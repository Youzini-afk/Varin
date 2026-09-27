import { afterEach, describe, expect, test } from 'bun:test';
import type { editor } from 'monaco-editor/editor';

import type {
  DocumentsAPI,
  VarinDocumentReadResult,
  VarinResourceReference,
} from '@varin/application-client';
import {
  consumeEditorContextAttachments,
  resetEditorContextAttachments,
} from '@/lib/agent-editor/attachments';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { projectEditorContextAttachments } from '@/lib/agent-editor/projection';
import { bindDocumentRegistry, resetDocumentRegistry } from '@/lib/documents/session';
import { DocumentRegistry } from '@/lib/documents/registry';
import { documentKey, type DocumentIdentity } from '@/lib/documents/types';
import { FileEditorModelRegistry } from '@/lib/monaco/model-registry';
import type { MonacoRuntime } from '@/lib/monaco/runtime';
import { getRuntimeKey } from '@varin/application-client';
import {
  armWorkbenchProfileTransitionPhase,
  beginWorkbenchProfileTransition,
  completeWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCovered,
  markWorkbenchProfileTransitionOperationPrepared,
  markWorkbenchProfileTransitionTargetPainted,
  resetWorkbenchProfileTransitionForTests,
  revealWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const identity: VarinResourceReference = { workspaceId, resourceId: 'src/main.ts' };

class JourneyModel {
  disposed = false;
  readonly uri: unknown;
  private value: string;
  private readonly listeners = new Set<(event: editor.IModelContentChangedEvent) => void>();

  constructor(value: string, uri: unknown) {
    this.value = value;
    this.uri = uri;
  }

  getValue(): string {
    return this.value;
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.value.slice(0, offset);
    const lines = before.split('\n');
    return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  }

  onDidChangeContent(listener: (event: editor.IModelContentChangedEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  pushEditOperations(
    _beforeCursorState: unknown,
    operations: readonly editor.IIdentifiedSingleEditOperation[],
  ): null {
    const changes = operations.map((operation) => {
      const from = this.offsetAt(operation.range.startLineNumber, operation.range.startColumn);
      const to = this.offsetAt(operation.range.endLineNumber, operation.range.endColumn);
      return { from, to, text: operation.text ?? '' };
    }).sort((left, right) => right.from - left.from);
    for (const change of changes) {
      this.value = `${this.value.slice(0, change.from)}${change.text}${this.value.slice(change.to)}`;
    }
    this.publish(changes);
    return null;
  }

  applyUserEdit(from: number, to: number, text: string): void {
    this.value = `${this.value.slice(0, from)}${text}${this.value.slice(to)}`;
    this.publish([{ from, to, text }]);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private offsetAt(lineNumber: number, column: number): number {
    const lines = this.value.split('\n');
    let offset = 0;
    for (let index = 0; index < lineNumber - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    return offset + column - 1;
  }

  private publish(changes: Array<{ from: number; to: number; text: string }>): void {
    const event = {
      changes: changes.map((change) => ({
        rangeOffset: change.from,
        rangeLength: change.to - change.from,
        text: change.text,
      })),
    } as editor.IModelContentChangedEvent;
    for (const listener of this.listeners) listener(event);
  }
}

const createMemoryDocuments = () => {
  const aliases = new Map<string, string>();
  const storageKey = (resource: VarinResourceReference): string => {
    const alias = `${resource.workspaceId}\0${resource.resourceId}`;
    return aliases.get(alias) ?? alias;
  };
  let revision = 1;
  const files = new Map<string, { content: string; revision: string }>([[
    storageKey(identity),
    { content: 'const value = 1;\n', revision: 'd1_1' },
  ]]);
  const read = async (resource: VarinResourceReference): Promise<VarinDocumentReadResult> => {
    const current = files.get(storageKey(resource));
    return current
      ? {
          status: 'ready',
          epoch: 1,
          resource,
          revision: current.revision,
          content: current.content,
          encoding: 'utf-8',
          bom: false,
          byteLength: current.content.length,
        }
      : { status: 'missing', epoch: 1, resource };
  };
  const api: DocumentsAPI = {
    clearDirtyBuffers: async () => ({ cleared: true }),
    publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
    resolveWorkspace: async (input) => ({ workspaceId: input.workspaceId ?? workspaceId, hostId: 'host-1', epoch: 1 }),
    resolveResourceIdentity: async (resource) => ({
      coordinationId: `host-1\0${storageKey(resource)}`,
      aliases: [...aliases.entries()].filter(([, key]) => key === storageKey(resource)).map(([alias]) => {
        const separator = alias.indexOf('\0');
        return { workspaceId: alias.slice(0, separator), resourceId: alias.slice(separator + 1) };
      }).concat(resource),
    }),
    read,
    write: async (request) => {
      const key = storageKey(request.resource);
      const current = files.get(key);
      if (request.expectedRevision !== (current?.revision ?? null)) {
        const currentResult = await read(request.resource);
        return { status: 'conflict', current: currentResult.status === 'ready'
          ? {
              status: 'ready',
              epoch: currentResult.epoch,
              resource: request.resource,
              revision: currentResult.revision,
              encoding: currentResult.encoding,
              bom: currentResult.bom,
              byteLength: currentResult.byteLength,
            }
          : currentResult };
      }
      const nextRevision = `d1_${++revision}`;
      files.set(key, { content: request.content, revision: nextRevision });
      return { status: 'written', revision: nextRevision, byteLength: request.content.length };
    },
    move: async (request) => ({ status: 'missing', resource: request.from }),
    delete: async (request) => {
      files.delete(storageKey(request.resource));
      return { status: 'deleted', resource: request.resource };
    },
    watch: () => ({ close: () => undefined }),
    listRecoveryJournals: async () => [],
    readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
    writeRecoveryJournal: async () => ({ status: 'missing', journalId: 'unused' }),
    deleteRecoveryJournal: async () => ({ status: 'missing' }),
  };
  return {
    api,
    aliases,
    externalWrite(content: string) {
      const nextRevision = `d1_${++revision}`;
      files.set(storageKey(identity), { content, revision: nextRevision });
    },
    files,
  };
};

const settleModel = async (registry: FileEditorModelRegistry, resource: DocumentIdentity): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (registry.getSnapshot(resource).status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const switchProfile = async (fromProfileId: string, toProfileId: string): Promise<void> => {
  const transitionId = beginWorkbenchProfileTransition({ fromProfileId, toProfileId });
  markWorkbenchProfileTransitionOperationPrepared(transitionId);
  armWorkbenchProfileTransitionPhase(transitionId, 'covering');
  markWorkbenchProfileTransitionCovered(transitionId);
  markWorkbenchProfileTransitionTargetPainted(transitionId, toProfileId);
  const revealed = revealWorkbenchProfileTransition(transitionId);
  armWorkbenchProfileTransitionPhase(transitionId, 'revealing');
  completeWorkbenchProfileTransition(transitionId);
  await revealed;
  const settled = getWorkbenchProfileTransitionSnapshot();
  expect(settled.phase).toBe('idle');
  expect(settled.toProfileId).toBeNull();
};

afterEach(() => {
  resetEditorContextAttachments();
  resetDocumentRegistry();
  resetWorkbenchProfileTransitionForTests();
});

describe('unified editor cross-surface journey', () => {
  test('parent and child project tabs share one Monaco model for the same physical file', async () => {
    const memory = createMemoryDocuments();
    const child: DocumentIdentity = { workspaceId: 'child-project', resourceId: 'main.ts' };
    memory.aliases.set(`${identity.workspaceId}\0${identity.resourceId}`, 'same-physical-file');
    memory.aliases.set(`${child.workspaceId}\0${child.resourceId}`, 'same-physical-file');
    memory.files.clear();
    memory.files.set('same-physical-file', { content: 'const value = 1;\n', revision: 'd1_1' });
    const documents = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1 });
    const models: JourneyModel[] = [];
    const monaco = {
      Uri: { from: (value: unknown) => value },
      editor: { createModel: (value: string, _language: string, uri: unknown) => {
        const model = new JourneyModel(value, uri);
        models.push(model);
        return model;
      } },
    } as unknown as MonacoRuntime;
    const modelRegistry = new FileEditorModelRegistry({ documents, loadRuntime: async () => monaco, runtimeKey: getRuntimeKey() });
    try {
      modelRegistry.acquire(identity, 'parent-tab');
      modelRegistry.acquire(child, 'child-tab');
      await settleModel(modelRegistry, identity);
      await settleModel(modelRegistry, child);
      const parentModel = modelRegistry.getSnapshot(identity);
      const childModel = modelRegistry.getSnapshot(child);
      expect(parentModel.status).toBe('ready');
      expect(childModel.status).toBe('ready');
      if (parentModel.status !== 'ready' || childModel.status !== 'ready') throw new Error('Shared model did not open');
      expect(childModel.model).toBe(parentModel.model);
      expect(models).toHaveLength(1);
    } finally {
      modelRegistry.dispose();
      await documents.dispose();
    }
  });

  test('preserves one model and document authority through IDE edits, rename, Agent attachment, conflict, and Profile handoff', async () => {
    const memory = createMemoryDocuments();
    const documents = bindDocumentRegistry(memory.api);
    const models: JourneyModel[] = [];
    const monaco = {
      Uri: { from: (value: unknown) => value },
      editor: {
        createModel: (value: string, _language: string, uri: unknown) => {
          const model = new JourneyModel(value, uri);
          models.push(model);
          return model;
        },
      },
    } as unknown as MonacoRuntime;
    const modelRegistry = new FileEditorModelRegistry({
      documents,
      loadRuntime: async () => monaco,
      runtimeKey: getRuntimeKey(),
    });

    const tabOwner = `tab:${workspaceId}:view-main`;
    modelRegistry.acquire(identity, tabOwner);
    await settleModel(modelRegistry, identity);
    const agentSnapshot = modelRegistry.getSnapshot(identity);
    expect(agentSnapshot.status).toBe('ready');
    if (agentSnapshot.status !== 'ready') throw new Error(agentSnapshot.status);
    const model = agentSnapshot.model as unknown as JourneyModel;

    // Profile staging changes Shell ownership, not the shared Workbench tab owner.
    await switchProfile('default', 'varin.ide');
    const ideSnapshot = modelRegistry.getSnapshot(identity);
    expect(ideSnapshot.status).toBe('ready');
    if (ideSnapshot.status !== 'ready') throw new Error(ideSnapshot.status);
    expect(ideSnapshot.model).toBe(agentSnapshot.model);
    expect(models).toHaveLength(1);

    model.applyUserEdit(model.getValue().indexOf('1'), model.getValue().indexOf('1') + 1, '2');
    expect(documents.get(identity)?.buffer).toBe('const value = 2;\n');

    const currentVersion = documents.get(identity)?.localEditRevision;
    const prepared = await documents.prepareWorkspaceEdit({
      workspaceId,
      origin: 'language:rename',
      textEdits: [{
        identity,
        version: currentVersion ?? null,
        edits: [{
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          newText: 'result',
        }],
      }],
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    expect((await documents.applyWorkspaceEdit(prepared.groupId)).status).toBe('applied');
    expect(model.getValue()).toBe('const result = 2;\n');

    const attached = attachEditorContext({
      sessionId: 'session-main',
      workspaceId,
      resourceId: identity.resourceId,
      kind: 'editor',
    });
    expect('status' in attached ? attached.status : attached.source).toBe('unsaved-buffer');
    const consumed = consumeEditorContextAttachments(getRuntimeKey(), 'session-main', workspaceId);
    expect(consumed[0]?.text).toBe('const result = 2;\n');
    expect(projectEditorContextAttachments('', consumed)).toContain('Pi file tools cannot see it on disk');

    const saved = await documents.save(identity);
    expect(saved.dirty).toBe(false);
    expect(memory.files.get(documentKey(identity))?.content).toBe('const result = 2;\n');

    const two = model.getValue().indexOf('2');
    model.applyUserEdit(two, two + 1, '3');
    memory.externalWrite('const result = 4;\n');
    const conflicted = await documents.reload(identity);
    expect(conflicted.status).toBe('conflict');
    expect(conflicted.buffer).toBe('const result = 3;\n');
    expect(conflicted.conflict?.diskContent).toBe('const result = 4;\n');

    await switchProfile('varin.ide', 'default');
    const returned = modelRegistry.getSnapshot(identity);
    expect(returned.status).toBe('ready');
    if (returned.status === 'ready') expect(returned.model).toBe(agentSnapshot.model);
    expect(models).toHaveLength(1);

    documents.discard(identity);
    modelRegistry.release(tabOwner);
    expect(model.disposed).toBe(true);
    expect(modelRegistry.getSnapshot(identity).status).toBe('loading');

    modelRegistry.dispose();
  });
});
