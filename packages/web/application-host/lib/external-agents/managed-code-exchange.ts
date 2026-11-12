/** Capture and apply stay on the actual Source Host; the coordinator carries receipts only. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ExternalChild, LaunchSource } from '../kernel/protocol.generated.js';
import type { CodeExchangeOwners, CodeParticipant, CodeSelection } from '../kernel/code-exchange.js';
import type { ToolInvocationAuthority } from '../kernel/tool-invocation.js';
import type { ToolExecutionReceipt } from '../kernel/tool-bridge.js';
import type { WorkingResult } from '../harness/working-state/types.js';
import type { IntegrationOperationReceipt } from '../harness/working-state/integration-coordinator.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from '../kernel/source-launch.js';
import { integrationCompletion } from '../kernel/integration-tool-owner.js';
import { sourcePathMap, mapSourcePath } from '../kernel/source-path-map.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { scopedMapping } from './code-exchange.js';
import { record } from './transport.js';

export async function exchangeRemoteExternalCode(owners:CodeExchangeOwners,caller:ToolInvocationAuthority,self:CodeParticipant,
  child:ExternalChild,direction:'receive'|'send',files:CodeSelection[]|undefined,signal:AbortSignal,
  options:{frozen?:WorkingResult;defer?:(result:WorkingResult)=>Promise<ToolExecutionReceipt>}):Promise<ToolExecutionReceipt> {
  const retained:Array<{release():Promise<void>}>=[];
  let dispatched=false;
  try {
    const saved=record(child.source),project=record(saved.projectSource),prepared=record(saved.baseline);
    const selected=saved.executionSource??saved.nativeSource??(project.resourceOwner?{
      resource_owner:project.resourceOwner,workspace_id:project.workspaceId,execution_workspace_id:project.executionWorkspaceId,
      mode:project.mode,branch_id:project.branchId??null,revision:project.revision??null,live_root:project.liveRoot??null,
      ...(project.nativeScope?{native_scope:project.nativeScope}:{})}:prepared.source);
    const externalSource=selected as LaunchSource|undefined;
    if(!externalSource||externalSource.resource_owner.kind!=='managed_host'||self.source.resource_owner.kind!=='managed_host'
      ||externalSource.workspace_id!==self.source.workspace_id||!isDeepStrictEqual(externalSource.resource_owner,self.source.resource_owner))
      throw new Error('These sources belong to different original resource owners or workspaces');
    const toSelf=child.handoff?scopedMapping(await sourcePathMap(owners.runtime,
      {runId:child.handoff.source_run_id??child.parent_run_id,source:child.handoff.source},self,signal),child.handoff.source_path??'')
      :await sourcePathMap(owners.runtime,{runId:child.parent_run_id,source:(prepared.origin as LaunchSource|undefined)??externalSource,frozenOrigin:true},self,signal);
    const mapping=direction==='receive'?toSelf:{from:toSelf.to,to:toSelf.from};
    if(files?.some(file=>!mapSourcePath(typeof file==='string'?file:file.path,mapping)))throw new Error('A selected file is outside the receiving source');
    const own=await admitRunSourceAuthority(owners.kernel,owners.runtime,
      savedSourceLaunch(self.runId,self.source,sourceToolSchemas(self.launch.selection).map(tool=>tool.name)),
      {signal,resolveLiveSource:owners.resolveLiveSource,purpose:'integration',operationId:caller.operationId,retention:'caller'});
    retained.push(own);
    if(own.kind!=='managed')throw new Error('Original exchange source owner changed');
    const service=own.service;
    const ownAddress={coordinatorHostId:owners.runtime.coordinatorHostId,authorityId:own.binding.authorityId,resourceEpoch:own.binding.resourceEpoch};
    const {runId:_attribution,...source}=savedSourceLaunch(caller.runId,externalSource,[]);
    // This is a source-read lease for the real external conversation, not a
    // fictitious external Run. File effects retain the original caller operation.
    const external=await service.bind({coordinatorHostId:owners.runtime.coordinatorHostId,source:{...source,tools:[]},
      scope:{kind:'source_read',threadId:child.conversation_id,branchId:externalSource.branch_id??child.parent_branch_id,
        key:`external-code:${caller.operationId}:${direction}`},purpose:'read',retention:'caller'},signal);
    const externalAddress={coordinatorHostId:owners.runtime.coordinatorHostId,authorityId:external.authorityId,resourceEpoch:external.resourceEpoch};
    retained.push({release:()=>service.release({...externalAddress,mode:'retire'}).then(()=>{})});
    if(saved.kind==='shared'&&external.physicalRoot&&own.binding.physicalRoot){
      const a=normalizePathIdentity(external.physicalRoot.canonicalRoot),b=normalizePathIdentity(own.binding.physicalRoot.canonicalRoot);
      if(a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`))return {executor_stopped:true,completion:{kind:'result',outcome:'succeeded',effect:'none',
        content:{data:{status:'shared_source',message:'Both Agents use the same writable source; changes already apply there.'},parts:[]}}};
    }
    const baseline=record(record(prepared.pin).source);
    if(typeof baseline.branch_id!=='string'||typeof baseline.revision!=='number')throw new Error('This external source has no original isolated baseline');
    let result=options.frozen;
    if(!result)result=await service.service({...(direction==='receive'?externalAddress:ownAddress),requestId:randomUUID(),operation:{kind:'code_capture',invocation:caller,
      sourceThreadId:direction==='receive'?child.conversation_id:caller.threadId,targetThreadId:direction==='receive'?caller.threadId:child.conversation_id,
      baselineBranchId:baseline.branch_id,baselineRevision:baseline.revision,mapping,baselineMapping:direction==='receive'?{from:'',to:''}:toSelf,
      ...(files?{files}:{})}},signal) as WorkingResult;
    if(!result.root||result.branchId!==`code-exchange:${caller.operationId}`)throw new Error('Original external capture receipt changed');
    if(options.defer)return options.defer(result);
    dispatched=true;
    const merged=await service.service({...(direction==='receive'?ownAddress:externalAddress),requestId:randomUUID(),operation:{kind:'external_code_apply',
      invocation:caller,self,child,direction,externalSource,result}},signal) as IntegrationOperationReceipt;
    return integrationCompletion(merged);
  } catch(error) {
    return {executor_stopped:!dispatched,completion:{kind:'result',outcome:dispatched?'indeterminate':'failed',effect:dispatched?'unknown':'none',
      content:{data:{code:'external_code_exchange_failed',message:error instanceof Error?error.message:String(error)},parts:[]}}};
  } finally {for(const lease of retained.reverse())await lease.release().catch(error=>owners.onCleanupError(caller.operationId,error));}
}
