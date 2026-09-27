import { afterEach, describe, expect, test } from 'bun:test';
import type { DocumentsAPI, VarinDocumentReadResult, VarinResourceReference } from '@varin/application-client';
import { getRuntimeKey } from '@varin/application-client';
import { bindDocumentRegistry, resetDocumentRegistry } from '@/lib/documents/session';
import { applyPatchDecisionsToDocument } from './document-write';
import { recordHintsFromToolCall, resetAgentFileChangeHints } from './hints';

const resource = (resourceId = 'note.txt'): VarinResourceReference => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const createMemoryDocuments = () => {
  const files = new Map<string, { content: string; revision: string }>();
  const keyOf = (ref: VarinResourceReference) => `${ref.workspaceId}\0${ref.resourceId}`;
  let revisionSeq = 1;
  const api: DocumentsAPI = {
    clearDirtyBuffers: async () => ({ cleared: true }),
    publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
    resolveWorkspace: async () => ({ workspaceId: resource().workspaceId, hostId: 'host-1', epoch: 1 }),
    resolveResourceIdentity: async (ref) => ({ coordinationId: `host-1\0${keyOf(ref)}`, aliases: [ref] }),
    read: async (ref) => {
      const file = files.get(keyOf(ref));
      if (!file) return { status: 'missing', epoch: 1, resource: ref };
      return {
        status: 'ready',
        epoch: 1,
        resource: ref,
        revision: file.revision,
        content: file.content,
        encoding: 'utf-8',
        bom: false,
        byteLength: file.content.length,
      } satisfies VarinDocumentReadResult;
    },
    write: async (request) => {
      const key = keyOf(request.resource);
      const current = files.get(key);
      if (request.expectedRevision === null) {
        if (current) {
          return { status: 'conflict', current: { status: 'ready', epoch: 1, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length } };
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          current: current
            ? { status: 'ready', epoch: 1, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length }
            : { status: 'missing', epoch: 1, resource: request.resource },
        };
      }
      const revision = `d1_${revisionSeq++}`;
      files.set(key, { content: request.content, revision });
      return { status: 'written', revision, byteLength: request.content.length };
    },
    move: async () => ({ status: 'missing', resource: resource() }),
    delete: async (request) => {
      files.delete(keyOf(request.resource));
      return { status: 'deleted', resource: request.resource };
    },
    watch: () => ({ close: () => undefined }),
    listRecoveryJournals: async () => [],
    readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
    writeRecoveryJournal: async () => ({ status: 'conflict', journal: {
      journalId: 'j',
      resource: resource(),
      revision: 1,
      baseRevision: null,
      epoch: 1,
      updatedAt: '2026-08-20T00:00:00.000Z',
      byteLength: 0,
    } }),
    deleteRecoveryJournal: async () => ({ status: 'missing', journalId: 'j' }),
  };
  return { api, files, keyOf };
};

afterEach(() => {
  resetDocumentRegistry();
  resetAgentFileChangeHints();
});

describe('document patch writes', () => {
  test('revert enters the revision-safe editor transaction without writing disk', async () => {
    const { api, files, keyOf } = createMemoryDocuments();
    const identity = resource();
    files.set(keyOf(identity), { content: 'one\nTWO\nthree', revision: 'd1_1' });
    const registry = bindDocumentRegistry(api);
    await registry.open(identity);
    const patch = ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'].join('\n');
    const reverted = await applyPatchDecisionsToDocument({
      identity,
      patch,
      decisions: ['accept'],
      direction: 'revert',
    });
    expect(reverted).toEqual({ status: 'applied', localEditRevision: 1 });
    expect(registry.get(identity)?.buffer).toBe('one\ntwo\nthree');
    expect(registry.get(identity)?.dirty).toBe(true);
    expect(files.get(keyOf(identity))?.content).toBe('one\nTWO\nthree');

    registry.discard(identity);
    registry.applyTransaction(identity, 'dirty', { origin: 'view' });
    files.set(keyOf(identity), { content: 'agent', revision: 'd1_agent' });
    const blocked = await applyPatchDecisionsToDocument({
      identity,
      patch,
      decisions: ['accept'],
      direction: 'apply',
    });
    expect(blocked).toEqual({ status: 'conflict', currentRevision: 'd1_1', dirty: true });
    expect(registry.get(identity)?.buffer).toBe('dirty');
    expect(files.get(keyOf(identity))?.content).toBe('agent');
  });
});

describe('hinted agent reloads', () => {
  test('marks a clean reload as agent-sourced when a tool hint exists', async () => {
    const { api, files, keyOf } = createMemoryDocuments();
    const identity = resource();
    files.set(keyOf(identity), { content: 'one', revision: 'd1_1' });
    const registry = bindDocumentRegistry(api);
    await registry.open(identity);
    recordHintsFromToolCall({
      runtimeKey: getRuntimeKey(),
      sessionId: 'session-a',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: 'note.txt' },
      workspaceId: identity.workspaceId,
      workspaceRoot: 'D:/workspace',
    });
    files.set(keyOf(identity), { content: 'two', revision: 'd1_2' });
    registry.handleWatchEvent({
      sourceId: 'test',
      generation: 1,
      kind: 'changed',
      sequence: 1,
      resource: identity,
      revision: 'd1_2',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.get(identity)?.buffer).toBe('two');
    expect(registry.get(identity)?.externalSource).toBe('agent');
  });
});
