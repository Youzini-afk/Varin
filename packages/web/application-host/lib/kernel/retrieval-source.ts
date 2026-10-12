/** Query-local access to the original admitted source. No registrations, grants or corpus live here. */
import { isDeepStrictEqual } from 'node:util';
import type { DocumentAuthority } from '../documents/authority.js';
import { inspectDocumentBytes, revisionFromBytes } from '../documents/inspect.js';
import type { ExploreFileSnapshot } from '../harness/explore-file-reader.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { runKernelCompute, type KernelComputeInput, type KernelComputeOptions, type KernelComputeResult } from './compute-runner.js';
import type { RetrievalQuery } from './protocol.generated.js';
import { originalMaterializationLocation } from './source-launch.js';

type SourceComputeInput = Omit<KernelComputeInput, 'workspaceId' | 'rootId' | 'branchId' | 'revision' | 'pinId' | 'objects'>;
export interface RetrievalSourceOwner {
  validate(query: RetrievalQuery, signal: AbortSignal): Promise<void>;
  read(query: RetrievalQuery, path: string, signal: AbortSignal): Promise<ExploreFileSnapshot>;
  checkPath(query: RetrievalQuery, path: string, signal: AbortSignal): Promise<void>;
  compute(query: RetrievalQuery, input: SourceComputeInput, options?: KernelComputeOptions): Promise<KernelComputeResult>;
  routingWorkspace(query: RetrievalQuery, signal: AbortSignal): Promise<string>;
}
export function createRetrievalSourceOwner(options: {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'listWorkspaceRegistrations'>;
  validateLiveSource: LiveSourceResolver;
}): RetrievalSourceOwner {
  const { kernel, documents } = options;
  const validate = async (query: RetrievalQuery, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const client = kernel.scoped(kernel.retrievalGrant(query));
    const source = query.source, root = query.physicalRoot;
    if (source.mode === 'live_root') {
      if (!source.live_root || !isDeepStrictEqual(root, source.live_root)) throw new Error('The original retrieval root changed');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, liveRoot: root! }, signal);
    } else {
      if (source.live_root || !source.branch_id || !Number.isSafeInteger(source.revision) || source.revision! < 0) throw new Error('The original fixed retrieval source is incomplete');
      const branch = await client.readBranch({ branchId: source.branch_id, revision: source.revision!, includeEntries: false }, signal);
      if (branch.workspaceId !== source.workspace_id || branch.branchId !== source.branch_id
        || branch.view !== 'revision' || branch.revision !== source.revision) throw new Error('The original retrieval revision changed');
      if (source.mode === 'fixed_branch') {
        if (root || source.environment_run_id) throw new Error('Fixed retrieval cannot use a physical root');
      } else {
        const handshake = kernel.handshake;
        if (source.mode !== 'materialized' || !root || !handshake || root.hostId !== handshake.hostId) throw new Error('The original materialized retrieval root is unavailable');
        const location = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? query.runId);
        const canonical = await canonicalizePathIdentity(location.targetPath);
        if (normalizePathIdentity(canonical) !== normalizePathIdentity(root.canonicalRoot)) throw new Error('The original materialized retrieval location changed');
      }
    }
    signal.throwIfAborted();
    kernel.retrievalGrant(query);
  };
  const compute: RetrievalSourceOwner['compute'] = async (query, input, options = {}) => {
    const client = kernel.scoped(kernel.retrievalGrant(query));
    const source = query.source;
    return runKernelCompute(client, { ...input, workspaceId: source.workspace_id,
      ...(source.mode === 'fixed_branch' ? { branchId: source.branch_id!, revision: source.revision! }
        : { rootId: query.physicalRoot!.rootId }) }, options);
  };
  return {
    validate, compute,
    async checkPath(query, path, signal) {
      signal.throwIfAborted();
      const client = kernel.scoped(kernel.retrievalGrant(query));
      if (query.source.mode === 'fixed_branch') {
        await client.readBranch({ branchId: query.source.branch_id!, revision: query.source.revision!, paths: [path], includeEntries: false }, signal);
      } else {
        await client.fileReadCheck({ workspaceId: query.source.workspace_id, rootId: query.physicalRoot!.rootId, path }, signal);
      }
      signal.throwIfAborted();
    },
    async routingWorkspace(query, signal) {
      signal.throwIfAborted();
      kernel.retrievalGrant(query);
      // Configuration identity only. This directory never supplies fixed/materialized source bytes.
      const workspace = (await documents.listWorkspaceRegistrations()).find(entry => entry.workspaceId === query.source.workspace_id);
      signal.throwIfAborted();
      if (!workspace?.canonicalPath) throw new Error('The original retrieval workspace configuration is unavailable');
      return workspace.canonicalPath;
    },
    async read(query, path, signal) {
      await validate(query, signal);
      const source = query.source;
      const client = kernel.scoped(kernel.retrievalGrant(query));
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
      if (before?.resourceKey !== after?.resourceKey) return { status: 'stale', message: 'Resource identity changed during retrieval' };
      return result;
    },
  };
}
