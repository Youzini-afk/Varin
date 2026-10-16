import { randomUUID } from 'node:crypto';
import { lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { StorageCategoryId, StorageCleanupCandidate, StorageCleanupPreview, StorageCleanupReceipt, StorageDevice, StorageInventory, StorageScope } from '@varin/application-client';
import type { createSemanticIndexManagement } from '../knowledge/semantic/index-management.js';
import { measureDirectory, within } from './measure.js';

type IndexManagement = ReturnType<typeof createSemanticIndexManagement>;
interface Options {
  hostId: string; name: string; dataDirectory: string; speechModelsDirectory: string;
  workspaces(): Promise<Array<{ workspaceId: string; canonicalPath: string }>>;
  devices(): Promise<StorageDevice[]>;
  indexes: IndexManagement;
  kernel: {
    health(options: { gcPreview: true }): Promise<{ storageRoot: string; gcPreview?: { objects: Array<{ hash: string; byteLength: number }>; retainedObjects: number } }>;
    collectStorageObjects(operationId: string, hashes: string[]): Promise<Record<string, unknown>>;
  };
}
type Candidate = StorageCleanupCandidate & { hashes?: string[]; directory?: string; workspaceId?: string; fingerprint?: string; revision?: string };
const PREVIEW_LIFETIME_MS = 10 * 60_000;
// Completed effects remain replayable for a day after completion, independent of
// their admission deadline. Running operations are never evicted.
const RECEIPT_LIFETIME_MS = 24 * 60 * 60_000;
interface StoredPreview { completedAt?: number; principal: string; public: StorageCleanupPreview; candidates: Candidate[]; receipt?: StorageCleanupReceipt; running?: Promise<StorageCleanupReceipt>; selected?: string[] }
const categories: StorageCategoryId[] = ['recovery', 'copies', 'conversations', 'indexes', 'models', 'other'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export class StorageServiceError extends Error {
  constructor(readonly status: number, readonly code: string, text: string) { super(text); }
}
export function parseStorageScope(value: unknown): StorageScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageServiceError(400, 'invalid-scope', 'A storage scope is required');
  const input = value as Record<string, unknown>;
  if ((input.kind === 'all' || input.kind === 'shared') && Object.keys(input).length === 1) return { kind: input.kind };
  if (input.kind === 'workspace' && typeof input.workspaceId === 'string' && input.workspaceId && Object.keys(input).length === 2) return { kind: 'workspace', workspaceId: input.workspaceId };
  throw new StorageServiceError(400, 'invalid-scope', 'Invalid storage scope');
}
export function createStorageService(options: Options) {
  const previews = new Map<string, StoredPreview>();
  const device: StorageDevice = { id: options.hostId, name: options.name, current: true, state: 'ready' };
  const knownWorkspaces = async (scope: StorageScope) => {
    const registrations = await options.workspaces();
    if (scope.kind === 'workspace' && !registrations.some(item => item.workspaceId === scope.workspaceId)) throw new StorageServiceError(404, 'workspace-unavailable', 'Workspace registration is unavailable');
    return registrations;
  };
  const roots = async () => {
    const saved = await options.indexes.read();
    const indexes = [...new Set([options.indexes.activeDirectory(), ...saved.retainedDirectories])];
    const all = [...new Set([options.dataDirectory, options.speechModelsDirectory, ...indexes].map(value => path.resolve(value)))];
    // Nested roots are scanned once and classified by their most specific owner.
    return { saved, indexes, roots: all.filter(root => !all.some(other => other !== root && within(other, root))) };
  };
  const inventory = async (scope: StorageScope, signal?: AbortSignal): Promise<StorageInventory> => {
    const registrations = await knownWorkspaces(scope);
    const owned = await roots();
    const ids = new Set(registrations.map(item => item.workspaceId));
    const buckets = new Map<string, Map<StorageCategoryId, number>>();
    const shared = new Map<StorageCategoryId, number>();
    const physical = new Map<string, { bytes: number; category: StorageCategoryId; workspace?: string }>(), issues: string[] = [];
    if (owned.saved.error) issues.push(owned.saved.error);
    // Optional model/cache directories may not exist yet. The owning Host data
    // root is mandatory: losing it must never turn a whole-Host scan into zero.
    try {
      if (!(await lstat(options.dataDirectory)).isDirectory()) issues.push(`Managed application root is not a directory: ${options.dataDirectory}`);
    } catch (error) { issues.push(`${(error as NodeJS.ErrnoException).code ?? 'unavailable'}: managed application root ${options.dataDirectory}`); }
    const classify = (filename: string): { category: StorageCategoryId; workspace?: string } => {
      for (const root of owned.indexes) if (within(root, filename)) {
        const segments = path.relative(root, filename).split(path.sep);
        return { category: 'indexes', ...(segments[0] === 'workspace' && segments[1] !== undefined && ids.has(segments[1]) ? { workspace: segments[1] } : {}) };
      }
      if (within(options.speechModelsDirectory, filename) || within(path.join(options.dataDirectory, 'optional-components'), filename)) return { category: 'models' };
      const relative = path.relative(options.dataDirectory, filename).split(path.sep);
      if (relative[0] === 'kernel') {
        if (relative[2] === 'agent-runtime') return { category: 'conversations' };
        if (relative[2] === 'managed') return { category: 'copies' };
        return { category: 'recovery' };
      }
      if (relative[0] === 'worktrees') return { category: 'copies' };
      if (relative[0] === 'knowledge' && relative[1] === options.hostId) {
        const workspace = relative[2]?.replace(/\.tdb(?:[.-].*)?$/, '');
        return { category: 'other', ...(workspace !== undefined && ids.has(workspace) ? { workspace } : {}) };
      }
      return { category: 'other' };
    };
    for (const root of owned.roots) {
      const measured = await measureDirectory(root, signal);
      issues.push(...measured.issues);
      for (const file of measured.files) {
        const owner = classify(file.path);
        const previous = physical.get(file.identity);
        if (!previous) physical.set(file.identity, { bytes: file.bytes, ...owner });
        else {
          if (previous.bytes !== file.bytes) issues.push(`File changed during scan: ${file.path}`);
          if (previous.workspace !== owner.workspace) delete previous.workspace;
          if (previous.category !== owner.category) previous.category = 'other';
        }
      }
    }
    for (const item of physical.values()) {
      const bucket = item.workspace ? buckets.get(item.workspace) ?? new Map<StorageCategoryId, number>() : shared;
      bucket.set(item.category, (bucket.get(item.category) ?? 0) + item.bytes);
      if (item.workspace) buckets.set(item.workspace, bucket);
    }
    const total = (bucket: Map<StorageCategoryId, number>) => [...bucket.values()].reduce((sum, value) => sum + value, 0);
    const sharedBytes = total(shared), hostBytes = sharedBytes + [...buckets.values()].reduce((sum, bucket) => sum + total(bucket), 0);
    const selected = scope.kind === 'workspace' ? buckets.get(scope.workspaceId) ?? new Map() : new Map(shared);
    if (scope.kind === 'all') for (const bucket of buckets.values()) for (const [id, bytes] of bucket) selected.set(id, (selected.get(id) ?? 0) + bytes);
    const volumes: StorageInventory['volumes'] = [], devices = new Set<number>();
    for (const root of owned.roots) {
      try {
        const entry = await lstat(root);
        if (devices.has(entry.dev)) continue;
        devices.add(entry.dev);
        const volume = await statfs(root);
        volumes.push({ path: root, state: 'ready', totalBytes: volume.blocks * volume.bsize, availableBytes: volume.bavail * volume.bsize });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') volumes.push({ path: root, state: 'unavailable', totalBytes: null, availableBytes: null });
      }
    }
    if (!volumes.length) volumes.push({ path: options.dataDirectory, state: 'unavailable', totalBytes: null, availableBytes: null });
    return { canCleanup: true, device, devices: [device, ...await options.devices()], scope, scannedAt: new Date().toISOString(), state: issues.length ? 'partial' : 'ready', measurement: 'logical-file-length',
      root: options.dataDirectory, bytes: total(selected), hostBytes, sharedBytes, categories: categories.map(id => ({ id, bytes: selected.get(id) ?? 0 })),
      workspaces: registrations.map(item => ({ id: item.workspaceId, name: path.basename(item.canonicalPath) || item.canonicalPath, path: item.canonicalPath, bytes: total(buckets.get(item.workspaceId) ?? new Map()) })), issues, volumes };
  };
  const preview = async (scope: StorageScope, principal = 'host-session'): Promise<StorageCleanupPreview> => {
    await knownWorkspaces(scope);
    const now = Date.now();
    for (const [id, stored] of previews) if (!stored.running && (stored.receipt ? stored.completedAt !== undefined && stored.completedAt + RECEIPT_LIFETIME_MS < now : Date.parse(stored.public.expiresAt) < now)) previews.delete(id);
    const candidates: Candidate[] = [], issues: string[] = [];
    // Native objects are shared across all source/recovery owners. They must
    // never appear as workspace-exclusive bytes or a workspace cleanup action.
    if (scope.kind !== 'workspace') {
      try {
        const health = await options.kernel.health({ gcPreview: true });
        if (!health.gcPreview) issues.push('Native storage cleanup preview is unavailable');
        else if (health.gcPreview.objects.length) candidates.push({ id: randomUUID(), kind: 'unreferenced-objects',
          count: health.gcPreview.objects.length, bytes: health.gcPreview.objects.reduce((sum, item) => sum + item.byteLength, 0), location: health.storageRoot,
          hashes: health.gcPreview.objects.map(item => item.hash) });
      } catch (error) { issues.push(message(error)); }
    }
    try {
      const saved = await options.indexes.read();
      if (saved.error) issues.push(saved.error);
      else for (const directory of saved.retainedDirectories.filter(candidate => scope.kind !== 'all' || !saved.retainedDirectories.some(other => other !== candidate && within(other, candidate)))) {
        if (path.resolve(directory) === path.resolve(options.indexes.activeDirectory())) continue;
        // Shared selection must not accidentally delete workspace-exclusive caches.
        if (scope.kind === 'shared') continue;
        const workspaceId = scope.kind === 'workspace' ? scope.workspaceId : undefined;
        const target = workspaceId ? path.join(directory, 'workspace', workspaceId) : directory;
        const measured = await measureDirectory(target);
        if (measured.issues.length) { issues.push(...measured.issues); continue; }
        if (measured.bytes) candidates.push({ id: randomUUID(), kind: 'retained-index', location: target, bytes: measured.bytes, count: measured.files.length, directory, ...(workspaceId ? { workspaceId } : {}), fingerprint: measured.fingerprint, revision: saved.revision });
      }
    } catch (error) { issues.push(message(error)); }
    const result: StorageCleanupPreview = { id: randomUUID(), deviceId: device.id, scope, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PREVIEW_LIFETIME_MS).toISOString(), candidates: candidates.map(({ id, kind, location, bytes, count }) => ({ id, kind, location, bytes, count })), issues };
    previews.set(result.id, { principal, public: result, candidates });
    return result;
  };
  const cleanup = async (previewId: string, candidateIds: string[], principal = 'host-session'): Promise<StorageCleanupReceipt> => {
    const stored = previews.get(previewId);
    if (stored && stored.principal !== principal) throw new StorageServiceError(403, 'preview-owner-mismatch', 'This cleanup preview belongs to another authenticated client');
    if (!stored) throw new StorageServiceError(409, 'preview-expired', 'The cleanup preview expired. Inspect storage again.');
    if (stored.receipt && stored.completedAt !== undefined && stored.completedAt + RECEIPT_LIFETIME_MS < Date.now()) {
      previews.delete(previewId);
      throw new StorageServiceError(409, 'receipt-expired', 'The cleanup receipt replay window ended. Rescan; this confirmation will not be executed again.');
    }
    if (!candidateIds.length || new Set(candidateIds).size !== candidateIds.length || candidateIds.some(id => !stored.candidates.some(item => item.id === id))) throw new StorageServiceError(400, 'invalid-candidates', 'Select only items from this preview');
    const selected = [...candidateIds].sort();
    if (stored.selected && JSON.stringify(stored.selected) !== JSON.stringify(selected)) throw new StorageServiceError(409, 'selection-changed', 'This cleanup was already confirmed with a different selection');
    if (stored.receipt) return stored.receipt;
    if (stored.running) return stored.running;
    if (Date.parse(stored.public.expiresAt) < Date.now()) throw new StorageServiceError(409, 'preview-expired', 'The cleanup preview expired. Inspect storage again.');
    stored.selected = selected;
    stored.running = (async () => {
      const receipt: StorageCleanupReceipt = { previewId, state: 'complete', bytesReclaimed: 0, objectsDeleted: 0, completed: [], failures: [] };
      try { await knownWorkspaces(stored.public.scope); }
      catch (error) {
        receipt.state = 'partial'; receipt.failures.push({ id: 'scope', message: message(error) });
        stored.receipt = receipt; stored.completedAt = Date.now(); return receipt;
      }
      let indexRevision = stored.candidates.find(item => item.kind === 'retained-index')?.revision;
      for (const item of stored.candidates.filter(candidate => selected.includes(candidate.id))) {
        try {
          if (item.kind === 'unreferenced-objects') {
            const result = await options.kernel.collectStorageObjects(`settings-storage:${previewId}`, item.hashes!);
            const bytes = result.byteLengthReclaimed, count = result.deletedBlobs;
            if (typeof bytes !== 'number' || typeof count !== 'number' || !Array.isArray(result.cleanupFailures)) throw new Error('Native storage returned an incomplete cleanup receipt');
            receipt.bytesReclaimed += bytes; receipt.objectsDeleted += count;
            if (result.cleanupFailures.length) throw new Error(result.cleanupFailures.map(String).join('; '));
          } else {
            const result = await options.indexes.removeRetainedScope(item.directory!, indexRevision!, { ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), fingerprint: item.fingerprint! });
            receipt.bytesReclaimed += result.bytesReclaimed; receipt.objectsDeleted += result.filesDeleted; indexRevision = result.revision;
          }
          receipt.completed.push(item.id);
        } catch (error) { receipt.failures.push({ id: item.id, message: message(error) }); }
      }
      receipt.state = receipt.failures.length ? 'partial' : 'complete';
      stored.receipt = receipt; stored.completedAt = Date.now();
      return receipt;
    })();
    try { return await stored.running; } finally { delete stored.running; }
  };
  return { device, devices: async () => [device, ...await options.devices()], inventory, preview, cleanup };
}
