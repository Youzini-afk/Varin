import { describe, expect, it } from 'vitest';
import { McpTaskRequestError } from '@varin/pi-host/mcp-errors';
import type { McpTaskLease, McpAuthorityTool } from '@varin/pi-host/mcp-authority';
import { createMcpTaskRuntime } from './mcp-task-runtime.js';
import type { KernelClient } from './kernel-client.js';
import type { HostJobPending, HostJobTaskUpdateParams, HostToolCall, McpTaskState, SourceMcpCreationOutcome } from './protocol.generated.js';

// Fault-injection at the Host/Catalog request boundary. Actual Catalog persistence, original
// admission and remote stdio behavior are covered by the kernel MCP Task integration tests.
const initial:McpTaskState={taskId:'receiver-id',status:'working',createdAt:'2026-01-01T00:00:00Z',lastUpdatedAt:'2026-01-01T00:00:00Z',ttl:0,pollInterval:5};
const endpoint={server:'peer',resourceKey:'mcp:peer',configurationVersion:'configuration',credentialVersion:'grant'};
const owner={kind:'external' as const,identity:'host',epoch:'epoch'};
const call:HostToolCall={operationId:'original-operation',runId:'original-run',origin:{kind:'model_step',request_id:'original-step'},callId:'original-call',name:'task',schemaVersion:'v1',arguments:{}};
const tool:McpAuthorityTool={name:'task',server:'peer',tool:'task',schemaVersion:'v1',taskSupport:'required',taskCapable:true,resourceKey:endpoint.resourceKey,configurationScope:'global',executionScope:'global',inputSchema:{type:'object'},description:'',exposure:'direct'};
const failure=(code:number)=>new McpTaskRequestError('remote-error',true,'protocol',code,{code,message:'Original receiver error'});
async function until(predicate:()=>boolean,attempts=200){for(let n=0;n<attempts;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Expected observation did not arrive');}
function fixture(options:{acceptFailures?:number;commitFailedAccept?:boolean;startError?:McpTaskRequestError;recoverLease?:boolean|(()=>Promise<McpTaskLease>);
  recoverCreation?:(count:number)=>Promise<SourceMcpCreationOutcome|null>;cleanup?:(count:number)=>Promise<void>;
  afterHolderReleased?:(count:number)=>Promise<void>;get?:(count:number)=>Promise<McpTaskState>;
  result?:()=>Promise<Record<string,unknown>>;cancel?:()=>Promise<McpTaskState>;afterUpdate?:(change:HostJobTaskUpdateParams)=>Promise<void>}={}){
  let op:HostJobPending|undefined,accepts=0,starts=0,gets=0,results=0,cancels=0,released=0,accesses=0,recoveries=0,creationReads=0,cleanups=0,holderAcks=0,terminals=0;
  let creation:SourceMcpCreationOutcome|null=null;
  const cleanupOrder:string[]=[];
  const updates:HostJobTaskUpdateParams[]=[],errors:Error[]=[];
  const finishes:string[]=[],unbinds:Array<string|undefined>=[];
  let ready:()=>void=()=>{},event:()=>void=()=>{},notify:((id:string)=>void)=()=>{};
  const clone=<T>(v:T):T=>structuredClone(v);
  const accept=()=>{op={...op!,accepted:true,mcpTask:{revision:1,task:clone(initial),observationRef:'acceptance',availability:'available',resultReady:false}};};
  const finish=()=>{finishes.push(op!.mcpTask!.task.status);if(['completed','failed'].includes(op!.mcpTask!.task.status))op={...op!,executorStopped:true};};
  const kernel={async agentRuntimeRequest(method:string,params:Record<string,unknown>){
    switch(method){
      case'runtime.host_job.begin':op={binding:params.binding as HostJobPending['binding'],runId:call.runId,accepted:false,cancelRequested:false,executorStopped:false,mcpHolderReleased:false,phase:'running',origin:{kind:'tool',origin:call.origin,call_id:call.callId,tool_name:call.name,schema_version:call.schemaVersion}};return clone(op);
      case'runtime.host_job.accept':accepts++;if(accepts<=(options.acceptFailures??0)){if(options.commitFailedAccept&&!op!.accepted)accept();throw new Error('Acceptance reply interrupted');}if(!op!.accepted)accept();return clone(op);
      case'runtime.host_job.pending':return op&&!op.mcpHolderReleased?[clone(op)]:[];
      case'runtime.host_job.terminal':terminals++;expect(params.effect).toBe('none');expect(params.executorStopped).toBe(true);op={...op!,phase:'terminal',executorStopped:true};return clone(op);
      case'runtime.host_job.task.holder_released':holderAcks++;cleanupOrder.push('catalog');op={...op!,mcpHolderReleased:true};await options.afterHolderReleased?.(holderAcks);return clone(op);
      case'runtime.host_job.access':accesses++;return clone({host_job:{binding:op!.binding,mcpTask:op!.mcpTask}});
      case'runtime.host_job.task.read':return clone({operation:{host_job:{binding:op!.binding,mcpTask:op!.mcpTask},external_receipt:{executor_stopped:op!.executorStopped},cancel_requested:op!.cancelRequested},observation:updates.at(-1)?.content,result:null});
      case'runtime.host_job.task.update':{
        const change=params as unknown as HostJobTaskUpdateParams;updates.push(clone(change));
        const current=op!.mcpTask!;
        if(current.revision!==change.expectedRevision)return clone(op);
        op={...op!,mcpTask:{revision:current.revision+1,task:clone(change.task),observationRef:'observation',availability:change.availability,...(change.problem?{problem:change.problem}:{}),
          resultReady:current.resultReady||!!change.result,...(change.result?{resultRef:'result',resultKind:change.result.kind,resultOutcome:change.result.outcome,resultEffect:change.result.effect}:current.resultRef?{resultRef:current.resultRef}:{} )}};
        finish();await options.afterUpdate?.(change);return clone(op);
      }
      case'runtime.host_job.task.finish':finish();return clone(op);
      default:throw new Error(`Unexpected request ${method}`);
    }
  }} as unknown as KernelClient;
  const lease:McpTaskLease={endpoint,bindInteraction(){return reason=>{unbinds.push(reason);};},async start(){starts++;if(options.startError)throw options.startError;const response={task:clone(initial),result:{task:clone(initial)}};creation={kind:'accepted',response:clone(response)};return response;},async get(){gets++;const task=await(options.get?.(gets)??Promise.resolve(initial));return{task:clone(task),result:{...clone(task)}};},async result(){results++;return options.result?.()??{content:[{type:'text',text:'Final content'}],isError:true};},async cancel(){cancels++;if(!options.cancel)throw new Error('Unexpected cancel');const task=await options.cancel();return{task:clone(task),result:{...clone(task)}};},onChange(listener){notify=listener;return()=>{};},release(){released++;}};
  const create=()=>createMcpTaskRuntime({kernel,runtime:{onReady(listener){ready=listener;return()=>{};},onEvent(listener){event=()=>listener({} as never);return()=>{};},async reconcileObservations(){return [];}},
    async recover(){recoveries++;if(typeof options.recoverLease==='function')return options.recoverLease();if(options.recoverLease)return lease;throw new Error('Live task lease was lost');},
    async recoverCreation(){creationReads++;return options.recoverCreation?options.recoverCreation(creationReads):clone(creation);},
    async cleanup(pending){cleanups++;expect(pending.binding.operationId).toBe(call.operationId);expect(pending.executorStopped).toBe(true);if(pending.accepted)expect(pending.mcpTask!.resultReady).toBe(true);cleanupOrder.push('source');await options.cleanup?.(cleanups);},
    onError(error){errors.push(error);}});
  let runtime=create();
  return{get runtime(){return runtime;},async reopen(){await runtime.dispose();runtime=create();},updates,errors,finishes,unbinds,cleanupOrder,lease,op:()=>op!,
    counts:()=>({accepts,starts,gets,results,cancels,released,accesses,recoveries,creationReads,cleanups,holderAcks,terminals}),
    ready:()=>ready(),event:()=>event(),notify:()=>notify('receiver-id'),requestCancel:()=>{op={...op!,cancelRequested:true};event();},
    setPhase:(phase:HostJobPending['phase'])=>{op={...op!,phase};},proveStopped:()=>{op={...op!,executorStopped:true};event();},ackHolderExternally:()=>{op={...op!,mcpHolderReleased:true};event();},
    submit:()=>runtime.submit({call,owner,lease,tool,args:{},signal:new AbortController().signal}),get:()=>runtime.control({call:{...call,operationId:'control-operation',callId:'control-call'},owner,action:'get',targetOperationId:call.operationId,signal:new AbortController().signal})};
}
describe('original MCP Task Host coordination',()=>{
  for(const committed of [false,true])it(`retains the exact accepted identity when accept ACK is lost (${committed?'committed':'uncommitted'})`,async()=>{
    const f=fixture({acceptFailures:committed?2:1,commitFailedAccept:committed});
    try{
      await expect(f.submit()).rejects.toThrow('Acceptance reply interrupted');
      expect(f.counts().released).toBe(0);f.runtime.start();
      await until(()=>f.counts().gets>0);
      expect(f.op().mcpTask!.task.taskId).toBe('receiver-id');expect(f.counts().starts).toBe(1);
      expect(f.errors.some(error=>/revision|undefined/.test(error.message))).toBe(false);
    }finally{await f.runtime.dispose();}
    expect(f.counts().released).toBe(1);
  });
  for(const committed of [false,true])it(`recovers a lost acceptance after Host reopen without replaying tools/call (${committed?'committed':'uncommitted'})`,async()=>{
    const f=fixture({acceptFailures:1,commitFailedAccept:committed,recoverLease:true});
    try{
      await expect(f.submit()).rejects.toThrow('Acceptance reply interrupted');
      await f.reopen();expect(f.counts().released).toBe(1);expect(f.counts().cleanups).toBe(0);
      f.runtime.start();await until(()=>f.counts().gets>0);
      expect(f.op().accepted).toBe(true);expect(f.op().mcpTask!.task.taskId).toBe(initial.taskId);
      expect(f.counts().starts).toBe(1);expect(f.counts().recoveries).toBe(1);
      expect(f.counts().creationReads).toBe(committed?0:1);
    }finally{await f.runtime.dispose();}
  });
  it('retries original acceptance publication after recovery ACK loss without another source wake',async()=>{
    const f=fixture({acceptFailures:2,recoverLease:true});
    try{
      await expect(f.submit()).rejects.toThrow('Acceptance reply interrupted');await f.reopen();f.runtime.start();
      await until(()=>f.counts().accepts===2);expect(f.counts().starts).toBe(1);expect(f.counts().creationReads).toBe(1);
      await until(()=>f.counts().gets>0,400);
      expect(f.counts().accepts).toBe(3);expect(f.counts().starts).toBe(1);expect(f.counts().creationReads).toBe(1);
      expect(f.counts().recoveries).toBe(1);
    }finally{await f.runtime.dispose();}
  });
  for(const beforeDispatch of [false,true])it(`retries a proven ${beforeDispatch?'pre-dispatch':'completed Task'} cleanup duty without another source wake`,async()=>{
    const f=fixture({...(beforeDispatch?{startError:new McpTaskRequestError('before-dispatch',false,'owner')}:
      {async get(){return{...initial,status:'completed' as const};}}),async cleanup(count){if(count===1)throw new Error('Transient cleanup failure');}});
    try{
      if(beforeDispatch)await expect(f.submit()).rejects.toThrow('before-dispatch');else await f.submit();
      f.runtime.start();await until(()=>f.counts().cleanups===1);await until(()=>f.op().mcpHolderReleased,400);
      expect(f.cleanupOrder).toEqual(['source','source','catalog']);expect(f.counts().starts).toBe(1);
      expect(f.counts().recoveries).toBe(0);expect(f.counts().creationReads).toBe(0);
    }finally{await f.runtime.dispose();}
  });
  for(const reply of ['source','catalog'] as const)it(`recovers ${reply} cleanup ACK loss after reopen without a live SDK lease`,async()=>{
    const f=fixture({async get(){return{...initial,status:'completed'};},
      ...(reply==='source'?{async cleanup(count:number){if(count===1)throw new Error('Source cleanup ACK lost');}}:
        {async afterHolderReleased(count:number){if(count===1)throw new Error('Catalog cleanup ACK lost');}})});
    try{
      await f.submit();f.runtime.start();await until(()=>f.errors.some(error=>error.message.includes('cleanup ACK lost')));
      expect(f.op().mcpTask!.resultReady).toBe(true);expect(f.op().executorStopped).toBe(true);
      const before=f.counts();await f.reopen();f.runtime.start();await f.runtime.reconcile();
      await until(()=>f.op().mcpHolderReleased);await f.runtime.reconcile();
      expect(f.counts().starts).toBe(1);expect(f.counts().recoveries).toBe(0);
      expect(f.counts().gets).toBe(before.gets);expect(f.counts().results).toBe(before.results);
      expect(f.cleanupOrder).toEqual(reply==='source'?['source','source','catalog']:['source','catalog']);
    }finally{await f.runtime.dispose();}
  });
  it('retries exact holder cleanup after a source wake during the old failed release',async()=>{
    const f=fixture({async get(){return{...initial,status:'completed'};},async cleanup(count){
      if(count===1){f.runtime.sourceReached();throw new Error('Old source release interrupted');}
    }});
    try{
      await f.submit();f.runtime.start();await until(()=>f.op().mcpHolderReleased);
      expect(f.cleanupOrder).toEqual(['source','source','catalog']);expect(f.counts().starts).toBe(1);
    }finally{await f.runtime.dispose();}
  });
  it('leaves durable cleanup unacknowledged when disposal interrupts its reply',async()=>{
    let resolveCleanup!:()=>void;
    const reply=new Promise<void>(resolve=>{resolveCleanup=resolve;});
    const f=fixture({async get(){return{...initial,status:'completed'};},async cleanup(count){if(count===1)await reply;}});
    try{
      await f.submit();f.runtime.start();await until(()=>f.counts().cleanups===1);
      const disposing=f.runtime.dispose();resolveCleanup();await disposing;
      expect(f.counts().cleanups).toBe(1);expect(f.counts().holderAcks).toBe(0);expect(f.op().mcpHolderReleased).toBe(false);
      await f.reopen();f.runtime.start();await until(()=>f.op().mcpHolderReleased);
      expect(f.counts().recoveries).toBe(0);expect(f.cleanupOrder).toEqual(['source','source','catalog']);
    }finally{resolveCleanup();await f.runtime.dispose();}
  });
  it('cleans a cancelled retained result only after independent executor stop evidence arrives',async()=>{
    const f=fixture({async get(){return{...initial,status:'cancelled'};}});
    try{
      await f.submit();f.runtime.start();await until(()=>f.op().mcpTask!.resultReady);
      expect(f.counts().cleanups).toBe(0);await f.reopen();f.runtime.start();await f.runtime.reconcile();
      expect(f.counts().recoveries).toBe(0);expect(f.counts().cleanups).toBe(0);
      f.proveStopped();await until(()=>f.op().mcpHolderReleased);
      expect(f.cleanupOrder).toEqual(['source','catalog']);expect(f.counts().recoveries).toBe(0);
    }finally{await f.runtime.dispose();}
  });
  it('detaches a late recovered SDK lease after the original holder was already acknowledged elsewhere',async()=>{
    let resolveLease!:(lease:McpTaskLease)=>void;
    const recovered=new Promise<McpTaskLease>(resolve=>{resolveLease=resolve;});
    const f=fixture({recoverLease:()=>recovered});
    try{
      await f.submit();await f.reopen();f.runtime.start();await until(()=>f.counts().recoveries===1);
      f.ackHolderExternally();await f.runtime.reconcile();resolveLease(f.lease);
      await until(()=>f.counts().released===2);
      expect(f.counts().gets).toBe(0);expect(f.counts().cleanups).toBe(0);expect(f.errors).toEqual([]);
    }finally{resolveLease(f.lease);await f.runtime.dispose();}
  });
  it('persists a typed pre-dispatch rejection and drains its original holder before releasing the local lease',async()=>{
    const f=fixture({startError:new McpTaskRequestError('before-dispatch',false,'owner')});
    try{
      await expect(f.submit()).rejects.toThrow('before-dispatch');
      expect(f.op().accepted).toBe(false);expect(f.op().executorStopped).toBe(true);expect(f.op().mcpHolderReleased).toBe(true);
      expect(f.counts().terminals).toBe(1);expect(f.counts().creationReads).toBe(0);expect(f.counts().released).toBe(1);
      expect(f.cleanupOrder).toEqual(['source','catalog']);
    }finally{await f.runtime.dispose();}
  });
  it('publishes recovered original pre-dispatch evidence and cleans the holder after Host reopen',async()=>{
    const f=fixture({startError:new McpTaskRequestError('lost-reply',true,'transport'),async recoverCreation(){
      return{kind:'failed',error:{code:'source-admission-rejected',dispatched:false,settlement:'unknown'}};
    }});
    try{
      await expect(f.submit()).rejects.toThrow('lost-reply');await f.reopen();f.runtime.start();
      await until(()=>f.op().mcpHolderReleased);
      expect(f.counts().starts).toBe(1);expect(f.counts().recoveries).toBe(0);expect(f.counts().terminals).toBe(1);
      expect(f.cleanupOrder).toEqual(['source','catalog']);
    }finally{await f.runtime.dispose();}
  });
  it('retries the known original pending creation receipt without another dispatch or source wake',async()=>{
    const f=fixture({startError:new McpTaskRequestError('lost-reply',true,'transport'),recoverLease:true,
      async recoverCreation(count){if(count===1)throw new McpTaskRequestError('mcp_task_creation_receipt_pending',true,'owner');
        return{kind:'accepted',response:{task:initial,result:{task:initial}}};}});
    try{
      await expect(f.submit()).rejects.toThrow('lost-reply');f.runtime.start();await until(()=>f.counts().gets>0,400);
      expect(f.counts().creationReads).toBe(2);expect(f.counts().starts).toBe(1);expect(f.op().accepted).toBe(true);
    }finally{await f.runtime.dispose();}
  });
  for(const outcome of [null,{kind:'failed',error:{code:'expired',dispatched:true,settlement:'session_expired'}}] as const)
    it(`retains unaccepted ${outcome?'session-expired dispatch':'missing creation'} as Unknown despite a generic terminal phase`,async()=>{
      const f=fixture({startError:new McpTaskRequestError('lost-reply',true,'transport'),async recoverCreation(){return outcome;}});
      try{
        await expect(f.submit()).rejects.toThrow('lost-reply');f.setPhase('terminal');f.runtime.start();
        await until(()=>f.counts().creationReads===1);await new Promise(resolve=>setTimeout(resolve,30));
        expect(f.op().executorStopped).toBe(false);expect(f.counts().cleanups).toBe(0);expect(f.counts().terminals).toBe(0);
        f.event();await f.runtime.reconcile();expect(f.counts().creationReads).toBe(1);
        f.runtime.sourceReached();await until(()=>f.counts().creationReads===2);expect(f.counts().starts).toBe(1);
      }finally{await f.runtime.dispose();}
    });
  it('keeps a source wake received during creation recovery and consumes the original acceptance next',async()=>{
    const f=fixture({startError:new McpTaskRequestError('lost-reply',true,'transport'),recoverLease:true,
      async recoverCreation(count){if(count===1){f.runtime.sourceReached();return null;}return{kind:'accepted',response:{task:initial,result:{task:initial}}};}});
    try{
      await expect(f.submit()).rejects.toThrow('lost-reply');f.runtime.start();await until(()=>f.counts().gets>0);
      expect(f.counts().creationReads).toBe(2);expect(f.counts().starts).toBe(1);expect(f.op().accepted).toBe(true);
    }finally{await f.runtime.dispose();}
  });
  it('pauses exact-ID missing/expired polls, retaining Unknown, until an explicit owner-ready observation',async()=>{
    const f=fixture({async get(){throw failure(-32602);}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask?.problem?.kind==='expired');
      await new Promise(resolve=>setTimeout(resolve,40));expect(f.counts().gets).toBe(1);
      expect(f.op().executorStopped).toBe(false);expect(f.op().mcpTask!.resultReady).toBe(false);
      f.event();await f.runtime.reconcile();expect(f.counts().gets).toBe(1);
      f.runtime.sourceReached();await until(()=>f.counts().gets===2);
    }finally{await f.runtime.dispose();}
  });
  it('cancels during a blocked get and ignores that older active snapshot with an equal protocol timestamp',async()=>{
    let resolveGet!:(task:McpTaskState)=>void;
    const blocked=new Promise<McpTaskState>(resolve=>{resolveGet=resolve;});
    const f=fixture({async get(){return blocked;},async cancel(){return{...initial,status:'cancelled'};}});
    try{await f.submit();f.runtime.start();await until(()=>f.counts().gets===1);f.requestCancel();
      await until(()=>f.op().mcpTask!.resultReady);expect(f.counts().cancels).toBe(1);
      resolveGet(initial);await new Promise(resolve=>setTimeout(resolve,20));
      expect(f.op().mcpTask!.task.status).toBe('cancelled');expect(f.op().mcpTask!.problem).toBeUndefined();
      expect(f.op().executorStopped).toBe(false);expect(f.errors).toEqual([]);
    }finally{resolveGet(initial);await f.runtime.dispose();}
  });
  it('keeps an unsupported cancellation diagnostic separate from status availability and recovery',async()=>{
    let healthy=false;
    const f=fixture({async get(){if(!healthy)throw new McpTaskRequestError('network',true,'transport');return initial;},async cancel(){throw new McpTaskRequestError('cancel-unsupported',false,'unsupported');}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask!.availability==='unavailable');
      f.requestCancel();await until(()=>f.updates.some(update=>update.problem?.stage==='cancel'));
      const cancelled=f.updates.find(update=>update.problem?.stage==='cancel')!;
      expect(cancelled.availability).toBe('unavailable');
      healthy=true;f.ready();await until(()=>f.op().mcpTask!.availability==='available');
      f.requestCancel();await until(()=>f.counts().cancels>=2);
      expect(f.op().mcpTask!.availability).toBe('available');expect(f.op().mcpTask!.resultReady).toBe(false);
      expect(f.op().executorStopped).toBe(false);
    }finally{await f.runtime.dispose();}
  });
  for(const code of [-32602,-32000,-32042])it(`keeps management error ${code} separate from the original task's terminal result`,async()=>{
    const f=fixture({async get(){return{...initial,status:'completed'};},async result(){throw failure(code);}});
    try{await f.submit();f.runtime.start();await until(()=>f.updates.some(update=>update.problem?.stage==='result'));
      expect(f.op().executorStopped).toBe(true);
      expect(f.op().mcpTask!.resultReady).toBe(code!==-32602);
      if(code!==-32602){const result=f.updates.find(update=>update.result)!.result!;expect(result.kind).toBe('protocol_error');expect(result.effect).toBe('unknown');expect(result.content.data).toEqual({taskId:'receiver-id',protocolError:{code,message:'Original receiver error'}});
        await until(()=>f.counts().released===1);expect(f.unbinds).toEqual(['rpc_closed']);}
    }finally{await f.runtime.dispose();}
  });
  it('does not hide an existing result-read failure behind a later control failure',async()=>{
    const f=fixture({async get(){return{...initial,status:'input_required'};},async result(){throw failure(-32602);},async cancel(){throw new McpTaskRequestError('cancel-unsupported',false,'unsupported');}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask!.problem?.stage==='result');
      f.requestCancel();await until(()=>f.updates.some(update=>(update.content as {problem?:{stage:string}}).problem?.stage==='cancel'));
      expect(f.op().mcpTask!.problem?.stage).toBe('result');expect(f.op().mcpTask!.availability).toBe('unavailable');
      expect(f.op().mcpTask!.resultReady).toBe(false);expect(f.op().executorStopped).toBe(false);
    }finally{await f.runtime.dispose();}
  });
  for(const error of [false,true])it(`retains a cancelled task's final ${error?'RPC error':'isError response'} without claiming stop`,async()=>{
    const f=fixture({async get(){return{...initial,status:'cancelled'};},...(error?{async result(){throw failure(-32000);}}:{})});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask!.resultReady);
      expect(f.op().executorStopped).toBe(false);expect(f.op().mcpTask!.resultEffect).toBe('unknown');
      const result=f.updates.find(update=>update.result)!.result!;expect(result.kind).toBe(error?'protocol_error':'response');
      if(!error)expect(result.content.data).toMatchObject({isError:true});
      expect(f.counts().cleanups).toBe(0);expect(f.counts().holderAcks).toBe(0);
    }finally{await f.runtime.dispose();}
    expect(f.counts().cleanups).toBe(0);expect(f.op().mcpHolderReleased).toBe(false);
  });
  it('keeps an early nonterminal URL error out of the terminal result and does not poll that result again until new evidence',async()=>{
    let state:McpTaskState['status']='input_required',attempt=0;
    const f=fixture({async get(){return{...initial,status:state};},async result(){if(++attempt===1)throw failure(-32042);return{content:[{type:'text',text:'Original eventual result'}]};}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask?.problem?.rpcCode===-32042);
      await new Promise(resolve=>setTimeout(resolve,40));expect(f.counts().results).toBe(1);expect(f.op().mcpTask!.resultReady).toBe(false);expect(f.op().mcpTask!.task.status).toBe('input_required');
      state='completed';f.notify();await until(()=>f.op().mcpTask!.resultReady);
      expect(f.counts().starts).toBe(1);expect(f.counts().results).toBe(2);expect(f.updates.filter(u=>u.result)).toHaveLength(1);
      expect(f.updates.find(u=>u.result)!.result!.kind).toBe('response');
    }finally{await f.runtime.dispose();}
  });
  it('does not lose an original Task notification that arrives before the URL-error diagnostic commits',async()=>{
    let state:McpTaskState['status']='input_required',attempt=0;
    const f=fixture({async get(){return{...initial,status:state};},async result(){if(++attempt===1){f.notify();throw failure(-32042);}state='completed';return{content:[]};}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask!.resultReady);expect(f.counts().results).toBe(2);expect(f.counts().starts).toBe(1);}
    finally{await f.runtime.dispose();}
  });
  it('pauses a URL-blocked tasks/get instead of producing the same card on each poll',async()=>{
    const f=fixture({async get(count){if(count===1)throw failure(-32042);return{...initial,status:'completed'};}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask?.problem?.rpcCode===-32042);
      await new Promise(resolve=>setTimeout(resolve,40));expect(f.counts().gets).toBe(1);expect(f.counts().results).toBe(0);
      f.notify();await until(()=>f.op().mcpTask!.resultReady);expect(f.counts().starts).toBe(1);
    }finally{await f.runtime.dispose();}
  });
  it('joins an ordinary inflight get without implicitly retrying its later URL error',async()=>{
    let rejectGet!:(error:Error)=>void;
    const first=new Promise<McpTaskState>((_resolve,reject)=>{rejectGet=reject;});
    const f=fixture({async get(){return first;}});
    try{await f.submit();f.runtime.start();await until(()=>f.counts().gets===1);
      const control=f.get();await until(()=>f.counts().accesses===1);rejectGet(failure(-32042));await control;
      await new Promise(resolve=>setTimeout(resolve,40));expect(f.counts().gets).toBe(1);expect(f.counts().starts).toBe(1);
      expect(f.op().mcpTask!.problem?.rpcCode).toBe(-32042);expect(f.op().mcpTask!.resultReady).toBe(false);
    }finally{rejectGet(failure(-32042));await f.runtime.dispose();}
  });
  it('rechecks a Catalog-visible URL error even when the old diagnostic ACK is still pending',async()=>{
    let releaseAck!:()=>void;
    const ack=new Promise<void>(resolve=>{releaseAck=resolve;});
    const f=fixture({async get(count){if(count===1)throw failure(-32042);return{...initial,status:'completed'};},async afterUpdate(change){if(change.problem?.rpcCode===-32042)await ack;}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask?.problem?.rpcCode===-32042);
      const control=f.get();await until(()=>f.counts().accesses===1);releaseAck();await control;
      await until(()=>f.op().mcpTask!.resultReady);expect(f.counts().gets).toBe(2);expect(f.counts().starts).toBe(1);
      expect(f.updates.find(update=>update.problem?.rpcCode===-32042)?.content).toMatchObject({response:{code:-32042,message:'Original receiver error'}});
    }finally{releaseAck();await f.runtime.dispose();}
  });

});
