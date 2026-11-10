import { unconfiguredWorkspaceEdits } from './workspace-edit.test-helper';
import { describe, expect, test } from 'vitest';
import { vi } from 'vitest';
import type {
  DocumentsAPI,
  VarinTextFormat,
  VarinTextEdit,
  VarinDocumentPendingSave,
  VarinAgentInputSnapshotCaptureRequest,
  VarinDocumentReadResult,
  VarinDocumentRecoveryJournalSummary,
  VarinDocumentSurfaceOperationCompletion,
  VarinDocumentSurfaceOperationPayload,
  VarinDocumentWatchEvent,
  VarinResourceReference,
  VarinResourceIdentity,
} from '@varin/application-client';
import { DocumentsError } from '@varin/application-client';
import { DocumentRegistry } from './registry';
import { documentKey } from './types';

const resource = (resourceId = 'note.txt'): VarinResourceReference => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const mutationToken = () => ({
  workspaceId: resource().workspaceId,
  epoch: 1,
  owner: { kind: 'test', id: 'document-registry' },
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const hashText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256-${Buffer.from(digest).toString('hex')}`;
};

const createMemoryDocuments = () => {
  type DirtyPublication = Parameters<DocumentsAPI['publishDirtyBuffers']>[0];
  const files = new Map<string, { content: string; revision: string }>();
  const journals = new Map<string, {
    journalId: string;
    resource: VarinResourceReference;
    content: string;
    epoch: number;
    revision: number;
    baseRevision: string | null;
    encoding?: string; bom?: boolean; sourceFormat?: VarinTextFormat; lineEnding?: 'lf' | 'crlf' | 'cr';
    normalizeLineEndings?: boolean; edits?: VarinTextEdit[]; pendingSave?: VarinDocumentPendingSave; pendingEdits?: VarinTextEdit[];
  }>();
  const listeners = new Set<(event: VarinDocumentWatchEvent) => void>();
  const dirtyPublications: DirtyPublication[] = [];
  const dirtyPublicationWaiters = new Set<{
    predicate: (publication: DirtyPublication) => boolean;
    resolve: (publication: DirtyPublication) => void;
  }>();
  const waitForDirtyPublication = (predicate: (publication: DirtyPublication) => boolean): Promise<DirtyPublication> => {
    for (let index = dirtyPublications.length - 1; index >= 0; index -= 1) {
      const existing = dirtyPublications[index];
      if (existing && predicate(existing)) return Promise.resolve(existing);
    }
    return new Promise((resolve) => { dirtyPublicationWaiters.add({ predicate, resolve }); });
  };
  const barrierAcknowledgements: Array<Parameters<NonNullable<DocumentsAPI['ackDirtyStateBarrier']>>[0]> = [];
  let resolveBarrierAcknowledgement: () => void = () => undefined;
  const barrierAcknowledged = new Promise<void>((resolve) => { resolveBarrierAcknowledgement = resolve; });
  const surfaceCompletions: VarinDocumentSurfaceOperationCompletion[] = [];
  let surfaceOperation: VarinDocumentSurfaceOperationPayload | null = null;
  let revisionSeq = 1;
  let workspaceEpoch = 1;
  let watchSequence = 0;
  const coordinationOverrides = new Map<string, string>();
  const unavailableWorkspaceIds = new Set<string>();
  const keyOf = (ref: VarinResourceReference) => {
    const alias = `${ref.workspaceId}\0${ref.resourceId}`;
    return coordinationOverrides.get(alias) ?? alias;
  };
  const nextRevision = () => `d1_${revisionSeq++}`;
  const emit = (event: VarinDocumentWatchEvent) => {
    for (const listener of listeners) listener(event);
  };
  function resolveResourceIdentity(ref: VarinResourceReference): Promise<VarinResourceIdentity>;
  function resolveResourceIdentity(ref: VarinResourceReference, options: { withinWorkspaceId: string }): Promise<VarinResourceIdentity | null>;
  async function resolveResourceIdentity(ref: VarinResourceReference, options?: { withinWorkspaceId: string }): Promise<VarinResourceIdentity | null> {
    const aliases = [...coordinationOverrides.entries()].filter(([, physical]) => physical === keyOf(ref))
      .map(([alias]) => {
        const separator = alias.indexOf('\0');
        return { workspaceId: alias.slice(0, separator), resourceId: alias.slice(separator + 1) };
      }).concat(ref);
    if (options && !aliases.some((alias) => alias.workspaceId === options.withinWorkspaceId)) return null;
    if (unavailableWorkspaceIds.has(ref.workspaceId)) throw new Error('Workspace is unavailable');
    return { coordinationId: `host-1\0${keyOf(ref)}`, aliases };
  }

  const api: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
    ackDirtyStateBarrier: async (request) => {
      barrierAcknowledgements.push(request);
      resolveBarrierAcknowledgement();
      return { acknowledged: true };
    },
    clearDirtyBuffers: async () => ({ cleared: true }),
    readSurfaceOperation: async () => {
      if (!surfaceOperation) throw new Error('surface operation unavailable');
      return surfaceOperation;
    },
    completeSurfaceOperation: async (request) => {
      surfaceCompletions.push(request);
      return { accepted: true };
    },
    publishDirtyBuffers: async (request) => {
      dirtyPublications.push(request);
      for (const waiter of dirtyPublicationWaiters) {
        if (!waiter.predicate(request)) continue;
        dirtyPublicationWaiters.delete(waiter);
        waiter.resolve(request);
      }
      return { ...request, updatedAt: '2026-08-28T00:00:00.000Z' };
    },
    resolveWorkspace: async ({ workspaceId }) => ({ workspaceId: workspaceId ?? resource().workspaceId, hostId: 'host-1', epoch: workspaceEpoch }),
    resolveResourceIdentity,
    read: async (ref) => {
      const file = files.get(keyOf(ref));
      if (!file) return { status: 'missing', epoch: workspaceEpoch, resource: ref };
      return {
        status: 'ready',
        epoch: workspaceEpoch,
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
          return { status: 'conflict', current: { status: 'ready', epoch: workspaceEpoch, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length } };
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          current: current
            ? { status: 'ready', epoch: workspaceEpoch, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length }
            : { status: 'missing', epoch: workspaceEpoch, resource: request.resource },
        };
      }
      const revision = nextRevision();
      const eol = request.lineEnding ?? request.sourceFormat?.defaultLineEnding;
      const content = eol === 'crlf' ? request.content.replace(/\r\n|\r/g, '\n').replace(/\n/g, '\r\n') : request.content;
      files.set(key, { content, revision });
      emit({ sourceId: 'memory-documents', generation: 1, kind: current ? 'changed' : 'created', sequence: ++watchSequence, resource: request.resource, revision });
      return { status: 'written', revision, byteLength: request.content.length };
    },
    move: async () => ({ status: 'missing', resource: resource() }),
    delete: async (request) => {
      files.delete(keyOf(request.resource));
      return { status: 'deleted', resource: request.resource };
    },
    watch: (_workspaceId, listener) => {
      listeners.add(listener);
      return { close: () => { listeners.delete(listener); } };
    },
    listRecoveryJournals: async () => [...journals.values()].map((entry) => ({
      journalId: entry.journalId,
      resource: entry.resource,
      revision: entry.revision,
      baseRevision: entry.baseRevision,
      epoch: entry.epoch,
      updatedAt: '2026-08-20T00:00:00.000Z',
      byteLength: entry.content.length,
    })) satisfies VarinDocumentRecoveryJournalSummary[],
    readRecoveryJournal: async (journalId) => {
      const entry = journals.get(journalId);
      if (!entry) return { status: 'missing', journalId };
      return {
        status: 'ready',
        journal: {
          journalId: entry.journalId,
          resource: entry.resource,
          revision: entry.revision,
          baseRevision: entry.baseRevision,
          epoch: entry.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: entry.content.length,
        },
        content: entry.content,
        encoding: entry.encoding ?? 'utf-8',
        bom: entry.bom ?? false,
        sourceFormat: entry.sourceFormat, lineEnding: entry.lineEnding, normalizeLineEndings: entry.normalizeLineEndings, edits: entry.edits, pendingSave: entry.pendingSave, pendingEdits: entry.pendingEdits,
      };
    },
    writeRecoveryJournal: async (request) => {
      const existing = [...journals.values()].find((entry) => (
        entry.resource.resourceId === request.resource.resourceId
      ));
      if (existing) {
        if (request.expectedRevision !== existing.revision) {
          return { status: 'conflict', journal: {
            journalId: existing.journalId,
            resource: existing.resource,
            revision: existing.revision,
            baseRevision: existing.baseRevision,
            epoch: existing.epoch,
            updatedAt: '2026-08-20T00:00:00.000Z',
            byteLength: existing.content.length,
          } };
        }
        existing.content = request.content;
        existing.encoding = request.encoding; existing.bom = request.bom; existing.sourceFormat = request.sourceFormat; existing.lineEnding = request.lineEnding; existing.edits = request.edits; existing.normalizeLineEndings = request.normalizeLineEndings; existing.pendingSave = request.pendingSave; existing.pendingEdits = request.pendingEdits;
        existing.revision += 1;
        existing.baseRevision = request.baseRevision;
        return { status: 'written', journal: {
          journalId: existing.journalId,
          resource: existing.resource,
          revision: existing.revision,
          baseRevision: existing.baseRevision,
          epoch: existing.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: existing.content.length,
        } };
      }
      if (request.expectedRevision !== null) return { status: 'missing', journalId: '' };
      const journalId = crypto.randomUUID();
      const created = {
        journalId,
        resource: request.resource,
        content: request.content,
        epoch: request.token.epoch,
        revision: 1,
        baseRevision: request.baseRevision,
        encoding: request.encoding, bom: request.bom, sourceFormat: request.sourceFormat, lineEnding: request.lineEnding, normalizeLineEndings: request.normalizeLineEndings, edits: request.edits, pendingSave: request.pendingSave, pendingEdits: request.pendingEdits,
      };
      journals.set(journalId, created);
      return { status: 'written', journal: {
        journalId,
        resource: request.resource,
        revision: 1,
        baseRevision: request.baseRevision,
        epoch: request.token.epoch,
        updatedAt: '2026-08-20T00:00:00.000Z',
        byteLength: request.content.length,
      } };
    },
    deleteRecoveryJournal: async (request) => {
      const current = journals.get(request.journalId);
      if (!current) return { status: 'missing' };
      if (current.revision !== request.expectedRevision) {
        return { status: 'conflict', journal: {
          journalId: current.journalId,
          resource: current.resource,
          revision: current.revision,
          baseRevision: current.baseRevision,
          epoch: current.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: current.content.length,
        } };
      }
      journals.delete(request.journalId);
      return { status: 'deleted' };
    },
  };

  return {
    api,
    coordinationOverrides,
    unavailableWorkspaceIds,
    barrierAcknowledged,
    barrierAcknowledgements,
    dirtyPublications,
    files,
    journals,
    surfaceCompletions,
    setSurfaceOperation: (operation: VarinDocumentSurfaceOperationPayload) => { surfaceOperation = operation; },
    emit,
    setEpoch: (epoch: number) => { workspaceEpoch = epoch; },
    waitForDirtyPublication,
  };
};

describe('DocumentRegistry', () => {
  test('restores a parent-project draft when the same file opens through its child project', async () => {
    const memory = createMemoryDocuments();
    const parent = { workspaceId: 'parent', resourceId: 'child/recovered.txt' };
    const child = { workspaceId: 'child', resourceId: 'recovered.txt' };
    memory.coordinationOverrides.set(`${parent.workspaceId}\0${parent.resourceId}`, 'recovered-physical-file');
    memory.coordinationOverrides.set(`${child.workspaceId}\0${child.resourceId}`, 'recovered-physical-file');
    memory.files.set('recovered-physical-file', { content: 'disk\n', revision: 'd1_disk' });
    await memory.api.writeRecoveryJournal({
      token: { workspaceId: parent.workspaceId, epoch: 1, owner: { kind: 'test', id: 'recovery' } },
      workspaceId: parent.workspaceId,
      recoverySessionId: 'shared-recovery',
      resource: parent,
      content: 'unsaved parent\n',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_disk',
      expectedRevision: null,
    });
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'shared-recovery' });
    try {
      const opened = await registry.open(child);
      expect(opened.buffer).toBe('unsaved parent\n');
      expect(opened.dirty).toBe(true);
      expect(registry.get(parent)).toBe(registry.get(child));
      await registry.save(child);
      expect(memory.files.get('recovered-physical-file')?.content).toBe('unsaved parent\n');
      expect(memory.journals.size).toBe(0);
    } finally {
      await registry.dispose();
    }
  });

  test('keeps both recovery drafts when two project aliases have different unsaved bodies', async () => {
    const memory = createMemoryDocuments();
    const parent = { workspaceId: 'parent', resourceId: 'child/conflicted.txt' };
    const child = { workspaceId: 'child', resourceId: 'conflicted.txt' };
    memory.coordinationOverrides.set(`${parent.workspaceId}\0${parent.resourceId}`, 'conflicted-physical-file');
    memory.coordinationOverrides.set(`${child.workspaceId}\0${child.resourceId}`, 'conflicted-physical-file');
    memory.files.set('conflicted-physical-file', { content: 'disk\n', revision: 'd1_disk' });
    for (const [resource, content] of [[parent, 'parent draft\n'], [child, 'child draft\n']] as const) {
      await memory.api.writeRecoveryJournal({
        token: { workspaceId: resource.workspaceId, epoch: 1, owner: { kind: 'test', id: 'recovery' } },
        workspaceId: resource.workspaceId,
        recoverySessionId: 'shared-conflict',
        resource,
        content,
        encoding: 'utf-8',
        bom: false,
        baseRevision: 'd1_disk',
        expectedRevision: null,
      });
    }
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'shared-conflict' });
    try {
      const opened = await registry.open(child);
      expect(opened.status).toBe('error');
      expect(opened.errorMessage).toContain('Multiple recovery drafts');
      expect(memory.journals.size).toBe(2);
      expect(memory.files.get('conflicted-physical-file')?.content).toBe('disk\n');
    } finally {
      await registry.dispose();
    }
  });

  test('keeps a readable file available when a secondary recovery alias is offline', async () => {
    const memory = createMemoryDocuments();
    const primary = { workspaceId: 'primary', resourceId: 'child/offline.txt' };
    const secondary = { workspaceId: 'secondary', resourceId: 'offline.txt' };
    memory.coordinationOverrides.set(`${primary.workspaceId}\0${primary.resourceId}`, 'offline-physical-file');
    memory.coordinationOverrides.set(`${secondary.workspaceId}\0${secondary.resourceId}`, 'offline-physical-file');
    memory.files.set('offline-physical-file', { content: 'readable disk\n', revision: 'd1_disk' });
    await memory.api.writeRecoveryJournal({
      token: { workspaceId: secondary.workspaceId, epoch: 1, owner: { kind: 'test', id: 'recovery' } },
      workspaceId: secondary.workspaceId,
      recoverySessionId: 'offline-recovery',
      resource: secondary,
      content: 'unknown secondary draft\n',
      encoding: 'utf-8', bom: false, baseRevision: 'd1_disk', expectedRevision: null,
    });
    const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...memory.api,
      resolveWorkspace: async (input) => {
        if (input.workspaceId === secondary.workspaceId) throw new Error('secondary root disconnected');
        return memory.api.resolveWorkspace(input);
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'offline-recovery' });
    try {
      const opened = await registry.open(primary);
      expect(opened.status).toBe('ready');
      expect(opened.buffer).toBe('readable disk\n');
      expect(opened.errorMessage).toContain('could not be checked');
      expect(memory.journals.size).toBe(1);
    } finally {
      await registry.dispose();
    }
  });

  test('rechecks a reconnecting alias recovery draft against current disk before exposing it', async () => {
    const memory = createMemoryDocuments();
    const primary = { workspaceId: 'primary', resourceId: 'child/reconnect.txt' };
    const secondary = { workspaceId: 'secondary', resourceId: 'reconnect.txt' };
    memory.coordinationOverrides.set(`${primary.workspaceId}\0${primary.resourceId}`, 'reconnect-physical-file');
    memory.coordinationOverrides.set(`${secondary.workspaceId}\0${secondary.resourceId}`, 'reconnect-physical-file');
    memory.files.set('reconnect-physical-file', { content: 'original disk\n', revision: 'd1_original' });
    await memory.api.writeRecoveryJournal({
      token: { workspaceId: secondary.workspaceId, epoch: 1, owner: { kind: 'test', id: 'recovery' } },
      workspaceId: secondary.workspaceId,
      recoverySessionId: 'reconnect-recovery',
      resource: secondary,
      content: 'old secondary draft\n',
      encoding: 'utf-8', bom: false, baseRevision: 'd1_original', expectedRevision: null,
    });
    let secondaryOnline = false;
    const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...memory.api,
      resolveResourceIdentity: async (resource) => {
        const result = await memory.api.resolveResourceIdentity(resource);
        return secondaryOnline ? result : { ...result, aliases: result.aliases.filter((alias) => alias.workspaceId !== secondary.workspaceId) };
      },
      resolveWorkspace: async (input) => {
        if (!secondaryOnline && input.workspaceId === secondary.workspaceId) throw new Error('secondary root offline');
        return memory.api.resolveWorkspace(input);
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'reconnect-recovery' });
    try {
      const opened = await registry.open(primary);
      expect(opened.status).toBe('ready');
      registry.applyTransaction(primary, 'new primary edit\n', { origin: 'editor' });
      await registry.save(primary);
      expect(memory.files.get('reconnect-physical-file')?.content).toBe('new primary edit\n');
      expect(memory.journals.size).toBe(1);

      secondaryOnline = true;
      const reconnected = await registry.open(secondary);
      expect(reconnected.status).toBe('error');
      expect(reconnected.errorMessage).toContain('older disk revision');
      expect(reconnected.buffer).toBe('new primary edit\n');
      expect(memory.files.get('reconnect-physical-file')?.content).toBe('new primary edit\n');
      expect(memory.journals.size).toBe(1);
    } finally {
      await registry.dispose();
    }
  });

  test('captures a dirty file through its live alias after a secondary project root goes offline', async () => {
    const memory = createMemoryDocuments();
    const primary = { workspaceId: 'primary', resourceId: 'child/draft.txt' };
    const secondary = { workspaceId: 'secondary', resourceId: 'draft.txt' };
    for (const alias of [primary, secondary]) {
      memory.coordinationOverrides.set(`${alias.workspaceId}\0${alias.resourceId}`, 'one-physical-draft');
    }
    memory.files.set('one-physical-draft', { content: 'disk\n', revision: 'd1_disk' });
    let secondaryOnline = true;
    const captures: Array<Parameters<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>[0]> = [];
    const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...memory.api,
      resolveResourceIdentity: async (resource) => {
        if (!secondaryOnline && resource.workspaceId === secondary.workspaceId) throw new Error('secondary root offline');
        const resolved = await memory.api.resolveResourceIdentity(resource);
        return secondaryOnline ? resolved : {
          ...resolved,
          aliases: resolved.aliases.filter((alias) => alias.workspaceId !== secondary.workspaceId),
        };
      },
      captureAgentInputSnapshot: async (request) => {
        captures.push(request);
        return {
          source: 'surface',
          roots: [{ workspaceId: primary.workspaceId, dirtyPaths: [primary.resourceId] }],
          snapshot: { status: 'ready', ref: 'live-alias-capture' },
        };
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'offline-alias-capture' });
    try {
      await registry.open(primary);
      await registry.open(secondary);
      registry.applyTransaction(primary, 'unsaved\n', { origin: 'editor' });
      secondaryOnline = false;
      const context = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'thread-1', branchId: 'main' });
      expect(context).toEqual({
        source: 'surface',
        roots: [{ workspaceId: primary.workspaceId, dirtyPaths: [primary.resourceId] }],
        snapshot: { status: 'ready', ref: 'live-alias-capture' },
      });
      expect(captures[0]?.resources.map((resource) => resource.resource)).toEqual([primary]);
    } finally {
      await registry.dispose();
    }
  });

  test('rekeys a moved shared file while retaining one buffer for its new project aliases', async () => {
    const memory = createMemoryDocuments();
    const oldParent = { workspaceId: 'parent', resourceId: 'child/old.txt' };
    const oldChild = { workspaceId: 'child', resourceId: 'old.txt' };
    const newParent = { workspaceId: 'parent', resourceId: 'child/new.txt' };
    const newChild = { workspaceId: 'child', resourceId: 'new.txt' };
    for (const alias of [oldParent, oldChild]) memory.coordinationOverrides.set(`${alias.workspaceId}\0${alias.resourceId}`, 'old-physical');
    for (const alias of [newParent, newChild]) memory.coordinationOverrides.set(`${alias.workspaceId}\0${alias.resourceId}`, 'new-physical');
    memory.files.set('old-physical', { content: 'disk\n', revision: 'd1_disk' });
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'shared-move' });
    try {
      const first = await registry.open(oldParent);
      await registry.open(oldChild);
      registry.handleWatchEvent({
        sourceId: 'test', generation: 1, kind: 'moved', sequence: 1,
        from: oldParent, resource: newParent,
      });
      for (let attempt = 0; attempt < 20 && !registry.get(newChild); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(registry.get(newParent)?.documentInstanceId).toBe(first.documentInstanceId);
      expect(registry.get(newChild)).toBe(registry.get(newParent));
      expect(registry.get(oldParent)).toBeUndefined();
      expect(registry.get(oldChild)).toBeUndefined();
    } finally {
      await registry.dispose();
    }
  });

  test('captures dirty files from distinct roots in one turn', async () => {
    const memory = createMemoryDocuments();
    const first = { workspaceId: 'project-a', resourceId: 'same.txt' };
    const second = { workspaceId: 'project-b', resourceId: 'same.txt' };
    memory.files.set(`${first.workspaceId}\0${first.resourceId}`, { content: 'A disk\n', revision: 'd1_a' });
    memory.files.set(`${second.workspaceId}\0${second.resourceId}`, { content: 'B disk\n', revision: 'd1_b' });
    const captures: Array<Parameters<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>[0]> = [];
    const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...memory.api,
      captureAgentInputSnapshot: async (request) => {
        captures.push(request);
        return {
          source: 'surface',
          roots: [
            { workspaceId: first.workspaceId, dirtyPaths: [first.resourceId] },
            { workspaceId: second.workspaceId, dirtyPaths: [second.resourceId] },
          ],
          snapshot: { status: 'ready', ref: 'two-root-ref' },
        };
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'two-root-test' });
    try {
      await Promise.all([registry.open(first), registry.open(second)]);
      registry.applyTransaction(first, 'A draft\n', { origin: 'editor-a' });
      registry.applyTransaction(second, 'B draft\n', { origin: 'editor-b' });
      const context = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'two-root-thread', branchId: 'main' });
      expect(context).toEqual({
        source: 'surface',
        roots: [
          { workspaceId: first.workspaceId, dirtyPaths: [first.resourceId] },
          { workspaceId: second.workspaceId, dirtyPaths: [second.resourceId] },
        ],
        snapshot: { status: 'ready', ref: 'two-root-ref' },
      });
      expect(captures).toHaveLength(1);
      expect(captures[0]?.resources.map((entry) => [entry.resource.workspaceId, entry.content])).toEqual([
        [first.workspaceId, 'A draft\n'],
        [second.workspaceId, 'B draft\n'],
      ]);
    } finally {
      await registry.dispose();
    }
  });

  test('captures only the selected Thread root, including a shared buffer alias, and releases with the same consumer', async () => {
    const memory = createMemoryDocuments();
    const selected = { workspaceId: 'selected', resourceId: 'draft.txt' };
    const alias = { workspaceId: 'parent', resourceId: 'selected/draft.txt' };
    const unrelated = { workspaceId: 'unrelated', resourceId: 'private.txt' };
    for (const ref of [selected, alias]) memory.coordinationOverrides.set(`${ref.workspaceId}\0${ref.resourceId}`, 'shared-file');
    memory.files.set('shared-file', { content: 'saved', revision: 'disk-1' });
    memory.files.set(`${unrelated.workspaceId}\0${unrelated.resourceId}`, { content: 'private saved', revision: 'disk-2' });
    const capture = vi.fn<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>(async request => ({
      source: 'surface', roots: [{ workspaceId: selected.workspaceId, dirtyPaths: request.resources.map(entry => entry.resource.resourceId) }],
      snapshot: { status: 'ready', ref: 'selected-snapshot' },
    }));
    const release = vi.fn<NonNullable<DocumentsAPI['releaseAgentInputSnapshot']>>(async () => ({ released: true }));
    const identityRequests: Array<{ withinWorkspaceId?: string }> = [];
    function resolve(ref: VarinResourceReference): Promise<VarinResourceIdentity>;
    function resolve(ref: VarinResourceReference, options: { withinWorkspaceId: string }): Promise<VarinResourceIdentity | null>;
    function resolve(ref: VarinResourceReference, options?: { withinWorkspaceId: string }): Promise<VarinResourceIdentity | null> {
      identityRequests.push(options ?? {});
      return options ? memory.api.resolveResourceIdentity(ref, options) : memory.api.resolveResourceIdentity(ref);
    }
    const registry = new DocumentRegistry({ documents: { ...memory.api, resolveResourceIdentity: resolve,
      captureAgentInputSnapshot: capture, releaseAgentInputSnapshot: release }, getGeneration: () => 1 });
    const consumer = { kind: 'thread' as const, threadId: 'thread-real', branchId: 'branch-real' };
    try {
      await registry.open(alias); await registry.open(selected); await registry.open(unrelated);
      registry.applyTransaction(alias, 'selected draft', { origin: 'editor' });
      registry.applyTransaction(unrelated, 'unrelated draft', { origin: 'editor' });
      memory.unavailableWorkspaceIds.add(unrelated.workspaceId);
      identityRequests.length = 0;
      const context = await registry.captureAgentInputContext(consumer, selected.workspaceId);
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]![0]).toMatchObject({ consumer, resources: [{ resource: selected, content: 'selected draft' }] });
      expect(capture.mock.calls[0]![0].resources).toHaveLength(1);
      expect(identityRequests.length).toBeGreaterThan(0);
      expect(identityRequests.every((options) => options.withinWorkspaceId === selected.workspaceId)).toBe(true);
      expect(context).toMatchObject({ source: 'surface', roots: [{ workspaceId: selected.workspaceId, dirtyPaths: ['draft.txt'] }] });
      await registry.releaseAgentInputContext(consumer, context);
      expect(release).toHaveBeenCalledExactlyOnceWith({ consumer, context });
      expect(await registry.captureAgentInputContext(consumer, 'clean-selected')).toEqual({ source: 'disk' });
      expect(capture).toHaveBeenCalledOnce();
      expect(registry.get(selected)?.buffer).toBe('selected draft');
      expect(registry.get(unrelated)?.buffer).toBe('unrelated draft');
      expect(memory.files.get('shared-file')?.content).toBe('saved');
      memory.unavailableWorkspaceIds.add(selected.workspaceId);
      memory.unavailableWorkspaceIds.add(alias.workspaceId);
      expect(await registry.captureAgentInputContext(consumer, selected.workspaceId)).toMatchObject({
        source: 'surface', snapshot: { status: 'unavailable' },
      });
      expect(capture).toHaveBeenCalledOnce();
    } finally { await registry.dispose(); }
  });

  test('discovers a newly selected nested root before deciding whether its files have drafts', async () => {
    const memory = createMemoryDocuments();
    const parent = { workspaceId: 'parent', resourceId: 'nested/draft.txt' };
    const nested = { workspaceId: 'new-nested-root', resourceId: 'draft.txt' };
    memory.coordinationOverrides.set(`${parent.workspaceId}\0${parent.resourceId}`, 'physical-draft');
    memory.files.set('physical-draft', { content: 'saved', revision: 'disk' });
    const capture = vi.fn<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>(async () => ({
      source: 'surface', roots: [{ workspaceId: nested.workspaceId, dirtyPaths: [nested.resourceId] }], snapshot: { status: 'ready', ref: 'new-root-draft' },
    }));
    const registry = new DocumentRegistry({ documents: { ...memory.api, captureAgentInputSnapshot: capture }, getGeneration: () => 1 });
    try {
      await registry.open(parent);
      registry.applyTransaction(parent, 'unsaved before root registration', { origin: 'editor' });
      memory.coordinationOverrides.set(`${nested.workspaceId}\0${nested.resourceId}`, 'physical-draft');
      const context = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'thread', branchId: 'branch' }, nested.workspaceId);
      expect(context).toMatchObject({ source: 'surface', roots: [{ workspaceId: nested.workspaceId, dirtyPaths: [nested.resourceId] }] });
      expect(capture.mock.calls[0]![0].resources.map(entry => [entry.resource, entry.content])).toEqual([[nested, 'unsaved before root registration']]);
      expect(registry.get(parent)?.buffer).toBe('unsaved before root registration');
    } finally { await registry.dispose(); }
  });

  test('verifies independent dirty files concurrently before sending a prompt', async () => {
    const memory = createMemoryDocuments();
    const first = { workspaceId: 'project-a', resourceId: 'a.txt' };
    const second = { workspaceId: 'project-b', resourceId: 'b.txt' };
    memory.files.set(`${first.workspaceId}\0${first.resourceId}`, { content: 'A', revision: 'd1_a' });
    memory.files.set(`${second.workspaceId}\0${second.resourceId}`, { content: 'B', revision: 'd1_b' });
    let delayIdentity = false;
    const releaseIdentity: Array<() => void> = [];
    const documents: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...memory.api,
      resolveResourceIdentity: async (reference) => {
        if (delayIdentity) await new Promise<void>((resolve) => { releaseIdentity.push(resolve); });
        return memory.api.resolveResourceIdentity(reference);
      },
      captureAgentInputSnapshot: async () => ({
        source: 'surface',
        roots: [first, second].map((reference) => ({ workspaceId: reference.workspaceId, dirtyPaths: [reference.resourceId] })),
        snapshot: { status: 'ready', ref: 'parallel-identity' },
      }),
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'parallel-capture' });
    try {
      await Promise.all([registry.open(first), registry.open(second)]);
      registry.applyTransaction(first, 'A draft', { origin: 'editor' });
      registry.applyTransaction(second, 'B draft', { origin: 'editor' });
      delayIdentity = true;
      const capture = registry.captureAgentInputContext({ kind: 'thread', threadId: 'thread-1', branchId: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const startedTogether = releaseIdentity.length;
      delayIdentity = false;
      releaseIdentity.forEach((release) => release());
      expect(startedTogether).toBe(2);
      expect((await capture).source).toBe('surface');
    } finally {
      await registry.dispose();
    }
  });

  test('shares one dirty buffer across parent and child project aliases', async () => {
    const memory = createMemoryDocuments();
    const { api, coordinationOverrides, files, waitForDirtyPublication } = memory;
    const parent = { workspaceId: 'parent', resourceId: 'child/shared.txt' };
    const child = { workspaceId: 'child', resourceId: 'shared.txt' };
    coordinationOverrides.set(`${parent.workspaceId}\0${parent.resourceId}`, 'physical-file');
    coordinationOverrides.set(`${child.workspaceId}\0${child.resourceId}`, 'physical-file');
    files.set('physical-file', { content: 'base\n', revision: 'd1_1' });
    const captures: Array<Parameters<NonNullable<DocumentsAPI['captureAgentInputSnapshot']>>[0]> = [];
    const scopedWatches = new Map<string, Set<(event: VarinDocumentWatchEvent) => void>>();
    const surface: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      watch: (workspaceId, listener) => {
        const listeners = scopedWatches.get(workspaceId) ?? new Set();
        listeners.add(listener);
        scopedWatches.set(workspaceId, listeners);
        return { close: () => { listeners.delete(listener); } };
      },
      captureAgentInputSnapshot: async (request) => {
        captures.push(request);
        return {
          source: 'surface',
          roots: [...new Set(request.resources.map((item) => item.resource.workspaceId))].map((workspaceId) => ({
            workspaceId,
            dirtyPaths: request.resources.filter((item) => item.resource.workspaceId === workspaceId)
              .map((item) => item.resource.resourceId),
          })),
          snapshot: { status: 'ready', ref: `alias-capture-${captures.length}` },
        };
      },
    };
    const registry = new DocumentRegistry({ documents: surface, getGeneration: () => 1, recoverySessionId: 'alias-test' });
    try {
      const first = await registry.open(parent);
      const second = await registry.open(child);
      expect(second.documentInstanceId).toBe(first.documentInstanceId);
      expect(registry.get(parent)).toBe(registry.get(child));

      registry.applyTransaction(child, 'edited\n', { origin: 'child-editor' });
      expect(registry.get(parent)?.buffer).toBe('edited\n');
      expect(registry.dirtyResourceIds(parent.workspaceId).has(parent.resourceId)).toBe(true);
      expect(registry.dirtyResourceIds(child.workspaceId).has(child.resourceId)).toBe(true);
      await waitForDirtyPublication((publication) => publication.workspaceId === child.workspaceId
        && publication.resources[0]?.resource.resourceId === child.resourceId);
      const childContext = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'child-thread', branchId: 'main' });
      expect(childContext.source).toBe('surface');
      if (childContext.source !== 'surface') throw new Error('Expected child draft');
      expect(childContext.roots).toEqual([
        { workspaceId: child.workspaceId, dirtyPaths: [child.resourceId] },
        { workspaceId: parent.workspaceId, dirtyPaths: [parent.resourceId] },
      ]);
      expect(captures[0]?.resources[0]?.resource).toEqual(child);
      const parentContext = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'parent-thread', branchId: 'main' });
      expect(parentContext.source).toBe('surface');
      if (parentContext.source !== 'surface') throw new Error('Expected parent draft');
      expect(parentContext.roots).toEqual(childContext.roots);
      const before = registry.get(child)!;
      memory.setSurfaceOperation({
        action: 'apply',
        operationId: 'shared-surface-edit',
        requestId: 'shared-surface-request',
        workspaceId: child.workspaceId,
        targets: [{
          resource: child,
          documentInstanceId: before.documentInstanceId,
          baseRevision: before.baseRevision,
          localEditRevision: before.localEditRevision,
          bufferHash: await hashText(before.buffer),
          encoding: before.encoding,
          bom: before.bom,
          lineEnding: before.lineEnding,
          newText: 'surface-edited\n',
        }],
      });
      for (const listener of scopedWatches.get(child.workspaceId) ?? []) {
        listener({ kind: 'surface-operation', action: 'apply', operationId: 'shared-surface-edit', requestId: 'shared-surface-request', workspaceId: child.workspaceId });
      }
      for (let attempt = 0; attempt < 20 && memory.surfaceCompletions.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(memory.surfaceCompletions[0]?.resources[0]?.resource).toEqual(child);
      expect(memory.surfaceCompletions[0]?.resources[0]?.status).toBe('applied');
      expect(registry.get(parent)?.buffer).toBe('surface-edited\n');
      await registry.save(child);
      expect(files.get('physical-file')?.content).toBe('surface-edited\n');
      expect(registry.dirtyResourceIds(parent.workspaceId).size).toBe(0);
      expect(registry.dirtyResourceIds(child.workspaceId).size).toBe(0);
    } finally {
      await registry.dispose();
    }
  });

  test('disposal waits for the final dirty journal and owner release before Host teardown', async () => {
    const memory = createMemoryDocuments();
    let releaseJournal!: () => void;
    let releaseOwner!: () => void;
    const journalGate = new Promise<void>(resolve => { releaseJournal = resolve; });
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    let journalEntered = false;
    let ownerEntered = false;
    const registry = new DocumentRegistry({ documents: {
      ...memory.api,
      writeRecoveryJournal: async request => { journalEntered = true; await journalGate; return memory.api.writeRecoveryJournal(request); },
      clearDirtyBuffers: async request => { ownerEntered = true; await ownerGate; return memory.api.clearDirtyBuffers(request); },
    }, getGeneration: () => 1, journalDebounceMs: 60_000 });
    await registry.open(resource());
    registry.applyTransaction(resource(), 'unsaved', { origin: 'editor' });
    const closing = registry.dispose();
    expect(registry.dispose()).toBe(closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(journalEntered).toBe(true);
    expect(ownerEntered).toBe(true);
    expect(closed).toBe(false);
    releaseJournal();
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseOwner();
    await closing;
    expect(closed).toBe(true);
    expect(memory.journals.size).toBe(1);
  });
  test('captures serialized CRLF editor content with UTF-8 BOM metadata', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource('crlf-bom.txt');
    const captures: VarinAgentInputSnapshotCaptureRequest[] = [];
    const surface: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      read: async (ref) => ({
        status: 'ready' as const,
        epoch: 1,
        resource: ref,
        revision: 'disk-crlf-bom',
        content: 'base\r\nline\r\n',
        encoding: 'utf-8',
        bom: true,
        byteLength: Buffer.byteLength('\uFEFFbase\r\nline\r\n', 'utf8'),
      }),
      captureAgentInputSnapshot: async (request) => {
        captures.push(request);
        return {
          source: 'surface' as const,
          roots: [{ workspaceId: identity.workspaceId, dirtyPaths: request.resources.map((entry) => entry.resource.resourceId) }],
          snapshot: { status: 'ready' as const, ref: 'surface-capture' },
        };
      },
    };
    const registry = new DocumentRegistry({ documents: surface, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'edited\nnext\n', { origin: 'test' });

    const captured = await registry.captureAgentInputContext({ kind: 'thread', threadId: 'thread-1', branchId: 'main' });
    expect(captured).toEqual({
      source: 'surface',
      roots: [{ workspaceId: identity.workspaceId, dirtyPaths: [identity.resourceId] }],
      snapshot: { status: 'ready', ref: 'surface-capture' },
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.resources[0]?.content).toBe('edited\r\nnext\r\n');
    expect(captures[0]?.resources[0]?.encoding).toBe('utf-8');
    expect(captures[0]?.resources[0]?.bom).toBe(true);
    registry.dispose();
  });

  test('keeps independent dirty buffers when switching documents', async () => {
    const { api } = createMemoryDocuments();
    await api.write({ token: mutationToken(), resource: resource('a.txt'), content: 'A', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: resource('b.txt'), content: 'B', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const a = await registry.open(resource('a.txt'));
    const b = await registry.open(resource('b.txt'));
    registry.applyTransaction(a.identity, 'A-edit', { origin: 'view-1' });
    registry.applyTransaction(b.identity, 'B-edit', { origin: 'view-1' });
    expect(registry.get(resource('a.txt'))?.buffer).toBe('A-edit');
    expect(registry.get(resource('b.txt'))?.buffer).toBe('B-edit');
    expect(registry.get(resource('a.txt'))?.dirty).toBe(true);
    registry.dispose();
  });

  test('coalesces concurrent first-open reads for the same document', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let reads = 0;
    const counted: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      read: async (ref) => {
        reads += 1;
        await Promise.resolve();
        return api.read(ref);
      },
    };
    const registry = new DocumentRegistry({ documents: counted, getGeneration: () => 1, recoverySessionId: 'session' });
    const [first, second, third] = await Promise.all([
      registry.open(identity),
      registry.open(identity),
      registry.open(identity),
    ]);
    expect(reads).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
    registry.dispose();
  });

  test('two views share one buffer and keep independent origins', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'from-a', { origin: 'view-a' });
    expect(registry.get(identity)?.buffer).toBe('from-a');
    expect(registry.get(identity)?.lastOrigin).toBe('view-a');
    registry.applyTransaction(identity, 'from-b', { origin: 'view-b' });
    expect(registry.get(identity)?.buffer).toBe('from-b');
    expect(registry.get(identity)?.lastOrigin).toBe('view-b');
    expect(registry.get(identity)?.dirty).toBe(true);
    registry.dispose();
  });

  test('applies incremental edits against one captured revision and advances it once', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'alpha beta gamma', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(identity);

    const result = registry.applyEdits(identity, {
      expectedLocalEditRevision: opened.localEditRevision,
      edits: [
        { from: 0, to: 5, insert: 'A' },
        { from: 11, to: 16, insert: 'G' },
      ],
      origin: 'monaco:view-a',
    });

    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.record.buffer).toBe('A beta G');
      expect(result.record.localEditRevision).toBe(opened.localEditRevision + 1);
      expect(result.record.lastChanges).toEqual([
        { from: 11, to: 16, insert: 'G' },
        { from: 0, to: 5, insert: 'A' },
      ]);
    }
    registry.dispose();
  });

  test('rejects stale and invalid incremental edits without mutating the buffer', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'abcdef', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(identity);
    registry.applyTransaction(identity, 'abcdef!', { origin: 'other-view' });

    const stale = registry.applyEdits(identity, {
      expectedLocalEditRevision: opened.localEditRevision,
      edits: [{ from: 0, to: 1, insert: 'A' }],
      origin: 'monaco:view-a',
    });
    expect(stale.status).toBe('stale');
    if (stale.status === 'stale') {
      expect(stale.actualLocalEditRevision).toBe(opened.localEditRevision + 1);
    }
    const current = registry.get(identity);
    if (!current) throw new Error('expected current document');
    const invalidRange = registry.applyEdits(identity, {
      expectedLocalEditRevision: current.localEditRevision,
      edits: [{ from: 2, to: 99, insert: '' }],
      origin: 'monaco:view-a',
    });
    expect(invalidRange.status).toBe('invalid');
    if (invalidRange.status === 'invalid') expect(invalidRange.reason).toBe('invalid-range');
    const overlapping = registry.applyEdits(identity, {
      expectedLocalEditRevision: current.localEditRevision,
      edits: [
        { from: 1, to: 4, insert: '' },
        { from: 3, to: 5, insert: '' },
      ],
      origin: 'monaco:view-a',
    });
    expect(overlapping.status).toBe('invalid');
    if (overlapping.status === 'invalid') expect(overlapping.reason).toBe('overlapping-ranges');
    expect(registry.get(identity)?.buffer).toBe('abcdef!');
    expect(registry.get(identity)?.localEditRevision).toBe(current.localEditRevision);
    registry.dispose();
  });

  test('keeps document instance identity across reload and move within a registry', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource('before.txt');
    const moved = resource('after.txt');
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let sequence = 0;
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      createDocumentInstanceId: () => `document-${++sequence}`,
    });
    const opened = await registry.open(identity);
    const reloaded = await registry.reload(identity);
    expect(reloaded.documentInstanceId).toBe(opened.documentInstanceId);

    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'moved', sequence: 1, from: identity, resource: moved });
    expect(registry.get(moved)?.documentInstanceId).toBe(opened.documentInstanceId);
    registry.dispose();
  });

  test('reloads clean documents and conflicts when dirty content differs', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'one', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    const initialVersion = registry.get(identity)?.localEditRevision;
    files.set(documentKey(identity), { content: 'two', revision: 'd1_external' });
    await registry.reload(identity);
    expect(registry.get(identity)?.buffer).toBe('two');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(registry.get(identity)?.localEditRevision).toBe((initialVersion ?? 0) + 1);
    expect(registry.get(identity)?.lastChanges).toEqual([{ from: 0, to: 3, insert: 'two' }]);
    registry.applyTransaction(identity, 'local', { origin: 'view' });
    files.set(documentKey(identity), { content: 'disk', revision: 'd1_later' });
    await registry.reload(identity);
    expect(registry.get(identity)?.status).toBe('conflict');
    expect(registry.get(identity)?.buffer).toBe('local');
    expect(registry.get(identity)?.conflict?.ancestorContent).toBe('two');
    expect(registry.get(identity)?.conflict?.diskContent).toBe('disk');
    registry.dispose();
  });

  test('save in flight keeps later edits dirty', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let releaseWrite: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseWrite = () => resolve();
    });
    const slow: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      write: async (request) => {
        await hold;
        return api.write(request);
      },
    };
    const registry = new DocumentRegistry({ documents: slow, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'first', { origin: 'view' });
    const saving = registry.save(identity);
    registry.applyTransaction(identity, 'second', { origin: 'view' });
    releaseWrite();
    const saved = await saving;
    expect(saved.buffer).toBe('second');
    expect(saved.dirty).toBe(true);
    registry.dispose();
  });

  test('repeated reloads preserve edits made during both retention and disk reads', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    files.set(documentKey(identity), { content: 'base', revision: 'd1_base' });
    type Gate = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
    let retentionGate: Gate | undefined;
    let readGate: Gate | undefined;
    const documents: DocumentsAPI = {
      ...api,
      setWorkspaceRetention: async ({ retained }) => {
        const gate = retentionGate;
        gate?.entered.resolve();
        await gate?.release.promise;
        return { retained };
      },
      read: async (ref) => {
        const result = await api.read(ref);
        const gate = readGate;
        gate?.entered.resolve();
        await gate?.release.promise;
        return result;
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, journalDebounceMs: 60_000 });
    try {
      const opened = await registry.open(identity);
      for (const cycle of [1, 2]) {
        retentionGate = { entered: deferred(), release: deferred() };
        readGate = { entered: deferred(), release: deferred() };
        files.set(documentKey(identity), { content: `disk ${cycle}`, revision: `d1_external_${cycle}` });
        const reloading = registry.reload(identity);
        await retentionGate.entered.promise;
        const duringRetention = registry.applyTransaction(identity, `retention edit ${cycle}`, { origin: 'view' });
        retentionGate.release.resolve();
        await readGate.entered.promise;
        expect(registry.get(identity)).toMatchObject({
          status: 'loading',
          buffer: duringRetention.buffer,
          localEditRevision: duringRetention.localEditRevision,
          documentInstanceId: opened.documentInstanceId,
        });
        const duringRead = registry.applyTransaction(identity, `read edit ${cycle}`, { origin: 'view' });
        readGate.release.resolve();
        expect(await reloading).toMatchObject({
          buffer: duringRead.buffer,
          localEditRevision: duringRead.localEditRevision,
          dirty: true,
          status: 'conflict',
          baseContent: `disk ${cycle}`,
          baseRevision: `d1_external_${cycle}`,
          conflict: { ancestorContent: 'base', ancestorRevision: 'd1_base', diskContent: `disk ${cycle}` },
        });
      }
    } finally {
      retentionGate?.release.resolve();
      readGate?.release.resolve();
      await registry.dispose();
    }
  });

  test.each(['dispose', 'generation-change'] as const)(
    '%s during retention prevents an old reload from publishing or reading',
    async (interruption) => {
      const { api, files } = createMemoryDocuments();
      const identity = resource();
      files.set(documentKey(identity), { content: 'base', revision: 'd1_base' });
      const entered = deferred();
      const release = deferred();
      let hold = false;
      let generation = 1;
      const read = vi.fn(api.read);
      const documents: DocumentsAPI = {
        ...api,
        read,
        setWorkspaceRetention: async ({ retained }) => {
          if (hold) { entered.resolve(); await release.promise; }
          return { retained };
        },
      };
      const registry = new DocumentRegistry({ documents, getGeneration: () => generation, journalDebounceMs: 60_000 });
      try {
        await registry.open(identity);
        hold = true;
        const reloading = registry.reload(identity);
        await entered.promise;
        const edited = registry.applyTransaction(identity, 'new input', { origin: 'view' });
        if (interruption === 'dispose') await registry.dispose();
        else generation += 1;
        release.resolve();
        await reloading;
        expect(read).toHaveBeenCalledTimes(1);
        if (interruption === 'dispose') expect(registry.get(identity)).toBeUndefined();
        else expect(registry.get(identity)).toBe(edited);
      } finally {
        release.resolve();
        await registry.dispose();
      }
    },
  );

  test('repeated save conflicts keep the latest edits and reconcile the final write receipt', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    files.set(documentKey(identity), { content: 'base', revision: 'd1_base' });
    let readGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
    const write = vi.fn(api.write);
    const documents: DocumentsAPI = {
      ...api,
      write,
      read: async (ref) => {
        const result = await api.read(ref);
        const gate = readGate;
        gate?.entered.resolve();
        await gate?.release.promise;
        return result;
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, journalDebounceMs: 60_000 });
    try {
      await registry.open(identity);
      registry.applyTransaction(identity, 'first edit', { origin: 'view' });
      for (const cycle of [1, 2]) {
        files.set(documentKey(identity), { content: `disk ${cycle}`, revision: `d1_external_${cycle}` });
        readGate = { entered: deferred(), release: deferred() };
        const saving = registry.save(identity, { overwriteConflict: true });
        await readGate.entered.promise;
        const edited = registry.applyTransaction(identity, `latest edit ${cycle}`, { origin: 'view' });
        expect((await registry.save(identity, { overwriteConflict: true })).saving).toBe(true);
        expect(write).toHaveBeenCalledTimes(cycle);
        readGate.release.resolve();
        expect(await saving).toMatchObject({
          buffer: edited.buffer,
          localEditRevision: edited.localEditRevision,
          dirty: true,
          saving: false,
          saveOperationId: null,
          saveCapturedEditRevision: null,
          status: 'conflict',
          baseContent: `disk ${cycle}`,
          baseRevision: `d1_external_${cycle}`,
          conflict: { ancestorContent: 'base', ancestorRevision: 'd1_base', diskContent: `disk ${cycle}` },
        });
      }
      const saved = await registry.save(identity, { overwriteConflict: true });
      const disk = await api.read(identity);
      expect(disk).toMatchObject({ status: 'ready', content: 'latest edit 2', revision: saved.baseRevision });
      expect(saved).toMatchObject({ buffer: 'latest edit 2', baseContent: 'latest edit 2', dirty: false, saving: false, conflict: null });
      expect(write.mock.calls.map(([request]) => request.expectedRevision)).toEqual(['d1_base', 'd1_external_1', 'd1_external_2']);
      expect(new Set(write.mock.calls.map(([request]) => request.operationId)).size).toBe(3);
    } finally {
      readGate?.release.resolve();
      await registry.dispose();
    }
  });

  test('a failed save-conflict read keeps edits and allows a later conflict retry', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    files.set(documentKey(identity), { content: 'base', revision: 'd1_base' });
    const entered = deferred();
    const release = deferred();
    let failRead = false;
    const documents: DocumentsAPI = {
      ...api,
      read: async (ref) => {
        if (failRead) { entered.resolve(); await release.promise; }
        return api.read(ref);
      },
    };
    const registry = new DocumentRegistry({ documents, getGeneration: () => 1, journalDebounceMs: 60_000 });
    try {
      await registry.open(identity);
      registry.applyTransaction(identity, 'first edit', { origin: 'view' });
      files.set(documentKey(identity), { content: 'disk', revision: 'd1_external' });
      failRead = true;
      const saving = registry.save(identity);
      await entered.promise;
      const edited = registry.applyTransaction(identity, 'newer edit', { origin: 'view' });
      const rejected = expect(saving).rejects.toThrow('read interrupted');
      release.reject(new Error('read interrupted'));
      await rejected;
      expect(registry.get(identity)).toMatchObject({
        buffer: edited.buffer, localEditRevision: edited.localEditRevision, dirty: true, saving: false,
        saveOperationId: null, saveCapturedEditRevision: null, errorMessage: 'read interrupted',
      });
      failRead = false;
      expect(await registry.save(identity)).toMatchObject({ buffer: edited.buffer, status: 'conflict', saving: false });
      expect(await registry.save(identity, { overwriteConflict: true })).toMatchObject({
        buffer: edited.buffer, baseContent: edited.buffer, dirty: false, saving: false,
      });
    } finally {
      release.resolve();
      await registry.dispose();
    }
  });

  test.each(['before-write', 'after-write'] as const)(
    'discard %s stays versioned and reconciles against the captured save bytes',
    async (phase) => {
      const { api, files, journals } = createMemoryDocuments();
      const identity = resource();
      files.set(documentKey(identity), { content: 'base\r\n', revision: 'd1_base' });
      const entered = deferred();
      const release = deferred();
      let hold = true;
      const write = vi.fn(async (request: Parameters<DocumentsAPI['write']>[0]) => {
        const paused = hold;
        if (paused && phase === 'before-write') { entered.resolve(); await release.promise; }
        const receipt = await api.write(request);
        if (paused && phase === 'after-write') { entered.resolve(); await release.promise; }
        return receipt;
      });
      const registry = new DocumentRegistry({ documents: { ...api, write }, getGeneration: () => 1, journalDebounceMs: 60_000 });
      try {
        await registry.open(identity);
        const edited = registry.applyTransaction(identity, 'saved edit\n', { origin: 'view' });
        const saving = registry.save(identity);
        await entered.promise;
        const discarded = registry.discard(identity)!;
        expect(discarded).toMatchObject({
          buffer: 'base\n', dirty: false, saving: true, localEditRevision: edited.localEditRevision + 1,
        });
        expect(registry.discard(identity)?.localEditRevision).toBe(discarded.localEditRevision);
        const staleEdit = registry.applyEdits(identity, {
          expectedLocalEditRevision: edited.localEditRevision,
          edits: [{ from: 0, to: 0, insert: 'stale' }],
          origin: 'stale-provider',
        });
        expect(staleEdit.status).toBe('stale');
        hold = false;
        release.resolve();
        const saved = await saving;
        expect(await api.read(identity)).toMatchObject({
          status: 'ready', content: 'saved edit\r\n', revision: saved.baseRevision,
        });
        expect(saved).toMatchObject({
          buffer: 'base\n', baseContent: 'saved edit\n', dirty: true, saving: false,
          localEditRevision: discarded.localEditRevision, saveOperationId: null, saveCapturedEditRevision: null,
        });
        expect(await registry.open(identity)).toMatchObject({ buffer: 'base\n', dirty: true, baseContent: 'saved edit\n' });
        await registry.flushRecoveryJournals();
        expect([...journals.values()]).toEqual([expect.objectContaining({
          content: 'base\r\n', baseRevision: saved.baseRevision,
        })]);
        const resaved = await registry.save(identity);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1]?.[0].expectedRevision).toBe(saved.baseRevision);
        expect(write.mock.calls[1]?.[0].operationId).not.toBe(write.mock.calls[0]?.[0].operationId);
        expect(await api.read(identity)).toMatchObject({ status: 'ready', content: 'base\r\n', revision: resaved.baseRevision });
        expect(resaved).toMatchObject({ buffer: 'base\n', baseContent: 'base\n', dirty: false, saving: false });
        expect(journals.size).toBe(0);
      } finally {
        release.resolve();
        await registry.dispose();
      }
    },
  );

  test('read failure preserves dirty buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'ok', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let failRead = false;
    const gated: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      read: async (ref) => {
        if (failRead) throw new Error('disk exploded');
        return api.read(ref);
      },
    };
    const registry = new DocumentRegistry({ documents: gated, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'draft', { origin: 'view' });
    failRead = true;
    const opened = await registry.open(identity, { reload: true });
    expect(opened.buffer).toBe('draft');
    expect(opened.dirty).toBe(true);
    registry.dispose();
  });

  test('deleted watch events keep dirty buffers and require explicit recreation', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'keep', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'kept', { origin: 'view' });
    files.delete(documentKey(identity));
    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'deleted', sequence: 1, resource: identity });
    expect(registry.get(identity)?.status).toBe('deleted');
    expect(registry.get(identity)?.buffer).toBe('kept');
    const blocked = await registry.save(identity);
    expect(blocked.status).toBe('deleted');
    expect(blocked.dirty).toBe(true);
    expect(files.has(documentKey(identity))).toBe(false);
    const saved = await registry.save(identity, { recreateDeleted: true });
    expect(saved.status).toBe('ready');
    expect(saved.dirty).toBe(false);
    expect(files.get(documentKey(identity))?.content).toBe('kept');
    registry.dispose();
  });

  test.each(['reset', 'invalidated'] as const)('%s events re-read open documents and preserve dirty conflicts', async kind => {
    const { api, files } = createMemoryDocuments();
    const clean = resource('folder/clean.txt');
    const dirty = resource('folder/dirty.txt');
    await api.write({ token: mutationToken(), resource: clean, content: 'one', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: dirty, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(clean);
    await registry.open(dirty);
    registry.applyTransaction(dirty, 'local', { origin: 'view' });
    files.set(documentKey(clean), { content: 'two', revision: 'external-clean' });
    files.set(documentKey(dirty), { content: 'disk', revision: 'external-dirty' });
    registry.handleWatchEvent(kind === 'reset'
      ? { sourceId: 'test', generation: 2, kind: 'reset', sequence: 1, reason: 'reconnected' }
      : { sourceId: 'test', generation: 1, kind: 'invalidated', sequence: 1, resource: resource('folder'), reason: 'entry-changed' }, clean.workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get(clean)?.buffer).toBe('two');
    expect(registry.get(dirty)?.buffer).toBe('local');
    expect(registry.get(dirty)?.status).toBe('conflict');
    registry.dispose();
  });

  test('dirty subscriptions only publish dirty-set membership changes', async () => {
    const { api, dirtyPublications, waitForDirtyPublication } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    let updates = 0;
    const unsubscribe = registry.subscribeDirty(identity.workspaceId, () => { updates += 1; });
    registry.applyTransaction(identity, 'first', { origin: 'view' });
    registry.applyTransaction(identity, 'second', { origin: 'view' });
    expect(updates).toBe(1);
    expect(registry.dirtyResourceIds(identity.workspaceId)).toEqual(new Set([identity.resourceId]));
    await waitForDirtyPublication((publication) => publication.resources[0]?.localEditRevision === 2);
    expect(dirtyPublications.at(-1)?.resources).toHaveLength(1);
    expect(dirtyPublications.at(-1)?.resources[0]?.resource).toEqual(identity);
    await registry.save(identity);
    expect(updates).toBe(2);
    await waitForDirtyPublication((publication) => publication.resources.length === 0);
    expect(dirtyPublications.at(-1)?.resources).toEqual([]);
    unsubscribe();
    registry.dispose();
  });

  test('publishes every dirty revision and fences affected edits during a Host barrier', async () => {
    const { api, barrierAcknowledged, barrierAcknowledgements, dirtyPublications, emit, waitForDirtyPublication } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'first edit', { origin: 'editor' });
    await waitForDirtyPublication((publication) => publication.resources[0]?.localEditRevision === 1);
    expect(dirtyPublications.at(-1)?.resources[0]?.localEditRevision).toBe(1);
    registry.applyTransaction(identity, 'second edit', { origin: 'editor' });
    await waitForDirtyPublication((publication) => publication.resources[0]?.localEditRevision === 2);
    expect(dirtyPublications.at(-1)?.resources[0]?.localEditRevision).toBe(2);

    emit({
      action: 'acquire',
      barrierId: 'barrier-1',
      caseSensitive: true,
      kind: 'dirty-state-barrier',
      paths: ['note.txt'],
      workspaceId: identity.workspaceId,
    });
    await barrierAcknowledged;
    expect(barrierAcknowledgements).toHaveLength(1);
    expect(barrierAcknowledgements[0]).toEqual({
      barrierId: 'barrier-1',
      generation: 1,
      ownerId: barrierAcknowledgements[0]?.ownerId,
      workspaceId: identity.workspaceId,
    });
    expect(barrierAcknowledgements[0]?.ownerId.startsWith('document-surface:session:')).toBe(true);
    expect(() => registry.applyTransaction(identity, 'blocked', { origin: 'editor' }))
      .toThrow('temporarily fenced');

    emit({
      action: 'release',
      barrierId: 'barrier-1',
      caseSensitive: true,
      kind: 'dirty-state-barrier',
      paths: ['note.txt'],
      workspaceId: identity.workspaceId,
    });
    expect(registry.applyTransaction(identity, 'allowed', { origin: 'editor' }).buffer).toBe('allowed');
    registry.dispose();
  });

  test.each([
    { name: 'workspace root', paths: ['.'], caseSensitive: true, affected: ['nested/note.txt', 'second.txt'], otherWorkspace: true },
    { name: 'normalized root', paths: ['.\\'], caseSensitive: false, affected: ['nested/note.txt', 'second.txt'], otherWorkspace: true },
    { name: 'exact parent inventory', paths: ['.\\Folder\\', 'Folder\\note.txt', 'folder/nested/second.txt', 'Folder/new.txt'], caseSensitive: false, affected: ['folder/note.txt', 'Folder/nested/second.txt'], otherWorkspace: false },
  ])('$name barriers finish pending journals and fence only their selected resources', async ({ paths, caseSensitive, affected, otherWorkspace }) => {
    const memory = createMemoryDocuments();
    const first = resource(affected[0]);
    const second = resource(affected[1]);
    const unrelated = ['folder/untouched.txt', 'folder-other/note.txt'].map(file => ({ ...resource(file), ...(otherWorkspace ? { workspaceId: 'another-workspace' } : {}) }));
    for (const ref of [first, second, ...unrelated]) memory.files.set(`${ref.workspaceId}\0${ref.resourceId}`, { content: 'base', revision: 'd1_base' });
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'barrier-journal' });
    const started = deferred(), finish = deferred();
    const write = memory.api.writeRecoveryJournal;
    const writes = vi.spyOn(memory.api, 'writeRecoveryJournal').mockImplementation(async request => {
      if (request.resource.resourceId === first.resourceId) { started.resolve(); await finish.promise; }
      return write(request);
    });
    const targetWrites = () => writes.mock.calls.filter(([request]) => request.resource.resourceId === first.resourceId);
    try {
      await Promise.all([first, second, ...unrelated].map(ref => registry.open(ref)));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      registry.applyTransaction(first, 'draft', { origin: 'editor' });
      memory.emit({ action: 'acquire', barrierId: 'source-barrier', caseSensitive, kind: 'dirty-state-barrier', paths, workspaceId: first.workspaceId });
      for (const ref of [first, second]) expect(() => registry.applyTransaction(ref, 'blocked', { origin: 'editor' })).toThrow('temporarily fenced');
      for (const ref of unrelated) expect(registry.applyTransaction(ref, 'unrelated', { origin: 'editor' }).buffer).toBe('unrelated');
      await started.promise;
      expect(memory.barrierAcknowledgements).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(750);
      expect(targetWrites()).toHaveLength(1);
      finish.resolve();
      await memory.barrierAcknowledged;
      expect([...memory.journals.values()].find(journal => journal.resource.resourceId === first.resourceId)?.content).toBe('draft');
      let opened = false;
      const opening = registry.open(resource('folder/new.txt')).then(record => { opened = true; return record; });
      await vi.advanceTimersByTimeAsync(750);
      expect(targetWrites()).toHaveLength(1);
      expect(opened).toBe(false);
      memory.emit({ action: 'release', barrierId: 'source-barrier', caseSensitive, kind: 'dirty-state-barrier', paths, workspaceId: first.workspaceId });
      expect((await opening).status).toBe('missing');
      registry.applyTransaction(first, 'later draft', { origin: 'editor' });
      await vi.advanceTimersByTimeAsync(750);
      expect(targetWrites()).toHaveLength(2);
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await registry.dispose();
    }
  });

  test('stale generation completions do not replace newer buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'v1', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let generation = 1;
    let finishRead: ((value: VarinDocumentReadResult) => void) | undefined;
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const gated: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      read: () => new Promise((resolve) => {
        finishRead = resolve;
        notifyReadStarted();
      }),
    };
    const registry = new DocumentRegistry({ documents: gated, getGeneration: () => generation, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;
    generation = 2;
    finishRead?.({
      status: 'ready',
      epoch: 1,
      resource: identity,
      revision: 'stale',
      content: 'old-host',
      encoding: 'utf-8',
      bom: false,
      byteLength: 8,
    });
    await pending;
    expect(registry.get(identity)?.buffer).not.toBe('old-host');
    registry.dispose();
  });

  test('restores a recovery journal into a dirty buffer without writing the file', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      journalDebounceMs: 0,
    });
    await registry.open(identity);
    registry.applyTransaction(identity, 'recovered', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const restored = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await restored.open(identity);
    expect(restored.get(identity)?.buffer).toBe('recovered');
    expect(restored.get(identity)?.dirty).toBe(true);
    expect(files.get(documentKey(identity))?.content).toBe('disk');
    registry.dispose();
    restored.dispose();
  });

  test('keeps a journal from an older workspace epoch as history instead of replaying it', async () => {
    const { api, files, setEpoch } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const first = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session', journalDebounceMs: 0 });
    await first.open(identity);
    first.applyTransaction(identity, 'old-epoch-draft', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.dispose();

    setEpoch(2);
    const restored = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await restored.open(identity);
    expect(restored.get(identity)?.buffer).toBe('disk');
    expect(restored.get(identity)?.dirty).toBe(false);
    expect(files.get(documentKey(identity))?.content).toBe('disk');
    restored.dispose();
  });

  test('does not replay a journal when the workspace epoch changes while it is being read', async () => {
    const { api, journals, setEpoch } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'old-epoch-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => 1, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;

    setEpoch(2);
    await registry.reload(identity);
    releaseJournal();
    await pending;

    expect(registry.get(identity)?.buffer).toBe('disk');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('does not replay a journal after the runtime generation changes while it is being read', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'stale-generation-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let generation = 1;
    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => generation, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;
    generation = 2;
    releaseJournal();
    await pending;

    expect(registry.get(identity)?.buffer).toBe('disk');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('does not replay a journal into a moved document identity after an asynchronous read', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    const moved = resource('renamed.txt');
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'moved-document-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
    ...unconfiguredWorkspaceEdits,
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => 1, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;
    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'moved', sequence: 1, from: identity, resource: moved });
    releaseJournal();
    await pending;

    expect(registry.get(identity)).toBeUndefined();
    expect(registry.get(moved)?.buffer).toBe('disk');
    expect(registry.get(moved)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('clears the current recovery revision after repeated journal writes', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      journalDebounceMs: 0,
    });
    await registry.open(identity);
    registry.applyTransaction(identity, 'draft-one', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    registry.applyTransaction(identity, 'draft-two', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...journals.values()][0]?.revision).toBe(2);
    await registry.save(identity);
    expect(journals.size).toBe(0);
    registry.dispose();
  });

  test('previews and atomically applies a multi-file workspace edit without writing disk', async () => {
    const { api, files } = createMemoryDocuments();
    const first = resource('first.ts');
    const second = resource('second.ts');
    await api.write({ token: mutationToken(), resource: first, content: 'const first = 1;\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: second, content: 'const second = first;\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(first);
    let listenerSawAtomicState = false;
    registry.subscribe(first, () => {
      listenerSawAtomicState = registry.get(second)?.buffer === 'const second = renamed;\n';
    });

    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: first.workspaceId,
      origin: 'language:rename',
      changes: [
        {
        kind: 'text',
        identity: first,
          version: opened.localEditRevision,
          edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: 'renamed' }],
        },
        {
        kind: 'text',
        identity: second,
          version: null,
          edits: [{ range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } }, newText: 'renamed' }],
        },
      ],
    });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw new Error('expected workspace edit preview');
    expect(preview.files.map((file) => file.identity.resourceId)).toEqual(['first.ts', 'second.ts']);
    expect(registry.get(first)?.buffer).toBe('const first = 1;\n');
    expect(registry.get(second)).toBeUndefined();

    const applied = await registry.applyWorkspaceEdit(preview.groupId);
    expect(applied.status).toBe('applied');
    expect(listenerSawAtomicState).toBe(true);
    expect(registry.get(first)?.buffer).toBe('const renamed = 1;\n');
    expect(registry.get(second)?.buffer).toBe('const second = renamed;\n');
    expect(files.get(documentKey(first))?.content).toBe('const first = 1;\n');
    expect(files.get(documentKey(second))?.content).toBe('const second = first;\n');

    const undone = await registry.undoWorkspaceEdit(preview.groupId);
    expect(undone.status).toBe('undone');
    expect(registry.get(first)?.buffer).toBe('const first = 1;\n');
    expect(registry.get(second)?.buffer).toBe('const second = first;\n');
    registry.dispose();
  });

  test('rejects a stale workspace edit without partially updating other files', async () => {
    const { api } = createMemoryDocuments();
    const first = resource('first.ts');
    const second = resource('second.ts');
    await api.write({ token: mutationToken(), resource: first, content: 'first\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: second, content: 'second\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const firstRecord = await registry.open(first);
    await registry.open(second);
    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: first.workspaceId,
      origin: 'language:rename',
      changes: [
        {
        kind: 'text',
        identity: first, version: firstRecord.localEditRevision, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'changed' }] },
        {
        kind: 'text',
        identity: second, version: 0, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'changed' }] },
      ],
    });
    if (preview.status !== 'ready') throw new Error('expected workspace edit preview');
    registry.applyTransaction(first, 'user edit\n', { origin: 'editor' });
    const result = await registry.applyWorkspaceEdit(preview.groupId);
    expect(result.status).toBe('rejected');
    expect(registry.get(first)?.buffer).toBe('user edit\n');
    expect(registry.get(second)?.buffer).toBe('second\n');
    registry.dispose();
  });

  test('rejects a prepared edit after the same path is reopened as a new document instance', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource('reopened.ts');
    const temporary = resource('moved-away.ts');
    await api.write({
      token: mutationToken(), resource: identity, content: 'same\n', encoding: 'utf-8', bom: false,
      expectedRevision: null, operationId: 'seed-reopened',
    });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const original = await registry.open(identity);
    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: identity.workspaceId,
      origin: 'thread-integration',
      groupId: 'reopened-operation',
      changes: [{
        identity,
        kind: 'text',
        version: original.localEditRevision,
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'next' }],
      }],
    });
    expect(preview.status).toBe('ready');

    registry.handleWatchEvent({
      sourceId: 'test', generation: 1, kind: 'moved', sequence: 1, from: identity, resource: temporary,
    });
    const reopened = await registry.open(identity);
    expect(reopened.buffer).toBe(original.buffer);
    expect(reopened.localEditRevision).toBe(original.localEditRevision);
    expect(reopened.documentInstanceId).not.toBe(original.documentInstanceId);

    const result = await registry.applyWorkspaceEdit('reopened-operation');
    expect(result.status).toBe('rejected');
    expect(registry.get(identity)?.buffer).toBe('same\n');
    registry.dispose();
  });

  test('keeps a caller-supplied workspace edit group id', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource('named.txt');
    await api.write({
      token: mutationToken(),
      resource: identity,
      content: 'before\n',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: 'seed-named',
    });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(identity);
    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: identity.workspaceId,
      origin: 'thread-integration',
      groupId: 'integration-op-named',
      changes: [{
        identity,
        kind: 'text',
        version: opened.localEditRevision,
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'after' }],
      }],
    });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw new Error('expected named group');
    expect(preview.groupId).toBe('integration-op-named');
    expect((await registry.applyWorkspaceEdit('integration-op-named')).status).toBe('applied');
    expect((await registry.undoWorkspaceEdit('integration-op-named')).status).toBe('undone');
    registry.dispose();
  });

  test('applies, retries, and undoes a Host surface operation without reopening or saving', async () => {
    const memory = createMemoryDocuments();
    const identity = resource('surface-operation.txt');
    await memory.api.write({
      token: mutationToken(), resource: identity, content: 'disk\n', encoding: 'utf-8', bom: false,
      expectedRevision: null, operationId: 'seed-surface-operation',
    });
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'unsaved\n', { origin: 'editor' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = registry.get(identity)!;
    const beforeHash = await hashText(before.buffer);
    const afterText = 'child\n';
    const afterHash = await hashText(afterText);
    const target = {
      resource: identity,
      documentInstanceId: before.documentInstanceId,
      baseRevision: before.baseRevision,
      localEditRevision: before.localEditRevision,
      bufferHash: beforeHash,
      encoding: before.encoding,
      bom: before.bom,
      lineEnding: before.lineEnding,
      newText: afterText,
    };
    const reportedErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unsubscribeThrowingObserver = registry.subscribe(identity, () => {
      throw new Error('observer failed after the buffer commit');
    });
    const dispatch = async (requestId: string, action: 'apply' | 'undo', extra: Record<string, unknown> = {}) => {
      const previousCompletions = memory.surfaceCompletions.length;
      memory.setSurfaceOperation({
        action,
        operationId: 'integration-surface-1',
        requestId,
        workspaceId: identity.workspaceId,
        targets: [{ ...target, ...extra }],
      });
      memory.emit({
        kind: 'surface-operation', action, operationId: 'integration-surface-1', requestId,
        workspaceId: identity.workspaceId,
      });
      for (let attempt = 0; attempt < 20 && memory.surfaceCompletions.length === previousCompletions; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    await dispatch('apply-1', 'apply');
    expect(memory.surfaceCompletions.at(-1)?.resources[0]?.status).toBe('applied');
    const applied = registry.get(identity)!;
    expect(applied.buffer).toBe(afterText);
    expect(memory.files.get(documentKey(identity))?.content).toBe('disk\n');

    const appliedRevision = applied.localEditRevision;
    await dispatch('apply-retry', 'apply');
    expect(memory.surfaceCompletions.at(-1)?.resources[0]?.status).toBe('applied');
    expect(registry.get(identity)?.localEditRevision).toBe(appliedRevision);

    await dispatch('undo-1', 'undo', {
      expectedAppliedRevision: appliedRevision,
      expectedAppliedHash: afterHash,
    });
    expect(memory.surfaceCompletions.at(-1)?.resources[0]?.status).toBe('undone');
    expect(registry.get(identity)?.buffer).toBe('unsaved\n');
    expect(memory.files.get(documentKey(identity))?.content).toBe('disk\n');
    expect(reportedErrors.mock.calls.length > 0).toBe(true);
    unsubscribeThrowingObserver();
    reportedErrors.mockRestore();
    registry.dispose();
  });

  test('applies and undoes two Host surface paths as one operation group', async () => {
    const memory = createMemoryDocuments();
    const first = resource('surface-group-a.txt');
    const second = resource('surface-group-b.txt');
    await memory.api.write({ token: mutationToken(), resource: first, content: 'disk-a\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: 'seed-group-a' });
    await memory.api.write({ token: mutationToken(), resource: second, content: 'disk-b\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: 'seed-group-b' });
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(first);
    await registry.open(second);
    registry.applyTransaction(first, 'draft-a\n', { origin: 'editor' });
    registry.applyTransaction(second, 'draft-b\n', { origin: 'editor' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const operationId = 'surface-group-operation';
    const makeTarget = async (identity: VarinResourceReference, nextText?: string) => {
      const record = registry.get(identity)!;
      return {
        resource: identity,
        documentInstanceId: record.documentInstanceId,
        baseRevision: record.baseRevision,
        localEditRevision: record.localEditRevision,
        bufferHash: await hashText(record.buffer),
        encoding: record.encoding,
        bom: record.bom,
        lineEnding: record.lineEnding,
        ...(nextText === undefined ? {} : { newText: nextText }),
      };
    };
    const applyTargets = [
      await makeTarget(first, 'applied-a\n'),
      await makeTarget(second, 'applied-b\n'),
    ];
    const dispatch = async (
      action: 'apply' | 'undo',
      targets: VarinDocumentSurfaceOperationPayload['targets'],
    ) => {
      const previous = memory.surfaceCompletions.length;
      memory.setSurfaceOperation({ action, operationId, requestId: `${action}-group`, workspaceId: first.workspaceId, targets });
      memory.emit({ kind: 'surface-operation', action, operationId, requestId: `${action}-group`, workspaceId: first.workspaceId });
      for (let attempt = 0; attempt < 20 && memory.surfaceCompletions.length === previous; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(memory.surfaceCompletions.length).toBeGreaterThan(previous);
      return memory.surfaceCompletions.at(-1)!;
    };

    const applied = await dispatch('apply', applyTargets);
    expect(applied.resources).toHaveLength(2);
    expect(applied.resources.every((entry) => entry.status === 'applied')).toBe(true);
    expect(registry.get(first)?.buffer).toBe('applied-a\n');
    expect(registry.get(second)?.buffer).toBe('applied-b\n');
    const undoTargets = await Promise.all([first, second].map(async (identity) => {
      const record = registry.get(identity)!;
      return {
        ...(await makeTarget(identity)),
        expectedAppliedRevision: record.localEditRevision,
        expectedAppliedHash: await hashText(record.buffer),
      };
    }));
    const undone = await dispatch('undo', undoTargets);
    expect(undone.resources).toHaveLength(2);
    expect(undone.resources.every((entry) => entry.status === 'undone')).toBe(true);
    expect(registry.get(first)?.buffer).toBe('draft-a\n');
    expect(registry.get(second)?.buffer).toBe('draft-b\n');
    registry.dispose();
  });
});


describe('Document Registry disk format state', () => {
  // These tests exercise the real Registry against a coordination port, not byte codecs.
  test('format-only changes participate in revision, dirty and conditional undo', async () => {
    const { api, files } = createMemoryDocuments(); const identity = resource();
    files.set(documentKey(identity), { content: 'plain', revision: 'base' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1 });
    try {
      const opened = await registry.open(identity);
      const changed = registry.setFormat(identity, { encoding: 'gbk' });
      expect(changed).toMatchObject({ buffer: 'plain', dirty: true, encoding: 'gbk', localEditRevision: opened.localEditRevision + 1 });
      expect(registry.applyEdits(identity, { expectedLocalEditRevision: opened.localEditRevision, edits: [{ from: 0, to: 0, insert: 'x' }], origin: 'stale' }).status).toBe('stale');
      expect(registry.undoFormat(identity)).toBe(true);
      expect(registry.get(identity)).toMatchObject({ encoding: 'utf-8', dirty: false, buffer: 'plain' });
    } finally { await registry.dispose(); }
  });

  test('a save receipt preserves a later format change and binds the original read format', async () => {
    const { api, files } = createMemoryDocuments(); const identity = resource();
    files.set(documentKey(identity), { content: 'plain', revision: 'base' });
    const release = deferred(); const captured: Parameters<DocumentsAPI['write']>[0][] = [];
    api.write = async request => { captured.push(request); await release.promise; return { status: 'written', revision: 'saved', byteLength: 5,
      format: { encoding: 'gbk', bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: 'explicit' } }; };
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1 });
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'gbk' });
      const saving = registry.save(identity); registry.setFormat(identity, { encoding: 'utf-16le', bom: true });
      release.resolve(); await saving;
      expect(captured[0]).toMatchObject({ encoding: 'gbk', sourceFormat: { encoding: 'utf-8' }, rememberEncoding: true, expectedRevision: 'base' });
      expect(registry.get(identity)).toMatchObject({ dirty: true, encoding: 'utf-16le', bom: true, baseFormat: { encoding: 'gbk', bom: false }, baseRevision: 'saved' });
    } finally { await registry.dispose(); }
  });

  test('format-only journals restore the desired format and retain the disk format', async () => {
    const { api, files } = createMemoryDocuments(); const identity = resource();
    files.set(documentKey(identity), { content: 'plain', revision: 'base' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'format-recovery' });
    await registry.open(identity); registry.setFormat(identity, { encoding: 'gbk' }); await registry.flushRecoveryJournals(); await registry.dispose();
    const recovered = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'format-recovery' });
    try { expect(await recovered.open(identity)).toMatchObject({ buffer: 'plain', dirty: true, encoding: 'gbk', baseFormat: { encoding: 'utf-8' } }); }
    finally { await recovered.dispose(); }
  });

  test('unrepresentable drafts remain editable and failed automatic save is revision scoped', async () => {
    const { api, files } = createMemoryDocuments(); const identity = resource();
    files.set(documentKey(identity), { content: 'plain', revision: 'base' });
    api.write = async () => { throw new DocumentsError('Cannot save this character as GBK', { reason: 'unrepresentable' }); };
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1 });
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'gbk' });
      const edited = registry.applyTransaction(identity, 'plain🙂', { origin: 'typing' });
      await expect(registry.save(identity)).rejects.toMatchObject({ reason: 'unrepresentable' });
      expect(registry.get(identity)).toMatchObject({ buffer: 'plain🙂', dirty: true, saveErrorRevision: edited.localEditRevision, saveErrorReason: 'unrepresentable' });
      const next = registry.applyTransaction(identity, 'plain', { origin: 'typing' });
      expect(next.localEditRevision).not.toBe(next.saveErrorRevision);
      const read = vi.spyOn(api, 'read'); await registry.reopenWithEncoding(identity, 'utf-8');
      expect(read).not.toHaveBeenCalled(); expect(registry.get(identity)?.buffer).toBe('plain');
    } finally { await registry.dispose(); }
  });
});

describe('Document Registry edit provenance and recovery', () => {
  const mixed: VarinTextFormat = { encoding: 'gbk', bom: false, lineEnding: 'mixed', defaultLineEnding: 'crlf', source: 'explicit' };
  const fixture = () => {
    const memory = createMemoryDocuments();
    const identity = resource('mixed.txt');
    memory.files.set(documentKey(identity), { content: 'old\r\nkeep\nlast\r', revision: 'base' });
    const read = memory.api.read;
    memory.api.read = async (...args) => { const result = await read(...args); return result.status === 'ready'
      ? { ...result, encoding: mixed.encoding, format: mixed } : result; };
    const writes: Parameters<DocumentsAPI['write']>[0][] = [];
    memory.api.write = async request => { writes.push(structuredClone(request)); return { status: 'written', revision: `saved-${writes.length}`, byteLength: 15, format: mixed }; };
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'provenance' });
    const edit = (from: number, to: number, insert: string, history?: 'undo' | 'redo') => registry.applyEdits(identity, {
      expectedLocalEditRevision: registry.get(identity)!.localEditRevision, edits: [{ from, to, insert }], origin: 'editor', history,
    });
    return { ...memory, identity, writes, registry, edit };
  };

  test('save sends all baseline-relative edits while keeping the untouched middle out of their ranges', async () => {
    const { registry, identity, edit, writes } = fixture();
    try {
      await registry.open(identity); edit(0, 3, 'newer'); edit(11, 15, 'tail'); edit(1, 3, 'EW');
      await registry.save(identity);
      expect(writes[0]).toMatchObject({ content: 'nEWer\nkeep\ntail\n', encoding: 'gbk', sourceFormat: mixed,
        edits: [{ start: 0, end: 3, text: 'nEWer' }, { start: 9, end: 13, text: 'tail' }] });
      expect(writes[0]?.lineEnding).toBeUndefined();
      expect(registry.get(identity)?.baseEdits).toEqual([]);
    } finally { await registry.dispose(); }
  });

  test('full buffer replacement does not invent untouched middle fragments', async () => {
    const { registry, identity, writes } = fixture();
    try {
      await registry.open(identity); registry.applyTransaction(identity, 'new\nkeep\ntail\n', { origin: 'replace' });
      await registry.save(identity);
      expect(writes[0]?.edits).toEqual([{ start: 0, end: 14, text: 'new\nkeep\ntail\n' }]);
    } finally { await registry.dispose(); }
  });

  test('undo and redo restore real edit provenance, and manual retyping does not undo format out of order', async () => {
    const { registry, identity, edit, writes } = fixture();
    try {
      await registry.open(identity); edit(0, 3, 'new'); registry.setFormat(identity, { encoding: 'utf-8' });
      edit(9, 13, 'tail'); edit(9, 13, 'last');
      expect(registry.undoFormat(identity)).toBe(false);
      edit(9, 13, 'tail', 'undo');
      expect(registry.undoFormat(identity)).toBe(false);
      edit(9, 13, 'last', 'undo');
      expect(registry.undoFormat(identity)).toBe(true);
      expect(registry.get(identity)?.baseEdits).toEqual([{ start: 0, end: 3, text: 'new' }]);
      edit(9, 13, 'tail', 'redo');
      await registry.save(identity);
      expect(writes[0]?.edits).toEqual([{ start: 0, end: 3, text: 'new' }, { start: 9, end: 13, text: 'tail' }]);
    } finally { await registry.dispose(); }
  });

  test('ordered workspace edits and batch undo preserve the draft provenance', async () => {
    const { registry, identity, edit } = fixture();
    try {
      await registry.open(identity); edit(0, 3, 'new');
      const prepared = await registry.prepareWorkspaceEdit({ workspaceId: identity.workspaceId, origin: 'agent', changes: [
        { kind: 'text', identity, version: null, edits: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: 'er' }] },
        { kind: 'text', identity, version: null, edits: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }, newText: 'tail' }] },
      ] });
      expect(prepared.status).toBe('ready'); if (prepared.status !== 'ready') return;
      await registry.applyWorkspaceEdit(prepared.groupId);
      expect(registry.get(identity)?.baseEdits).toEqual([{ start: 0, end: 3, text: 'newer' }, { start: 9, end: 13, text: 'tail' }]);
      expect((await registry.undoWorkspaceEdit(prepared.groupId)).status).toBe('undone');
      expect(registry.get(identity)?.baseEdits).toEqual([{ start: 0, end: 3, text: 'new' }]);
    } finally { await registry.dispose(); }
  });

  test('save receipt rebases edits made while the captured text is being saved', async () => {
    const { registry, api, identity, edit, writes } = fixture();
    const write = api.write, release = deferred();
    api.write = async request => { await release.promise; return write(request); };
    try {
      await registry.open(identity); edit(0, 3, 'newer'); const saving = registry.save(identity);
      edit(11, 15, 'tail'); release.resolve(); await saving;
      expect(registry.get(identity)?.baseEdits).toEqual([{ start: 11, end: 15, text: 'tail' }]);
      await registry.save(identity);
      expect(writes[1]).toMatchObject({ expectedRevision: 'saved-1', edits: [{ start: 11, end: 15, text: 'tail' }] });
    } finally { await registry.dispose(); }
  });

  test('recovery journals carry baseline edits and EOL conversion intent across Registry lifetimes', async () => {
    const { registry, api, identity, edit, writes } = fixture();
    await registry.open(identity); edit(0, 3, 'new'); edit(9, 13, 'tail');
    registry.setFormat(identity, { lineEnding: 'crlf' });
    await registry.flushRecoveryJournals(); await registry.dispose();
    const restored = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'provenance' });
    try {
      expect(await restored.open(identity)).toMatchObject({ normalizeLineEndings: true, baseFormat: mixed, dirty: true,
        baseEdits: [{ start: 0, end: 3, text: 'new' }, { start: 9, end: 13, text: 'tail' }] });
      await restored.save(identity);
      expect(writes[0]).toMatchObject({ lineEnding: 'crlf', sourceFormat: mixed });
    } finally { await restored.dispose(); }
  });

  test('Surface compensation restores format-only dirty state and the original EOL baseline', async () => {
    const memory = fixture(); const { registry, identity } = memory;
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8', lineEnding: 'crlf' });
      const before = registry.get(identity)!;
      registry.discard(identity);
      memory.emit({ kind: 'dirty-state-barrier', action: 'acquire', barrierId: 'restore-barrier', caseSensitive: true,
        paths: [identity.resourceId], workspaceId: identity.workspaceId });
      await memory.barrierAcknowledged;
      const current = registry.get(identity)!;
      memory.setSurfaceOperation({ action: 'restore', barrierId: 'restore-barrier', operationId: 'restore-format', requestId: 'restore-format-1', workspaceId: identity.workspaceId,
        targets: [{ resource: identity, documentInstanceId: current.documentInstanceId, baseRevision: current.baseRevision,
          localEditRevision: current.localEditRevision, bufferHash: await hashText(current.buffer), encoding: current.encoding, bom: current.bom,
          lineEnding: current.lineEnding, baseFormat: current.baseFormat, normalizeLineEndings: false, newText: before.buffer,
          restoreState: { baseContent: before.baseContent, baseRevision: before.baseRevision, baseFormat: before.baseFormat,
            encoding: before.encoding, bom: before.bom, lineEnding: before.lineEnding, normalizeLineEndings: before.normalizeLineEndings, edits: before.baseEdits } }] });
      memory.emit({ kind: 'surface-operation', action: 'restore', operationId: 'restore-format', requestId: 'restore-format-1', workspaceId: identity.workspaceId });
      await vi.waitFor(() => expect(memory.surfaceCompletions.at(-1)?.resources[0]?.status).toBe('restored'));
      expect(registry.get(identity)).toMatchObject({ buffer: before.buffer, dirty: true, encoding: 'utf-8', baseFormat: mixed, normalizeLineEndings: true });
      expect(registry.dirtyResourceIds(identity.workspaceId).has(identity.resourceId)).toBe(true);
    } finally {
      memory.emit({ kind: 'dirty-state-barrier', action: 'release', barrierId: 'restore-barrier', caseSensitive: true, paths: [identity.resourceId], workspaceId: identity.workspaceId });
      await registry.dispose();
    }
  });

  test('a pending conversion retries the identical operation before saving newer text', async () => {
    const { registry, api, identity, edit } = fixture();
    const calls: Parameters<DocumentsAPI['write']>[0][] = [];
    const receipts = new Map<string, Awaited<ReturnType<DocumentsAPI['write']>>>();
    let writes = 0;
    let preference = 'gbk';
    api.write = async request => {
      calls.push(structuredClone(request));
      if (!receipts.has(request.operationId)) {
        writes += 1;
        receipts.set(request.operationId, { status: 'written', revision: `written-${writes}`, byteLength: 15, format: { ...mixed, encoding: request.encoding } });
      }
      if (calls.length === 1) throw new DocumentsError('Preference persistence is temporarily unavailable', { reason: 'reconciliation-pending' });
      if (request.rememberEncoding) preference = request.encoding;
      return receipts.get(request.operationId)!;
    };
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8' });
      await expect(registry.save(identity)).rejects.toMatchObject({ reason: 'reconciliation-pending' });
      expect(registry.get(identity)?.saveOperationId).toBe(calls[0]?.operationId);
      edit(0, 3, 'new');
      await registry.save(identity);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toMatchObject({ expectedRevision: 'written-1', content: 'new\nkeep\nlast\n', edits: [{ start: 0, end: 3, text: 'new' }] });
      expect(writes).toBe(2); expect(preference).toBe('utf-8');
      expect(registry.get(identity)).toMatchObject({ dirty: false, status: 'ready', encoding: 'utf-8', baseRevision: 'written-2', saveOperationId: null });
    } finally { await registry.dispose(); }
  });
  test('restart reconciles the durable save intent once and preserves later unsaved text', async () => {
    const { registry, api, identity, edit, files, journals } = fixture();
    const calls: Parameters<DocumentsAPI['write']>[0][] = [];
    let written = false;
    let unavailable = true;
    api.write = async request => {
      calls.push(structuredClone(request));
      const journal = [...journals.values()][0];
      expect(journal?.pendingSave?.operationId).toBe(request.operationId);
      expect(journal?.pendingSave).not.toHaveProperty('token');
      if (!written) {
        written = true;
        files.set(documentKey(identity), { content: request.content, revision: 'converted' });
      }
      if (unavailable) throw new DocumentsError('Preference unavailable', { reason: 'reconciliation-pending' });
      return { status: 'written', revision: 'converted', byteLength: 14, format: { ...mixed, encoding: 'utf-8' } };
    };
    await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8' });
    await expect(registry.save(identity)).rejects.toMatchObject({ reason: 'reconciliation-pending' });
    edit(0, 3, 'newer'); edit(11, 15, 'tail');
    await registry.flushRecoveryJournals(); await registry.dispose();
    unavailable = false;
    // A successful Host read reconciles the persisted preference before decoding.
    const read = api.read; api.read = async (...args) => { const result = await read(...args); return result.status === 'ready'
      ? { ...result, encoding: 'utf-8', format: { ...mixed, encoding: 'utf-8' } } : result; };
    const reopened = new DocumentRegistry({ documents: api, getGeneration: () => 2, recoverySessionId: 'provenance' });
    try {
      expect(await reopened.open(identity)).toMatchObject({ status: 'ready', baseRevision: 'converted', encoding: 'utf-8', dirty: true,
        buffer: 'newer\nkeep\ntail\n', baseEdits: [{ start: 0, end: 3, text: 'newer' }, { start: 9, end: 13, text: 'tail' }] });
      expect(calls).toHaveLength(2);
      const { token: firstToken, ...first } = calls[0]!;
      const { token: resumedToken, ...resumed } = calls[1]!;
      expect(resumed).toEqual(first);
      expect(firstToken.owner.generation).toBe(1); expect(resumedToken.owner.generation).toBe(2);
      expect(files.get(documentKey(identity))?.content).toBe('old\nkeep\nlast\n');
    } finally { await reopened.dispose(); }
  });

  test('a conversion is not dispatched when its recovery intent cannot be persisted', async () => {
    const { registry, api, identity, edit, writes } = fixture();
    const journal = api.writeRecoveryJournal;
    api.writeRecoveryJournal = async () => { throw new Error('Recovery storage unavailable'); };
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8' }); edit(0, 3, 'new');
      await expect(registry.save(identity)).rejects.toThrow('Recovery storage unavailable');
      expect(writes).toHaveLength(0);
      expect(registry.get(identity)?.saveOperationId).toBeNull();
      api.writeRecoveryJournal = journal;
      await registry.save(identity);
      expect(writes).toHaveLength(1);
    } finally { api.writeRecoveryJournal = journal; await registry.dispose(); }
  });

  test('undo during an in-flight save restores captured byte provenance before later edits', async () => {
    const { registry, api, identity, edit, writes } = fixture();
    const write = api.write, release = deferred(); api.write = async request => { await release.promise; return write(request); };
    try {
      await registry.open(identity); registry.setFormat(identity, { bom: true, encoding: 'utf-8' });
      const saving = registry.save(identity);
      edit(0, 4, 'new\n'); edit(0, 4, 'old\n', 'undo'); edit(9, 13, 'tail');
      release.resolve(); await saving;
      expect(registry.get(identity)?.baseEdits).toEqual([{ start: 9, end: 13, text: 'tail' }]);
      await registry.save(identity);
      expect(writes[1]?.edits).toEqual([{ start: 9, end: 13, text: 'tail' }]);
    } finally { await registry.dispose(); }
  });

  test('saved mixed-EOL normalization is not falsely undone as a uniform default EOL', async () => {
    const { registry, api, identity } = fixture();
    api.write = async () => ({ status: 'written', revision: 'normalized', byteLength: 17,
      format: { ...mixed, lineEnding: 'crlf' } });
    try {
      await registry.open(identity); registry.setFormat(identity, { lineEnding: 'crlf' });
      await registry.save(identity);
      expect(registry.canUndoFormat(identity)).toBe(false);
      expect(registry.undoFormat(identity)).toBe(false);
      expect(registry.get(identity)).toMatchObject({ dirty: false, baseFormat: { lineEnding: 'crlf' } });
    } finally { await registry.dispose(); }
  });

  test('ordinary original-format saving remains available when journal storage is unavailable', async () => {
    const { registry, api, identity, edit, writes } = fixture();
    const journal = api.writeRecoveryJournal;
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.writeRecoveryJournal = async () => { throw new Error('Recovery storage unavailable'); };
    try {
      await registry.open(identity); edit(0, 3, 'new');
      expect(await registry.save(identity)).toMatchObject({ dirty: false, status: 'ready' });
      expect(writes).toHaveLength(1); expect(writes[0]?.rememberEncoding).toBeUndefined();
    } finally { api.writeRecoveryJournal = journal; await registry.dispose(); reported.mockRestore(); }
  });

  test('saved encoding and BOM conversions can still be undone against the new baseline', async () => {
    const { registry, api, identity } = fixture();
    api.write = async () => ({ status: 'written', revision: 'utf8-bom', byteLength: 20,
      format: { ...mixed, encoding: 'utf-8', bom: true } });
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8', bom: true });
      await registry.save(identity);
      expect(registry.canUndoFormat(identity)).toBe(true);
      expect(registry.undoFormat(identity)).toBe(true);
      expect(registry.get(identity)).toMatchObject({ encoding: 'gbk', bom: false, dirty: true,
        baseFormat: { encoding: 'utf-8', bom: true } });
      expect(registry.canUndoFormat(identity)).toBe(false);
    } finally { await registry.dispose(); }
  });

  test('creating an already-open missing file inherits the resolved project format and reloads it', async () => {
    const memory = createMemoryDocuments(); const identity = resource('new-file.txt');
    const read = memory.api.read, write = memory.api.write;
    memory.api.read = async (...args) => { const result = await read(...args); return result.status === 'missing' || result.status === 'ready'
      ? { ...result, encoding: 'gbk', bom: false, format: { ...mixed, lineEnding: 'none', defaultLineEnding: 'lf' } } : result; };
    const requests: Parameters<DocumentsAPI['write']>[0][] = [];
    memory.api.write = async request => { requests.push(request); return write(request); };
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1 });
    try {
      expect(await registry.open(identity)).toMatchObject({ status: 'missing', encoding: 'gbk' });
      expect(await registry.create(identity, '中文')).toMatchObject({ status: 'ready', buffer: '中文', dirty: false, encoding: 'gbk' });
      expect(requests[0]).toMatchObject({ encoding: 'gbk', bom: false, content: '中文', expectedRevision: null });
    } finally { await registry.dispose(); }
  });

  test('clears a completed conversion journal after Host preference reconciliation advances its revision', async () => {
    const { registry, api, identity, journals } = fixture();
    api.write = async () => {
      const journal = [...journals.values()][0]!;
      journal.revision += 1;
      return { status: 'written', revision: 'converted', byteLength: 14, format: { ...mixed, encoding: 'utf-8' } };
    };
    try {
      await registry.open(identity); registry.setFormat(identity, { encoding: 'utf-8' });
      expect(await registry.save(identity)).toMatchObject({ dirty: false, baseRevision: 'converted' });
      expect(journals.size).toBe(0);
      expect(registry.get(identity)?.recoveryJournalId).toBeNull();
    } finally { await registry.dispose(); }
  });

});

describe('Document Registry recovery interpretation', () => {
  test.each([true, false])('restores the original Unicode baseline after project encoding changes (stored edits: %s)', async (hasStoredEdits) => {
    const memory = createMemoryDocuments();
    const identity = resource('interpretation.txt');
    const bytes = Buffer.from('中文', 'utf8');
    const originalText = new TextDecoder('gbk', { fatal: true }).decode(bytes);
    let policy = 'gbk';
    const reads: Array<Parameters<DocumentsAPI['read']>[1]> = [];
    memory.api.read = async (resource, options) => {
      reads.push(options);
      const encoding = options?.encoding ?? policy;
      return { status: 'ready', resource, epoch: 1, revision: 'same-raw-revision',
        content: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding, bom: false, byteLength: bytes.length,
        format: { encoding, bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: options?.encoding ? 'explicit' : 'project' } };
    };
    const writes: Parameters<DocumentsAPI['write']>[0][] = [];
    memory.api.write = async request => {
      writes.push(request);
      // Coordination validation uses the actual original bytes and codec. Native
      // serializer tests separately cover byte output; this catches wrong offsets.
      let assembled = new TextDecoder(request.sourceFormat!.encoding, { fatal: true }).decode(bytes);
      for (const edit of [...request.edits!].reverse()) assembled = assembled.slice(0, edit.start) + edit.text + assembled.slice(edit.end);
      if (assembled !== request.content) throw new DocumentsError('Edits do not produce the supplied content', { reason: 'invalid-text' });
      return { status: 'written', revision: 'saved', byteLength: bytes.length + 1, format: request.sourceFormat };
    };
    const first = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'interpretation' });
    await first.open(identity);
    expect(originalText.length).toBe(3);
    first.applyEdits(identity, { expectedLocalEditRevision: first.get(identity)!.localEditRevision,
      edits: [{ from: originalText.length, to: originalText.length, insert: '!' }], origin: 'typing' });
    await first.flushRecoveryJournals(); await first.dispose();
    if (!hasStoredEdits) for (const journal of memory.journals.values()) delete journal.edits;
    policy = 'utf-8'; reads.length = 0;
    const restored = new DocumentRegistry({ documents: memory.api, getGeneration: () => 2, recoverySessionId: 'interpretation' });
    try {
      expect(await restored.open(identity)).toMatchObject({ baseContent: originalText, baseFormat: { encoding: 'gbk' },
        buffer: `${originalText}!`, encoding: 'gbk', dirty: true });
      expect(reads).toEqual([undefined, { encoding: 'gbk' }]);
      expect(await restored.save(identity)).toMatchObject({ dirty: false, baseRevision: 'saved' });
      expect(writes[0]).toMatchObject({ sourceFormat: { encoding: 'gbk' }, expectedRevision: 'same-raw-revision',
        edits: hasStoredEdits ? [{ start: 3, end: 3, text: '!' }] : [{ start: 0, end: 3, text: `${originalText}!` }] });
      expect(policy).toBe('utf-8');
    } finally { await restored.dispose(); }
  });

  test('does not install an old interpretation if raw bytes change during recovery', async () => {
    const memory = createMemoryDocuments(); const identity = resource('changed-recovery.txt');
    const originalFormat: VarinTextFormat = { encoding: 'gbk', bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: 'project' };
    await memory.api.writeRecoveryJournal({ token: mutationToken(), workspaceId: identity.workspaceId, recoverySessionId: 'changed-recovery', resource: identity,
      content: '涓\ue15f枃!', encoding: 'gbk', bom: false, sourceFormat: originalFormat, edits: [{ start: 3, end: 3, text: '!' }],
      baseRevision: 'old-raw', expectedRevision: null });
    memory.api.read = async (resource, options) => ({ status: 'ready', resource, epoch: 1, revision: options?.encoding ? 'new-raw' : 'old-raw',
      content: options?.encoding ? 'external' : '中文', encoding: options?.encoding ?? 'utf-8', bom: false, byteLength: 6,
      format: { ...originalFormat, encoding: options?.encoding ?? 'utf-8' } });
    const write = vi.spyOn(memory.api, 'write');
    const registry = new DocumentRegistry({ documents: memory.api, getGeneration: () => 1, recoverySessionId: 'changed-recovery' });
    try {
      expect(await registry.open(identity)).toMatchObject({ status: 'error', buffer: '中文', baseFormat: { encoding: 'utf-8' } });
      expect(registry.get(identity)?.errorMessage).toContain('baseline changed');
      expect([...memory.journals.values()][0]?.content).toBe('涓\ue15f枃!');
      expect(write).not.toHaveBeenCalled();
    } finally { await registry.dispose(); }
  });
});
