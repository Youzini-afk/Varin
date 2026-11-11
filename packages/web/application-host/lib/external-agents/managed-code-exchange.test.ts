import {expect,it,vi,afterEach} from 'vitest';
import {createManagedRemoteTargetRegistry,managedEndpointIdentity} from '../harness/managed-remote-client.js';
import {exchangeRemoteExternalCode} from './managed-code-exchange.js';
import {admitRunSourceAuthority} from '../kernel/source-launch.js';
import type {CodeExchangeOwners,CodeParticipant} from '../kernel/code-exchange.js';
import type {ToolInvocationAuthority} from '../kernel/tool-invocation.js';
import type {ExternalChild,LaunchSource} from '../kernel/protocol.generated.js';
vi.mock('../kernel/source-launch.js',async original=>({...await original<typeof import('../kernel/source-launch.js')>(),admitRunSourceAuthority:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
const owner={kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:managedEndpointIdentity({apiUrl:'https://target.example'})};
const selfSource:LaunchSource={resource_owner:owner,workspace_id:'workspace',execution_workspace_id:'execution',mode:'native_workspace',branch_id:'parent',revision:null,live_root:null};
const externalSource:LaunchSource={...selfSource,execution_workspace_id:'external-work',branch_id:'child-source:dispatch'};
const caller={operationId:'exchange',runId:'caller-run',threadId:'parent-thread',source:selfSource} as ToolInvocationAuthority;
const self={source:selfSource,runId:'caller-run',branchId:'main',launch:{selection:{tools:[],extension_bindings:[],tool_schemas:[]}}} as unknown as CodeParticipant;
const child={operation_id:'dispatch',dispatch_operation_id:null,parent_run_id:'caller-run',parent_thread_id:'parent-thread',parent_branch_id:'main',conversation_id:'external:child:dispatch',
  handoff:{source:selfSource,source_path:null},source:{kind:'isolated',nativeSource:externalSource,baseline:{pin:{source:{...externalSource,mode:'fixed_branch',revision:0}}}}} as unknown as ExternalChild;
async function fixture(outcome:'applied'|'disconnected'|'malformed'='applied'){
  const result={branchId:'code-exchange:exchange',resultRevision:0,root:'retained-root',changedPaths:['result.txt'],pathStates:{},baseStates:{}};
  const page={entries:[{path:'original/result.txt',relativePath:'original/result.txt',name:'result.txt',type:'file'}],nextCursor:'original-source-page'};
  const operation=vi.fn(async(input:{operation:{kind:string}})=>{
    if(input.operation.kind==='files')return page;
    if(input.operation.kind==='code_capture')return result;
    expect(input.operation.kind).toBe('external_code_apply');
    if(outcome==='disconnected')throw new Error('Original target disconnected after dispatch');
    return {status:'applied',changedFiles:outcome==='malformed'?null:['result.txt'],
      receipt:{kind:'integration',workspaceId:'workspace',operationId:'integration:exchange',revision:1,state:'complete'},
      effect:'confirmed',executorStopped:true,recoveryCoverage:'files-only'};
  });
  const registry=createManagedRemoteTargetRegistry({coordinatorHostId:'coordinator',kernel:{} as never,resources:{} as never,
    readSettings:async()=>({desktopHosts:[{id:'connection',apiUrl:'https://target.example'}]}),
    fetch:async(url,init)=>{
      let body:unknown;
      const endpoint=new URL(String(url)).pathname;
      if(endpoint.endsWith('/identity'))body={protocolVersion:1,hostId:'target',capabilities:['sources'],machine:{machineId:'managed:target',kind:'managed-remote',state:'available'}};
      else if(endpoint.endsWith('/sources/bind'))body={authorityId:'external-read',resourceEpoch:'epoch',physicalRoot:{canonicalRoot:'/target/child'}};
      else if(endpoint.endsWith('/sources/release'))body={};
      else {expect(endpoint).toMatch(/\/sources\/service$/);body=await operation(JSON.parse(String(init?.body)));}
      return Response.json(body,{headers:{'x-varin-managed-host':'target'}});
    }});
  const client=await registry.source(owner);
  const service={...client,bind:vi.fn(client.bind),release:vi.fn(client.release),service:vi.fn(client.service)};
  const release=vi.fn(async()=>{});
  vi.mocked(admitRunSourceAuthority).mockResolvedValue({kind:'managed',service,binding:{authorityId:'caller',resourceEpoch:'epoch',physicalRoot:{canonicalRoot:'/target/parent'}},release} as never);
  const owners={runtime:{coordinatorHostId:'coordinator',childExecutionForRun:async()=>null},kernel:{nativeWorkspaces:{open:vi.fn()}},onCleanupError:vi.fn()} as unknown as CodeExchangeOwners;
  return {owners,service,release,operation,page};
}
it('remote external exchange uses a real source-read lease and keeps the original external journal action',async()=>{
  const f=await fixture();
  const receipt=await exchangeRemoteExternalCode(f.owners,caller,self,child,'receive',undefined,new AbortController().signal,{});
  expect(receipt.completion,JSON.stringify(receipt)).toMatchObject({kind:'result',outcome:'succeeded'});
  expect(f.service.bind).toHaveBeenCalledWith(expect.objectContaining({scope:{kind:'source_read',threadId:child.conversation_id,branchId:externalSource.branch_id,key:'external-code:exchange:receive'}}),expect.any(AbortSignal));
  expect(f.service.service).toHaveBeenLastCalledWith(expect.objectContaining({authorityId:'caller',operation:expect.objectContaining({kind:'external_code_apply',child,direction:'receive',externalSource})}),expect.any(AbortSignal));
  expect(f.owners.kernel.nativeWorkspaces!.open).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});
it('lost remote apply reply remains unknown instead of reporting a stopped successful integration',async()=>{
  const f=await fixture('disconnected');
  const receipt=await exchangeRemoteExternalCode(f.owners,caller,self,child,'send',undefined,new AbortController().signal,{});
  expect(receipt,JSON.stringify(receipt)).toMatchObject({executor_stopped:false,completion:{kind:'result',outcome:'indeterminate',effect:'unknown'}});
});

it('keeps a malformed apply response unknown without replaying the remote effect',async()=>{
  const f=await fixture('malformed');
  const receipt=await exchangeRemoteExternalCode(f.owners,caller,self,child,'receive',undefined,new AbortController().signal,{});
  expect(receipt).toMatchObject({executor_stopped:false,completion:{kind:'result',outcome:'indeterminate',effect:'unknown'}});
  expect(f.operation.mock.calls.map(([request])=>request.operation.kind)).toEqual(['code_capture','external_code_apply']);
});
it('preserves original file metadata and continuation through the closed managed service',async()=>{
  const f=await fixture();
  const page=await f.service.service({coordinatorHostId:'coordinator',authorityId:'caller',resourceEpoch:'epoch',requestId:'files',operation:{kind:'files',options:{query:'result'}}});
  expect(page).toEqual(f.page);
  expect(f.operation.mock.calls.map(([request])=>request.operation.kind)).toEqual(['files']);
});
