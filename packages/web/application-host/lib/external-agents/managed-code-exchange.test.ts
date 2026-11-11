import {expect,it,vi,afterEach} from 'vitest';
import {exchangeRemoteExternalCode} from './managed-code-exchange.js';
import {admitRunSourceAuthority} from '../kernel/source-launch.js';
import type {CodeExchangeOwners,CodeParticipant} from '../kernel/code-exchange.js';
import type {ToolInvocationAuthority} from '../kernel/tool-invocation.js';
import type {ExternalChild,LaunchSource} from '../kernel/protocol.generated.js';
vi.mock('../kernel/source-launch.js',async original=>({...await original<typeof import('../kernel/source-launch.js')>(),admitRunSourceAuthority:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
const owner={kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:'endpoint'};
const selfSource:LaunchSource={resource_owner:owner,workspace_id:'workspace',execution_workspace_id:'execution',mode:'native_workspace',branch_id:'parent',revision:null,live_root:null};
const externalSource:LaunchSource={...selfSource,execution_workspace_id:'external-work',branch_id:'child-source:dispatch'};
const caller={operationId:'exchange',runId:'caller-run',threadId:'parent-thread',source:selfSource} as ToolInvocationAuthority;
const self={source:selfSource,runId:'caller-run',branchId:'main',launch:{selection:{tools:[],extension_bindings:[],tool_schemas:[]}}} as unknown as CodeParticipant;
const child={operation_id:'dispatch',dispatch_operation_id:null,parent_run_id:'caller-run',parent_thread_id:'parent-thread',parent_branch_id:'main',conversation_id:'external:child:dispatch',
  handoff:{source:selfSource,source_path:null},source:{kind:'isolated',nativeSource:externalSource,baseline:{pin:{source:{...externalSource,mode:'fixed_branch',revision:0}}}}} as unknown as ExternalChild;
function fixture(failApply=false){
  const result={branchId:'code-exchange:exchange',resultRevision:0,root:'retained-root'};
  const service={bind:vi.fn(async()=>({authorityId:'external-read',resourceEpoch:'epoch',physicalRoot:{canonicalRoot:'/target/child'}})),release:vi.fn(async()=>({})),
    service:vi.fn(async(input:{operation:{kind:string}})=>{if(input.operation.kind==='code_capture')return result;
      if(failApply)throw new Error('Original target disconnected after dispatch');
      return {status:'applied',receipt:{operationId:'integration:exchange'},effect:'confirmed',executorStopped:true,recoveryCoverage:'files-only'};})};
  const release=vi.fn(async()=>{});
  vi.mocked(admitRunSourceAuthority).mockResolvedValue({kind:'managed',service,binding:{authorityId:'caller',resourceEpoch:'epoch',physicalRoot:{canonicalRoot:'/target/parent'}},release} as never);
  const owners={runtime:{coordinatorHostId:'coordinator',childExecutionForRun:async()=>null},kernel:{nativeWorkspaces:{open:vi.fn()}},onCleanupError:vi.fn()} as unknown as CodeExchangeOwners;
  return {owners,service,release};
}
it('remote external exchange uses a real source-read lease and keeps the original external journal action',async()=>{
  const f=fixture();
  const receipt=await exchangeRemoteExternalCode(f.owners,caller,self,child,'receive',undefined,new AbortController().signal,{});
  expect(receipt.completion,JSON.stringify(receipt)).toMatchObject({kind:'result',outcome:'succeeded'});
  expect(f.service.bind).toHaveBeenCalledWith(expect.objectContaining({scope:{kind:'source_read',threadId:child.conversation_id,branchId:externalSource.branch_id,key:'external-code:exchange:receive'}}),expect.any(AbortSignal));
  expect(f.service.service).toHaveBeenLastCalledWith(expect.objectContaining({authorityId:'caller',operation:expect.objectContaining({kind:'external_code_apply',child,direction:'receive',externalSource})}),expect.any(AbortSignal));
  expect(f.owners.kernel.nativeWorkspaces!.open).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});
it('lost remote apply reply remains unknown instead of reporting a stopped successful integration',async()=>{
  const f=fixture(true);
  const receipt=await exchangeRemoteExternalCode(f.owners,caller,self,child,'send',undefined,new AbortController().signal,{});
  expect(receipt,JSON.stringify(receipt)).toMatchObject({executor_stopped:false,completion:{kind:'result',outcome:'indeterminate',effect:'unknown'}});
});
