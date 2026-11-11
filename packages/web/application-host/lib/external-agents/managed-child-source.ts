/** Target-side adapter to the existing child handoff and source materializer. */
import { isDeepStrictEqual } from 'node:util';
import { nativeExecutionWorkspaceId } from '../kernel/native-workspaces.js';
import { record } from './transport.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ManagedExternalChildSourceRequest, ManagedExternalChildSourceResult, ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import type { createExternalSourceOwner } from './source.js';
export function createManagedExternalChildSourceOwner(deps:{kernel:KernelClient;hostId:string;sources:ReturnType<typeof createExternalSourceOwner>}) {
  return async(principal:ManagedSourcePrincipal,input:ManagedExternalChildSourceRequest,signal?:AbortSignal):Promise<ManagedExternalChildSourceResult>=>{
    const {child}=input, handoff=child.handoff;
    const execution=child.dispatch_operation_id??child.operation_id;
    if(!principal.principalId||!input.coordinatorHostId||!handoff||child.project_source
      || child.conversation_id!==`external:child:${execution}`||handoff.operation_id!==`child-source-handoff:${execution}`
      ||handoff.source.resource_owner.kind!=='managed_host'||handoff.source.resource_owner.hostId!==deps.hostId
      ||!['prepare','release','remove'].includes(input.action))throw new Error('External child handoff identity changed');
    const original=await deps.kernel.sourceRequest('source.authority.handoff',{principalId:principal.principalId,
      coordinatorHostId:input.coordinatorHostId,operationId:execution,parentRunId:handoff.source_run_id??child.parent_run_id,
      parentThreadId:child.parent_thread_id,source:handoff.source},signal);
    if(!isDeepStrictEqual(original,handoff))throw new Error('External child has no original authenticated handoff');
    const authority = { principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId };
    if(input.action==='prepare') {
      // Reconstruct from the authenticated handoff. A request's cached cwd or
      // nativeSource is not permission to open an arbitrary target directory.
      const prepared=await deps.sources.prepare({...child,source:null,resources_released:false},signal??new AbortController().signal,authority);
      const native=prepared.nativeSource as import('../kernel/protocol.generated.js').LaunchSource|undefined;
      const executionSource=native??(child.work_mode==='shared' ? {...handoff.source,
        ...(handoff.source.mode==='live_root'&&(handoff.root.kind==='physical'||handoff.root.kind==='derived')?{live_root:handoff.root.root}:{})}
        : {...handoff.source,mode:'materialized' as const,branch_id:`child-source:${execution}`,revision:0,
          environment_run_id:child.conversation_id,live_root:null});
      return {status:'prepared',source:{...prepared,executionSource}};
    }
    const cached=record(record(child.source).nativeSource);
    if(input.action==='remove'&&child.work_mode==='isolated_write'&&cached.mode==='native_workspace'&&(cached.branch_id!==`child-source:${execution}`
      ||cached.workspace_id!==handoff.source.workspace_id||cached.execution_workspace_id!==nativeExecutionWorkspaceId(`child-source:${execution}`)))
      throw new Error('External cleanup source differs from its original preparation');
    if(input.action==='release')await deps.sources.release(child,signal??new AbortController().signal,authority);
    else await deps.sources.remove(child,input.unstarted??false);
    return {status:'released'};
  };
}
