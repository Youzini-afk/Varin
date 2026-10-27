import path from 'node:path';
import type { ThreadFileTarget } from '@varin/application-client';
import type { LaunchSource } from './protocol.generated.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { LiveSourceResolver } from './live-source.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';
import { assertAbsolutePathInWorkspace, resolveWorkspacePath } from '../workspace/path-safety.js';

export type ThreadFileTargetResolver = (runId: string, source: LaunchSource | null, file: string, signal?: AbortSignal) => Promise<ThreadFileTarget>;

/** User file navigation uses Documents admission; it does not acquire an Agent tool grant. */
export function createThreadFileTargetResolver(options: {
  storageRoot: string;
  documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration'>;
  validateLiveSource: LiveSourceResolver;
  nativeWorkspaces?:import('./native-workspaces.js').NativeWorkspaceOwner|undefined;
}): ThreadFileTargetResolver {
  return async (runId, source, file, signal) => {
    signal?.throwIfAborted();
    if (!source) return { kind: 'unavailable', reason: 'no_source' };
    if (source.resource_owner.kind === 'managed_host') return { kind: 'unavailable', reason: 'managed_source' };
    if (source.mode === 'fixed_branch') return { kind: 'unavailable', reason: 'fixed_source' };
    let root: string;
    if (source.mode === 'live_root') {
      if (!source.live_root) throw new Error('Original workspace is unavailable');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, liveRoot: source.live_root }, signal);
      root = source.live_root.canonicalRoot;
    } else if(source.mode==='native_workspace'){
      if(!options.nativeWorkspaces)throw new Error('The original native source owner is unavailable');
      const entry=await options.nativeWorkspaces.open(source,signal);
      root=(await options.nativeWorkspaces.acquire(source,entry.grant,signal)).path;
    } else {
      const location = await originalMaterializationLocation(options.storageRoot, source.workspace_id, source.environment_run_id ?? runId);
      root = await admitMaterializedRoot(location.targetPath, signal);
    }
    const normalized = process.platform === 'win32' ? file.replace(/^\/([a-zA-Z])\//, '$1:/') : file;
    const target = await (path.isAbsolute(normalized) ? assertAbsolutePathInWorkspace(normalized, { root }) : resolveWorkspacePath(normalized, { root }));
    const workspace = await options.documents.resolveWorkspace({ path: root });
    await options.documents.admitWorkspaceRegistration(workspace.workspaceId, signal);
    signal?.throwIfAborted();
    return { kind: 'document', workspaceId: workspace.workspaceId, root, resourceId: target.relativePath };
  };
}
