import { isDeepStrictEqual } from 'node:util';
import type { VarinWorkspaceEditBuffer, VarinWorkspaceEditBufferSlot, VarinWorkspaceEditSurfaceChange, VarinWorkspaceEditSurfaceReceipt } from '@varin/application-client';
import { createWorkspaceEditCoordinator, WorkspaceEditSurfaceAppliedError, WorkspaceEditSurfaceRejectedError } from './workspace-edit.js';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbortError, waitWithSignal } from '../cancellation.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseAgentInputContext,
  parseAgentInputSnapshotConsumer,
  type AgentInputSnapshotConsumer,
  type AgentInputContext,
} from '@varin/protocol';
import { detectLineEnding, normalizeEditorLineEndings } from './line-ending.js';
import type { DurableFileOperationContext } from '../recovery/durable-file-operation.js';
import {
  canonicalizePathIdentity,
  normalizePathIdentity,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from '../workspace/path-safety.js';
import {
  DocumentAuthorityError,
  DocumentPathError,
  DocumentUntrustedError,
  DocumentWorkspaceUnavailableError,
  DocumentWorkspaceUnregisteredError,
  isDocumentAuthorityError,
} from './errors.js';
import { encodeDocumentText, inspectDocumentBytes, revisionFromBytes } from './inspect.js';
import { createWorkspaceMutationAuthority, type CaptureToken } from './mutation-authority.js';
import { createCaptureInventory } from './capture-inventory.js';
import {
  createRecoveryJournalStore,
  type RecoveryJournalDeleteRequest,
  type RecoveryJournalListRequest,
  type RecoveryJournalWriteRequest,
} from './recovery-journal.js';
import { createSerialQueues, type SerialQueueResource } from './serialize.js';
import {
  createWorkspaceWatcher,
  type WatchEvent,
  type WorkspaceWatcher,
  type WorkspaceWatchFs,
} from './watch.js';
import {
  createWorkspaceRegistry,
  looksLikeCanonicalWorkspaceId,
  looksLikeFilesystemWorkspaceScopeId,
  type WorkspaceMapping,
} from './workspace-registry.js';
import {
  createSurfaceSnapshotStore,
  type SurfaceSnapshotResource,
} from './surface-snapshot-store.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

export interface DocumentResourceOperation {
  resourceId: string;
  scope: 'exact' | 'subtree';
}

export interface MutationToken {
  workspaceId: string;
  epoch: number;
  owner: unknown;
}

export interface MutationOwner {
  kind: string;
  id: string;
  generation?: number | undefined;
}

interface DocumentWriter {
  owner: MutationOwner;
  markMutated: () => Promise<void>;
  close: () => Promise<void>;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

interface LoadedWorkspace extends WorkspaceMapping {
  root: string;
}

interface ResolveResourceResult {
  workspace: LoadedWorkspace;
  resolved: ResolvedWorkspacePath;
}

type SnapshotResult =
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'binary'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt: string }
  | { status: 'unsupported-encoding'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt: string; candidates?: string[] }
  | { status: 'ready'; resource: DocumentResource; revision: string; content: string; encoding: string; bom: boolean; byteLength: number; modifiedAt: string };

type SnapshotWithEpoch = SnapshotResult & { epoch: number };

type WithoutContentResult =
  | { status: 'ready'; epoch: number; resource: DocumentResource; revision: string; encoding: string; bom: boolean; byteLength: number; modifiedAt?: string }
  | Exclude<SnapshotWithEpoch, { status: 'ready' }>;

interface WriteRequest {
  resource: DocumentResource;
  token: MutationToken;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null;
  operationId?: string | undefined;
}

interface MoveRequest {
  from: DocumentResource;
  to: DocumentResource;
  token: MutationToken;
  expectedRevision: string;
  operationId?: string | undefined;
}

interface DeleteRequest {
  resource: DocumentResource;
  token: MutationToken;
  expectedRevision: string;
  operationId?: string | undefined;
}

interface ResolveWorkspaceInput {
  workspaceId?: string;
  path?: string;
}

export interface ResolveWorkspaceResult {
  workspaceId: string;
  hostId: string;
  epoch: number;
}

interface WatchSubscription {
  ready: Promise<boolean>;
  readonly position: import('./watch.js').WatchPosition | null;
  settle: () => Promise<void>;
  close: () => void;
}

interface WatcherRecord {
  listeners: Set<(event: WatchEvent) => void>;
  controller: WorkspaceWatcher | null;
  ready: Promise<WorkspaceWatcher | null> | null;
  inventory: ReturnType<typeof createCaptureInventory>;
  inventoryRetained: boolean;
}

interface CaptureWatch {
  subscription: WatchSubscription;
  controller: WorkspaceWatcher;
  inventory?: { record: WatcherRecord; candidate: Awaited<ReturnType<ReturnType<typeof createCaptureInventory>["prepare"]>> };
}

interface DirtySurfaceRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface DirtySurfaceRecord extends DirtySurfaceRequest {
  key: string;
  listener: (event: unknown) => void;
  registrationId: string;
}

interface DirtySurfaceSubscription {
  close: () => void;
}

export interface DirtyBufferResource {
  baseRevision: string | null;
  bufferHash?: string;
  documentInstanceId?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: 'lf' | 'crlf' | 'cr';
  localEditRevision: number;
  resource: DocumentResource;
}

interface DirtyBufferRecord {
  generation: number;
  ownerId: string;
  publicationRevision: number;
  resources: DirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

export interface DirtyBufferPublication {
  generation: number;
  ownerId: string;
  /** Present only while the matching owner/generation watch registration is live. */
  registrationId?: string;
  resources: DirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

export interface DocumentSurfaceBinding {
  baseRevision: string | null;
  bufferHash: string;
  documentInstanceId: string;
  encoding: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
  localEditRevision: number;
  resource: DocumentResource;
}

export interface DocumentSurfaceOperationTarget extends DocumentSurfaceBinding {
  newText?: string;
  expectedAppliedRevision?: number;
  expectedAppliedHash?: string;
  restoreState?: DocumentSurfaceRestoreState;
}

export interface DocumentSurfaceRestoreState {
  baseContent: string;
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
}

export interface DocumentSurfaceOperationRequest {
  workspaceEdit?: VarinWorkspaceEditSurfaceChange;
  action: 'capture' | 'apply' | 'undo' | 'restore' | 'workspace-edit';
  barrierId?: string;
  generation: number;
  operationId: string;
  ownerId: string;
  registrationId: string;
  targets: DocumentSurfaceOperationTarget[];
  workspaceId: string;
}

export interface DocumentSurfaceOperationResult {
  workspaceEditBuffer?: VarinWorkspaceEditBuffer | null;
  resource: DocumentResource;
  status: 'captured' | 'applied' | 'undone' | 'restored' | 'failed';
  documentInstanceId?: string;
  beforeLocalEditRevision?: number;
  beforeHash?: string;
  afterLocalEditRevision?: number;
  afterHash?: string;
  content?: string;
  baseContent?: string;
  message?: string;
}

interface PendingDocumentSurfaceOperation extends DocumentSurfaceOperationRequest {
  requestId: string;
  resolve: (results: DocumentSurfaceOperationResult[]) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface DirtyBarrierWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DirtyBarrier {
  barrierId: string;
  caseSensitive: boolean;
  paths: string[];
  pending: Set<string>;
  requiredPublications: Map<string, number>;
  released: boolean;
  cleanup?: () => void;
  surfaceKeys: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Set<DirtyBarrierWaiter>;
  workspaceId: string;
}

export interface DirtyStateBarrierHandle {
  barrierId: string;
  release: () => Promise<void>;
  settle: () => Promise<void>;
}

interface DirtyStateBarrierAckRequest {
  barrierId: string;
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface PublishDirtyBuffersRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
  resources: unknown[];
}

interface ClearDirtyBuffersRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface CaptureAgentInputSnapshotRequest {
  generation: number;
  ownerId: string;
  resources: unknown[];
  consumer: AgentInputSnapshotConsumer;
}

interface BeginDirtyStateBarrierOptions {
  caseSensitive?: boolean;
  signal?: AbortSignal | undefined;
}

interface JournalMutationRequest {
  workspaceId?: string;
  token?: MutationToken;
}

type StaleEpochResult = { status: 'stale-epoch'; currentEpoch: number | undefined };

export type DocumentReadResult = SnapshotWithEpoch;
export type DocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string | undefined }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;
export type DocumentMoveResult =
  | { status: 'moved'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt?: string | undefined }
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'target-exists'; resource: DocumentResource }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;
export type DocumentDeleteResult =
  | { status: 'deleted'; resource: DocumentResource }
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;

export interface DocumentAuthorityOptions {
  hostId: string;
  dataDir: string;
  fsPromises?: DocumentFsPromises;
  fsModule?: WorkspaceWatchFs;
  pathModule?: typeof path;
  processLike?: Pick<NodeJS.Process, 'pid' | 'platform' | 'kill'>;
  isTrusted?: (root: string) => Promise<boolean>;
  isAllowedRoot?: (root: string) => Promise<boolean>;
  onWorkspaceResolved?: (resolved: ResolveWorkspaceResult) => void;
  onMutation?: (event: DocumentMutationObservation) => void | Promise<void>;
  onIntegrationParentChanged?: (workspaceId: string, resourceIds?: readonly string[]) => void;
  maxReadBytes?: number;
  overflowLimit?: number;
  dirtyBarrierTimeoutMs?: number;
}

export type DurableMutationStorageFn = <T>(
  workspaceId: string,
  operation: (context: DurableFileOperationContext) => Promise<T> | T,
) => Promise<T>;

export interface DocumentMutationObservation {
  workspaceId: string;
  resourceId: string;
  kind: 'created' | 'modified' | 'deleted';
  owner: MutationOwner;
}

export type DocumentFsPromises = typeof fs.promises;

// ── Helpers ──────────────────────────────────────────────────────────────

const resourceKey = (
  hostId: string,
  canonicalPath: string,
  pathModule: typeof path,
  platform: string,
): string => `${hostId}\0${normalizePathIdentity(canonicalPath, { pathModule, platform }).replace(/\\/g, '/')}`;

const coordinationIdFor = (
  hostId: string,
  canonicalPath: string,
  pathModule: typeof path,
  platform: string,
): string => `document:${createHash('sha256').update(resourceKey(hostId, canonicalPath, pathModule, platform)).digest('base64url')}`;

const toIso = (mtimeMs: number): string => new Date(mtimeMs).toISOString();

const revisionFromObjectHash = (objectHash: string): string | null => {
  const match = /^sha256-([0-9a-f]{64})$/i.exec(objectHash);
  return match ? `d1_${Buffer.from(match[1]!, 'hex').toString('base64url')}` : null;
};

const withoutContent = (result: SnapshotWithEpoch): WithoutContentResult => {
  if (result.status === 'ready') {
    const next: WithoutContentResult = {
      status: 'ready',
      epoch: result.epoch,
      resource: result.resource,
      revision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      byteLength: result.byteLength,
    };
    if (result.modifiedAt) (next as { modifiedAt?: string }).modifiedAt = result.modifiedAt;
    return next;
  }
  return result;
};

// ── Factory ──────────────────────────────────────────────────────────────

export const createDocumentAuthority = (options: DocumentAuthorityOptions) => {
  const {
    hostId,
    dataDir,
    fsPromises = fs.promises,
    fsModule = fs,
    pathModule = path,
    processLike = process,
    isTrusted = async () => true,
    isAllowedRoot = async () => true,
    onWorkspaceResolved = () => undefined,
    onMutation = () => undefined,
    onIntegrationParentChanged = () => undefined,
    maxReadBytes = Number.POSITIVE_INFINITY,
    overflowLimit,
    dirtyBarrierTimeoutMs = 15_000,
  } = options;

  const registry = createWorkspaceRegistry({
    hostId,
    filePath: pathModule.join(dataDir, 'documents', 'workspaces.json'),
    fsPromises,
    pathModule,
  });
  const journals = createRecoveryJournalStore({
    rootDir: pathModule.join(dataDir, 'document-recovery'),
    hostId,
    fsPromises,
    pathModule,
  });
  const queues = createSerialQueues();
  // A recovery operation holds the same resource queue while it captures a
  // safety image and performs the conditional Documents write. Documents'
  // public write/delete methods enter this helper too, so remember the held
  // exact keys and let those nested calls execute inside the existing queue.
  const activeResourceKeys = new AsyncLocalStorage<ReadonlySet<string>>();
  const watchers = new Map<string, WatcherRecord>();
  const captureWatches = new Map<string, CaptureWatch>();
  const platform = typeof processLike?.platform === 'string' ? processLike.platform : process.platform;
  const dirtyBuffersByOwner = new Map<string, DirtyBufferRecord>();
  const dirtySurfaces = new Map<string, DirtySurfaceRecord>();
  const dirtyBarriers = new Map<string, DirtyBarrier>();
  const pendingSurfaceOperations = new Map<string, PendingDocumentSurfaceOperation>();
  let durableMutationStorage: DurableMutationStorageFn | null = null;
  const surfaceSnapshots = createSurfaceSnapshotStore({ caseSensitive: platform !== 'win32' });
  let dirtyPublicationRevision = 0;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const mutations = createWorkspaceMutationAuthority({
    dataDir,
    hostId,
    fsModule,
    fsPromises,
    pathModule,
    processLike,
  });

  const publishMutation = (event: DocumentMutationObservation): void => {
    onIntegrationParentChanged(event.workspaceId, [event.resourceId]);
    try {
      void Promise.resolve(onMutation({ ...event, owner: { ...event.owner } })).catch((error: unknown) => {
        console.warn(`[Documents] Mutation observer failed: ${(error as Error)?.message || error}`);
      });
    } catch (error) {
      console.warn(`[Documents] Mutation observer failed: ${(error as Error)?.message || error}`);
    }
  };

  /** Admits the original Host namespace without opening its former filesystem location.
   * This is registration/trust authority only, never a physical root or file capability. */
  const admitWorkspaceRegistration = async (workspaceId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const mapping = await waitWithSignal(registry.get(workspaceId), signal);
    if (!mapping || mapping.hostId !== hostId) throw new DocumentWorkspaceUnregisteredError();
    if (!await waitWithSignal(isTrusted(mapping.canonicalPath), signal)) throw new DocumentUntrustedError();
    signal?.throwIfAborted();
    return mapping;
  };

  const loadWorkspace = async (workspaceId: string): Promise<LoadedWorkspace> => {
    const mapping = await registry.get(workspaceId);
    if (!mapping) {
      throw new DocumentWorkspaceUnregisteredError();
    }
    let root: string;
    try {
      // A file root may address a file that does not exist yet; canonicalize
      // through its existing ancestors. Directory roots stay strict — an
      // unreachable root is an unavailable workspace, not an empty one.
      root = await canonicalizePathIdentity(mapping.canonicalPath, {
        allowMissing: mapping.kind === 'file',
        fsPromises,
        pathModule,
      });
    } catch (error) {
      throw new DocumentWorkspaceUnavailableError(undefined, { cause: error });
    }
    if (
      normalizePathIdentity(root, { pathModule, platform })
      !== normalizePathIdentity(mapping.canonicalPath, { pathModule, platform })
    ) {
      throw new DocumentUntrustedError('Workspace root identity changed');
    }
    if (!await isTrusted(root)) {
      throw new DocumentUntrustedError();
    }
    return { ...mapping, root };
  };

  const fail = (error: unknown): never => {
    if (isAbortError(error)) throw error;
    if (isDocumentAuthorityError(error)) throw error;
    if (error instanceof WorkspacePathError) {
      throw new DocumentPathError(
        error.message,
        error.statusCode && error.statusCode >= 500 ? error.statusCode : 403,
      );
    }
    throw new DocumentAuthorityError(error instanceof Error ? error.message : 'Document request failed', {
      code: 'failed',
      statusCode: 500,
    });
  };

  const resolveResourcePath = async (resource: DocumentResource, allowMissing = false, admittedWorkspace?: Promise<LoadedWorkspace>): Promise<ResolveResourceResult> => {
    const workspace = await (admittedWorkspace ?? loadWorkspace(resource.workspaceId));
    try {
      if (workspace.kind === 'file') {
        if (normalizeWorkspaceRelativePath(resource.resourceId) !== '') {
          throw new DocumentPathError('A file resource root addresses only that file');
        }
        // A new file has no existing ancestor inside its own file root. Resolve
        // through its actual parent rather than applying directory containment.
        const realPath = await canonicalizePathIdentity(workspace.root, { allowMissing, fsPromises, pathModule });
        if (normalizePathIdentity(realPath, { pathModule, platform }) !== normalizePathIdentity(workspace.root, { pathModule, platform })) {
          throw new DocumentPathError('File resource identity changed');
        }
        return { workspace, resolved: { relativePath: '', absolutePath: realPath } };
      }
      const resolved = await resolveWorkspacePath(resource.resourceId, {
        root: workspace.root,
        fsPromises,
        pathModule,
        allowMissing,
      });
      return { workspace, resolved };
    } catch (error) {
      return fail(error);
    }
    throw new DocumentPathError('Path is outside workspace');
  };

  type ResourceIdentity = { coordinationId: string; aliases: DocumentResource[] };
  function resolveResourceIdentity(resource: DocumentResource): Promise<ResourceIdentity>;
  function resolveResourceIdentity(resource: DocumentResource, options: { withinWorkspaceId: string }): Promise<ResourceIdentity | null>;
  async function resolveResourceIdentity(resource: DocumentResource, options?: { withinWorkspaceId: string }): Promise<ResourceIdentity | null> {
    if (options !== undefined) {
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => key !== 'withinWorkspaceId')
        || typeof options.withinWorkspaceId !== 'string' || !options.withinWorkspaceId) {
        throw new DocumentPathError('A selected workspace identity is required', 400);
      }
      const selected = await admitWorkspaceRegistration(options.withinWorkspaceId);
      const reference = await registry.get(resource.workspaceId);
      if (!reference || reference.hostId !== hostId) throw new DocumentWorkspaceUnregisteredError();
      try {
        const relative = normalizeWorkspaceRelativePath(resource.resourceId);
        if (reference.kind === 'file' && relative !== '') {
          throw new DocumentPathError('A file resource root addresses only that file');
        }
      } catch (error) { return fail(error); }
      const contains = (container: WorkspaceMapping, target: WorkspaceMapping): boolean => {
        const root = normalizePathIdentity(container.canonicalPath, { pathModule, platform });
        const candidate = normalizePathIdentity(target.canonicalPath, { pathModule, platform });
        if (root === candidate) return true;
        if (container.kind === 'file') return false;
        const relative = pathModule.relative(root, candidate);
        return Boolean(relative) && !pathModule.isAbsolute(relative)
          && relative !== '..' && !relative.startsWith(`..${pathModule.sep}`);
      };
      // Only the original registered root kinds and canonical paths can prove
      // disjointness. Overlapping roots still go through physical admission.
      if (!contains(selected, reference) && !contains(reference, selected)) return null;
    }
    const { resolved } = await resolveResourcePath(resource, true);
    const canonical = await canonicalizePathIdentity(resolved.absolutePath, {
      allowMissing: true, fsPromises, pathModule,
    }).catch((error) => fail(error));
    const aliases = new Map<string, DocumentResource>();
    const addAlias = (alias: DocumentResource): void => {
      aliases.set(`${alias.workspaceId}\0${alias.resourceId}`, alias);
    };
    addAlias(resource);
    for (const mapping of await registry.list()) {
      const candidateRelative = pathModule.relative(mapping.canonicalPath, canonical);
      const possibleAlias = mapping.kind === 'file'
        ? normalizePathIdentity(mapping.canonicalPath, { pathModule, platform })
          === normalizePathIdentity(canonical, { pathModule, platform })
        : Boolean(candidateRelative) && !pathModule.isAbsolute(candidateRelative)
          && candidateRelative !== '..' && !candidateRelative.startsWith(`..${pathModule.sep}`);
      if (!possibleAlias) continue;
      let workspace: LoadedWorkspace;
      try {
        workspace = await loadWorkspace(mapping.workspaceId);
      } catch (error) {
        if (mapping.workspaceId === options?.withinWorkspaceId) throw error;
        continue;
      }
      if (workspace.kind === 'file') {
        if (normalizePathIdentity(workspace.root, { pathModule, platform })
          === normalizePathIdentity(canonical, { pathModule, platform })) {
          addAlias({ workspaceId: workspace.workspaceId, resourceId: '' });
        }
        continue;
      }
      const relative = pathModule.relative(workspace.root, canonical);
      if (relative && !pathModule.isAbsolute(relative) && relative !== '..'
        && !relative.startsWith(`..${pathModule.sep}`)) {
        addAlias({ workspaceId: workspace.workspaceId, resourceId: relative.split(pathModule.sep).join('/') });
      }
    }
    return { coordinationId: coordinationIdFor(hostId, canonical, pathModule, platform), aliases: [...aliases.values()] };
  }

  const withResolvedResourceOperation = async <Result>(
    requests: ReadonlyArray<{ resource: DocumentResource; scope: 'exact' | 'subtree' }>,
    operation: (resolved: readonly ResolveResourceResult[]) => Promise<Result>,
    options: { signal?: AbortSignal; reportPhase?: (phase: string) => void } = {},
  ): Promise<Result> => {
    options.signal?.throwIfAborted();
    options.reportPhase?.('document:resolve');
    const workspaces = new Map<string, Promise<LoadedWorkspace>>();
    const resolved = await waitWithSignal(Promise.all(requests.map(({ resource }) => {
      let workspace = workspaces.get(resource.workspaceId);
      if (!workspace) { workspace = loadWorkspace(resource.workspaceId); workspaces.set(resource.workspaceId, workspace); }
      return resolveResourcePath(resource, true, workspace);
    })), options.signal);
    const canonicalPaths = await waitWithSignal(Promise.all(resolved.map((entry) => canonicalizePathIdentity(
      entry.resolved.absolutePath,
      { allowMissing: true, fsPromises, pathModule },
    ))), options.signal).catch((error) => fail(error));
    const queueResources: SerialQueueResource[] = resolved.map((_entry, index) => ({
      key: resourceKey(hostId, canonicalPaths[index]!, pathModule, platform),
      scope: requests[index]!.scope,
    }));
    const held = activeResourceKeys.getStore();
    const nested = held && queueResources.every((resource) => held.has(resource.key));
    // Production nesting must reach the kernel's directional lease coverage
    // check. Equal path keys do not make an exact lease a subtree lease.
    if (nested && !durableMutationStorage) return operation(resolved);

    const workspaceId = requests[0]?.resource.workspaceId;
    if (durableMutationStorage && workspaceId) {
      const storage = durableMutationStorage;
      if (requests.some((request) => request.resource.workspaceId !== workspaceId)) {
        throw new DocumentAuthorityError('One resource operation cannot span Documents workspaces', {
          code: 'failed',
          statusCode: 400,
        });
      }
      const keys = new Set(queueResources.map((resource) => resource.key));
      const execute = () => activeResourceKeys.run(keys, () => {
        options.signal?.throwIfAborted();
        options.reportPhase?.('document:storage');
        return storage(workspaceId, (context) => {
          options.signal?.throwIfAborted();
          options.reportPhase?.('document:lease');
          return context.resourceOperationGate.run(
            requests.map((request, index) => {
              const relative = pathModule.relative(resolved[index]!.workspace.root, canonicalPaths[index]!);
              if (pathModule.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathModule.sep}`)) {
                throw new DocumentPathError('Path is outside workspace');
              }
              return { resourceId: relative.split(pathModule.sep).join('/'), scope: request.scope };
            }),
            () => operation(resolved),
            options,
          );
        });
      });
      // The kernel lease is scoped to one Documents workspace. The host queue
      // joins aliases from overlapping workspace roots before entering it.
      options.reportPhase?.('document:queue');
      return nested ? execute() : queues.runResources(queueResources, execute, options.signal);
    }
    return queues.runResources(queueResources, () => activeResourceKeys.run(
      new Set(queueResources.map((resource) => resource.key)),
      () => operation(resolved),
    ), options.signal);
  };

  const runResourceOperation = <Result>(
    workspaceId: string,
    resources: readonly DocumentResourceOperation[],
    operation: () => Promise<Result>,
  ): Promise<Result> => withResolvedResourceOperation(
    resources.map((resource) => ({
      resource: { workspaceId, resourceId: resource.resourceId },
      scope: resource.scope,
    })),
    () => operation(),
  );

  const assertTokenWorkspace = (token: MutationToken | undefined, workspaceId: string | undefined): void => {
    if (!token || token.workspaceId !== workspaceId) {
      throw new DocumentAuthorityError('Workspace mutation token does not match the target workspace', {
        code: 'failed',
        statusCode: 400,
      });
    }
  };

  const snapshotFile = async (resource: DocumentResource, absolutePath: string, signal?: AbortSignal): Promise<SnapshotResult> => {
    signal?.throwIfAborted();
    let stat: import('node:fs').Stats;
    try {
      stat = await fsPromises.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing', resource };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let real: string;
      try {
        real = await fsPromises.realpath(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing', resource };
        throw error;
      }
      const workspace = await loadWorkspace(resource.workspaceId);
      const relative = pathModule.relative(workspace.root, real);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
        throw new DocumentPathError('Path is outside workspace');
      }
      stat = await fsPromises.stat(real);
      absolutePath = real;
    }
    if (stat.isDirectory()) {
      throw new DocumentPathError('Path is not a file', 400);
    }
    if (stat.size > maxReadBytes) {
      throw new DocumentAuthorityError('Document is too large to read', { code: 'failed', statusCode: 413 });
    }
    const bytes = await fsPromises.readFile(absolutePath, { signal });
    const revision = revisionFromBytes(bytes);
    const inspected = inspectDocumentBytes(bytes);
    const modifiedAt = toIso(stat.mtimeMs);
    if (inspected.kind === 'binary') {
      return {
        status: 'binary',
        resource,
        revision,
        byteLength: inspected.byteLength,
        modifiedAt,
      };
    }
    if (inspected.kind === 'unsupported-encoding') {
      const result: SnapshotResult = {
        status: 'unsupported-encoding',
        resource,
        revision,
        byteLength: inspected.byteLength,
        modifiedAt,
      };
      if (inspected.candidates) (result as { candidates?: string[] }).candidates = inspected.candidates;
      return result;
    }
    return {
      status: 'ready',
      resource,
      revision,
      content: inspected.content,
      encoding: inspected.encoding,
      bom: inspected.bom,
      byteLength: inspected.byteLength,
      modifiedAt,
    };
  };

  const atomicReplace = async (absolutePath: string, bytes: Uint8Array): Promise<void> => {
    await fsPromises.mkdir(pathModule.dirname(absolutePath), { recursive: true });
    const tmp = `${absolutePath}.varin-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, bytes);
      await fsPromises.rename(tmp, absolutePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  // Shared directory admission for explicit registration and read-only metadata lookup.
  const admitWorkspaceDirectory = async (value: unknown): Promise<string> => {
    const rawPath = typeof value === 'string' ? value.trim() : '';
    if (!rawPath) {
      throw new DocumentAuthorityError('Workspace path is required', { code: 'failed', statusCode: 400 });
    }
    let canonicalPath: string;
    try {
      canonicalPath = await canonicalizePathIdentity(rawPath, { fsPromises, pathModule });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new DocumentAuthorityError('Workspace path does not exist', { code: 'failed', statusCode: 404 });
      }
      throw error;
    }
    const stat = await fsPromises.stat(canonicalPath);
    if (!stat.isDirectory()) {
      throw new DocumentPathError('Workspace path is not a directory', 400);
    }
    if (!await isAllowedRoot(canonicalPath)) {
      throw new DocumentPathError(`Workspace path is outside the Host deployment boundary: ${canonicalPath}`);
    }
    return canonicalPath;
  };

  /** Read the existing namespace without registering a workspace or publishing an epoch. */
  const lookupWorkspacePath = async (value: unknown): Promise<{ canonicalPath: string; workspaceId: string | null }> => {
    try {
      const canonicalPath = await admitWorkspaceDirectory(value);
      if (!await isTrusted(canonicalPath)) throw new DocumentUntrustedError();
      const mapping = await registry.findExact(canonicalPath, 'directory');
      return { canonicalPath, workspaceId: mapping?.workspaceId ?? null };
    } catch (error) {
      return fail(error);
    }
  };

  const resolveWorkspace = async (input: ResolveWorkspaceInput = {}): Promise<ResolveWorkspaceResult> => {
    try {
      if (input.workspaceId) {
        const mapping = await registry.get(input.workspaceId);
        if (!mapping) {
          throw new DocumentAuthorityError('Workspace is not registered on this application host', {
            code: 'failed',
            statusCode: 404,
          });
        }
        const mutation = await mutations.inspect(mapping.workspaceId);
        return { workspaceId: mapping.workspaceId, hostId, epoch: mutation.epoch };
      }
      const canonicalPath = await admitWorkspaceDirectory(input.path);
      const mapping = await registry.resolve({ canonicalPath, create: true });
      if (!mapping) throw new DocumentAuthorityError('Workspace resolution failed', { code: 'failed', statusCode: 500 });
      const mutation = await mutations.inspect(mapping.workspaceId);
      const resolved = { workspaceId: mapping.workspaceId, hostId, epoch: mutation.epoch };
      void Promise.resolve().then(() => onWorkspaceResolved(resolved)).catch((error: unknown) => {
        console.warn(`[Documents] Workspace resolution observer failed: ${(error as Error)?.message || error}`);
      });
      return resolved;
    } catch (error) {
      return fail(error);
    }
    throw new DocumentAuthorityError('Workspace resolution failed', { code: 'failed', statusCode: 500 });
  };

  const resolveScopeId = async (scopeId: unknown): Promise<string | null> => {
    if (looksLikeCanonicalWorkspaceId(scopeId)) {
      const mapping = await registry.get(scopeId);
      return mapping ? mapping.workspaceId : null;
    }
    if (!looksLikeFilesystemWorkspaceScopeId(scopeId)) return null;
    try {
      const canonicalPath = await canonicalizePathIdentity(scopeId as string, {
        allowMissing: true,
        fsPromises,
        pathModule,
      });
      const containing = await registry.findContaining(canonicalPath);
      if (containing) return containing.workspaceId;
      await fsPromises.stat(canonicalPath);
      if (!await isAllowedRoot(canonicalPath)) return null;
      const mapping = await registry.resolve({ canonicalPath, create: true });
      return mapping?.workspaceId ?? null;
    } catch {
      return null;
    }
  };

  /**
   * HR0: resource-rooted Documents addressing for targets outside any project
   * workspace. A `file` root addresses exactly one canonical file; a
   * `directory` root addresses a subtree. These records are backend addressing
   * details — they carry no project identity, no session lifecycle, and no
   * classification role. Registration observes the explicit Host deployment
   * boundary; local project/navigation settings do not decide file access.
   */
  const findContainingResourceRoot = async (canonicalPath: string): Promise<WorkspaceMapping | null> => (
    registry.findContaining(canonicalPath)
  );

  const findExactResourceRoot = async (
    canonicalPath: string,
    kind?: 'directory' | 'file',
  ): Promise<WorkspaceMapping | null> => registry.findExact(canonicalPath, kind);

  const ensureResourceRoot = async (
    canonicalPath: string,
    kind: 'directory' | 'file',
  ): Promise<WorkspaceMapping> => {
    if (!await isAllowedRoot(canonicalPath)) {
      throw new DocumentPathError(`Resource path is outside the Host deployment boundary: ${canonicalPath}`);
    }
    const mapping = await registry.resolve({ canonicalPath, create: true, kind });
    if (!mapping) {
      throw new DocumentAuthorityError('Resource root registration failed', { code: 'failed', statusCode: 500 });
    }
    return mapping;
  };

  const registerWriterForScope = async (
    scopeId: unknown,
    owner: MutationOwner,
    options: Record<string, unknown> = {},
  ) => {
    const workspaceId = await resolveScopeId(scopeId);
    if (!workspaceId) return null;
    const state = await mutations.inspect(workspaceId);
    return mutations.registerWriter({ workspaceId, epoch: state.epoch, owner }, options);
  };

  const runMutationForScope = async <Result>(
    scopeId: unknown,
    owner: MutationOwner,
    operation: () => Promise<Result>,
    options: Record<string, unknown> = {},
  ): Promise<Result> => {
    const resourceOperations = Array.isArray(options.resourceOperations)
      ? options.resourceOperations.filter((value): value is DocumentResourceOperation => (
          Boolean(value)
          && typeof value === 'object'
          && typeof (value as DocumentResourceOperation).resourceId === 'string'
          && ((value as DocumentResourceOperation).scope === 'exact' || (value as DocumentResourceOperation).scope === 'subtree')
        ))
      : [];
    const { resourceOperations: _resourceOperations, ...writerOptions } = options;
    const workspaceId = await resolveScopeId(scopeId);
    const writer = workspaceId
      ? await registerWriterForScope(workspaceId, owner, writerOptions)
      : null;
    try {
      if (workspaceId && durableMutationStorage && resourceOperations.length > 0) {
        const storage = durableMutationStorage;
        return await storage(workspaceId, (context) => context.resourceOperationGate.run(resourceOperations, operation));
      }
      return await operation();
    } finally {
      if (writer) {
        try {
          await writer.markMutated();
        } finally {
          await writer.close();
        }
      }
    }
  };

  const read = (resource: DocumentResource, options: { signal?: AbortSignal; reportPhase?: (phase: string) => void } = {}): Promise<DocumentReadResult> => withResolvedResourceOperation([
    { resource, scope: 'exact' },
  ], async ([target]) => {
    try {
      options.reportPhase?.('document:mutation-state');
      const mutation = await waitWithSignal(mutations.inspect(resource.workspaceId, options.signal), options.signal);
      const { resolved } = target!;
      options.signal?.throwIfAborted();
      options.reportPhase?.('document:read');
      return { ...(await snapshotFile(resource, resolved.absolutePath, options.signal)), epoch: mutation.epoch };
    } catch (error) {
      return fail(error);
    }
  }, options);

  const readSnapshot = (resource: DocumentResource, options: { signal?: AbortSignal; reportPhase?: (phase: string) => void } = {}): Promise<SnapshotResult> => withResolvedResourceOperation([
    { resource, scope: 'exact' },
  ], async ([target]) => {
    options.signal?.throwIfAborted();
    options.reportPhase?.('document:read');
    return snapshotFile(resource, target!.resolved.absolutePath, options.signal);
  }, options);

  /** Capture related files under one exact-resource lease. An unreadable candidate
   * stays a per-file result so callers can retain their normal selection precedence. */
  const readSnapshots = (resources: readonly DocumentResource[], options: { signal?: AbortSignal } = {}): Promise<PromiseSettledResult<SnapshotResult>[]> => {
    if (!resources.length) return Promise.resolve([]);
    return withResolvedResourceOperation(resources.map(resource => ({ resource, scope: 'exact' })),
      resolved => Promise.allSettled(resources.map((resource, index) => snapshotFile(resource, resolved[index]!.resolved.absolutePath, options.signal))), options);
  };

  const write = (request: WriteRequest): Promise<DocumentWriteResult> => withResolvedResourceOperation([
    { resource: request.resource, scope: 'subtree' },
  ], async ([target]) => {
    let writer: DocumentWriter | undefined;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-write' });
      const { resolved } = target!;
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      } as SnapshotWithEpoch;
      if (request.expectedRevision === null) {
        if (current.status !== 'missing') {
          return { status: 'conflict', current: withoutContent(current) };
        }
      } else if (current.status === 'missing' || (current.status !== 'binary' && current.status !== 'unsupported-encoding' && current.revision !== request.expectedRevision)) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      let bytes: Uint8Array;
      try {
        bytes = encodeDocumentText({
          content: request.content,
          encoding: request.encoding,
          bom: request.bom,
        });
      } catch {
        throw new DocumentAuthorityError('Unsupported document encoding', { code: 'failed', statusCode: 400 });
      }
      let writeConflict = false;
      if (durableMutationStorage) {
        writeConflict = await durableMutationStorage(request.resource.workspaceId, async (context) => {
          if (!context.fileResources) {
            await atomicReplace(resolved.absolutePath, bytes);
            return false;
          }
          const captured = await context.fileStore.captureState(
            context.identity,
            context.root,
            request.resource.resourceId,
            { store: false },
          );
          const capturedRevision = captured.state.kind === 'regular-file'
            ? revisionFromObjectHash(captured.state.objectHash)
            : null;
          if (
            (current.status === 'missing' && captured.state.kind !== 'missing')
            || (current.status !== 'missing' && (
              captured.state.kind !== 'regular-file'
              || capturedRevision !== current.revision
            ))
          ) {
            return true;
          }
          const result = await context.fileResources.writeBytes(
            context.identity,
            request.resource.resourceId,
            bytes,
            {
              expected: captured.state,
              ...(captured.state.kind === 'regular-file' && captured.state.mode !== undefined
                ? { mode: captured.state.mode }
                : {}),
              ...(request.operationId
                ? { operationId: `document-write:${request.resource.workspaceId}:${request.resource.resourceId}:${request.operationId}` }
                : {}),
            },
          );
          return result.status === 'conflict';
        });
      } else {
        await atomicReplace(resolved.absolutePath, bytes);
      }
      if (writeConflict) {
        const latest = {
          ...(await snapshotFile(request.resource, resolved.absolutePath)),
          epoch: request.token.epoch,
        } as SnapshotWithEpoch;
        return { status: 'conflict', current: withoutContent(latest) };
      }
      await writer.markMutated();
      const next = await snapshotFile(request.resource, resolved.absolutePath);
      if (next.status !== 'ready') {
        throw new DocumentAuthorityError('Failed to read document after write', { code: 'failed', statusCode: 500 });
      }
      const result: { status: 'written'; revision: string; byteLength: number; modifiedAt?: string } = {
        status: 'written',
        revision: next.revision,
        byteLength: next.byteLength,
      };
      if (next.modifiedAt) result.modifiedAt = next.modifiedAt;
      publishMutation({
        workspaceId: request.resource.workspaceId,
        resourceId: request.resource.resourceId,
        kind: current.status === 'missing' ? 'created' : 'modified',
        owner: writer.owner,
      });
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const move = (request: MoveRequest): Promise<DocumentMoveResult> => withResolvedResourceOperation([
    { resource: request.from, scope: 'subtree' },
    { resource: request.to, scope: 'subtree' },
  ], async ([source, target]) => {
    let writer: DocumentWriter | undefined;
    try {
      if (request.from.workspaceId !== request.to.workspaceId) {
        throw new DocumentAuthorityError('Document moves must stay within one workspace', {
          code: 'failed',
          statusCode: 400,
        });
      }
      assertTokenWorkspace(request.token, request.from.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-move' });
      if (!source || !target) throw new DocumentAuthorityError('Document move resources are unavailable');
      const current = {
        ...(await snapshotFile(request.from, source.resolved.absolutePath)),
        epoch: request.token.epoch,
      } as SnapshotWithEpoch;
      if (current.status === 'missing') return { status: 'missing', resource: request.from };
      if (current.status !== 'ready' && current.status !== 'binary' && current.status !== 'unsupported-encoding') {
        return { status: 'conflict', current: withoutContent(current) };
      }
      if (current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      const targetCurrent = await snapshotFile(request.to, target.resolved.absolutePath);
      if (targetCurrent.status !== 'missing') return { status: 'target-exists', resource: request.to };
      let moveStatus: 'moved' | 'target-exists' | 'conflict' = 'moved';
      if (durableMutationStorage) {
        moveStatus = await durableMutationStorage(request.from.workspaceId, async (context) => {
          if (!context.fileResources) {
            await fsPromises.mkdir(pathModule.dirname(target.resolved.absolutePath), { recursive: true });
            await fsPromises.rename(source.resolved.absolutePath, target.resolved.absolutePath);
            return 'moved';
          }
          const sourceState = await context.fileStore.captureState(
            context.identity,
            context.root,
            request.from.resourceId,
            { store: false },
          );
          const targetState = await context.fileStore.captureState(
            context.identity,
            context.root,
            request.to.resourceId,
            { store: false },
          );
          const sourceRevision = sourceState.state.kind === 'regular-file'
            ? revisionFromObjectHash(sourceState.state.objectHash)
            : null;
          if (sourceState.state.kind !== 'regular-file' || sourceRevision !== current.revision) return 'conflict';
          if (targetState.state.kind !== 'missing') return 'target-exists';
          const renamed = await context.fileResources.rename(
            context.identity,
            request.from.resourceId,
            request.to.resourceId,
            {
              targetMustBeMissing: true,
              expectedFrom: sourceState.state,
              expectedTo: targetState.state,
              ...(request.operationId
                ? { operationId: `document-move:${request.from.workspaceId}:${request.from.resourceId}:${request.to.resourceId}:${request.operationId}` }
                : {}),
            },
          );
          return renamed === 'renamed' ? 'moved' : renamed;
        });
      } else {
        await fsPromises.mkdir(pathModule.dirname(target.resolved.absolutePath), { recursive: true });
        await fsPromises.rename(source.resolved.absolutePath, target.resolved.absolutePath);
      }
      if (moveStatus === 'target-exists') return { status: 'target-exists', resource: request.to };
      if (moveStatus === 'conflict') {
        const latest = {
          ...(await snapshotFile(request.from, source.resolved.absolutePath)),
          epoch: request.token.epoch,
        } as SnapshotWithEpoch;
        return { status: 'conflict', current: withoutContent(latest) };
      }
      await writer.markMutated();
      const next = await snapshotFile(request.to, target.resolved.absolutePath);
      const result: { status: 'moved'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt?: string } = {
        status: 'moved',
        resource: request.to,
        revision: next.status === 'missing' ? '' : next.revision,
        byteLength: next.status === 'missing' ? 0 : next.byteLength ?? 0,
      };
      if (next.status !== 'missing' && next.modifiedAt) result.modifiedAt = next.modifiedAt;
      publishMutation({
        workspaceId: request.from.workspaceId,
        resourceId: request.from.resourceId,
        kind: 'deleted',
        owner: writer.owner,
      });
      publishMutation({
        workspaceId: request.to.workspaceId,
        resourceId: request.to.resourceId,
        kind: 'created',
        owner: writer.owner,
      });
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const remove = (request: DeleteRequest): Promise<DocumentDeleteResult> => withResolvedResourceOperation([
    { resource: request.resource, scope: 'subtree' },
  ], async ([target]) => {
    let writer: DocumentWriter | undefined;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-delete' });
      const { resolved } = target!;
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      } as SnapshotWithEpoch;
      if (current.status === 'missing') return { status: 'missing', resource: request.resource };
      if ((current.status === 'ready' || current.status === 'binary' || current.status === 'unsupported-encoding') && current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      let deleteConflict = false;
      if (durableMutationStorage) {
        deleteConflict = await durableMutationStorage(request.resource.workspaceId, async (context) => {
          if (!context.fileResources) {
            await fsPromises.unlink(resolved.absolutePath);
            return false;
          }
          const captured = await context.fileStore.captureState(
            context.identity,
            context.root,
            request.resource.resourceId,
            { store: false },
          );
          const capturedRevision = captured.state.kind === 'regular-file'
            ? revisionFromObjectHash(captured.state.objectHash)
            : null;
          if (captured.state.kind !== 'regular-file' || capturedRevision !== current.revision) return true;
          const applied = await context.fileResources.applyStateDetailed(
            context.identity,
            request.resource.resourceId,
            { kind: 'missing' },
            {
              expected: captured.state,
              ...(request.operationId
                ? { operationId: `document-delete:${request.resource.workspaceId}:${request.resource.resourceId}:${request.operationId}` }
                : {}),
            },
          );
          return applied.status === 'conflict';
        });
      } else {
        await fsPromises.unlink(resolved.absolutePath);
      }
      if (deleteConflict) {
        const latest = {
          ...(await snapshotFile(request.resource, resolved.absolutePath)),
          epoch: request.token.epoch,
        } as SnapshotWithEpoch;
        return { status: 'conflict', current: withoutContent(latest) };
      }
      await writer.markMutated();
      publishMutation({
        workspaceId: request.resource.workspaceId,
        resourceId: request.resource.resourceId,
        kind: 'deleted',
        owner: writer.owner,
      });
      return { status: 'deleted', resource: request.resource };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const watch = (workspaceId: string, listener: (event: WatchEvent) => void): WatchSubscription => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', {
        code: 'failed',
        statusCode: 500,
      });
    }
    let record: WatcherRecord | undefined = watchers.get(workspaceId);
    if (!record) {
      const newRecord: WatcherRecord = { listeners: new Set(), controller: null, ready: null,
        inventory: createCaptureInventory(), inventoryRetained: false };
      watchers.set(workspaceId, newRecord);
      newRecord.ready = Promise.all([loadWorkspace(workspaceId), mutations.inspect(workspaceId)]).then(async ([workspace]) => {
        const controller = createWorkspaceWatcher({
          workspaceId,
          rootPath: workspace.root,
          fsModule,
          fsPromises,
          pathModule,
          ...(overflowLimit !== undefined ? { overflowLimit } : {}),
          onNamespaceInvalidated: relative => newRecord.inventory.invalidate(relative),
          onEvent: (event) => {
            void mutations.observeWatchEvent(workspaceId, event).catch(() => undefined);
            for (const current of newRecord.listeners) current(event);
          },
        });
        if (watchers.get(workspaceId) !== newRecord) {
          controller.close();
          return null;
        }
        newRecord.controller = controller;
        await controller.ready;
        return controller;
      }).catch(() => {
        newRecord.controller?.close();
        if (watchers.get(workspaceId) === newRecord) watchers.delete(workspaceId);
        return null;
      });
      record = newRecord;
    }
    const rec = record;
    rec.listeners.add(listener);
    return {
      ready: Promise.resolve(rec.ready).then((controller) => Boolean(controller)),
      get position() { return rec.controller?.position ?? null; },
      settle: () => Promise.resolve(rec.ready).then((controller) => controller?.settle()),
      close() {
        rec.listeners.delete(listener);
        if (rec.listeners.size === 0 && !rec.inventoryRetained) {
          rec.controller?.close();
          if (watchers.get(workspaceId) === rec) watchers.delete(workspaceId);
        }
      },
    };
  };

  const watcherController = (workspaceId: string): WorkspaceWatcher | null => watchers.get(workspaceId)?.controller ?? null;

  const beginCapture = async (workspaceId: string, options: Record<string, unknown> = {}, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const subscription = watch(workspaceId, () => undefined);
    try {
      const record = watchers.get(workspaceId);
      const controller = await waitWithSignal(Promise.resolve(record?.ready), signal);
      if (!controller || watchers.get(workspaceId) !== record) {
        throw new DocumentAuthorityError('Workspace watcher is unavailable for capture', {
          code: 'failed',
          statusCode: 500,
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      await waitWithSignal(controller.settle(), signal);
      await waitWithSignal(mutations.setWatchBaseline(workspaceId, controller.position), signal);
      const capture = await waitWithSignal(mutations.beginCapture(workspaceId, options), signal);
      signal?.throwIfAborted();
      captureWatches.set(capture.captureId, { subscription, controller });
      return capture;
    } catch (error) {
      subscription.close();
      throw error;
    }
  };

  /** The existing root observer owns only reusable namespace metadata. Bytes are
   * always captured through the caller's freshly admitted Rust resource owner. */
  const captureInventory = (capture: CaptureToken, scan: (scopes?: readonly string[]) => Promise<string[]>, signal?: AbortSignal) => {
    const tracked = captureWatches.get(capture.captureId);
    const record = watchers.get(capture.workspaceId);
    if (!tracked || !record || record.controller !== tracked.controller) {
      throw new DocumentAuthorityError('Original capture observation is unavailable', { code: 'failed', statusCode: 409 });
    }
    const identity = () => ({ epoch: capture.epoch, ...tracked.controller.position,
      complete: tracked.controller.connected && tracked.controller.coverage.namespace === 'complete' });
    const current = (): void => {
      signal?.throwIfAborted();
      if (captureWatches.get(capture.captureId) !== tracked || watchers.get(capture.workspaceId) !== record
        || record.controller !== tracked.controller) throw new Error('Original capture observation changed');
    };
    return {
      read: async (): Promise<readonly string[]> => {
        current();
        if (tracked.inventory) throw new Error('Capture inventory was already prepared');
        const candidate = await waitWithSignal(record.inventory.prepare({ ...identity(), scan }), signal);
        current();
        tracked.inventory = { record, candidate };
        return candidate.paths;
      },
      verify: async (): Promise<void> => {
        current();
        const candidate = tracked.inventory?.candidate;
        if (!candidate) throw new Error('Capture inventory was not prepared');
        await waitWithSignal(tracked.controller.settle(), signal);
        current();
        await waitWithSignal(record.inventory.verify(candidate, identity(), scan), signal);
        current();
      },
    };
  };

  const discardCapture = (capture: unknown): void => {
    const captureId = (capture as { captureId?: string })?.captureId;
    const tracked = captureId ? captureWatches.get(captureId) : undefined;
    if (captureId) captureWatches.delete(captureId);
    tracked?.subscription.close();
  };

  const completeCapture = async (capture: unknown, signal?: AbortSignal) => {
    const captureId = (capture as { captureId?: string })?.captureId;
    const tracked = captureId ? captureWatches.get(captureId) : undefined;
    try {
      signal?.throwIfAborted();
      await waitWithSignal(Promise.resolve(tracked?.controller.settle()), signal);
      const completed = await waitWithSignal(mutations.completeCapture(capture as never), signal);
      if (completed.stable && tracked?.inventory) {
        const { record, candidate } = tracked.inventory;
        if (disposed || watchers.get(completed.workspaceId) !== record || record.controller !== tracked.controller) {
          throw new Error('Capture inventory owner changed before completion');
        }
        const complete = tracked.controller.connected && tracked.controller.coverage.namespace === 'complete';
        record.inventory.commit(candidate, { epoch: (capture as CaptureToken).epoch, ...tracked.controller.position, complete });
        // Lazy lifetime of this Documents root. A reset invalidates the metadata;
        // Host disposal closes the retained original watch. No branch or file body is pinned.
        record.inventoryRetained = complete;
      }
      return completed;
    } finally {
      discardCapture(capture);
    }
  };

  const journalMutation = async <T extends { status: string }>(
    request: JournalMutationRequest,
    purpose: string,
    operation: () => Promise<T>,
  ): Promise<T | StaleEpochResult> => {
    let writer: DocumentWriter | undefined;
    try {
      const workspaceId = request.workspaceId ?? request.token?.workspaceId;
      assertTokenWorkspace(request.token, workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose });
      const result = await operation();
      if (result.status === 'written' || result.status === 'deleted') await writer.markMutated();
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  };

  const dirtyBufferKey = (ownerId: string, workspaceId: string): string => `${ownerId}\0${workspaceId}`;
  const dirtyResourceIdentity = (resource: DirtyBufferResource): string => JSON.stringify({
    resourceId: resource.resource.resourceId,
    baseRevision: resource.baseRevision,
    localEditRevision: resource.localEditRevision,
    documentInstanceId: resource.documentInstanceId ?? null,
    bufferHash: resource.bufferHash ?? null,
    encoding: resource.encoding ?? null,
    bom: resource.bom ?? null,
    lineEnding: resource.lineEnding ?? null,
  });
  const sameDirtyResources = (left: readonly DirtyBufferResource[], right: readonly DirtyBufferResource[]): boolean => {
    const a = left.map(dirtyResourceIdentity).sort();
    const b = right.map(dirtyResourceIdentity).sort();
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  };
  const publicDirtyBufferRecord = (record: DirtyBufferRecord): DirtyBufferPublication => {
    const result = structuredClone(record);
    delete (result as Partial<DirtyBufferRecord>).publicationRevision;
    const surface = dirtySurfaces.get(dirtyBufferKey(record.ownerId, record.workspaceId));
    return {
      ...result,
      ...(surface?.generation === record.generation ? { registrationId: surface.registrationId } : {}),
    };
  };

  const rejectSurfaceOperationsForRegistration = (registrationId: string, reason: string): void => {
    for (const [requestId, operation] of pendingSurfaceOperations) {
      if (operation.registrationId !== registrationId) continue;
      pendingSurfaceOperations.delete(requestId);
      operation.cleanup();
      operation.reject(new DocumentAuthorityError(reason, { code: 'stale-completion', statusCode: 409 }));
    }
  };

  const releaseDirtyBarrier = (barrier: DirtyBarrier, error?: unknown): void => {
    if (!barrier || barrier.released) return;
    barrier.released = true;
    barrier.cleanup?.();
    if (barrier.timer) clearTimeout(barrier.timer);
    dirtyBarriers.delete(barrier.barrierId);
    for (const surfaceKey of barrier.surfaceKeys) {
      const surface = dirtySurfaces.get(surfaceKey);
      if (!surface) continue;
      try {
        surface.listener({
          action: 'release',
          barrierId: barrier.barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId: barrier.workspaceId,
        });
      } catch {
        // Releasing every other surface and settling waiters is more important
        // than propagating an already-disconnected listener failure.
      }
    }
    for (const waiter of barrier.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    barrier.waiters.clear();
  };

  const dirtyBarrierFailure = (message: string): DocumentAuthorityError => new DocumentAuthorityError(message, {
    code: 'failed',
    statusCode: 503,
  });

  const armDirtyBarrierDeadline = (barrier: DirtyBarrier): void => {
    if (barrier.timer) clearTimeout(barrier.timer);
    if (barrier.pending.size === 0 || barrier.released) {
      barrier.timer = null;
      return;
    }
    barrier.timer = setTimeout(() => {
      releaseDirtyBarrier(barrier, dirtyBarrierFailure('Document surfaces did not publish dirty state before the barrier deadline'));
    }, dirtyBarrierTimeoutMs);
    barrier.timer.unref?.();
  };

  const settleDirtyBarrier = (barrier: DirtyBarrier): Promise<void> => {
    if (barrier.released) {
      return Promise.reject(dirtyBarrierFailure('Dirty-state barrier was released before it settled'));
    }
    if (barrier.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => barrier.waiters.add({ reject, resolve }));
  };

  const resolveDirtyBarrierWaiters = (barrier: DirtyBarrier): void => {
    if (barrier.pending.size > 0 || barrier.released) return;
    if (barrier.timer) clearTimeout(barrier.timer);
    barrier.timer = null;
    for (const waiter of barrier.waiters) waiter.resolve();
    barrier.waiters.clear();
  };

  const registerDirtySurface = (request: DirtySurfaceRequest, listener: (event: unknown) => void): DirtySurfaceSubscription => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', { code: 'failed', statusCode: 500 });
    }
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || typeof listener !== 'function') {
      throw new DocumentAuthorityError('Dirty surface registration is malformed', { code: 'failed', statusCode: 400 });
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const previous = dirtySurfaces.get(key);
    if (previous) rejectSurfaceOperationsForRegistration(previous.registrationId, 'Document surface registration was replaced');
    const record: DirtySurfaceRecord = { ...request, key, listener, registrationId: randomUUID() };
    dirtySurfaces.set(key, record);
    onIntegrationParentChanged(request.workspaceId);
    for (const barrier of dirtyBarriers.values()) {
      if (barrier.workspaceId !== request.workspaceId || barrier.released) continue;
      barrier.surfaceKeys.add(key);
      barrier.pending.add(key);
      barrier.requiredPublications.set(key, dirtyPublicationRevision + 1);
      armDirtyBarrierDeadline(barrier);
      try {
        listener({
          action: 'acquire',
          barrierId: barrier.barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId: barrier.workspaceId,
        });
      } catch {
        releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface could not receive the dirty-state barrier'));
      }
    }
    return {
      close() {
        if (dirtySurfaces.get(key)?.registrationId !== record.registrationId) return;
        dirtySurfaces.delete(key);
        dirtyBuffersByOwner.delete(key);
        onIntegrationParentChanged(request.workspaceId);
        rejectSurfaceOperationsForRegistration(record.registrationId, 'Document surface disconnected during an operation');
        surfaceSnapshots.dropPendingOwner(request.ownerId, request.workspaceId);
        for (const barrier of dirtyBarriers.values()) {
          if (!barrier.surfaceKeys.has(key) || barrier.released) continue;
          releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface disconnected while the dirty-state barrier was held'));
        }
      },
    };
  };

  const beginDirtyStateBarrier = async (
    workspaceId: string,
    paths: unknown,
    options: BeginDirtyStateBarrierOptions = {},
  ): Promise<DirtyStateBarrierHandle> => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', { code: 'failed', statusCode: 500 });
    }
    options.signal?.throwIfAborted();
    await waitWithSignal(loadWorkspace(workspaceId), options.signal);
    options.signal?.throwIfAborted();
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new DocumentAuthorityError('Dirty-state barrier paths are malformed', { code: 'failed', statusCode: 400 });
    }
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') {
      throw new DocumentAuthorityError('Dirty-state barrier path comparison is malformed', { code: 'failed', statusCode: 400 });
    }
    if (!Number.isSafeInteger(dirtyBarrierTimeoutMs) || dirtyBarrierTimeoutMs <= 0) {
      throw new DocumentAuthorityError('Dirty-state barrier timeout is malformed', { code: 'failed', statusCode: 500 });
    }
    const barrierId = randomUUID();
    const surfaces = [...dirtySurfaces.values()].filter((surface) => surface.workspaceId === workspaceId);
    const barrier: DirtyBarrier = {
      barrierId,
      caseSensitive: options.caseSensitive ?? platform !== 'win32',
      paths: [...new Set(paths as string[])].sort(),
      pending: new Set(surfaces.map((surface) => surface.key)),
      requiredPublications: new Map(surfaces.map((surface) => [surface.key, dirtyPublicationRevision + 1])),
      released: false,
      surfaceKeys: new Set(surfaces.map((surface) => surface.key)),
      timer: null,
      waiters: new Set(),
      workspaceId,
    };
    armDirtyBarrierDeadline(barrier);
    dirtyBarriers.set(barrierId, barrier);
    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => releaseDirtyBarrier(barrier, signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
      barrier.cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    for (const surface of surfaces) {
      if (barrier.released) break;
      try {
        surface.listener({
          action: 'acquire',
          barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId,
        });
      } catch {
        releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface could not receive the dirty-state barrier'));
      }
    }
    options.signal?.throwIfAborted();
    await settleDirtyBarrier(barrier);
    options.signal?.throwIfAborted();
    return {
      barrierId,
      async release() {
        releaseDirtyBarrier(barrier);
      },
      settle: () => settleDirtyBarrier(barrier),
    };
  };

  const acknowledgeDirtyStateBarrier = async (request: DirtyStateBarrierAckRequest): Promise<{ acknowledged: boolean }> => {
    if (!request || typeof request.barrierId !== 'string' || !request.barrierId
      || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new DocumentAuthorityError('Dirty-state barrier acknowledgement is malformed', { code: 'failed', statusCode: 400 });
    }
    const barrier = dirtyBarriers.get(request.barrierId);
    if (!barrier || barrier.released || barrier.workspaceId !== request.workspaceId) {
      return { acknowledged: false };
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const surface = dirtySurfaces.get(key);
    const publication = dirtyBuffersByOwner.get(key);
    const requiredPublication = barrier.requiredPublications.get(key) ?? Number.POSITIVE_INFINITY;
    if (!surface || surface.generation !== request.generation || !barrier.pending.has(key)
      || publication?.generation !== request.generation
      || publication.publicationRevision < requiredPublication) {
      return { acknowledged: false };
    }
    barrier.pending.delete(key);
    resolveDirtyBarrierWaiters(barrier);
    return { acknowledged: true };
  };

  const publishDirtyBuffers = async (request: PublishDirtyBuffersRequest): Promise<DirtyBufferPublication> => {
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || !Array.isArray(request.resources)) {
      throw new DocumentAuthorityError('Dirty buffer publication is malformed', { code: 'failed', statusCode: 400 });
    }
    await loadWorkspace(request.workspaceId);
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const existing = dirtyBuffersByOwner.get(key);
    if (existing && existing.generation > request.generation) {
      throw new DocumentAuthorityError('Dirty buffer publication is stale', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    const resources = request.resources.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !(entry as Record<string, unknown>).resource
        || ((entry as Record<string, unknown>).resource as Record<string, unknown>).workspaceId !== request.workspaceId
        || typeof ((entry as Record<string, unknown>).resource as Record<string, unknown>).resourceId !== 'string'
        || ((entry as Record<string, unknown>).baseRevision !== null && typeof (entry as Record<string, unknown>).baseRevision !== 'string')
        || !Number.isSafeInteger((entry as Record<string, unknown>).localEditRevision)
        || ((entry as Record<string, unknown>).localEditRevision as number) < 0
        || ((entry as Record<string, unknown>).documentInstanceId !== undefined
          && (typeof (entry as Record<string, unknown>).documentInstanceId !== 'string'
            || !(entry as Record<string, unknown>).documentInstanceId))
        || ((entry as Record<string, unknown>).bufferHash !== undefined
          && (typeof (entry as Record<string, unknown>).bufferHash !== 'string'
            || !/^sha256-[0-9a-f]{64}$/u.test((entry as Record<string, unknown>).bufferHash as string)))
        || ((entry as Record<string, unknown>).encoding !== undefined
          && typeof (entry as Record<string, unknown>).encoding !== 'string')
        || ((entry as Record<string, unknown>).bom !== undefined
          && typeof (entry as Record<string, unknown>).bom !== 'boolean')
        || ((entry as Record<string, unknown>).lineEnding !== undefined
          && !['lf', 'crlf', 'cr'].includes(String((entry as Record<string, unknown>).lineEnding)))) {
        throw new DocumentAuthorityError('Dirty buffer resource is malformed', { code: 'failed', statusCode: 400 });
      }
      return {
        baseRevision: (entry as Record<string, unknown>).baseRevision as string | null,
        localEditRevision: (entry as Record<string, unknown>).localEditRevision as number,
        resource: { ...((entry as Record<string, unknown>).resource as DocumentResource) },
        ...(typeof (entry as Record<string, unknown>).documentInstanceId === 'string'
          ? { documentInstanceId: (entry as Record<string, unknown>).documentInstanceId as string } : {}),
        ...(typeof (entry as Record<string, unknown>).bufferHash === 'string'
          ? { bufferHash: (entry as Record<string, unknown>).bufferHash as string } : {}),
        ...(typeof (entry as Record<string, unknown>).encoding === 'string'
          ? { encoding: (entry as Record<string, unknown>).encoding as string } : {}),
        ...(typeof (entry as Record<string, unknown>).bom === 'boolean'
          ? { bom: (entry as Record<string, unknown>).bom as boolean } : {}),
        ...(typeof (entry as Record<string, unknown>).lineEnding === 'string'
          ? { lineEnding: (entry as Record<string, unknown>).lineEnding as 'lf' | 'crlf' | 'cr' } : {}),
      };
    });
    const record: DirtyBufferRecord = {
      generation: request.generation,
      ownerId: request.ownerId,
      publicationRevision: ++dirtyPublicationRevision,
      resources,
      updatedAt: new Date().toISOString(),
      workspaceId: request.workspaceId,
    };
    dirtyBuffersByOwner.set(key, record);
    if (!existing || existing.generation !== request.generation || !sameDirtyResources(existing.resources, resources)) {
      const previousPaths = new Set(existing?.resources.map((resource) => resource.resource.resourceId) ?? []);
      const currentPaths = resources.map((resource) => resource.resource.resourceId);
      onIntegrationParentChanged(request.workspaceId, [...new Set([...previousPaths, ...currentPaths])]);
    }
    return publicDirtyBufferRecord(record);
  };

  const clearDirtyBuffers = async (request: ClearDirtyBuffersRequest): Promise<{ cleared: boolean }> => {
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new DocumentAuthorityError('Dirty buffer clear request is malformed', { code: 'failed', statusCode: 400 });
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const existing = dirtyBuffersByOwner.get(key);
    if (existing && existing.generation > request.generation) {
      throw new DocumentAuthorityError('Dirty buffer clear request is stale', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    const cleared = dirtyBuffersByOwner.delete(key);
    if (cleared) {
      onIntegrationParentChanged(request.workspaceId, existing?.resources.map((resource) => resource.resource.resourceId));
    }
    surfaceSnapshots.dropPendingOwner(request.ownerId, request.workspaceId);
    return { cleared };
  };

  const inspectDirtyBuffers = async (workspaceId: string): Promise<DirtyBufferPublication[]> => {
    await loadWorkspace(workspaceId);
    return [...dirtyBuffersByOwner.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map(publicDirtyBufferRecord)
      .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  };

  const assertSurfaceOperationCaller = (request: Record<string, unknown>): {
    generation: number;
    ownerId: string;
    requestId: string;
    workspaceId: string;
    pending: PendingDocumentSurfaceOperation;
  } => {
    const ownerId = typeof request.ownerId === 'string' ? request.ownerId : '';
    const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId : '';
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const generation = Number(request.generation);
    if (!ownerId || !workspaceId || !requestId || !Number.isSafeInteger(generation) || generation < 0) {
      throw new DocumentAuthorityError('Document surface operation identity is malformed', { code: 'failed', statusCode: 400 });
    }
    const pending = pendingSurfaceOperations.get(requestId);
    const surface = dirtySurfaces.get(dirtyBufferKey(ownerId, workspaceId));
    if (!pending || pending.ownerId !== ownerId || pending.workspaceId !== workspaceId
      || pending.generation !== generation || !surface
      || surface.registrationId !== pending.registrationId || surface.generation !== generation) {
      throw new DocumentAuthorityError('Document surface operation is stale or unavailable', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    return { generation, ownerId, requestId, workspaceId, pending };
  };

  const requestSurfaceOperation = async (
    request: DocumentSurfaceOperationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DocumentSurfaceOperationResult[]> => {
    if (!request || !['capture', 'apply', 'undo', 'restore', 'workspace-edit'].includes(request.action)
      || typeof request.operationId !== 'string' || !request.operationId
      || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || typeof request.registrationId !== 'string' || !request.registrationId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || !Array.isArray(request.targets) || (request.targets.length === 0 && request.action !== 'workspace-edit')) {
      throw new DocumentAuthorityError('Document surface operation is malformed', { code: 'failed', statusCode: 400 });
    }
    await loadWorkspace(request.workspaceId);
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const surface = dirtySurfaces.get(key);
    const publication = dirtyBuffersByOwner.get(key);
    const captureWorkspaceEdit = request.action === 'workspace-edit' && request.workspaceEdit?.mode === 'capture';
    if (!surface || surface.registrationId !== request.registrationId || surface.generation !== request.generation
      || (!publication && !captureWorkspaceEdit) || (publication && publication.generation !== request.generation)) {
      throw new DocumentAuthorityError('Document surface owner is no longer connected', {
        code: 'stale-completion', statusCode: 409,
      });
    }
    const published = new Map((publication?.resources ?? []).map((resource) => [resource.resource.resourceId, resource]));
    const barrier = request.barrierId ? dirtyBarriers.get(request.barrierId) : undefined;
    if (request.action === 'restore' || request.barrierId !== undefined) {
      if (!barrier || barrier.released || barrier.workspaceId !== request.workspaceId
        || barrier.pending.size > 0 || !barrier.surfaceKeys.has(key)
        || request.targets.some(target => !barrier.paths.some(resourceId => (
          barrier.caseSensitive ? resourceId === target.resource.resourceId
            : resourceId.toLowerCase() === target.resource.resourceId.toLowerCase()
        )))) {
        throw new DocumentAuthorityError('Document recovery barrier is no longer held', { code: 'stale-completion', statusCode: 409 });
      }
    }
    if (request.action === 'workspace-edit') {
      const change = request.workspaceEdit;
      if (!change || !['capture', 'validate', 'apply'].includes(change.mode) || !Array.isArray(change.before) || !Array.isArray(change.after)
        || (captureWorkspaceEdit ? !Array.isArray(change.captureScopes) || change.captureScopes.some(scope => scope.resource.workspaceId !== request.workspaceId) : !barrier
        || [...change.before, ...change.after].some(slot => slot.resource.workspaceId !== request.workspaceId
          || !barrier!.paths.includes(slot.resource.resourceId)))) {
        throw new DocumentAuthorityError('Workspace edit surface request is outside its barrier', { code: 'stale-completion', statusCode: 409 });
      }
    }
    const seen = new Set<string>();
    for (const target of request.targets) {
      const resourceId = target?.resource?.resourceId;
      const current = typeof resourceId === 'string' ? published.get(resourceId) : undefined;
      if ((request.action === 'apply' && typeof target.newText !== 'string')
        || (request.action === 'restore' && (typeof target.newText !== 'string'
          || !target.restoreState || typeof target.restoreState.baseContent !== 'string'
          || (target.restoreState.baseRevision !== null && typeof target.restoreState.baseRevision !== 'string')
          || target.restoreState.encoding !== 'utf-8' || typeof target.restoreState.bom !== 'boolean'
          || !['lf', 'crlf', 'cr'].includes(target.restoreState.lineEnding)))
        || (request.action === 'undo' && (!Number.isSafeInteger(target.expectedAppliedRevision)
          || target.expectedAppliedRevision! < 0
          || typeof target.expectedAppliedHash !== 'string'
          || !/^sha256-[0-9a-f]{64}$/u.test(target.expectedAppliedHash)))) {
        throw new DocumentAuthorityError('Document surface operation target is malformed', { code: 'failed', statusCode: 400 });
      }
      const expectedLocalEditRevision = request.action === 'undo'
        ? target.expectedAppliedRevision
        : target.localEditRevision;
      const expectedBufferHash = request.action === 'undo'
        ? target.expectedAppliedHash
        : target.bufferHash;
      const currentMismatch = current && (
        current.baseRevision !== target.baseRevision
        || current.localEditRevision !== expectedLocalEditRevision
        || current.documentInstanceId !== target.documentInstanceId
        || current.bufferHash !== expectedBufferHash
        || current.encoding !== target.encoding || current.bom !== target.bom
        || current.lineEnding !== target.lineEnding
      );
      if (!resourceId || seen.has(resourceId) || target.resource.workspaceId !== request.workspaceId
        || (request.action !== 'undo' && !barrier && !current) || currentMismatch) {
        throw new DocumentAuthorityError('Document surface binding changed before the operation was dispatched', {
          code: 'stale-completion', statusCode: 409,
        });
      }
      seen.add(resourceId);
      await resolveResourcePath(target.resource, true);
    }
    if (dirtySurfaces.get(key) !== surface || dirtyBuffersByOwner.get(key) !== publication
      || surface.registrationId !== request.registrationId || surface.generation !== request.generation) {
      throw new DocumentAuthorityError('Document surface binding changed before dispatch', {
        code: 'stale-completion', statusCode: 409,
      });
    }
    options.signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise<DocumentSurfaceOperationResult[]>((resolve, reject) => {
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const abort = () => {
        const pending = pendingSurfaceOperations.get(requestId);
        if (!pending) return;
        pendingSurfaceOperations.delete(requestId);
        cleanup();
        reject(options.signal?.reason ?? new Error('Document surface operation was cancelled'));
      };
      const pending: PendingDocumentSurfaceOperation = {
        ...structuredClone(request),
        requestId,
        resolve: (results) => { cleanup(); resolve(results); },
        reject: (error) => { cleanup(); reject(error); },
        cleanup,
      };
      pendingSurfaceOperations.set(requestId, pending);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        surface.listener({
          action: request.action,
          kind: 'surface-operation',
          operationId: request.operationId,
          requestId,
          workspaceId: request.workspaceId,
        });
      } catch (error) {
        pendingSurfaceOperations.delete(requestId);
        cleanup();
        reject(error);
      }
    });
  };

  const readSurfaceOperation = async (value: unknown): Promise<Omit<DocumentSurfaceOperationRequest, 'generation' | 'ownerId' | 'registrationId'> & { requestId: string }> => {
    const request = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { pending } = assertSurfaceOperationCaller(request);
    return {
      action: pending.action,
      ...(pending.barrierId ? { barrierId: pending.barrierId } : {}),
      operationId: pending.operationId,
      requestId: pending.requestId,
      targets: structuredClone(pending.targets),
      ...(pending.workspaceEdit ? { workspaceEdit: structuredClone(pending.workspaceEdit) } : {}),
      workspaceId: pending.workspaceId,
    };
  };

  const completeSurfaceOperation = async (value: unknown): Promise<{ accepted: boolean }> => {
    const request = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { pending, requestId } = assertSurfaceOperationCaller(request);
    const completionError = (message: string, options: { code: DocumentAuthorityError['code']; statusCode: number }) =>
      new DocumentAuthorityError(message, options);
    if (request.operationId !== pending.operationId || !Array.isArray(request.resources)) {
      throw completionError('Document surface operation completion is malformed', { code: 'failed', statusCode: 400 });
    }
    if (pending.action === 'workspace-edit') {
      const receipt = request.workspaceEdit as VarinWorkspaceEditSurfaceReceipt | undefined;
      const change = pending.workspaceEdit!;
      if (!receipt || receipt.stepId !== change.stepId || !['applied', 'rejected'].includes(receipt.status)
        || !Array.isArray(receipt.buffers) || (receipt.message !== undefined && typeof receipt.message !== 'string')
        || (receipt.status === 'applied' && (change.mode === 'capture'
          ? receipt.buffers.some(slot => slot.resource.workspaceId !== pending.workspaceId || !slot.buffer
            || !isDeepStrictEqual(slot.resource, slot.buffer.resource) || !change.captureScopes?.some(scope => slot.resource.resourceId === scope.resource.resourceId
              || (scope.subtree && slot.resource.resourceId.startsWith(`${scope.resource.resourceId}/`))))
          : !isDeepStrictEqual(receipt.buffers, change.after)))) {
        throw completionError('Workspace edit surface receipt does not match its dispatch', { code: 'stale-completion', statusCode: 409 });
      }
      pendingSurfaceOperations.delete(requestId);
      pending.cleanup();
      if (receipt.status === 'rejected') pending.reject(new WorkspaceEditSurfaceRejectedError(receipt.message ?? 'Workspace edit buffer changed'));
      else if (change.mode === 'capture') pending.resolve(receipt.buffers.map(slot => ({ resource: slot.resource, status: 'captured', workspaceEditBuffer: slot.buffer })));
      else {
        if (receipt.message) pending.reject(new WorkspaceEditSurfaceAppliedError(receipt.message));
        else pending.resolve([]);
      }
      return { accepted: true };
    }
    const targets = new Set(pending.targets.map((target) => target.resource.resourceId));
    const targetByPath = new Map(pending.targets.map((target) => [target.resource.resourceId, target]));
    const results: DocumentSurfaceOperationResult[] = request.resources.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw completionError('Document surface operation result is malformed', { code: 'failed', statusCode: 400 });
      }
      const result = entry as Record<string, unknown>;
      const allowed = new Set([
        'resource', 'status', 'documentInstanceId', 'beforeLocalEditRevision', 'beforeHash',
        'afterLocalEditRevision', 'afterHash', 'content', 'baseContent', 'message',
      ]);
      const resource = result.resource && typeof result.resource === 'object' && !Array.isArray(result.resource)
        ? result.resource as Record<string, unknown> : {};
      const status = String(result.status);
      const expectedStatuses = pending.action === 'capture'
        ? new Set(['captured', 'failed'])
        : pending.action === 'apply' ? new Set(['applied', 'failed'])
          : pending.action === 'restore' ? new Set(['restored', 'failed']) : new Set(['undone', 'failed']);
      const validHash = (field: unknown) => field === undefined
        || (typeof field === 'string' && /^sha256-[0-9a-f]{64}$/u.test(field));
      const validRevision = (field: unknown) => field === undefined
        || (Number.isSafeInteger(field) && Number(field) >= 0);
      const shapeValid = Object.keys(result).every((key) => allowed.has(key))
        && (result.documentInstanceId === undefined || (typeof result.documentInstanceId === 'string' && result.documentInstanceId.length > 0))
        && validRevision(result.beforeLocalEditRevision) && validRevision(result.afterLocalEditRevision)
        && validHash(result.beforeHash) && validHash(result.afterHash)
        && (result.content === undefined || typeof result.content === 'string')
        && (result.baseContent === undefined || typeof result.baseContent === 'string')
        && (result.message === undefined || typeof result.message === 'string')
        && (status !== 'captured' || (typeof result.content === 'string' && typeof result.documentInstanceId === 'string'
          && result.beforeLocalEditRevision !== undefined && result.beforeHash !== undefined))
        && ((status !== 'applied' && status !== 'restored') || (typeof result.documentInstanceId === 'string'
          && result.beforeLocalEditRevision !== undefined && result.beforeHash !== undefined
          && result.afterLocalEditRevision !== undefined && result.afterHash !== undefined))
        && (status !== 'undone' || (typeof result.documentInstanceId === 'string'
          && result.afterLocalEditRevision !== undefined && result.afterHash !== undefined
          && typeof result.content === 'string'));
      if (resource.workspaceId !== pending.workspaceId || typeof resource.resourceId !== 'string'
        || !targets.delete(resource.resourceId)
        || !expectedStatuses.has(status) || !shapeValid) {
        throw completionError('Document surface operation result is malformed', { code: 'failed', statusCode: 400 });
      }
      return structuredClone(entry) as DocumentSurfaceOperationResult;
    });
    if (targets.size > 0) {
      throw completionError('Document surface operation result is incomplete', { code: 'failed', statusCode: 400 });
    }
    for (const result of results) {
      if (result.status === 'restored') {
        const target = targetByPath.get(result.resource.resourceId)!;
        const expectedHash = `sha256-${createHash('sha256').update(normalizeEditorLineEndings(target.newText!), 'utf8').digest('hex')}`;
        if (result.documentInstanceId !== target.documentInstanceId
          || result.beforeLocalEditRevision !== target.localEditRevision || result.beforeHash !== target.bufferHash
          || result.afterLocalEditRevision !== target.localEditRevision + 1 || result.afterHash !== expectedHash) {
          throw completionError('Document recovery completion does not match its target', { code: 'stale-completion', statusCode: 409 });
        }
        continue;
      }
      if (result.status !== 'applied' && result.status !== 'undone') continue;
      const target = targetByPath.get(result.resource.resourceId)!;
      const content = result.status === 'applied' ? target.newText : result.content;
      const editorHash = typeof content === 'string'
        ? `sha256-${createHash('sha256').update(normalizeEditorLineEndings(content), 'utf8').digest('hex')}`
        : '';
      if (typeof content !== 'string' || result.documentInstanceId !== target.documentInstanceId
        || result.afterLocalEditRevision === undefined || !result.afterHash
        || result.afterHash !== editorHash) {
        throw completionError('Document surface operation completion does not match its target', {
          code: 'stale-completion', statusCode: 409,
        });
      }
      const publication = dirtyBuffersByOwner.get(dirtyBufferKey(pending.ownerId, pending.workspaceId));
      if (publication) {
        dirtyBuffersByOwner.set(dirtyBufferKey(pending.ownerId, pending.workspaceId), {
          ...publication,
          publicationRevision: ++dirtyPublicationRevision,
          updatedAt: new Date().toISOString(),
          resources: publication.resources.map((resource) => (
            resource.resource.resourceId === result.resource.resourceId
              ? {
                  ...resource,
                  localEditRevision: result.afterLocalEditRevision!,
                  ...(result.afterHash === undefined ? {} : { bufferHash: result.afterHash }),
                  ...(result.documentInstanceId === undefined
                    ? {}
                    : { documentInstanceId: result.documentInstanceId }),
                }
              : resource
          )),
        });
      }
    }
    pendingSurfaceOperations.delete(requestId);
    pending.cleanup();
    pending.resolve(results);
    return { accepted: true };
  };

  const captureAgentInputSnapshot = async (request: CaptureAgentInputSnapshotRequest): Promise<AgentInputContext> => {
    const consumer = parseAgentInputSnapshotConsumer(request?.consumer);
    if (!consumer
      || typeof request.ownerId !== 'string' || !request.ownerId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || !Array.isArray(request.resources) || request.resources.length === 0) {
      throw new DocumentAuthorityError('Agent input snapshot capture is malformed', { code: 'failed', statusCode: 400 });
    }
    const resources: SurfaceSnapshotResource[] = request.resources.map((entry) => {
      const candidate = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      const resource = candidate.resource && typeof candidate.resource === 'object' && !Array.isArray(candidate.resource)
        ? candidate.resource as Record<string, unknown>
        : {};
      if (typeof resource.workspaceId !== 'string' || !resource.workspaceId
        || typeof resource.resourceId !== 'string'
        || (candidate.baseRevision !== null && typeof candidate.baseRevision !== 'string')
        || !Number.isSafeInteger(candidate.localEditRevision) || Number(candidate.localEditRevision) < 0
        || (candidate.documentInstanceId !== undefined && (typeof candidate.documentInstanceId !== 'string' || !candidate.documentInstanceId))
        || typeof candidate.content !== 'string'
        || (candidate.encoding !== undefined && candidate.encoding !== 'utf-8')
        || (candidate.bom !== undefined && typeof candidate.bom !== 'boolean')
        || (candidate.bufferHash !== undefined
          && (typeof candidate.bufferHash !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(candidate.bufferHash)))
        || (candidate.lineEnding !== undefined
          && !['lf', 'crlf', 'cr'].includes(String(candidate.lineEnding)))) {
        throw new DocumentAuthorityError('Agent input snapshot resource is malformed', { code: 'failed', statusCode: 400 });
      }
      const lineEnding = candidate.lineEnding === 'crlf' || candidate.lineEnding === 'cr' || candidate.lineEnding === 'lf'
        ? candidate.lineEnding
        : detectLineEnding(candidate.content);
      const bufferHash = typeof candidate.bufferHash === 'string'
        ? candidate.bufferHash
        : `sha256-${createHash('sha256').update(normalizeEditorLineEndings(candidate.content), 'utf8').digest('hex')}`;
      return {
        baseRevision: candidate.baseRevision as string | null,
        encoding: candidate.encoding === undefined ? 'utf-8' : candidate.encoding,
        bom: candidate.bom === undefined ? false : candidate.bom,
        content: candidate.content,
        localEditRevision: Number(candidate.localEditRevision),
        ...(typeof candidate.documentInstanceId === 'string' ? { documentInstanceId: candidate.documentInstanceId } : {}),
        resource: { workspaceId: resource.workspaceId, resourceId: resource.resourceId },
        bufferHash,
        lineEnding,
      };
    });
    const byRoot = new Map<string, SurfaceSnapshotResource[]>();
    for (const resource of resources) {
      const entries = byRoot.get(resource.resource.workspaceId) ?? [];
      entries.push(resource);
      byRoot.set(resource.resource.workspaceId, entries);
    }
    const publications = new Map<string, DirtyBufferPublication>();
    for (const [workspaceId, entries] of byRoot) {
      await loadWorkspace(workspaceId);
      const publication = dirtyBuffersByOwner.get(dirtyBufferKey(request.ownerId, workspaceId));
      if (!publication || publication.generation !== request.generation) {
        throw new DocumentAuthorityError('Dirty buffer publication is unavailable for capture', {
          code: 'stale-completion', statusCode: 409,
        });
      }
      const requestedByPath = new Map(entries.map((resource) => [resource.resource.resourceId, resource]));
      const publishedByPath = new Map(publication.resources.map((resource) => [resource.resource.resourceId, resource]));
      if (requestedByPath.size !== entries.length
        || publishedByPath.size !== publication.resources.length
        || requestedByPath.size !== publishedByPath.size
        || [...requestedByPath].some(([resourceId, resource]) => {
          const published = publishedByPath.get(resourceId);
          const publishedHash = published?.bufferHash;
          const serializedHash = `sha256-${createHash('sha256').update(normalizeEditorLineEndings(resource.content), 'utf8').digest('hex')}`;
          return !published
            || published.resource.workspaceId !== workspaceId
            || published.baseRevision !== resource.baseRevision
            || published.localEditRevision !== resource.localEditRevision
            || published.documentInstanceId !== resource.documentInstanceId
            || (published.encoding !== undefined && published.encoding !== resource.encoding)
            || (published.bom !== undefined && published.bom !== resource.bom)
            || (published.lineEnding !== undefined && published.lineEnding !== resource.lineEnding)
            || (publishedHash !== undefined && publishedHash !== serializedHash)
            || (resource.bufferHash !== undefined && resource.bufferHash !== serializedHash);
        })) {
        throw new DocumentAuthorityError('Dirty buffer publication changed before capture', {
          code: 'stale-completion', statusCode: 409,
        });
      }
      publications.set(workspaceId, publication);
    }
    const resolvedResources = await Promise.all(resources.map(async (resource) => ({
      ...resource,
      ...await resolveResourceIdentity(resource.resource),
    })));
    if ([...publications].some(([workspaceId, publication]) => (
      dirtyBuffersByOwner.get(dirtyBufferKey(request.ownerId, workspaceId)) !== publication
    ))) {
      throw new DocumentAuthorityError('Dirty buffer publication changed before capture', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    return surfaceSnapshots.capture({
      ownerId: request.ownerId,
      ownerGeneration: request.generation,
      resources: resolvedResources,
      consumer,
    });
  };

  const releaseAgentInputSnapshot = (valueConsumer: unknown, value: unknown): { released: boolean } => {
    const consumer = parseAgentInputSnapshotConsumer(valueConsumer);
    if (!consumer) {
      throw new DocumentAuthorityError('Agent input snapshot consumer is malformed', { code: 'failed', statusCode: 400 });
    }
    const context = parseAgentInputContext(value);
    if (!context) {
      throw new DocumentAuthorityError('Agent input context is malformed', { code: 'failed', statusCode: 400 });
    }
    return surfaceSnapshots.release(consumer, context);
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    const workspaceEditDisposal = workspaceEdits.dispose();
    const records = [...watchers.values()];
    watchers.clear();
    for (const record of records) {
      record.listeners.clear();
      record.controller?.close();
    }
    for (const tracked of captureWatches.values()) {
      tracked.subscription.close();
      tracked.controller.close();
    }
    captureWatches.clear();
    for (const barrier of [...dirtyBarriers.values()]) {
      releaseDirtyBarrier(barrier, dirtyBarrierFailure('Document authority was disposed during a dirty-state barrier'));
    }
    dirtySurfaces.clear();
    dirtyBuffersByOwner.clear();
    for (const [requestId, operation] of pendingSurfaceOperations) {
      pendingSurfaceOperations.delete(requestId);
      operation.cleanup();
      operation.reject(new DocumentAuthorityError('Document authority was disposed during a surface operation', {
        code: 'stale-completion', statusCode: 409,
      }));
    }
    surfaceSnapshots.dispose();
    disposePromise = (async () => {
      await workspaceEditDisposal;
      await Promise.allSettled(records.map((record) => record.ready));
      await mutations.dispose();
    })();
    return disposePromise;
  };

  const workspaceEdits = createWorkspaceEditCoordinator({
    hostId,
    storage: (workspaceId, callback) => {
      if (!durableMutationStorage) throw new DocumentAuthorityError('Workspace edit storage is unavailable', { code: 'failed', statusCode: 503 });
      return durableMutationStorage(workspaceId, callback);
    },
    resources: runResourceOperation,
    inspect: async workspaceId => ({ root: (await loadWorkspace(workspaceId)).root, epoch: (await mutations.inspect(workspaceId)).epoch }),
    owner: (workspaceId, ownerId, generation) => {
      const owner = dirtySurfaces.get(dirtyBufferKey(ownerId, workspaceId));
      if (!owner || owner.generation !== generation) throw new DocumentAuthorityError('Document surface is unavailable', { code: 'stale-completion', statusCode: 409 });
      return { ownerId, generation, registrationId: owner.registrationId };
    },
    read,
    resolve: resolveResourceIdentity,
    barrier: (workspaceId, paths) => beginDirtyStateBarrier(workspaceId, paths),
    assertBarrier: barrierId => {
      const barrier = dirtyBarriers.get(barrierId);
      if (!barrier || barrier.released || barrier.pending.size > 0) throw new DocumentAuthorityError('Workspace edit barrier was lost', { code: 'stale-completion', statusCode: 409 });
    },
    captureSurfaces: async (workspaceId, scopes, owner, buffers) => {
      const result: Array<{ owner: { ownerId: string; generation: number; registrationId: string }; buffers: VarinWorkspaceEditBufferSlot[] }> = owner
        ? [{ owner, buffers: buffers.map(buffer => ({ resource: buffer.resource, buffer })) }] : [];
      for (const candidate of dirtySurfaces.values()) {
        if (candidate.workspaceId !== workspaceId || candidate.ownerId === owner?.ownerId) continue;
        const captured = await requestSurfaceOperation({ action: 'workspace-edit', workspaceId,
          ownerId: candidate.ownerId, generation: candidate.generation, registrationId: candidate.registrationId,
          operationId: randomUUID(), targets: [], workspaceEdit: { stepId: randomUUID(), mode: 'capture', epoch: 0,
            origin: 'workspace-edit-preview', before: [], after: [], captureScopes: scopes.map(scope => ({
              resource: { workspaceId, resourceId: scope.resourceId }, subtree: scope.scope === 'subtree' })) } });
        if (captured.length || !owner) result.push({ owner: { ownerId: candidate.ownerId, generation: candidate.generation, registrationId: candidate.registrationId },
          buffers: captured.map(entry => ({ resource: entry.resource, buffer: entry.workspaceEditBuffer! })) });
      }
      return result;
    },
    validateDirtyOwners: async (workspaceId, paths, surfaces) => {
      for (const publication of await inspectDirtyBuffers(workspaceId)) for (const current of publication.resources) {
        if (!paths.includes(current.resource.resourceId)) continue;
        const baseline = surfaces.find(surface => surface.owner.ownerId === publication.ownerId
          && surface.owner.registrationId === publication.registrationId && surface.owner.generation === publication.generation);
        const buffer = baseline?.buffers.find(slot => slot.resource.resourceId === current.resource.resourceId)?.buffer;
        if (!buffer || current.documentInstanceId !== buffer.documentInstanceId || current.localEditRevision !== buffer.localEditRevision
          || current.baseRevision !== buffer.baseRevision) {
          throw new DocumentAuthorityError(`A different or changed draft owns ${current.resource.resourceId}`, { code: 'stale-completion', statusCode: 409 });
        }
      }
    },
    surface: async (workspaceId, owner, barrierId, operationId, workspaceEdit) => {
      await requestSurfaceOperation({ action: 'workspace-edit', workspaceId, ...owner, barrierId, operationId, workspaceEdit, targets: [] });
    },
    mutate: async (workspaceId, epoch, operationId, callback) => {
      const writer = await mutations.registerWriter({ workspaceId, epoch, owner: { kind: 'workspace-edit', id: operationId } }, { purpose: 'workspace-edit' });
      try { return await callback(); } finally { try { await writer.markMutated(); } finally { await writer.close(); } }
    },
    notify: (workspaceId, action, reversed, operationId) => {
      if (action.rename) watcherController(workspaceId)?.publishMutation({ kind: 'moved', operationId,
        from: { workspaceId, resourceId: reversed ? action.rename.to : action.rename.from },
        resource: { workspaceId, resourceId: reversed ? action.rename.from : action.rename.to } });
      else for (const [resourceId, state] of Object.entries(reversed ? action.before : action.after)) watcherController(workspaceId)?.publishMutation({
        kind: state.kind === 'missing' ? 'deleted' : (reversed ? action.after : action.before)[resourceId]?.kind === 'missing' ? 'created' : 'changed', operationId, resource: { workspaceId, resourceId } });
      const states = reversed ? action.before : action.after;
      for (const [resourceId, state] of Object.entries(states)) publishMutation({ workspaceId, resourceId,
        kind: state.kind === 'missing' ? 'deleted' : (reversed ? action.after : action.before)[resourceId]?.kind === 'missing' ? 'created' : 'modified',
        owner: { kind: 'workspace-edit', id: 'documents' } });
    },
  });

  return {
    hostId,
    resolveWorkspace,
    lookupWorkspacePath,
    /** Resource location and trust only; does not enter the mutation ledger. */
    getWorkspace: (workspaceId: string, signal?: AbortSignal) => waitWithSignal(loadWorkspace(workspaceId), signal),
    resolveResourceIdentity,
    listWorkspaceRegistrations: () => registry.list(),
    admitWorkspaceRegistration,
    inspectWorkspace: async (workspaceId: string, options: { signal?: AbortSignal; reportPhase?: (phase: string) => void } = {}) => {
      try {
        options.signal?.throwIfAborted();
        options.reportPhase?.('workspace:resolve');
        const workspace = await waitWithSignal(loadWorkspace(workspaceId), options.signal);
        options.signal?.throwIfAborted();
        options.reportPhase?.('workspace:mutation-state');
        const rest = { ...await waitWithSignal(mutations.inspect(workspaceId, options.signal), options.signal) } as Record<string, unknown>;
        delete rest.workspaceId;
        return {
          ...rest,
          workspaceId: workspace.workspaceId,
          hostId,
          root: workspace.root,
          kind: workspace.kind,
        };
      } catch (error) {
        return fail(error);
      }
    },
    resolveScopeId,
    findContainingResourceRoot,
    findExactResourceRoot,
    ensureResourceRoot,
    registerWriterForScope,
    runMutationForScope,
    runResourceOperation,
    read,
    readSnapshot,
    readSnapshots,
    prepareWorkspaceEdit: workspaceEdits.prepare,
    discardWorkspaceEdit: async (request: { workspaceId: string; operationId: string }) => workspaceEdits.discard(request),
    applyWorkspaceEdit: workspaceEdits.apply,
    readWorkspaceEdit: workspaceEdits.read,
    readWorkspaceEditRecovery: workspaceEdits.recovery,
    undoWorkspaceEdit: workspaceEdits.undo,
    listWorkspaceEdits: workspaceEdits.list,
    reconcileWorkspaceEdits: workspaceEdits.reconcile,
    write,
    move,
    delete: remove,
    watch,
    listRecoveryJournals: (request: RecoveryJournalListRequest) => journals.list(request),
    readRecoveryJournal: (journalId: string) => journals.read(journalId),
    publishDirtyBuffers,
    clearDirtyBuffers,
    inspectDirtyBuffers,
    requestSurfaceOperation,
    readSurfaceOperation,
    completeSurfaceOperation,
    captureAgentInputSnapshot,
    releaseAgentInputSnapshot,
    cloneInputSnapshot: surfaceSnapshots.clone,
    bindDurableMutationStorage: (fn: DurableMutationStorageFn | null) => {
      durableMutationStorage = fn;
    },
    registerDirtySurface,
    beginDirtyStateBarrier,
    acknowledgeDirtyStateBarrier,
    writeRecoveryJournal: (request: RecoveryJournalWriteRequest) => journalMutation(
      request,
      'document-recovery-journal-write',
      () => journals.write(request),
    ),
    deleteRecoveryJournal: (request: RecoveryJournalDeleteRequest) => journalMutation(
      request,
      'document-recovery-journal-delete',
      () => journals.delete(request),
    ),
    mutationAuthority: mutations,
    inspectMutation: mutations.inspect,
    subscribeMutationState: mutations.subscribe,
    beginCapture,
    captureInventory,
    completeCapture,
    discardCapture,
    dispose,
    advanceEpoch: mutations.advanceEpoch,
    setMaintenance: mutations.setMaintenance,
    registerWriter: mutations.registerWriter,
    emitWatchOverflow: (workspaceId: string) => {
      const controller = watcherController(workspaceId);
      if (!controller) return false;
      controller.overflow();
      return true;
    },
    reconnectWatch: (workspaceId: string) => watcherController(workspaceId)?.reconnect(),
    emitAuthorityChanged: (workspaceId: string) => watcherController(workspaceId)?.authorityChanged(),
    hasWatch: (workspaceId: string) => Boolean(watcherController(workspaceId)),
  };
};

export type DocumentAuthority = ReturnType<typeof createDocumentAuthority>;
