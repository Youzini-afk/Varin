import {afterEach,expect,it,vi} from 'vitest';
import type {ExchangeScope} from './code-exchange.js';
import type {WorkingResult} from '../harness/working-state/types.js';
import type {ManagedSourceLocalScope} from '../harness/managed-remote-types.js';
import type {ToolInvocationAuthority} from './tool-invocation.js';
import {toolOperationId} from './protocol.generated.js';
const mocks=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('./code-exchange.js',async original=>({...await original<typeof import('./code-exchange.js')>(),openCodeTarget:mocks.open,acknowledgedCode:async()=>({})}));
import {createManagedCodeExchangeService} from './managed-code-exchange.js';
afterEach(()=>vi.clearAllMocks());
it.each(['published','failure','cancelled'] as const)('retains the original capture grant until publication %s settles',async outcome=>{
  let active=true,entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const waiting=new Promise<void>(resolve=>{finish=resolve;});
  const controller=new AbortController();
  const source={resource_owner:{kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:'endpoint'},
    workspace_id:'workspace',execution_workspace_id:'private-view',mode:'native_workspace' as const,branch_id:'child-source:dispatch',revision:null,live_root:null};
  const origin={kind:'model_step' as const,request_id:'request'};
  const invocation:ToolInvocationAuthority={invocationId:'call',runId:'parent-run',threadId:'parent',callId:'exchange',origin,
    operationId:toolOperationId(origin,'exchange'),executorOwner:{kind:'kernel'},
    source,toolName:'submit_code',operation:'effect',completion:'result',arguments:{}};
  const result:WorkingResult={branchId:`code-exchange:${invocation.operationId}`,root:'retained-root',resultRevision:1,changedPaths:[],baseStates:{},pathStates:{},diffStats:{files:0,insertions:0,deletions:0},createdAt:'2026-11-11T00:00:00Z'};
  const resume=vi.fn(async()=>{entered();await waiting;
    if(!active)throw new Error('Kernel grant is no longer active');
    controller.signal.throwIfAborted();
    if(outcome==='failure')throw new Error('Original publication failed');
    return result;
  });
  const release=vi.fn(async()=>{active=false;});
  mocks.open.mockResolvedValue({store:{resumeResultPublication:resume},directory:'/original-target',release} as unknown as ExchangeScope);
  const scope:ManagedSourceLocalScope={principal:{principalId:'paired',capabilities:['filesystem:write']},coordinatorHostId:'coordinator',authorityId:'original',resourceEpoch:'epoch',source,
    scope:{kind:'source_read',threadId:'external:child:dispatch',branchId:'child-source:dispatch',key:'exchange'},physicalRoot:{hostId:'target',rootId:'native-root',canonicalRoot:'/original-target'},
    grant:{grantId:'original-reader',kernelEpoch:'epoch',hostGeneration:'generation',authorityInstanceId:null,workerId:null,workerGeneration:null,sessionId:null,threadId:'external:child:dispatch',runId:null,operationId:null,owningWorkspace:'workspace',executionWorkspace:'private-view',capabilities:['storage.read','storage.write'],pathScopes:[''],storageIdentity:'target-storage'}};
  const service=createManagedCodeExchangeService({kernel:{nativeWorkspaces:{}}} as never);
  const promise=service(scope,{kind:'code_capture',invocation,sourceThreadId:'external:child:dispatch',targetThreadId:'parent',baselineBranchId:'baseline',baselineRevision:0,mapping:{from:'',to:''},baselineMapping:{from:'',to:''}},controller.signal);
  // Attach rejection observation before cancellation to detect no stray promise.
  const observed=promise.then(value=>({value}),error=>({error}));
  await started;await new Promise(resolve=>setTimeout(resolve,0));
  expect(release).not.toHaveBeenCalled();expect(active).toBe(true);
  if(outcome==='cancelled')controller.abort();
  finish();const settled=await observed;
  if(outcome==='published')expect(settled).toEqual({value:result});
  else expect('error' in settled && settled.error.message).toMatch(outcome==='failure'?/Original publication failed/:/abort/i);
  expect(release).toHaveBeenCalledTimes(1);expect(active).toBe(false);
});
