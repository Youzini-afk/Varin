import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';
import type { IntegrationOperationReceipt } from '../harness/working-state/integration-coordinator.js';
import type { WorkingResult } from '../harness/working-state/types.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { acknowledgedCode, captureCodeSelection, codeBaseline, codeIntegration, openCodeTarget, openFixedCodeSource,
  type CodeExchangeOwners, type CodeParticipant, type CodeSelection } from './code-exchange.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import { toolOperationId, validToolOrigin } from './protocol.generated.js';
import { sourcePathMap } from './source-path-map.js';

export async function exchangeManagedCode(owners:CodeExchangeOwners,invocation:ToolInvocationAuthority,branchId:string,
  source:CodeParticipant,target:CodeParticipant,files:CodeSelection[]|undefined,signal:AbortSignal,onApply:()=>void) {
  const retained:Array<{release():Promise<void>}>=[];
  try {
    const own=source.runId===invocation.runId?source:target;
    const original=await admitRunSourceAuthority(owners.kernel,owners.runtime,
      savedSourceLaunch(own.runId,own.source,sourceToolSchemas(own.launch.selection).map(t=>t.name)),
      {signal,resolveLiveSource:owners.resolveLiveSource,purpose:'integration',operationId:invocation.operationId,retention:'caller'});
    retained.push(original);
    const open=async (participant:CodeParticipant)=>{
      if(participant.source.mode==='fixed_branch') {
        if(participant.source.resource_owner.kind!=='managed_host')throw new Error('The exchange source changed resource Host');
        const service=await owners.runtime.managedSource(participant.source.resource_owner,signal);
        const {runId:_run,...selected}=savedSourceLaunch(participant.runId,participant.source,[]);
        const bound=await service.bind({coordinatorHostId:owners.runtime.coordinatorHostId,
          source:{...selected,tools:[]},scope:{kind:'source_read',threadId:participant.member.threadId,branchId:participant.branchId,key:`code-source:${invocation.operationId}`},
          purpose:'read',retention:'caller'},signal);
        const address={coordinatorHostId:owners.runtime.coordinatorHostId,authorityId:bound.authorityId,resourceEpoch:bound.resourceEpoch};
        retained.push({release:()=>service.release({...address,mode:'retire'}).then(()=>{})});
        return {service,address};
      }
      const admitted=participant.runId===own.runId?original:await admitRunSourceAuthority(owners.kernel,owners.runtime,
        savedSourceLaunch(participant.runId,participant.source,sourceToolSchemas(participant.launch.selection).map(t=>t.name)),{signal,resolveLiveSource:owners.resolveLiveSource});
      if(admitted!==original)retained.push(admitted);
      if(admitted.kind!=='managed')throw new Error('The exchange source changed resource Host');
      const address={coordinatorHostId:owners.runtime.coordinatorHostId,authorityId:admitted.binding.authorityId,resourceEpoch:admitted.binding.resourceEpoch};
      return {service:admitted.service,address};
    };
    const sender=await open(source),receiver=await open(target);
    const {source:baseline,participant:baselineOwner}=await codeBaseline(owners.runtime,source,target,signal);
    if(!baseline.branch_id || baseline.revision===null)throw Object.assign(new Error('No common file baseline links these Agents: neither side records the fixed revision both started from, so their changes cannot be merged'),{code:'baseline_unavailable'});
    const result=await sender.service.service({...sender.address,requestId:randomUUID(),operation:{kind:'code_capture',invocation,
      mapping: await sourcePathMap(owners.runtime, source, target, signal),
      baselineMapping: await sourcePathMap(owners.runtime, baselineOwner, source, signal),
      sourceThreadId:source.member.threadId,targetThreadId:target.member.threadId,
      baselineBranchId:baseline.branch_id,baselineRevision:baseline.revision,...(files?{files}:{})}},signal) as WorkingResult;
    onApply();
    const merged=await receiver.service.service({...receiver.address,requestId:randomUUID(),
      operation:{kind:'code_apply',invocation,branchId,source,target,result}},signal) as IntegrationOperationReceipt;
    return {result,merged};
  } finally {for(const scope of retained.reverse())await scope.release().catch(error=>owners.onCleanupError(invocation.operationId,error));}
}

export function createManagedCodeExchangeService(owners:Pick<CodeExchangeOwners,'kernel'|'storage'|'documents'|'recovery'|'metadataReader'|'coordinator'>):ManagedSourceServiceHandler {
  return async(scope,operation,suppliedSignal)=>{
    if(operation.kind!=='code_capture'&&operation.kind!=='code_apply')throw new Error('Unknown code exchange operation');
    const invocation=operation.invocation;
    if(!scope.principal.capabilities.includes('filesystem:write') || !validToolOrigin(invocation.origin)
      || toolOperationId(invocation.origin,invocation.callId)!==invocation.operationId
      || !['submit_code','update'].includes(invocation.toolName)
      || invocation.source?.workspace_id!==scope.source.workspace_id
      || !isDeepStrictEqual(invocation.source.resource_owner,scope.source.resource_owner))throw new Error('The exchange differs from its original source authority');
    const signal=suppliedSignal??new AbortController().signal;
    if(scope.source.mode==='fixed_branch') {
      if(operation.kind!=='code_capture')throw new Error('该 Agent 当前保存的是固定成果；续接后即可交换改动。');
      const fixed=await openFixedCodeSource(owners,invocation,scope.source,signal);
      try {return await captureCodeSelection({store:fixed.store,workspaceId:scope.source.workspace_id,operationId:invocation.operationId,
        fixedSource:{branchId:scope.source.branch_id!,revision:scope.source.revision!},baselineBranchId:operation.baselineBranchId,
        baselineRevision:operation.baselineRevision,...(operation.files?{files:operation.files}:{}),signal,
        mapping: operation.mapping, baselineMapping: operation.baselineMapping,
        acknowledged:await acknowledgedCode(fixed.store,operation.sourceThreadId,operation.targetThreadId,
          await owners.metadataReader.listOperations(scope.source.workspace_id,'integration'))});}
      finally{await fixed.release();}
    }
    if(!scope.physicalRoot)throw new Error('Agent 的工作目录不可用');
    const selected=savedSourceLaunch(scope.scope.kind==='run'?scope.scope.runId:invocation.runId,scope.source,[]);
    const target=await openCodeTarget(owners,invocation,selected,scope.physicalRoot,signal);
    try {
      if(operation.kind==='code_capture')return captureCodeSelection({store:target.store,workspaceId:scope.source.workspace_id,ownerThreadId:operation.sourceThreadId,
        operationId:invocation.operationId,directory:target.directory,baselineBranchId:operation.baselineBranchId,
        ...(scope.source.mode==='native_workspace'?{nativeSource:scope.source,nativeWorkspaces:owners.kernel.nativeWorkspaces}:{}),
        baselineRevision:operation.baselineRevision,...(operation.files?{files:operation.files}:{}),
        mapping: operation.mapping, baselineMapping: operation.baselineMapping,
        acknowledged:await acknowledgedCode(target.store,operation.sourceThreadId,operation.targetThreadId),signal});
      if(!isDeepStrictEqual(operation.target.source,scope.source))throw new Error('The exchange target source changed');
      const input=codeIntegration(invocation,operation.branchId,operation.source,operation.target,operation.result,target,signal);
      try{return await owners.coordinator.mergeResult(input);}
      catch(error){const inspection={...input};delete inspection.signal;const receipt=await owners.coordinator.inspectIntegration(inspection);if(receipt)return receipt;throw error;}
    } finally{await target.release();}
  };
}
