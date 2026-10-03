import { afterEach, describe, expect, test } from 'vitest';
import type {
  DocumentsAPI,
  LanguageServicesAPI,
  VarinLanguageDocumentSyncRequest,
} from '@varin/application-client';
import { bindDocumentRegistry, resetDocumentRegistry } from '@/lib/documents/session';
import {
  acquireLanguageDocument,
  bindLanguageServices,
  flushLanguageDocumentSync,
  notifyLanguageDocumentChange,
  notifyLanguageDocumentSave,
  resetLanguageServices,
} from './session';

const identity = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId: 'incremental.ts',
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for language synchronization');
};

const createDocuments = (): DocumentsAPI => ({
  clearDirtyBuffers: async () => ({ cleared: true }),
  publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
  resolveWorkspace: async () => ({ workspaceId: identity.workspaceId, hostId: 'host', epoch: 1 }),
  resolveResourceIdentity: async (ref) => ({ coordinationId: `host\0${ref.workspaceId}\0${ref.resourceId}`, aliases: [ref] }),
  read: async (resource) => ({
    status: 'ready',
    epoch: 1,
    resource,
    revision: 'r1',
    content: 'abcdef',
    encoding: 'utf-8',
    bom: false,
    byteLength: 6,
  }),
  write: async (request) => ({ status: 'written', revision: 'r2', byteLength: request.content.length }),
  move: async (request) => ({ status: 'moved', resource: request.to, revision: 'r2', byteLength: 0 }),
  delete: async (request) => ({ status: 'deleted', resource: request.resource }),
  watch: () => ({ close() {} }),
  listRecoveryJournals: async () => [],
  readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
  writeRecoveryJournal: async () => ({ status: 'missing', journalId: 'missing' }),
  deleteRecoveryJournal: async () => ({ status: 'missing' }),
});

afterEach(() => {
  resetLanguageServices();
  resetDocumentRegistry();
});

describe('language document synchronization', () => {
  test('serializes open and incremental edits while preserving each captured revision', async () => {
    const requests: VarinLanguageDocumentSyncRequest[] = [];
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const language = {
      getStatus: async () => ({
        status: 'absent' as const,
        workspaceId: identity.workspaceId,
        languageId: 'typescript',
      }),
      subscribe: () => ({ close() {} }),
      syncDocument: async (request: VarinLanguageDocumentSyncRequest) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        requests.push(request);
        if (request.reason === 'open') await openGate;
        activeRequests -= 1;
        return {
          status: 'synced' as const,
          documentVersion: request.documentVersion,
          providerId: 'fixture',
          generation: 1,
        };
      },
      disposeWorkspace: async () => undefined,
    } as unknown as LanguageServicesAPI;

    const registry = bindDocumentRegistry(createDocuments());
    await registry.open(identity);
    bindLanguageServices(language);
    acquireLanguageDocument(identity);
    await waitUntil(() => requests.length === 1);

    registry.applyTransaction(identity, 'XbcdeY', {
      origin: 'editor',
      changes: [
        { from: 5, to: 6, insert: 'Y' },
        { from: 0, to: 1, insert: 'X' },
      ],
    });
    notifyLanguageDocumentChange(identity);
    registry.applyTransaction(identity, 'XbcdeYZ', {
      origin: 'editor',
      changes: [{ from: 6, to: 6, insert: 'Z' }],
    });
    notifyLanguageDocumentChange(identity);
    notifyLanguageDocumentSave(identity);

    releaseOpen?.();
    await flushLanguageDocumentSync(identity);
    expect(requests).toHaveLength(4);

    expect(maxActiveRequests).toBe(1);
    expect(requests.map((request) => request.documentVersion)).toEqual([0, 1, 2, 2]);
    expect({ reason: requests[0]?.reason, content: requests[0]?.content }).toEqual({
      reason: 'open',
      content: 'abcdef',
    });
    expect({ reason: requests[1]?.reason, changes: requests[1]?.changes }).toEqual({
      reason: 'change',
      changes: [
        { from: 5, to: 6, insert: 'Y' },
        { from: 0, to: 1, insert: 'X' },
      ],
    });
    expect(requests[1]?.content).toBeUndefined();
    expect({ reason: requests[2]?.reason, changes: requests[2]?.changes }).toEqual({
      reason: 'change',
      changes: [{ from: 6, to: 6, insert: 'Z' }],
    });
    expect({ reason: requests[3]?.reason, content: requests[3]?.content }).toEqual({
      reason: 'save',
      content: 'XbcdeYZ',
    });
  });

  test('reopens the current dirty buffer exactly once when the provider generation changes', async () => {
    const requests: VarinLanguageDocumentSyncRequest[] = [];
    let listener: Parameters<LanguageServicesAPI['subscribe']>[1] | undefined;
    let generation = 1;
    const language = {
      getStatus: async () => ({
        status: 'absent' as const,
        workspaceId: identity.workspaceId,
        languageId: 'typescript',
      }),
      subscribe: (_workspaceId: string, next: Parameters<LanguageServicesAPI['subscribe']>[1]) => {
        listener = next;
        return { close() {} };
      },
      syncDocument: async (request: VarinLanguageDocumentSyncRequest) => {
        requests.push(request);
        return {
          status: 'synced' as const,
          documentVersion: request.documentVersion,
          providerId: 'fixture',
          generation,
        };
      },
      disposeWorkspace: async () => undefined,
    } as unknown as LanguageServicesAPI;

    const registry = bindDocumentRegistry(createDocuments());
    await registry.open(identity);
    bindLanguageServices(language);
    acquireLanguageDocument(identity);
    await waitUntil(() => requests.length === 1);

    listener?.({
      kind: 'status',
      snapshot: {
        status: 'ready',
        workspaceId: identity.workspaceId,
        languageId: 'typescript',
        providerId: 'fixture',
        generation: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests).toHaveLength(1);

    registry.applyTransaction(identity, 'dirty buffer', { origin: 'editor' });
    generation = 2;
    listener?.({
      kind: 'status',
      snapshot: {
        status: 'ready',
        workspaceId: identity.workspaceId,
        languageId: 'typescript',
        providerId: 'fixture',
        generation: 2,
      },
    });
    await waitUntil(() => requests.length === 2);
    expect({
      reason: requests[1]?.reason,
      documentVersion: requests[1]?.documentVersion,
      content: requests[1]?.content,
    }).toEqual({
      reason: 'open',
      documentVersion: 1,
      content: 'dirty buffer',
    });
  });
});
