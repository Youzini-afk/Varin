import { randomUUID } from 'node:crypto';
import { sourceReadError } from './source-admission-error.js';
/** Query access retains the original admitted source authority. Private derived-language
 * service contexts prepare and release Storage-owned views; they never replace a Run grant. */
import { isDeepStrictEqual } from 'node:util';
import type { DocumentAuthority } from '../documents/authority.js';
import { inspectDocumentBytes, revisionFromBytes } from '../documents/inspect.js';
import type { ExploreFileSnapshot } from '../harness/explore-file-reader.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { runKernelCompute, type KernelComputeInput, type KernelComputeOptions, type KernelComputeResult } from './compute-runner.js';
import type { LaunchSource, LiveRoot, KernelMaterializedView } from './protocol.generated.js';
import type { NativeProcessIdentity } from './process-service.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';

export type SourceComputeInput = Omit<KernelComputeInput, 'workspaceId' | 'rootId' | 'branchId' | 'revision' | 'pinId' | 'objects'>;
export interface SourceQueryAccess {
  runId: string;
  threadId: string;
  grantId: string;
  source: LaunchSource;
  physicalRoot: LiveRoot | null;
}
export interface PreparedLanguageSource {
  root: string;
  derivedView?: KernelMaterializedView;
  check(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export interface SourceQueryOwner {
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
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'admitWorkspaceRegistration'>;
  validateLiveSource: LiveSourceResolver;
}): SourceQueryOwner {
  const { kernel, documents } = options;
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
    const client = kernel.scoped(kernel.sourceGrant(query));
    await documents.admitWorkspaceRegistration(query.source.workspace_id, signal);
    if (query.source.execution_workspace_id !== query.source.workspace_id) await documents.admitWorkspaceRegistration(query.source.execution_workspace_id, signal);
    const source = query.source, root = query.physicalRoot;
    if (source.mode === 'live_root') {
      if (!source.live_root || !isDeepStrictEqual(root, source.live_root)) throw new Error('The original source root changed');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, liveRoot: root! }, signal);
    } else {
      if (source.live_root || !source.branch_id || !Number.isSafeInteger(source.revision) || source.revision! < 0) throw new Error('The original fixed source is incomplete');
      const branch = await client.readBranch({ branchId: source.branch_id, revision: source.revision!, includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
      if (branch.workspaceId !== source.workspace_id || branch.branchId !== source.branch_id
        || branch.view !== 'revision' || branch.revision !== source.revision) throw new Error('The original source revision changed');
      if (source.mode === 'fixed_branch') {
        if (root || source.environment_run_id) throw new Error('Fixed source cannot use a physical root');
      } else {
        const handshake = kernel.handshake;
        if (source.mode !== 'materialized' || !root || !handshake || root.hostId !== handshake.hostId) throw new Error('The original materialized source root is unavailable');
        const location = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? query.runId);
        const canonical = await admitMaterializedRoot(location.targetPath, signal);
        if (normalizePathIdentity(canonical) !== normalizePathIdentity(root.canonicalRoot)) throw new Error('The original materialized source location changed');
      }
    }
    signal.throwIfAborted();
    kernel.sourceGrant(query);
  };
  const validateLanguage: SourceQueryOwner['validateLanguage'] = async (query, signal) => {
    await validate(query, signal);
    // Language backends may discover imports/configuration anywhere in their cwd.
    // Inspect the original issued Run handle, never the service materialization grant.
    if (!kernel.sourceGrant(query).pathScopes.includes('')) {
      const project = query.source.mode === 'fixed_branch' ? 'fixed project' : 'source project';
      throw new Error(`The selected language backend reads the entire ${project}; the current grant only allows selected paths. Use a whole-project read grant or file_read for path-scoped access.`);
    }
  };
  const compute: SourceQueryOwner['compute'] = async (query, input, options = {}) => {
    const client = kernel.scoped(kernel.sourceGrant(query));
    const source = query.source;
    return runKernelCompute(client, { ...input, workspaceId: source.workspace_id,
      ...(source.mode === 'fixed_branch' ? { branchId: source.branch_id!, revision: source.revision! }
        : { rootId: query.physicalRoot!.rootId }) }, options);
  };
  return {
    validate, validateLanguage, compute,
    async prepareLanguageView(query, viewId, signal) {
      await validateLanguage(query, signal);
      if (query.source.mode !== 'fixed_branch') {
        if (!query.physicalRoot) throw new Error('The original source root is unavailable');
        return { root: query.physicalRoot.canonicalRoot, check: async active => { active.throwIfAborted(); }, release: async () => {} };
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
        return { root: derivedView.canonicalRoot, derivedView, release,
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
      const client = kernel.scoped(kernel.sourceGrant(query));
      if (query.source.mode === 'fixed_branch') {
        await client.readBranch({ branchId: query.source.branch_id!, revision: query.source.revision!, paths: [path], includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
      } else {
        await client.fileReadCheck({ workspaceId: query.source.workspace_id, rootId: query.physicalRoot!.rootId, path }, signal);
      }
      signal.throwIfAborted();
    },
    async routingWorkspace(query, signal) {
      signal.throwIfAborted();
      kernel.sourceGrant(query);
      // Configuration identity only. This directory never supplies fixed/materialized source bytes.
      const workspace = await documents.admitWorkspaceRegistration(query.source.workspace_id, signal);
      signal.throwIfAborted();
      return workspace.canonicalPath;
    },
    async read(query, path, signal) {
      await validate(query, signal);
      const source = query.source;
      const client = kernel.scoped(kernel.sourceGrant(query));
      const address = query.physicalRoot ? { workspaceId: source.workspace_id, rootId: query.physicalRoot.rootId, path } : null;
      const before = address ? await client.fileReadCheck(address, signal) : null;
      let result: ExploreFileSnapshot;
      if (source.mode === 'live_root') {
        const snapshot = await documents.readSnapshot({ workspaceId: source.workspace_id, resourceId: path }, { signal });
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
          source: source.mode === 'fixed_branch' ? 'working-branch' : 'disk' }
          : { status: 'unavailable', message: `The selected source is ${inspected.kind}` };
      }
      const after = address ? await client.fileReadCheck(address, signal) : null;
      await validate(query, signal);
      if (before?.resourceKey !== after?.resourceKey) return { status: 'stale', message: 'Resource identity changed during source read' };
      return result;
    },
  };
}
