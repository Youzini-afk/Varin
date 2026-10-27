import { isDeepStrictEqual } from 'node:util';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import type { ManagedProcessAdmission } from '../process/types.js';
import type { KernelClient } from './kernel-client.js';
import type { LaunchSource, LaunchIntent } from './protocol.generated.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';

/** A local MCP process belongs to the captured native source. Reopening it cannot
 * infer permission from an application-data prefix or an obsolete session registry. */
export function createMcpSourceProcessAdmission(options: {
  kernel: KernelClient;
  runId: string;
  source: LaunchSource;
  executionCwd: string;
  admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{ canonicalPath: string }>;
  validateLiveSource(source: LaunchSource, signal: AbortSignal): Promise<void>;
}): ManagedProcessAdmission {
  const source = structuredClone(options.source);
  return async signal => {
    signal.throwIfAborted();
    const original = await options.kernel.agentRuntimeRequest<LaunchIntent | null, 'runtime.launch.inspect'>('runtime.launch.inspect', { runId: options.runId }, signal);
    if (!original || !isDeepStrictEqual(original.selection.source, source) || source.resource_owner.kind !== 'local' || source.mode === 'fixed_branch') throw new Error('MCP process source is unavailable');
    await options.admitWorkspaceRegistration(source.workspace_id, signal);
    if (source.execution_workspace_id !== source.workspace_id) await options.admitWorkspaceRegistration(source.execution_workspace_id, signal);
    let canonicalRoot: string;
    if (source.mode === 'live_root') {
      await options.validateLiveSource(source, signal);
      canonicalRoot = await canonicalizePathIdentity(source.live_root!.canonicalRoot);
    } else if(source.mode==='native_workspace'){
      if(!options.kernel.nativeWorkspaces)throw new Error('Native MCP source is unavailable');
      const entry=await options.kernel.nativeWorkspaces.open(source,signal);
      canonicalRoot=(await options.kernel.nativeWorkspaces.acquire(source,entry.grant,signal)).path;
    } else {
      const handshake = options.kernel.handshake;
      if (!handshake) throw new Error('MCP process source authority is unavailable');
      const originalPath = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? options.runId);
      canonicalRoot = await admitMaterializedRoot(originalPath.targetPath, signal);
    }
    if (normalizePathIdentity(canonicalRoot) !== normalizePathIdentity(options.executionCwd)) throw new Error('MCP process source changed');
    signal.throwIfAborted();
    return { workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot };
  };
}
