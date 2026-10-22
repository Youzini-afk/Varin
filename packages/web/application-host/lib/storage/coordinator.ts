import { randomUUID } from 'node:crypto';
import type { StorageCleanupPreview, StorageCleanupReceipt, StorageDevice, StorageScope, StorageTarget } from '@varin/application-client';
import { ManagedResponseError, type ManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import type { ManagedHostSourceOwner } from '../harness/managed-remote-types.js';
import { createStorageService, StorageServiceError } from './service.js';

type LocalStorage = ReturnType<typeof createStorageService>;
type RemoteStorage = Pick<ManagedRemoteTargetRegistry, 'storage' | 'storageTargets'>;
const REPLAY_MS = 24 * 60 * 60_000;
const sameScope = (a: StorageScope | undefined, b: StorageScope) => a?.kind === b.kind && (a.kind !== 'workspace' || (b.kind === 'workspace' && a.workspaceId === b.workspaceId));
const amount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const categoryIds = new Set(['recovery', 'copies', 'conversations', 'indexes', 'models', 'other']);
interface RemotePreview {
  principal: string; owner: ManagedHostSourceOwner; remoteId: string; preview: StorageCleanupPreview;
  acceptedAt?: number; completedAt?: number; selected?: string[]; running?: Promise<StorageCleanupReceipt>; receipt?: StorageCleanupReceipt;
}

export function parseStorageTarget(value: unknown): StorageTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageServiceError(400, 'invalid-target', 'Select a configured storage device');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof input.id !== 'string' || !input.id.startsWith('connection:') || !input.id.slice(11)
    || typeof input.hostId !== 'string' || !input.hostId || typeof input.endpointIdentity !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(input.endpointIdentity)) {
    throw new StorageServiceError(400, 'invalid-target', 'Select a configured storage device with a confirmed Host identity');
  }
  return { id: input.id, hostId: input.hostId, endpointIdentity: input.endpointIdentity };
}
const ownerOf = (target: StorageTarget): ManagedHostSourceOwner => ({ kind: 'managed_host', connectionId: target.id.slice('connection:'.length), hostId: target.hostId, endpointIdentity: target.endpointIdentity });
const remoteFailure = (error: unknown): never => {
  if (error instanceof StorageServiceError) throw error;
  if (error instanceof ManagedResponseError) throw new StorageServiceError(error.status && error.status >= 400 && error.status < 600 ? error.status : 502, typeof error.code === 'string' ? error.code : 'storage-unavailable', error.message);
  throw new StorageServiceError(503, 'storage-unavailable', error instanceof Error ? error.message : 'The original storage Host is unavailable');
};

/** Routes resource requests through the configured connection owner. This is
 * only a receipt/target coordinator; all measurements and effects stay at B. */
export function createStorageCoordinator(local: LocalStorage, remote: RemoteStorage) {
  const previews = new Map<string, RemotePreview>();
  const devices = async (signal?: AbortSignal): Promise<StorageDevice[]> => {
    const [configured, managed] = await Promise.all([local.devices(), remote.storageTargets(signal)]);
    return [...new Map([...configured, ...managed].map(device => [device.id, device])).values()];
  };
  const prune = () => {
    const now = Date.now();
    for (const [id, stored] of previews) {
      const deadline = stored.completedAt !== undefined ? stored.completedAt + REPLAY_MS : stored.acceptedAt !== undefined ? stored.acceptedAt + REPLAY_MS : Date.parse(stored.preview.expiresAt);
      if (!stored.running && deadline < now) previews.delete(id);
    }
  };
  const inventory = async (scope: StorageScope, signal?: AbortSignal, target?: StorageTarget) => {
    try {
      const [value, catalog] = await Promise.all([target ? remote.storage(ownerOf(target), 'inventory', { scope }, signal) : local.inventory(scope, signal), devices(signal)]);
      if (!value || !sameScope(value.scope, scope) || !amount(value.bytes) || !amount(value.hostBytes) || !amount(value.sharedBytes)
        || value.measurement !== 'logical-file-length' || typeof value.root !== 'string' || !date(value.scannedAt)
        || !Array.isArray(value.categories) || value.categories.some(category => !category || !categoryIds.has(category.id) || !amount(category.bytes))
        || new Set(value.categories.map(category => category.id)).size !== categoryIds.size || value.categories.reduce((sum, category) => sum + category.bytes, 0) !== value.bytes
        || !Array.isArray(value.workspaces) || value.workspaces.some(workspace => !workspace || typeof workspace.id !== 'string' || typeof workspace.name !== 'string' || typeof workspace.path !== 'string' || !amount(workspace.bytes))
        || !strings(value.issues) || !Array.isArray(value.volumes) || value.volumes.some(volume => !volume || typeof volume.path !== 'string'
          || !(volume.state === 'unavailable' && volume.totalBytes === null && volume.availableBytes === null) && !(volume.state === 'ready' && amount(volume.totalBytes) && amount(volume.availableBytes)))
        || !['ready', 'partial'].includes(value.state) || typeof value.canCleanup !== 'boolean'
        || (target && value.device?.id !== target.hostId)) throw new StorageServiceError(502, 'unconfirmed-inventory', 'The selected Host did not return a valid storage measurement');
      const device = target ? catalog.find(item => item.id === target.id && item.target?.hostId === target.hostId && item.target.endpointIdentity === target.endpointIdentity) : local.device;
      if (!device) throw new StorageServiceError(409, 'target-changed', 'The selected storage connection changed. Select the device again.');
      return { ...value, device, devices: catalog };
    } catch (error) { return remoteFailure(error); }
  };
  const preview = async (scope: StorageScope, principal: string, target?: StorageTarget): Promise<StorageCleanupPreview> => {
    if (!target) return local.preview(scope, principal);
    prune();
    try {
      const owner = ownerOf(target), original = await remote.storage(owner, 'preview', { scope });
      if (!original || original.deviceId !== owner.hostId || !sameScope(original.scope, scope) || typeof original.id !== 'string' || !original.id || !date(original.createdAt) || !date(original.expiresAt)
        || !Array.isArray(original.candidates) || original.candidates.some(item => !item || typeof item.id !== 'string' || !item.id || !['unreferenced-objects', 'retained-index', 'retired-code-model'].includes(item.kind) || typeof item.location !== 'string' || !amount(item.bytes) || !amount(item.count))
        || new Set(original.candidates.map(item => item.id)).size !== original.candidates.length || !strings(original.issues)) {
        throw new StorageServiceError(502, 'unconfirmed-preview', 'The selected Host did not confirm the requested cleanup scope');
      }
      const result = { ...original, id: randomUUID(), deviceId: target.id };
      previews.set(result.id, { owner, remoteId: original.id, principal, preview: result });
      return result;
    } catch (error) { return remoteFailure(error); }
  };
  const cleanup = async (previewId: string, candidateIds: string[], principal: string): Promise<StorageCleanupReceipt> => {
    const stored = previews.get(previewId);
    if (!stored) return local.cleanup(previewId, candidateIds, principal);
    if (stored.principal !== principal) throw new StorageServiceError(403, 'preview-owner-mismatch', 'This cleanup preview belongs to another authenticated client');
    if (!candidateIds.length || new Set(candidateIds).size !== candidateIds.length || candidateIds.some(id => !stored.preview.candidates.some(item => item.id === id))) throw new StorageServiceError(400, 'invalid-candidates', 'Select only items from this preview');
    const selected = [...candidateIds].sort();
    if (stored.selected && JSON.stringify(selected) !== JSON.stringify(stored.selected)) throw new StorageServiceError(409, 'selection-changed', 'This cleanup already has a different confirmed selection');
    if (stored.running) return stored.running;
    if ((stored.completedAt ?? stored.acceptedAt ?? Date.now()) + REPLAY_MS < Date.now()) {
      previews.delete(previewId);
      throw new StorageServiceError(409, 'receipt-expired', 'The cleanup replay window ended. Rescan without repeating this confirmation.');
    }
    if (stored.receipt) return stored.receipt;
    if (stored.acceptedAt === undefined && Date.parse(stored.preview.expiresAt) < Date.now()) throw new StorageServiceError(409, 'preview-expired', 'The cleanup preview expired. Inspect storage again.');
    stored.selected = selected; stored.acceptedAt ??= Date.now();
    stored.running = (async () => {
      try {
        // Re-resolves the original endpoint and Host, but never substitutes a new
        // target. A lost response retries this remote preview, never a new one.
        const receipt = await remote.storage(stored.owner, 'cleanup', { previewId: stored.remoteId, candidateIds: selected });
        if (!receipt || receipt.previewId !== stored.remoteId || !['complete', 'partial'].includes(receipt.state) || !amount(receipt.bytesReclaimed)
          || !amount(receipt.objectsDeleted) || !strings(receipt.completed) || receipt.completed.some(id => !selected.includes(id))
          || !Array.isArray(receipt.failures) || receipt.failures.some(failure => !failure || typeof failure.id !== 'string' || typeof failure.message !== 'string')) throw new StorageServiceError(502, 'unconfirmed-receipt', 'The target cleanup completion remains unconfirmed');
        stored.receipt = { ...receipt, previewId }; stored.completedAt = Date.now();
        return stored.receipt;
      } catch (error) { return remoteFailure(error); }
    })();
    try { return await stored.running; } finally { delete stored.running; }
  };
  return { inventory, preview, cleanup };
}
