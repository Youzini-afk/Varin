import { describe, expect, it } from 'vitest';
import { McpTaskRequestError, type McpTaskLease, type McpAuthorityTool } from '@varin/pi-host/mcp-authority';
import { createMcpTaskRuntime } from './mcp-task-runtime.js';
import type { KernelClient } from './kernel-client.js';
import type { HostJobPending, HostJobTaskUpdateParams, HostToolCall, McpTaskState } from './protocol.generated.js';

// Fault-injection at the Host/Catalog request boundary. Actual Catalog persistence, original
// admission and remote stdio behavior are covered by the kernel MCP Task integration tests.
const initial:McpTaskState={taskId:'receiver-id',status:'working',createdAt:'2026-01-01T00:00:00Z',lastUpdatedAt:'2026-01-01T00:00:00Z',ttl:0,pollInterval:5};
const endpoint={server:'peer',resourceKey:'mcp:peer',configurationVersion:'configuration',credentialVersion:'grant'};
const owner={kind:'external' as const,identity:'host',epoch:'epoch'};
const call:HostToolCall={operationId:'original-operation',runId:'original-run',origin:{kind:'model_step',request_id:'original-step'},callId:'original-call',name:'task',schemaVersion:'v1',arguments:{}};
const tool:McpAuthorityTool={name:'task',server:'peer',tool:'task',schemaVersion:'v1',taskSupport:'required',taskCapable:true,resourceKey:endpoint.resourceKey,configurationScope:'global',executionScope:'global',inputSchema:{type:'object'},description:'',exposure:'direct'};
const failure=(code:number)=>new McpTaskRequestError('remote-error',true,'protocol',code,{code,message:'Original receiver error'});
async function until(predicate:()=>boolean){for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Expected observation did not arrive');}
function fixture(options:{acceptFailures?:number;commitFailedAccept?:boolean;get?:(count:number)=>Promise<McpTaskState>;result?:()=>Promise<Record<string,unknown>>;cancel?:()=>Promise<McpTaskState>}={}){
  let op:HostJobPending|undefined,accepts=0,starts=0,gets=0,results=0,cancels=0,released=0;
  const updates:HostJobTaskUpdateParams[]=[],errors:Error[]=[];
  const finishes:string[]=[];
  let ready:()=>void=()=>{},event:()=>void=()=>{};
  const clone=<T>(v:T):T=>structuredClone(v);
  const accept=()=>{op={...op!,accepted:true,mcpTask:{revision:1,task:clone(initial),observationRef:'acceptance',availability:'available',resultReady:false}};};
  const finish=()=>{finishes.push(op!.mcpTask!.task.status);if(['completed','failed'].includes(op!.mcpTask!.task.status))op={...op!,executorStopped:true};};
  const kernel={async agentRuntimeRequest(method:string,params:Record<string,unknown>){
    switch(method){
      case'runtime.host_job.begin':op={binding:params.binding as HostJobPending['binding'],runId:call.runId,accepted:false,cancelRequested:false,executorStopped:false,phase:'running',origin:{kind:'tool',origin:call.origin,call_id:call.callId,tool_name:call.name,schema_version:call.schemaVersion}};return clone(op);
      case'runtime.host_job.accept':accepts++;if(accepts<=(options.acceptFailures??0)){if(options.commitFailedAccept&&!op!.accepted)accept();throw new Error('Acceptance reply interrupted');}if(!op!.accepted)accept();return clone(op);
      case'runtime.host_job.pending':return op?[clone(op)]:[];
      case'runtime.host_job.task.update':{
        const change=params as unknown as HostJobTaskUpdateParams;updates.push(clone(change));
        const current=op!.mcpTask!;
        if(current.revision!==change.expectedRevision)return clone(op);
        op={...op!,mcpTask:{revision:current.revision+1,task:clone(change.task),observationRef:'observation',availability:change.availability,...(change.problem?{problem:change.problem}:{}),
          resultReady:current.resultReady||!!change.result,...(change.result?{resultRef:'result',resultKind:change.result.kind,resultOutcome:change.result.outcome,resultEffect:change.result.effect}:current.resultRef?{resultRef:current.resultRef}:{} )}};
        finish();return clone(op);
      }
      case'runtime.host_job.task.finish':finish();return clone(op);
      default:throw new Error(`Unexpected request ${method}`);
    }
  }} as unknown as KernelClient;
  const lease:McpTaskLease={endpoint,async start(){starts++;return{task:clone(initial),result:{task:clone(initial)}};},async get(){gets++;const task=await(options.get?.(gets)??Promise.resolve(initial));return{task:clone(task),result:{...clone(task)}};},async result(){results++;return options.result?.()??{content:[{type:'text',text:'Final content'}],isError:true};},async cancel(){cancels++;if(!options.cancel)throw new Error('Unexpected cancel');const task=await options.cancel();return{task:clone(task),result:{...clone(task)}};},onChange(){return()=>{};},release(){released++;}};
  const runtime=createMcpTaskRuntime({kernel,runtime:{onReady(listener){ready=listener;return()=>{};},onEvent(listener){event=()=>listener({} as never);return()=>{};},async reconcileObservations(){return [];}},async recover(){throw new Error('Live task lease was lost');},onError(error){errors.push(error);}});
  return{runtime,updates,errors,finishes,lease,op:()=>op!,counts:()=>({accepts,starts,gets,results,cancels,released}),ready:()=>ready(),event:()=>event(),requestCancel:()=>{op={...op!,cancelRequested:true};event();},submit:()=>runtime.submit({call,owner,lease,tool,args:{},signal:new AbortController().signal})};
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
  it('pauses exact-ID missing/expired polls, retaining Unknown, until an explicit owner-ready observation',async()=>{
    const f=fixture({async get(){throw failure(-32602);}});
    try{await f.submit();f.runtime.start();await until(()=>f.op().mcpTask?.problem?.kind==='expired');
      await new Promise(resolve=>setTimeout(resolve,40));expect(f.counts().gets).toBe(1);
      expect(f.op().executorStopped).toBe(false);expect(f.op().mcpTask!.resultReady).toBe(false);
      f.event();await f.runtime.reconcile();expect(f.counts().gets).toBe(1);
      f.ready();await until(()=>f.counts().gets===2);
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
  for(const code of [-32602,-32000])it(`keeps management error ${code} separate from the original task's terminal result`,async()=>{
    const f=fixture({async get(){return{...initial,status:'completed'};},async result(){throw failure(code);}});
    try{await f.submit();f.runtime.start();await until(()=>f.updates.some(update=>update.problem?.stage==='result'));
      expect(f.op().executorStopped).toBe(true);
      expect(f.op().mcpTask!.resultReady).toBe(code===-32000);
      if(code===-32000){const result=f.updates.find(update=>update.result)!.result!;expect(result.kind).toBe('protocol_error');expect(result.effect).toBe('unknown');expect(result.content.data).toEqual({taskId:'receiver-id',protocolError:{code,message:'Original receiver error'}});}
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
    }finally{await f.runtime.dispose();}
  });
});
