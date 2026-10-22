import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export type StorageCategoryId = 'recovery' | 'copies' | 'conversations' | 'indexes' | 'models' | 'other';
export type StorageScope = { kind: 'all' } | { kind: 'shared' } | { kind: 'workspace'; workspaceId: string };
export type StorageAvailability = 'ready' | 'offline' | 'restricted' | 'unsupported' | 'unavailable';
/** A selected configured connection, bound to its observed Host and mount identity. */
export interface StorageTarget { id: string; hostId: string; endpointIdentity: string }
export interface StorageDevice { id: string; name: string; current: boolean; state: StorageAvailability; detail?: string; target?: StorageTarget }
export interface StorageCategory { id: StorageCategoryId; bytes: number; }
export interface StorageWorkspace { id: string; name: string; path: string; bytes: number; }
export interface StorageInventory {
  device: StorageDevice;
  devices: StorageDevice[];
  scope: StorageScope;
  scannedAt: string;
  state: 'ready' | 'partial';
  canCleanup: boolean;
  measurement: 'logical-file-length';
  root: string;
  bytes: number;
  hostBytes: number;
  sharedBytes: number;
  categories: StorageCategory[];
  workspaces: StorageWorkspace[];
  issues: string[];
  volumes: Array<{ path: string; totalBytes: number | null; availableBytes: number | null; state: 'ready' | 'unavailable' }>;
}
export interface StorageCleanupCandidate {
  id: string;
  kind: 'unreferenced-objects' | 'retained-index' | 'retired-code-model';
  bytes: number;
  count: number;
  location: string;
}
export interface StorageCleanupPreview {
  id: string;
  deviceId: string;
  scope: StorageScope;
  createdAt: string;
  expiresAt: string;
  candidates: StorageCleanupCandidate[];
  issues: string[];
}
export interface StorageCleanupReceipt {
  previewId: string;
  state: 'complete' | 'partial';
  bytesReclaimed: number;
  objectsDeleted: number;
  completed: string[];
  failures: Array<{ id: string; message: string }>;
}
export class StorageRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'StorageRequestError'; }
}
/** A preview and its confirmation stay on the same authenticated Application Host. */
export function createStorageHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const request = async <T>(action: string, body: object, signal?: AbortSignal): Promise<T> => {
    const check = () => {
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new StorageRequestError(409, 'host-changed', 'Application Host changed. Scan storage again.');
    };
    check();
    const response = await runtimeFetch(`/api/storage/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    check();
    const value = await response.json();
    check();
    if (!response.ok) throw new StorageRequestError(response.status, value.code ?? 'storage-request-failed', value.error ?? 'Storage request failed');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid storage response');
    return value as T;
  };
  return {
    inventory: (scope: StorageScope, signal?: AbortSignal, target?: StorageTarget) => request<StorageInventory>('inventory', { scope, ...(target ? { target } : {}) }, signal),
    preview: (scope: StorageScope, signal?: AbortSignal, target?: StorageTarget) => request<StorageCleanupPreview>('preview', { scope, ...(target ? { target } : {}) }, signal),
    cleanup: (previewId: string, candidateIds: string[]) => request<StorageCleanupReceipt>('cleanup', { previewId, candidateIds }),
  };
}
