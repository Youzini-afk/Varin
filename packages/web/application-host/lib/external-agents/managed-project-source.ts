/** A remote project baseline stays in the original prepared branch owner. */
import { createHash, randomUUID } from 'node:crypto';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from '../kernel/storage-adapter.js';
import { record } from './transport.js';
import { nativeExecutionWorkspaceId } from '../kernel/native-workspaces.js';
import type { ManagedExternalProjectSourceRequest, ManagedExternalProjectSourceResult, ManagedSourcePrincipal } from '../harness/managed-remote-types.js';

export function createManagedExternalProjectSourceOwner(deps: { kernel:KernelClient; storage:KernelStorageAdapter; hostId:string }) {
  return async (principal:ManagedSourcePrincipal, input:ManagedExternalProjectSourceRequest, signal?:AbortSignal):Promise<ManagedExternalProjectSourceResult> => {
    const {source,identity,key}=input;
    if (!principal.principalId || !input.coordinatorHostId || identity.runtime!=='agent' || !identity.threadId || !identity.branchId
      || !key.startsWith('external-project:') || !key.slice('external-project:'.length)
      || !['baseline','remove'].includes(input.action) || source.resource_owner.kind!=='managed_host' || source.resource_owner.hostId!==deps.hostId
      || source.mode!=='native_workspace' || source.native_scope || !principal.capabilities.includes('filesystem:read')
      || input.action==='remove'&&!principal.capabilities.includes('filesystem:write')) throw new Error('External project source authority changed');
    // The same two hashes used by Source.prepare and Thread source preparation.
    // Neither a caller-supplied UUID nor a matching path can substitute for them.
    const targetKey=createHash('sha256').update(JSON.stringify([principal.principalId,input.coordinatorHostId,key])).digest('hex');
    const branch=`source:${createHash('sha256').update(JSON.stringify([identity.threadId,identity.branchId,targetKey])).digest('hex')}`;
    if(source.branch_id!==branch || source.execution_workspace_id!==nativeExecutionWorkspaceId(branch)) throw new Error('External project preparation identity changed');
    const pinId=`external-project-pin:${key.slice('external-project:'.length)}`;
    const grant=await deps.kernel.issueGrant({grantId:`external-project-owner:${randomUUID()}`,threadId:identity.threadId,
      owningWorkspace:source.workspace_id,executionWorkspace:source.execution_workspace_id,
      capabilities:['storage.read','storage.write','storage.maintenance'],pathScopes:['']},signal);
    try {
      const store=new KernelWorkingStateRootStore(await deps.storage.contextFromBranchGrant({grant,
        owningWorkspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id}));
      const original=await store.readOriginalSource(branch,signal?{signal}:{});
      if(!original) throw new Error('External project has no original preparation receipt');
      if(input.action==='baseline') {
        const pin=await store.pinBranchHandoff!(branch,pinId,{revision:0,...(signal?{signal}:{})});
        if(pin.root!==original.root)throw new Error('External project baseline changed');
        const checkpoint=await deps.kernel.scoped(grant).getOperation(`source-snapshot:${branch.slice('source:'.length)}`,signal);
        const frozen=record(record(checkpoint?.result).filesystem);
        const origin=checkpoint?.kind==='workspace.checkpoint.fork'&&checkpoint.state==='committed'
          &&typeof frozen.sourceBranchId==='string'&&typeof frozen.sourcePath==='string'
          ? {...source,branch_id:frozen.sourceBranchId,execution_workspace_id:nativeExecutionWorkspaceId(frozen.sourceBranchId),
              ...(frozen.sourcePath?{native_scope:frozen.sourcePath}:{})}:undefined;
        return {status:'baseline',baseline:{source,pin:{pin_id:pin.pinId,root:pin.root,
          source:{...source,mode:'fixed_branch',revision:0}},provenance:original.provenance,...(origin?{origin}:{})}};
      }
      // Only release the external consumer's immutable pin. The prepared branch
      // and mount may still be owned by its parent or another saved conversation.
      await deps.kernel.scoped(grant).unpinBranch({operationId:`external-project-unpin:${key}`,branchId:branch,pinId},signal);
      return {status:'removed'};
    } finally {await deps.kernel.revokeGrant(grant.grantId);}
  };
}
