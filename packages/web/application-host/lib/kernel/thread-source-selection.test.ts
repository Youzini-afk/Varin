import { expect, it, vi } from 'vitest';
import { createThreadSourcePreparer, normalizeThreadSourcePreparation } from './thread-sources.js';
import { createNativeWorkspaceOwner } from './native-workspaces.js';
import type { ThreadPrepareSource } from '@varin/application-client';
const selection={mode:'native_workspace' as const,workspaceId:'original',executionWorkspaceId:'managed-project',branchId:'adopted',adoptionOperationId:'adoption'};
const input:ThreadPrepareSource={runtime:'agent',threadId:'thread',branchId:'main',key:'first',resourceOwner:{kind:'local'},workspaceId:'original',mode:'native_workspace',selection,content:{mode:'saved-files'},captureScopes:[]};
it('preserves explicit native selection and rejects forged fields, workspace or traversal',()=>{
  expect(normalizeThreadSourcePreparation(input).selection).toEqual(selection);
  for(const invalid of [{...selection,workspaceId:'other'}, {...selection,principalId:'other'}, {...selection,nativeScope:'../outside'}])
    expect(()=>normalizeThreadSourcePreparation({...input,selection:invalid} as ThreadPrepareSource)).toThrow();
});
it('does not upgrade frozen live defaults after adoption and forwards native selection to the original remote owner',async()=>{
  const native={prepare:vi.fn(async()=>{throw new Error('Must not consult later adoption');}),prepareSelection:vi.fn()};
  const remote={prepare:vi.fn(async()=>({path:'/target/mount',source:{...selection,resourceOwner:{kind:'local'},tools:[]}}))};
  const prepare=createThreadSourcePreparer({documents:{admitWorkspaceRegistration:async()=>({canonicalPath:'/original'})} as never,
    nativeWorkspaces:native as never,workingStates:{} as never,liveSources:{prepare:async()=>({rootId:'root',canonicalRoot:'/original',hostId:'host'})} as never,
    remote:remote as never,inspectInventory:async()=>({kind:'directory'}),sourceTools:async()=>[]});
  expect((await prepare({...input,mode:'live_root',selection:{mode:'live_root'}})).source.mode).toBe('live_root');
  expect(native.prepare).not.toHaveBeenCalled();
  const managed={kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:'endpoint'};
  await prepare({...input,key:'remote',resourceOwner:managed});
  expect(remote.prepare).toHaveBeenCalledWith(expect.objectContaining({resourceOwner:managed,selection}),expect.any(AbortSignal));
});
it('opens only the committed adoption matching original physical root without claiming its project lifetime',async()=>{
  const view={binding:{generation:'generation'},rootId:'mount-root',mount:{state:'ready',path:'/target/mount'}};
  const operation={kind:'workspace.adopt',state:'committed',result:{workspaceId:'original',branchId:'adopted',adoption:{sourceRootId:'physical-root'}}};
  const actor={getOperation:vi.fn(async()=>operation),fileRootRegister:vi.fn(async()=>({rootId:'physical-root'})),openWorkspace:vi.fn(async()=>view),mountWorkspace:vi.fn(async()=>view),bindWorkspace:vi.fn(async()=>view)};
  const kernel={handshake:{kernelEpoch:'epoch',hostId:'target'},issueGrant:vi.fn(async()=>({grantId:'grant'})),revokeGrant:vi.fn(async()=>{}),scoped:()=>actor,agentRuntimeRequest:vi.fn(async()=>({}))};
  const projects=vi.fn(async()=>[]);
  const owner=createNativeWorkspaceOwner({kernel:kernel as never,documents:{admitWorkspaceRegistration:async()=>({canonicalPath:'/physical'})} as never,projects,update:async()=>{throw new Error('No target registry copy');}});
  expect((await owner.prepareSelection(selection,'thread')).source).toMatchObject({mode:'native_workspace',workspaceId:'original',executionWorkspaceId:'managed-project',branchId:'adopted'});
  expect(projects).not.toHaveBeenCalled();
  expect(kernel.agentRuntimeRequest).not.toHaveBeenCalled();
  actor.getOperation.mockResolvedValue({...operation,result:{...operation.result,adoption:{sourceRootId:'foreign-root'}}});
  await expect(owner.prepareSelection(selection,'thread')).rejects.toThrow('another physical source');
  expect(actor.openWorkspace).toHaveBeenCalledTimes(1);
});
