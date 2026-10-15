import {
  toJsonValue,
  type CapabilityInvocationContext,
  type JsonCapabilityHandler,
} from '../extensions/json-value.js';

const METHODS = new Set<string>([
  'resolveWorkspace',
  'prepareWorkspaceEdit', 'discardWorkspaceEdit', 'applyWorkspaceEdit', 'readWorkspaceEdit', 'readWorkspaceEditRecovery', 'undoWorkspaceEdit', 'listWorkspaceEdits',
  'read',
  'write',
  'move',
  'delete',
  'listRecoveryJournals',
  'readRecoveryJournal',
  'writeRecoveryJournal',
  'deleteRecoveryJournal',
  'publishDirtyBuffers',
  'clearDirtyBuffers',
]);

const asRecord = (params: unknown): Record<string, unknown> | null => (
  params !== null && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : null
);

const asResource = (params: unknown): Record<string, unknown> | null => {
  const record = asRecord(params);
  if (!record) return null;
  const resource = record.resource;
  if (resource !== null && typeof resource === 'object' && !Array.isArray(resource)) {
    return resource as Record<string, unknown>;
  }
  if (typeof record.workspaceId === 'string' && typeof record.resourceId === 'string') return record;
  return null;
};

const bindCapabilityOwner = (
  record: Record<string, unknown>,
  context: CapabilityInvocationContext | undefined,
): Record<string, unknown> => {
  const owner = context?.owner;
  const token = record.token;
  if (!owner || !token || typeof token !== 'object' || Array.isArray(token)) return record;
  return {
    ...record,
    token: {
      ...token,
      owner: {
        kind: 'extension',
        id: `${owner.extensionId}:${owner.entrypointId}`,
        generation: owner.generation,
      },
    },
  };
};

export const createDocumentsCapabilityHandler =
  (authority: Record<string, unknown>): JsonCapabilityHandler =>
  async (method, params, context) => {
    const result = await (async (): Promise<unknown> => {
    if (!METHODS.has(method)) {
      throw new Error(`workspace.documents does not implement ${method}`);
    }
    if (method === 'resolveWorkspace') {
      return (authority.resolveWorkspace as (input: unknown) => Promise<unknown>)(asRecord(params) ?? {});
    }
    if (method === 'read') {
      const resource = asResource(params);
      if (!resource) throw new Error('workspace.documents.read requires a resource');
      return (authority.read as (resource: unknown) => Promise<unknown>)(resource);
    }
    if (method === 'readRecoveryJournal') {
      const journalId = typeof params === 'string' ? params : asRecord(params)?.journalId;
      if (typeof journalId !== 'string' || !journalId) {
        throw new Error('workspace.documents.readRecoveryJournal requires a journalId');
      }
      return (authority.readRecoveryJournal as (journalId: string) => Promise<unknown>)(journalId);
    }
    const record = asRecord(params);
    if (!record) throw new Error('workspace.documents expects an object');
    if (['prepareWorkspaceEdit', 'discardWorkspaceEdit', 'applyWorkspaceEdit', 'readWorkspaceEdit', 'readWorkspaceEditRecovery', 'undoWorkspaceEdit'].includes(method)) return (authority[method] as (request: unknown) => Promise<unknown>)(record);
    if (method === 'listWorkspaceEdits') return (authority.listWorkspaceEdits as (workspaceId: string) => Promise<unknown>)(String(record.workspaceId ?? ''));
    if (method === 'write') return (authority.write as (request: unknown) => Promise<unknown>)(bindCapabilityOwner(record, context));
    if (method === 'move') return (authority.move as (request: unknown) => Promise<unknown>)(bindCapabilityOwner(record, context));
    if (method === 'delete') return (authority.delete as (request: unknown) => Promise<unknown>)(bindCapabilityOwner(record, context));
    if (method === 'listRecoveryJournals') return (authority.listRecoveryJournals as (request: unknown) => Promise<unknown>)(record);
    if (method === 'writeRecoveryJournal') return (authority.writeRecoveryJournal as (request: unknown) => Promise<unknown>)(bindCapabilityOwner(record, context));
    if (method === 'deleteRecoveryJournal') return (authority.deleteRecoveryJournal as (request: unknown) => Promise<unknown>)(bindCapabilityOwner(record, context));
    if (method === 'publishDirtyBuffers' || method === 'clearDirtyBuffers') {
      const owner = context?.owner;
      const request = owner ? {
        ...record,
        generation: owner.generation,
        ownerId: `extension:${owner.extensionId}:${owner.entrypointId}`,
      } : record;
      return method === 'publishDirtyBuffers'
        ? (authority.publishDirtyBuffers as (request: unknown) => Promise<unknown>)(request)
        : (authority.clearDirtyBuffers as (request: unknown) => Promise<unknown>)(request);
    }
    throw new Error(`workspace.documents does not implement ${method}`);
    })();
    return toJsonValue(result);
  };
