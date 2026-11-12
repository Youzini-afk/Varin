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

it.each(['external:child:dispatch','coordinator-child-thread'])(
  'captures an unpublished native source for %s without claiming a target Catalog Thread',async sourceThreadId=>{
    const source={resource_owner:{kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:'endpoint'},
      workspace_id:'workspace',execution_workspace_id:'private-view',mode:'native_workspace' as const,branch_id:'child-source:dispatch',revision:null,live_root:null};
    const origin={kind:'model_step' as const,request_id:'request'};
    const invocation:ToolInvocationAuthority={invocationId:'call',runId:'coordinator-parent-run',threadId:'coordinator-parent',callId:'exchange',origin,
      operationId:toolOperationId(origin,'exchange'),executorOwner:{kind:'kernel'},
      source,toolName:'update',operation:'effect',completion:'result',arguments:{}};
    const branchId=`code-exchange:${invocation.operationId}`,snapshotBranch=`code-snapshot:${invocation.operationId}`;
    const captured={'result.txt':{kind:'regular-file' as const,objectHash:'target-object',byteLength:20}};
    const result:WorkingResult={branchId,root:'published-root',resultRevision:1,changedPaths:['result.txt'],baseStates:{'result.txt':{kind:'missing'}},
      pathStates:captured,diffStats:{files:1,insertions:1,deletions:0},createdAt:'2026-11-11T00:00:00Z'};
    const released=vi.fn(async()=>{}), snapshot=vi.fn(async()=>{}), retainPrepared=vi.fn(async()=>{
      throw new Error('No coordinator Thread exists in the target Catalog');
    });
    const createBranch=vi.fn(async()=>{}),commitVirtualWrites=vi.fn(async()=>({status:'committed'})),deleteBranch=vi.fn(async()=>{});
    const readStateSlice=vi.fn(async(branch:string)=>branch===snapshotBranch?captured:{'result.txt':{kind:'missing'}});
    const publishHeadResult=vi.fn(async()=>result);
    const store={resumeResultPublication:vi.fn(async()=>null),getBranchRoot:vi.fn().mockResolvedValueOnce(null).mockResolvedValue({writeRevision:0}),
      readStateSlice,createBranch,commitVirtualWrites,publishHeadResult,deleteBranch};
    mocks.open.mockResolvedValue({store,directory:'/target-private-view',release:released} as unknown as ExchangeScope);
    const scope:ManagedSourceLocalScope={principal:{principalId:'paired',capabilities:['filesystem:write']},coordinatorHostId:'coordinator',
      authorityId:'original-reader',resourceEpoch:'target-epoch',source,
      scope:{kind:'source_read',threadId:sourceThreadId,branchId:'child-source:dispatch',key:'exchange'},
      physicalRoot:{hostId:'target',rootId:'native-root',canonicalRoot:'/target-private-view'},
      grant:{grantId:'original-reader',kernelEpoch:'target-epoch',hostGeneration:'generation',authorityInstanceId:null,workerId:null,workerGeneration:null,sessionId:null,
        threadId:sourceThreadId,runId:null,operationId:null,owningWorkspace:'workspace',executionWorkspace:'private-view',capabilities:['storage.read','storage.write'],pathScopes:[''],storageIdentity:'target-storage'}};
    const service=createManagedCodeExchangeService({kernel:{nativeWorkspaces:{snapshot,retainPrepared}}} as never);
    const signal=new AbortController().signal;
    expect(await service(scope,{kind:'code_capture',invocation,sourceThreadId,targetThreadId:'coordinator-parent',baselineBranchId:'baseline',baselineRevision:0,
      mapping:{from:'',to:''},baselineMapping:{from:'',to:''},files:['result.txt']},signal)).toBe(result);
    // This is a new capture, not the resumed-publication fast path above. The
    // native snapshot receives no local Catalog deletion owner, but still reads
    // the original native source and publishes selected bytes under this grant.
    expect(snapshot).toHaveBeenCalledWith(source,snapshotBranch,snapshotBranch,signal,undefined,{});
    expect(retainPrepared).not.toHaveBeenCalled();
    expect(readStateSlice).toHaveBeenCalledWith(snapshotBranch,['result.txt'],{revision:0,signal});
    expect(createBranch).toHaveBeenCalledWith('workspace',branchId,{'result.txt':{kind:'missing'}});
    expect(commitVirtualWrites).toHaveBeenCalledWith(branchId,0,captured);
    expect(publishHeadResult).toHaveBeenCalledWith(branchId,{publicationId:branchId,signal});
    expect(deleteBranch).toHaveBeenCalledWith(snapshotBranch);
    expect(publishHeadResult.mock.invocationCallOrder[0]).toBeLessThan(deleteBranch.mock.invocationCallOrder[0]!);
    expect(deleteBranch.mock.invocationCallOrder[0]).toBeLessThan(released.mock.invocationCallOrder[0]!);
    expect(released).toHaveBeenCalledTimes(1);
  });

it.each([undefined,'different-branch','different-environment'] as const)(
  'applies to the original external source across native optional-field serialization (%s)',async changed=>{
    // External preparation keeps its native Source in JSON. Rust's original
    // authority round-trip emits the optional absent environment as null.
    const externalSource={resource_owner:{kind:'managed_host' as const,hostId:'target',connectionId:'connection',endpointIdentity:'endpoint'},
      workspace_id:'workspace',execution_workspace_id:'private-view',mode:'native_workspace' as const,branch_id:'child-source:dispatch',revision:null,live_root:null};
    const source={...externalSource,environment_run_id:null};
    const origin={kind:'model_step' as const,request_id:'request'};
    const invocation:ToolInvocationAuthority={invocationId:'call',runId:'parent-run',threadId:'parent',callId:'exchange',origin,
      operationId:toolOperationId(origin,'exchange'),executorOwner:{kind:'kernel'},source,toolName:'submit_code',operation:'effect',completion:'result',arguments:{}};
    const result:WorkingResult={branchId:`code-exchange:${invocation.operationId}`,root:'retained-root',resultRevision:1,
      changedPaths:['parent-result.txt'],baseStates:{},pathStates:{},diffStats:{files:1,insertions:1,deletions:0},createdAt:'2026-11-11T00:00:00Z'};
    const receipt={status:'applied',changedFiles:['parent-result.txt'],effect:'confirmed',executorStopped:true};
    const mergeResult=vi.fn(async()=>receipt),release=vi.fn(async()=>{});
    mocks.open.mockResolvedValue({store:{},directory:'/original-target',documentWorkspaceId:'original-document-workspace',workingStates:{},release} as unknown as ExchangeScope);
    const scope:ManagedSourceLocalScope={principal:{principalId:'paired',capabilities:['filesystem:write']},coordinatorHostId:'coordinator',authorityId:'original',resourceEpoch:'epoch',source,
      scope:{kind:'source_read',threadId:'external:child:dispatch',branchId:source.branch_id,key:'exchange'},
      physicalRoot:{hostId:'target',rootId:'native-root',canonicalRoot:'/original-target'},
      grant:{grantId:'original-reader',kernelEpoch:'epoch',hostGeneration:'generation',authorityInstanceId:null,workerId:null,workerGeneration:null,sessionId:null,
        threadId:'external:child:dispatch',runId:null,operationId:null,owningWorkspace:'workspace',executionWorkspace:'private-view',capabilities:['storage.read','storage.write'],pathScopes:[''],storageIdentity:'target-storage'}};
    const service=createManagedCodeExchangeService({coordinator:{mergeResult}} as never);
    const child={operation_id:'dispatch',dispatch_operation_id:null,conversation_id:'external:child:dispatch'} as import('./protocol.generated.js').ExternalChild;
    const self={branchId:'parent-branch',source} as import('./code-exchange.js').CodeParticipant;
    const expected={...externalSource,...(changed==='different-branch'?{branch_id:'another-branch'}:{}),
      ...(changed==='different-environment'?{environment_run_id:'different-original-view'}:{})};
    const settled=service(scope,{kind:'external_code_apply',invocation,self,child,direction:'send',externalSource:expected,result},new AbortController().signal);
    if(changed){await expect(settled).rejects.toThrow('External exchange original source changed');expect(mergeResult).not.toHaveBeenCalled();}
    else {
      await expect(settled).resolves.toBe(receipt);
      expect(mergeResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({operationId:`integration:${invocation.operationId}`,
        operationBinding:expect.objectContaining({kind:'external_code_exchange',direction:'send',target:externalSource,
          targetThreadId:'external:child:dispatch',parentRunId:'parent-run'})}));
    }
    expect(release).toHaveBeenCalledOnce();
  });
