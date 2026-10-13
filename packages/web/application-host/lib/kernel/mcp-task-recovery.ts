/** Reopen only the accepted Task's original endpoint. No Run restart, task listing or dispatch. */
import { McpTaskRequestError, type McpAuthority, type McpTaskLease } from '@varin/pi-host/mcp-authority';
import { createMcpOriginalOwnerRecovery } from './mcp-original-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { HostJobPending, LaunchSource, McpBinding } from './protocol.generated.js';
export function createMcpTaskRecovery(options:{
  kernel:KernelClient;authority:McpAuthority;agentDir:string;hostId:string;
  admitWorkspaceRegistration(id:string,signal?:AbortSignal):Promise<{canonicalPath:string}>;
  projectTrusted(cwd:string):boolean;
  validateLiveSource(source:LaunchSource,signal:AbortSignal):Promise<void>;
}):(pending:HostJobPending,signal:AbortSignal)=>Promise<McpTaskLease>{
  return async(pending,signal)=>{
    const subject=pending.binding.subject;
    if(subject.kind!=='mcp'||!pending.accepted||!pending.mcpTask)throw new McpTaskRequestError('mcp_task_original_identity_missing',false,'owner');
    const context=await options.kernel.agentRuntimeRequest<{threadId:string;source:LaunchSource|null;binding:McpBinding},'runtime.host_job.task.context'>(
      'runtime.host_job.task.context',{operationId:pending.binding.operationId},signal);
    const lease=await createMcpOriginalOwnerRecovery(options)(pending.runId,subject.endpoint,context,signal);
    try{return await lease.taskOwner(subject.endpoint.server,subject.endpoint,signal,{operationId:pending.binding.operationId,executionOwner:pending.binding.executionOwner});}finally{lease.release();}
  };
}
