import { expect, test, vi } from 'vitest';
import { createExternalSourceOwner } from './source.js';
import { createManagedExternalProjectSourceOwner } from './managed-project-source.js';
import type { ExternalChild } from '../kernel/protocol.generated.js';

const remote={kind:'managed_host' as const,hostId:'remote',connectionId:'configured',endpointIdentity:'endpoint'};
const child={operation_id:'external-operation',parent_thread_id:'parent',parent_branch_id:'main',work_mode:'isolated_write',
  project_source:{kind:'project',project:{id:'remote-project',name:'Remote',path:'/same',resource_owner:remote},source_path:null},source:null} as unknown as ExternalChild;

test('remote independent project baselines and cleanup stay on their actual source owner', async () => {
  const source={resourceOwner:remote,workspaceId:'workspace',executionWorkspaceId:'execution',mode:'native_workspace' as const,branchId:'prepared'};
  const selected={resource_owner:remote,workspace_id:'workspace',execution_workspace_id:'execution',mode:'native_workspace' as const,
    branch_id:'prepared',revision:null,live_root:null};
  const provenance={consistency:'fixed-root',root:'original'};
  const baseline={source:selected,pin:{pin_id:'original-pin',root:'original',source:{...selected,mode:'fixed_branch',revision:0}},provenance};
  const externalProjectSource=vi.fn(async(input:{action:string})=>input.action==='baseline'?{status:'baseline',baseline}:{status:'removed'});
  const issueGrant=vi.fn();
  const prepareProjectSource=vi.fn(async()=>({path:'/target/only',source,provenance}));
  const owner=createExternalSourceOwner({kernel:{issueGrant} as never,storage:{} as never,capture:{} as never,
    prepareProjectSource:prepareProjectSource as never,managed:{coordinatorHostId:'coordinator',source:async()=>({externalProjectSource} as never)}});
  const prepared=await owner.prepare(child,new AbortController().signal);
  expect(prepared.cwd).toBe('/target/only');
  expect((prepared as {baseline?:unknown}).baseline).toEqual(baseline);
  expect(externalProjectSource).toHaveBeenCalledWith(expect.objectContaining({action:'baseline',source:selected,
    key:'external-project:external-operation',identity:{runtime:'agent',threadId:'parent',branchId:'main'}}),expect.any(AbortSignal));
  await owner.remove({...child,source:prepared});
  expect(externalProjectSource).toHaveBeenLastCalledWith(expect.objectContaining({action:'remove',source:selected}));
  expect(issueGrant).not.toHaveBeenCalled();
});

test('remote shared project preparation does not register its path on the coordinator',async()=>{
  const issueGrant=vi.fn();
  const source={resourceOwner:remote,workspaceId:'workspace',executionWorkspaceId:'workspace',mode:'live_root' as const,
    liveRoot:{hostId:'remote',rootId:'remote-root',canonicalRoot:'/same'}};
  const owner=createExternalSourceOwner({kernel:{issueGrant} as never,storage:{} as never,capture:{} as never,
    prepareProjectSource:async()=>({path:'/same',source}) as never});
  const prepared=await owner.prepare({...child,work_mode:'shared'},new AbortController().signal);
  expect((prepared as {projectSource?:unknown}).projectSource).toEqual(source);
  expect(issueGrant).not.toHaveBeenCalled();
});

test('target baseline owner rejects caller-chosen branch identities before minting a grant',async()=>{
  const issueGrant=vi.fn();
  const owner=createManagedExternalProjectSourceOwner({kernel:{issueGrant} as never,storage:{} as never,hostId:'remote'});
  await expect(owner({principalId:'alice',capabilities:['filesystem:read','filesystem:write']},{coordinatorHostId:'coordinator',action:'remove',
    identity:{runtime:'agent',threadId:'parent',branchId:'main'},key:'external-project:external-operation',source:{resource_owner:remote,
      workspace_id:'workspace',execution_workspace_id:'another-execution',branch_id:'another-saved-conversation',mode:'native_workspace',revision:null,live_root:null}}))
    .rejects.toThrow('preparation identity changed');
  expect(issueGrant).not.toHaveBeenCalled();
});

test('cleanup recalls the original project preparation key after a lost Catalog source receipt without repinning',async()=>{
  const source={resourceOwner:remote,workspaceId:'workspace',executionWorkspaceId:'execution',mode:'native_workspace' as const,branchId:'original'};
  const prepareProjectSource=vi.fn(async()=>({path:'/target/original',source}));
  const externalProjectSource=vi.fn(async()=>({status:'removed'}));
  const owner=createExternalSourceOwner({kernel:{} as never,storage:{} as never,capture:{} as never,
    prepareProjectSource:prepareProjectSource as never,managed:{coordinatorHostId:'coordinator',source:async()=>({externalProjectSource} as never)}});
  await owner.remove(child,true);
  expect(prepareProjectSource).toHaveBeenCalledWith(child.project_source!.kind==='project'?child.project_source!.project:undefined,
    {runtime:'agent',threadId:'parent',branchId:'main'},'external-project:external-operation','isolated_write',null,expect.any(AbortSignal));
  expect(externalProjectSource).toHaveBeenCalledOnce();
  expect(externalProjectSource).toHaveBeenCalledWith(expect.objectContaining({action:'remove',source:expect.objectContaining({branch_id:'original'})}));
  await owner.remove({...child,dispatch_operation_id:'original-dispatch'},true);
  expect(externalProjectSource).toHaveBeenCalledOnce();
  prepareProjectSource.mockRejectedValueOnce(new Error('Original target is offline'));
  await expect(owner.remove(child,true)).rejects.toThrow('Original target is offline');
});
