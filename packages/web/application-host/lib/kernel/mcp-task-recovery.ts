/** Reopen only the accepted Task's original endpoint. No Run restart, task listing or dispatch. */
import { stat } from 'node:fs/promises';
import { McpTaskRequestError, type McpAuthority, type McpTaskLease } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import type { HostJobPending, LaunchSource, McpBinding } from './protocol.generated.js';
import { originalMaterializationLocation } from './source-launch.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
export function createMcpTaskRecovery(options:{
  kernel:KernelClient;authority:McpAuthority;agentDir:string;hostId:string;
  inspectWorkspace(id:string):Promise<{root:string}>;
  projectTrusted(cwd:string):boolean;
  validateLiveSource(source:LaunchSource,signal:AbortSignal):Promise<void>;
}):(pending:HostJobPending,signal:AbortSignal)=>Promise<McpTaskLease>{
  return async(pending,signal)=>{
    const subject=pending.binding.subject;
    if(subject.kind!=='mcp'||!pending.accepted||!pending.mcpTask)throw new McpTaskRequestError('mcp_task_original_identity_missing',false,'owner');
    const context=await options.kernel.agentRuntimeRequest<{threadId:string;source:LaunchSource|null;binding:McpBinding},'runtime.host_job.task.context'>(
      'runtime.host_job.task.context',{operationId:pending.binding.operationId},signal);
    const original=context.binding.provenance,configuration=original.configuration;
    const endpoint=subject.endpoint,server=original.servers[endpoint.server];
    if(!server||server.definition_version!==endpoint.configurationVersion||server.resource_key!==endpoint.resourceKey
      ||configuration.agent_dir!==options.agentDir)throw new McpTaskRequestError('mcp_task_original_endpoint_changed',false,'owner');
    const workspace=original.execution_scope==='workspace'&&context.source
      ?await options.inspectWorkspace(context.source.workspace_id):undefined;
    if(configuration.config_cwd!==options.agentDir&&configuration.config_cwd!==workspace?.root)throw new McpTaskRequestError('mcp_task_original_configuration_unavailable',false,'owner');
    if(configuration.project_trusted&&(!workspace||!options.projectTrusted(configuration.config_cwd)))throw new McpTaskRequestError('mcp_task_original_trust_revoked',false,'owner');
    let executionCwd=options.agentDir;
    if(original.execution_scope==='workspace'){
      const source=context.source;
      if(!workspace||!source||source.mode==='fixed_branch')throw new McpTaskRequestError('mcp_task_original_execution_view_unavailable',false,'owner');
      if(source.mode==='live_root'){
        await options.validateLiveSource(source,signal);
        executionCwd=source.live_root!.canonicalRoot;
      }else{
        const handshake=options.kernel.handshake??await options.kernel.start();
        executionCwd=(await originalMaterializationLocation(handshake.storageRoot,source.workspace_id,source.environment_run_id??pending.runId)).targetPath;
      }
      const current=await canonicalizePathIdentity(executionCwd);
      if(normalizePathIdentity(current)!==normalizePathIdentity(executionCwd)||!(await stat(current)).isDirectory())throw new McpTaskRequestError('mcp_task_original_execution_view_unavailable',false,'owner');
    }
    const lease=await options.authority.acquire({agentDir:configuration.agent_dir,configCwd:configuration.config_cwd,
      projectTrusted:configuration.project_trusted,executionCwd,executionScope:original.execution_scope,
      environmentId:workspace?`${options.hostId}:${context.source!.execution_workspace_id}`:`${options.hostId}:global`,sessionId:`agent:${context.threadId}`},
      {servers:[endpoint.server],signal,provenance:{...original,servers:{[endpoint.server]:server}}});
    try{return await lease.taskOwner(endpoint.server,endpoint,signal);}finally{lease.release();}
  };
}
