import { createHash, randomUUID } from 'node:crypto';
import type { SettingsActionOperationStore, SettingsServiceCaller } from './settings-service.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { KernelStorageContext } from '../kernel/storage-adapter.js';
import type { KernelStorageAdapter } from '../kernel/storage-adapter.js';

type OperationState = NonNullable<import('@varin/protocol').SettingsActionResult['operation']>['state'];

interface StoredOperation {
  id: string;
  threadId: string;
  branchId: string;
  entryId: string;
  verb: string;
  state: OperationState;
  detail?: string;
  cancelVerb?: string;
  createdAt: string;
  updatedAt: string;
}

const recordIdFor = (caller: SettingsServiceCaller, entryId: string, operationId: string): string => (
  `settings.operation:${createHash('sha256').update(`${caller.threadId}\0${caller.branchId}\0${entryId}\0${operationId}`).digest('hex')}`
);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const parse = (value: unknown): StoredOperation | null => {
  const row = asRecord(value);
  const state = row.state;
  if (typeof row.id !== 'string' || typeof row.threadId !== 'string' || typeof row.branchId !== 'string'
    || typeof row.entryId !== 'string' || typeof row.verb !== 'string'
    || (state !== 'running' && state !== 'succeeded' && state !== 'failed' && state !== 'cancelled' && state !== 'unavailable')
    || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') return null;
  return {
    id: row.id,
    threadId: row.threadId,
    branchId: row.branchId,
    entryId: row.entryId,
    verb: row.verb,
    state,
    ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    ...(typeof row.cancelVerb === 'string' ? { cancelVerb: row.cancelVerb } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const parsePayload = (value: string | undefined): unknown => {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
};

/**
 * Durable settings operation metadata on the existing Rust typed record port.
 * The kernel owns the `settings.operation` envelope; this store does not create
 * a second database or claim ownership of the domain action itself.
 */
export function createKernelSettingsActionOperationStore(options: {
  kernel: KernelClient;
  storage: KernelStorageAdapter;
  onCleanupError?(error: unknown): void;
}): SettingsActionOperationStore {
  // This namespace is only the existing typed-record partition, never a source,
  // registered workspace, path, grant from a renderer, or another database.
  const withRecords = async <T>(caller: SettingsServiceCaller, write: boolean, consume: (context: KernelStorageContext) => Promise<T>): Promise<T> => {
    if (!caller.threadId || !caller.branchId) throw new Error('Settings operations require an admitted native Thread/branch');
    const namespace = `thread-settings:${createHash('sha256').update(`${caller.threadId}\0${caller.branchId}`).digest('hex')}`;
    const grant = await options.kernel.issueGrant({ grantId: `settings-record:${randomUUID()}`, threadId: caller.threadId,
      owningWorkspace: namespace, executionWorkspace: namespace, pathScopes: [], capabilities: ['storage.read', ...(write ? ['storage.write'] : [])] });
    try {
      const context = await options.storage.contextFromBranchGrant({ grant, owningWorkspaceId: namespace, executionWorkspaceId: namespace });
      return await consume(context);
    } finally {
      try { await options.kernel.revokeGrant(grant.grantId); }
      catch (error) { try { if (options.onCleanupError) options.onCleanupError(error); else console.error('[Settings] Original record grant cleanup requires attention'); } catch { /* Keep the actual owner receipt. */ } }
    }
  };

  return {
    async get(caller, entryId, operationId) {
      return withRecords(caller, false, async context => {
        const record = await context.records.get(recordIdFor(caller, entryId, operationId));
        const parsed = parse(parsePayload(record?.payloadJson));
        if (!parsed || parsed.threadId !== caller.threadId || parsed.branchId !== caller.branchId) return null;
        return {
          id: parsed.id,
          entryId: parsed.entryId,
          verb: parsed.verb,
          state: parsed.state,
          ...(parsed.detail ? { detail: parsed.detail } : {}),
          ...(parsed.cancelVerb ? { cancelVerb: parsed.cancelVerb } : {}),
          ...(typeof record?.recordRevision === 'number' ? { recordRevision: record.recordRevision } : {}),
        };
      });
    },
    async available(caller) {
      try {
        return await withRecords(caller, false, async context => {
          await context.records.list({ recordType: 'settings.operation', threadId: caller.threadId, branchId: caller.branchId });
          return true;
        });
      } catch { return false; }
    },
    async put(caller, operation) {
      return withRecords(caller, true, async context => {
        const operationRecordId = recordIdFor(caller, operation.entryId, operation.id);
        const existing = await context.records.get(operationRecordId);
        const previous = parse(existing ? parsePayload(existing.payloadJson) : null);
        if (existing && !previous) throw new Error('Existing settings operation record is malformed; preserving it');
        if (previous && (previous.threadId !== caller.threadId || previous.branchId !== caller.branchId)) {
          throw new Error('settings operation belongs to a different Thread/branch');
        }
        const now = new Date().toISOString();
        const payload: StoredOperation = {
          id: operation.id,
          threadId: caller.threadId,
          branchId: caller.branchId,
          entryId: operation.entryId,
          verb: operation.verb,
          state: operation.state,
          ...(operation.detail ? { detail: operation.detail } : {}),
          ...(operation.cancelVerb ? { cancelVerb: operation.cancelVerb } : {}),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        await context.records.put({
          operationId: `settings-action-record:${randomUUID()}`,
          recordId: operationRecordId,
          recordType: 'settings.operation',
          state: operation.state,
          payloadJson: JSON.stringify(payload),
          threadId: caller.threadId,
          branchId: caller.branchId,
          ...(typeof existing?.recordRevision === 'number' ? { expectedRecordRevision: existing.recordRevision } : {}),
        });
      });
    },
  };
}
