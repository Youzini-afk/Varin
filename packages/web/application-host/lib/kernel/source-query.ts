import { randomUUID } from 'node:crypto';
import { sourceReadError } from './source-admission-error.js';
/** Query access retains the original admitted source authority. Private derived-language
 * service contexts prepare and release Storage-owned views; they never replace a Run grant. */
import { isDeepStrictEqual } from 'node:util';
import type { DocumentAuthority } from '../documents/authority.js';
import { inspectDocumentBytes, revisionFromBytes } from '../documents/inspect.js';
import type { ExploreFileSnapshot } from '../harness/file-snapshot.js';
import { normalizePathIdentity, stripWindowsNamespacePrefix } from '../workspace/path-safety.js';
import type { KernelClient, KernelGrantHandle } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { runKernelCompute, type KernelComputeInput, type KernelComputeOptions, type KernelComputeResult } from './compute-runner.js';
import type { LaunchSource, LiveRoot, KernelMaterializedView } from './protocol.generated.js';
import type { SourceServiceOperation, SourceServiceResponse } from '../harness/managed-remote-types.js';
import type { NativeProcessIdentity } from './process-service.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';
import { ManagedSourceDrainedError } from '../harness/managed-source-drain.js';

export type SourceComputeInput = Omit<KernelComputeInput, 'workspaceId' | 'rootId' | 'branchId' | 'revision' | 'pinId' | 'objects'>;
export interface SourceQueryAccess {
  runId?: string;
  threadId: string;
  grantId?: string;
  source: LaunchSource;
  physicalRoot: LiveRoot | null;
}
export interface PreparedLanguageSource {
  root: string;
  derivedView?: KernelMaterializedView;
  check(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export interface ManagedSourceQueryTransport {
  service<Operation extends SourceServiceOperation>(query: SourceQueryAccess, operation: Operation, signal?: AbortSignal): Promise<SourceServiceResponse<Operation>>;
}
export interface SourceQueryOwner {
  pathScopes(query: SourceQueryAccess, signal: AbortSignal): Promise<readonly string[]>;
  prepareLanguageView(query: SourceQueryAccess, viewId: string, signal: AbortSignal): Promise<PreparedLanguageSource>;
  dispose(): Promise<void>;
  validate(query: SourceQueryAccess, signal: AbortSignal): Promise<void>;
  validateLanguage(query: SourceQueryAccess, signal: AbortSignal): Promise<void>;
  read(query: SourceQueryAccess, path: string, signal: AbortSignal): Promise<ExploreFileSnapshot>;
  checkPath(query: SourceQueryAccess, path: string, signal: AbortSignal): Promise<void>;
  compute(query: SourceQueryAccess, input: SourceComputeInput, options?: KernelComputeOptions): Promise<KernelComputeResult>;
  routingWorkspace(query: SourceQueryAccess, signal: AbortSignal): Promise<string>;
  /** Trusted Host callback; never a JSON permission or a caller-selected cwd. */
  processAdmission(query: SourceQueryAccess, view?: PreparedLanguageSource): (signal: AbortSignal) => Promise<NativeProcessIdentity>;
}
export function createSourceQueryOwner(options: {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'admitWorkspaceRegistration'> & Partial<Pick<DocumentAuthority, 'resolveWorkspace'>>;
  validateLiveSource: LiveSourceResolver;
  remote?: ManagedSourceQueryTransport;
  /** Target-only, already admitted native handle; never decoded from a query payload. */
  targetAuthority?: { grant(query: SourceQueryAccess): KernelGrantHandle };
}): SourceQueryOwner {
  const { kernel, documents } = options;
  // Language servers use ordinary file URLs and module resolution paths. Rust's
  // Windows namespace spelling remains in the source identity, not the server cwd.
  const languageRoot = (root: string) => process.platform === 'win32' ? stripWindowsNamespacePrefix(root) : root;
  const targetQueries = options.targetAuthority !== undefined;
  const managed = (query: SourceQueryAccess) => query.source.resource_owner.kind === 'managed_host' && !options.targetAuthority;
  const immutable = (query: SourceQueryAccess) => query.source.mode === 'fixed_branch'
    || query.source.mode === 'materialized' && !query.physicalRoot;
  const service = async <Operation extends SourceServiceOperation>(query: SourceQueryAccess, operation: Operation, signal?: AbortSignal): Promise<SourceServiceResponse<Operation>> => {
    if (!options.remote) throw new Error('The original managed source service is unavailable');
    return await options.remote.service(query, operation, signal);
  };
  const sourceGrant = (query: SourceQueryAccess): KernelGrantHandle => {
    if (managed(query)) throw new Error('A managed source has no local resource grant');
    if (options.targetAuthority) return options.targetAuthority.grant(query);
    if (!query.runId || !query.grantId) throw new Error('The original source Run authority is required');
    return kernel.sourceGrant({ ...query, runId: query.runId, grantId: query.grantId });
  };
  // Credentials for the Host-owned physical resource only. Run admission stays
  // separate, and these handles are never included in a Run or tool binding.
  const contexts = new Map<string, Promise<{ client: ReturnType<KernelClient['scoped']>; grantId: string }>>();
  const context = async (query: SourceQueryAccess) => {
    const key = JSON.stringify([kernel.kernelEpoch, query.source.workspace_id, query.source.execution_workspace_id]);
    let pending = contexts.get(key);
    if (!pending) {
      pending = kernel.issueGrant({ grantId: `language-view-host:${randomUUID()}`,
        owningWorkspace: query.source.workspace_id, executionWorkspace: query.source.execution_workspace_id,
        capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }).then(grant => ({ client: kernel.scoped(grant), grantId: grant.grantId }));
      contexts.set(key, pending);
      void pending.catch(() => { if (contexts.get(key) === pending) contexts.delete(key); });
    }
    return pending;
  };
  const validate = async (query: SourceQueryAccess, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (managed(query)) { await service(query, { kind: 'validate' }, signal); return; }
    const client = kernel.scoped(sourceGrant(query));
    await documents.admitWorkspaceRegistration(query.source.workspace_id, signal);
    if (query.source.execution_workspace_id !== query.source.workspace_id) await documents.admitWorkspaceRegistration(query.source.execution_workspace_id, signal);
    const source = query.source, root = query.physicalRoot;
    if (source.mode === 'live_root') {
      if (!source.live_root || !root || root.hostId !== source.live_root.hostId || root.rootId !== source.live_root.rootId
        || normalizePathIdentity(root.canonicalRoot) !== normalizePathIdentity(source.live_root.canonicalRoot)) throw new Error('The original source root changed');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, liveRoot: root! }, signal);
    } else if(source.mode==='native_workspace'){
      if(!root||!kernel.nativeWorkspaces)throw new Error('Native source mount is unavailable');
      const actual=await kernel.nativeWorkspaces.acquire(source,sourceGrant(query),signal);
      if(root.rootId!==actual.rootId||normalizePathIdentity(root.canonicalRoot)!==normalizePathIdentity(actual.path))throw new Error('Native source mount generation changed');
    } else {
      if (source.live_root || !source.branch_id || !Number.isSafeInteger(source.revision) || source.revision! < 0) throw new Error('The original fixed source is incomplete');
      const branch = await client.readBranch({ branchId: source.branch_id, revision: source.revision!, includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
      if (branch.workspaceId !== source.workspace_id || branch.branchId !== source.branch_id
        || branch.view !== 'revision' || branch.revision !== source.revision) throw new Error('The original source revision changed');
      if (source.mode === 'fixed_branch') {
        if (root || source.environment_run_id) throw new Error('Fixed source cannot use a physical root');
      } else {
        const handshake = kernel.handshake;
        if (source.mode !== 'materialized' || !handshake || root && root.hostId !== handshake.hostId) throw new Error('The original materialized source root is unavailable');
        const location = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? query.runId ?? '');
        if (root) {
          const canonical = await admitMaterializedRoot(location.targetPath, signal);
          if (normalizePathIdentity(canonical) !== normalizePathIdentity(root.canonicalRoot)) throw new Error('The original materialized source location changed');
        } else if ((await client.getOperation(`source-materialize:${location.key}`, signal))?.state === 'committed') {
          throw new Error('The source gained its physical execution view; obtain a current source descriptor');
        }
      }
    }
    signal.throwIfAborted();
    sourceGrant(query);
  };
  const validateLanguage: SourceQueryOwner['validateLanguage'] = async (query, signal) => {
    if (managed(query)) throw new Error('Managed language requests must use the original target language owner');
    await validate(query, signal);
    // Language backends may discover imports/configuration anywhere in their cwd.
    // Inspect the original issued Run handle, never the service materialization grant.
    if (!sourceGrant(query).pathScopes.includes('')) {
      const project = query.source.mode === 'fixed_branch' ? 'fixed project' : 'source project';
      throw new Error(`The selected language backend reads the entire ${project}; the current grant only allows selected paths. Use a whole-project read grant or file_read for path-scoped access.`);
    }
  };
  const compute: SourceQueryOwner['compute'] = async (query, input, options = {}) => {
    if (managed(query)) {
      const result = await service(query, { kind: 'compute', input: { ...input, jobId: `compute:${randomUUID()}` } }, options.signal);
      if (options.onRecords) await options.onRecords(result.records);
      return options.collect === false ? { ...result, records: [] } : result;
    }
    const client = kernel.scoped(sourceGrant(query));
    const source = query.source;
    let drained = false;
    try {
      return await runKernelCompute(client, { ...input, workspaceId: source.workspace_id,
        ...(immutable(query) ? { branchId: source.branch_id!, revision: source.revision! }
          : { rootId: query.physicalRoot!.rootId }) }, { ...options, onDrained: () => {
            drained = true; options.onDrained?.();
          } });
    } catch (error) {
      // Only the admitted target needs an in-process drain projection. All
      // existing local consumers retain their original exception unchanged.
      if (targetQueries && drained) throw new ManagedSourceDrainedError(error);
      throw error;
    }
  };
  return {
    validate, validateLanguage, compute,
    async pathScopes(query, signal) {
      if (managed(query)) {
        const result = await service(query, { kind: 'validate' }, signal);
        if (!Array.isArray(result.pathScopes) || result.pathScopes.some(path => typeof path !== 'string')) throw new Error('Managed source returned invalid path scopes');
        return result.pathScopes;
      }
      signal.throwIfAborted(); return sourceGrant(query).pathScopes;
    },
    async prepareLanguageView(query, viewId, signal) {
      await validateLanguage(query, signal);
      if (query.source.mode !== 'fixed_branch') {
        if (!query.physicalRoot) throw new Error('The original source root is unavailable');
        return { root: languageRoot(query.physicalRoot.canonicalRoot), check: async active => { active.throwIfAborted(); }, release: async () => {} };
      }
      const { client } = await context(query);
      await validateLanguage(query, signal);
      const address = { workspaceId: query.source.workspace_id, viewId };
      const release = async () => { await client.materializedViewRelease(address); };
      try {
        const derivedView = await client.materializedViewPrepare({ ...address, executionWorkspaceId: query.source.execution_workspace_id,
          branchId: query.source.branch_id!, revision: query.source.revision! }, signal);
        if (derivedView.branchId !== query.source.branch_id || derivedView.revision !== query.source.revision
          || derivedView.viewId !== viewId || derivedView.kernelEpoch !== kernel.kernelEpoch) throw new Error('Derived source view changed during preparation');
        return { root: languageRoot(derivedView.canonicalRoot), derivedView, release,
          async check(active) {
            active.throwIfAborted();
            const checked = await client.materializedViewCheck(address, active);
            if (!isDeepStrictEqual(derivedView, checked)) throw new Error('Derived source view identity changed');
          } };
      } catch (error) {
        // Native cancellation settles only after its materialization worker stops.
        // The independent service context can release after the Run grant retires.
        await release();
        throw error;
      }
    },
    async dispose() {
      const owned = [...contexts.values()];
      contexts.clear();
      if (kernel.isReady) await Promise.all(owned.map(async pending => kernel.retireGrant((await pending).grantId)));
    },
    processAdmission(query, view) {
      return async signal => {
        await validateLanguage(query, signal);
        if (view) await view.check(signal);
        const root = view?.root ?? query.physicalRoot?.canonicalRoot;
        if (!root || (query.source.mode === 'fixed_branch' && !view?.derivedView)) throw new Error('Language process requires the admitted source view');
        return { workspaceId: query.source.workspace_id, executionWorkspaceId: query.source.execution_workspace_id, canonicalRoot: root };
      };
    },
    async checkPath(query, path, signal) {
      signal.throwIfAborted();
      if (managed(query)) { await service(query, { kind: 'check_path', path }, signal); return; }
      const client = kernel.scoped(sourceGrant(query));
      if (immutable(query)) {
        await client.readBranch({ branchId: query.source.branch_id!, revision: query.source.revision!, paths: [path], includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
      } else {
        await client.fileReadCheck({ workspaceId: query.source.workspace_id, rootId: query.physicalRoot!.rootId, path }, signal);
      }
      signal.throwIfAborted();
    },
    async routingWorkspace(query, signal) {
      signal.throwIfAborted();
      if (managed(query)) return service(query, { kind: 'routing_workspace' }, signal);
      sourceGrant(query);
      // Source coordinate only. Consumers choose configuration at its actual Host owner.
      const workspace = await documents.admitWorkspaceRegistration(query.source.workspace_id, signal);
      signal.throwIfAborted();
      return workspace.canonicalPath;
    },
    async read(query, path, signal) {
      if (managed(query)) return service(query, { kind: 'read', path }, signal);
      await validate(query, signal);
      const source = query.source;
      const client = kernel.scoped(sourceGrant(query));
      const address = query.physicalRoot ? { workspaceId: source.workspace_id, rootId: query.physicalRoot.rootId, path } : null;
      const before = address ? await client.fileReadCheck(address, signal) : null;
      let result: ExploreFileSnapshot;
      if (source.mode === 'live_root') {
        let workspaceId = source.workspace_id;
        const owning = await documents.admitWorkspaceRegistration(workspaceId, signal);
        if (normalizePathIdentity(owning.canonicalPath) !== normalizePathIdentity(source.live_root!.canonicalRoot)) {
          if (!documents.resolveWorkspace) throw new Error('Scoped source document admission is unavailable');
          workspaceId = (await documents.resolveWorkspace({ path: source.live_root!.canonicalRoot })).workspaceId;
          const selected = await documents.admitWorkspaceRegistration(workspaceId, signal);
          if (normalizePathIdentity(selected.canonicalPath) !== normalizePathIdentity(source.live_root!.canonicalRoot)) throw new Error('Scoped source document root changed');
        }
        const snapshot = await documents.readSnapshot({ workspaceId, resourceId: path }, { signal });
        result = snapshot.status === 'ready' ? { status: 'ready', content: snapshot.content, revision: snapshot.revision, source: 'disk' }
          : { status: 'unavailable', message: `Source text is unavailable (${snapshot.status})` };
      } else {
        // A single native capture supplies all pages, retaining its actual reader until drain.
        // The explicit range avoids the bytes operation's default 64 KiB partial read.
        const parts: Buffer[] = [];
        let offset = 0, byteLength: number | undefined, revision: string | undefined;
        const page = await compute(query, { operation: 'bytes', lane: 'foreground', paths: [path], files: [{ path }],
          includeHidden: true, respectGitignore: false, byteLength: Number.MAX_SAFE_INTEGER }, { signal, collect: false, onRecords(records) {
          for (const record of records) {
            if (record.kind !== 'bytes') continue;
            if (record.path !== path || !record.data || typeof record.data !== 'object') throw new Error('The original source reader changed its path');
            const data = record.data as Record<string, unknown>;
            if (!Number.isSafeInteger(data.byteLength) || Number(data.byteLength) < 0 || data.offset !== offset
              || typeof data.bytesBase64 !== 'string' || (revision !== undefined && revision !== record.revision)
              || (byteLength !== undefined && byteLength !== data.byteLength)) throw new Error('The original source reader returned incomplete pages');
            const bytes = Buffer.from(data.bytesBase64, 'base64');
            revision = record.revision; byteLength = Number(data.byteLength); offset += bytes.byteLength;
            if (offset > byteLength) throw new Error('The original source reader exceeded its bytes');
            parts.push(bytes);
          }
        } });
        if (!['ready', 'empty'].includes(page.status) || byteLength === undefined || offset !== byteLength || !revision) {
          return { status: 'unavailable', message: page.message ?? 'The selected source is missing or is not a regular readable file' };
        }
        const bytes = Buffer.concat(parts), inspected = inspectDocumentBytes(bytes);
        if (revisionFromBytes(bytes) !== revision) throw new Error('The original source reader revision differs from its bytes');
        result = inspected.kind === 'text' ? { status: 'ready', content: inspected.content, revision,
          source: immutable(query) ? 'working-branch' : 'disk' }
          : { status: 'unavailable', message: `The selected source is ${inspected.kind}` };
      }
      const after = address ? await client.fileReadCheck(address, signal) : null;
      await validate(query, signal);
      if (before?.resourceKey !== after?.resourceKey) return { status: 'stale', message: 'Resource identity changed during source read' };
      return result;
    },
  };
}
