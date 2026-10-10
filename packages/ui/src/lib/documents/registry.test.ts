import { describe, expect, test } from 'vitest';
import { vi } from 'vitest';
import type {
  DocumentsAPI,
  VarinAgentInputSnapshotCaptureRequest,
  VarinDocumentReadResult,
  VarinDocumentRecoveryJournalSummary,
  VarinDocumentSurfaceOperationCompletion,
  VarinDocumentSurfaceOperationPayload,
  VarinDocumentWatchEvent,
  VarinResourceReference,
} from '@varin/application-client';
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
  const keyOf = (ref: VarinResourceReference) => {
    const alias = `${ref.workspaceId}\0${ref.resourceId}`;
    return coordinationOverrides.get(alias) ?? alias;
  };
  const nextRevision = () => `d1_${revisionSeq++}`;
  const emit = (event: VarinDocumentWatchEvent) => {
    for (const listener of listeners) listener(event);
  };

  const api: DocumentsAPI = {
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
    resolveResourceIdentity: async (ref) => ({
      coordinationId: `host-1\0${keyOf(ref)}`,
      aliases: [...coordinationOverrides.entries()].filter(([, physical]) => physical === keyOf(ref))
        .map(([alias]) => {
          const separator = alias.indexOf('\0');
          return { workspaceId: alias.slice(0, separator), resourceId: alias.slice(separator + 1) };
        }).concat(ref),
    }),
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
      files.set(key, { content: request.content, revision });
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
        encoding: 'utf-8',
        bom: false,
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
      const context = await registry.captureAgentInputContext('session-1');
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
      const context = await registry.captureAgentInputContext('two-root-session');
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

  test('verifies independent dirty files concurrently before sending a prompt', async () => {
    const memory = createMemoryDocuments();
    const first = { workspaceId: 'project-a', resourceId: 'a.txt' };
    const second = { workspaceId: 'project-b', resourceId: 'b.txt' };
    memory.files.set(`${first.workspaceId}\0${first.resourceId}`, { content: 'A', revision: 'd1_a' });
    memory.files.set(`${second.workspaceId}\0${second.resourceId}`, { content: 'B', revision: 'd1_b' });
    let delayIdentity = false;
    const releaseIdentity: Array<() => void> = [];
    const documents: DocumentsAPI = {
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
      const capture = registry.captureAgentInputContext('session-1');
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
      const childContext = await registry.captureAgentInputContext('child-session');
      expect(childContext.source).toBe('surface');
      if (childContext.source !== 'surface') throw new Error('Expected child draft');
      expect(childContext.roots).toEqual([
        { workspaceId: child.workspaceId, dirtyPaths: [child.resourceId] },
        { workspaceId: parent.workspaceId, dirtyPaths: [parent.resourceId] },
      ]);
      expect(captures[0]?.resources[0]?.resource).toEqual(child);
      const parentContext = await registry.captureAgentInputContext('parent-session');
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

    const captured = await registry.captureAgentInputContext('session-1');
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

  test('read failure preserves dirty buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'ok', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let failRead = false;
    const gated: DocumentsAPI = {
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

  test('stale generation completions do not replace newer buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'v1', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let generation = 1;
    let finishRead: ((value: VarinDocumentReadResult) => void) | undefined;
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const gated: DocumentsAPI = {
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
      textEdits: [
        {
          identity: first,
          version: opened.localEditRevision,
          edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: 'renamed' }],
        },
        {
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

    const undone = registry.undoWorkspaceEdit(preview.groupId);
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
      textEdits: [
        { identity: first, version: firstRecord.localEditRevision, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'changed' }] },
        { identity: second, version: 0, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'changed' }] },
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
      textEdits: [{
        identity,
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

  test('returns explicit unsupported for resource operations before changing documents', async () => {
    const { api } = createMemoryDocuments();
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const result = await registry.prepareWorkspaceEdit({
      workspaceId: resource().workspaceId,
      origin: 'language:code-action',
      textEdits: [],
      resourceOperations: [{ kind: 'create', identity: resource('created.ts') }],
    });
    expect(result).toEqual({
      status: 'rejected',
      failures: [{
        reason: 'resource-operation-unsupported',
        message: 'Workspace resource create, rename, and delete operations require a Host batch mutation contract',
      }],
    });
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
      textEdits: [{
        identity,
        version: opened.localEditRevision,
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'after' }],
      }],
    });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw new Error('expected named group');
    expect(preview.groupId).toBe('integration-op-named');
    expect((await registry.applyWorkspaceEdit('integration-op-named')).status).toBe('applied');
    expect(registry.undoWorkspaceEdit('integration-op-named').status).toBe('undone');
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
