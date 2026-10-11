/** Reconcile the original Catalog HostJob with its accepted MCP Task. This owns live leases only;
 * every durable identity, cancellation, acceptance, observation and output stays in Catalog. */
import { McpAuthorityError, McpTaskRequestError, type McpTaskLease, type McpAuthorityTool, type McpTaskResponse } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostToolCall, ToolExecutionReceipt } from './tool-bridge.js';
import type { ExecutorOwner, HostJobBinding, HostJobPending, HostJobTaskUpdateParams, KernelMethod, KernelMethodParams, McpTaskAction, McpTaskProblem, McpTaskStage, Operation, OutputBody, ResolvedMedia } from './protocol.generated.js';
import { projectMcpOutput } from './mcp-output.js';
const DOMAIN = 'mcp.task';
const terminal = (status: string) => ['completed','failed','cancelled'].includes(status);
const stopped = (status: string) => status === 'completed' || status === 'failed';
const accepted = (operationId:string):ToolExecutionReceipt => ({executor_stopped:false,completion:{kind:'job_accepted',operation_id:operationId,phase:'accepted',effect:'confirmed',lifetime:'thread'}});
interface Entry {
  op: HostJobPending;
  acceptance?:McpTaskResponse;
  acceptanceFlight?:Promise<void>;
  lease?: McpTaskLease;
  unobserve?:()=>void;
  unbindInteraction?:()=>void;
  nextPoll: number;
  resultFlight?:Promise<void>;
  pollFlight?:Promise<void>;
  cancelFlight?:Promise<void>;
  recoveryFlight?:Promise<void>;
  result?:Record<string,unknown>;
  resultError?:McpTaskRequestError;
  resultAttempted:boolean;
  serial:Promise<unknown>;
}
export type McpTaskRuntime = ReturnType<typeof createMcpTaskRuntime>;
export function createMcpTaskRuntime(options:{
  kernel:KernelClient;
  runtime:Pick<AgentRuntimeClient,'onReady'|'onEvent'|'reconcileObservations'>;
  recover(pending:HostJobPending,signal:AbortSignal):Promise<McpTaskLease>;
  onError?:(error:Error)=>void;
}) {
  const entries = new Map<string,Entry>(), admitting = new Set<string>();
  const lifetime = new AbortController();
  const removers:Array<()=>void> = [];
  let started=false, disposed=false, work:Promise<void>|undefined, dirty=false, timer:ReturnType<typeof setTimeout>|undefined;
  const report = (error:unknown) => { if (!disposed) options.onError?.(error instanceof Error ? error : new Error(String(error))); };
  const request = <T,M extends Extract<KernelMethod,`runtime.${string}`>>(method:M,params:KernelMethodParams[M],signal?:AbortSignal):Promise<T> => options.kernel.agentRuntimeRequest<T,M>(method,params,signal);
  const queue = <T>(entry:Entry,fn:()=>Promise<T>):Promise<T> => {
    const result=entry.serial.then(fn,fn); entry.serial=result.catch(()=>undefined); return result;
  };
  const unavailable = (entry:Entry) => {
    const problem=entry.op.mcpTask?.problem;
    return !!problem && problem.stage !== 'cancel' && problem.stage !== 'interaction'
      && (problem.kind === 'owner' || problem.kind === 'unsupported' || problem.rpcCode === -32601 || problem.rpcCode === -32602);
  };
  type Change=Omit<HostJobTaskUpdateParams,'binding'|'expectedRevision'>;
  const update = (entry:Entry,input:Change|((current:NonNullable<HostJobPending['mcpTask']>)=>Change)) => queue(entry,async()=>{
    const current=entry.op.mcpTask!;
    let change=typeof input==='function'?input(current):input;
    if(change.task.taskId!==current.task.taskId || change.task.createdAt!==current.task.createdAt)throw new McpTaskRequestError('mcp-task-identity-changed',true,'protocol');
    if(Date.parse(change.task.lastUpdatedAt)<Date.parse(current.task.lastUpdatedAt) || terminal(current.task.status)&&change.task.status!==current.task.status) {
      if(!change.result)return entry.op;
      change={...change,task:current.task};
    }
    const next=await request<HostJobPending,'runtime.host_job.task.update'>('runtime.host_job.task.update',{
      binding:entry.op.binding,expectedRevision:current.revision,...change,
    });
    entry.op=next;return next;
  });
  const recordProblem = async(entry:Entry,error:unknown,stage:McpTaskStage) => {
    const task=entry.op.mcpTask!.task;
    const problem:McpTaskProblem = error instanceof McpTaskRequestError
      ? {kind:error.kind,stage,...(error.rpcCode === undefined ? {} : {rpcCode:error.rpcCode})}
      : {kind:error instanceof McpAuthorityError ? 'owner' : 'transport',stage};
    // A retention deadline can explain unavailability, never prove completion or physical stop.
    if (stage !== 'cancel' && task.ttl !== null && Date.parse(task.createdAt)+task.ttl <= Date.now() && problem.rpcCode === -32602) problem.kind='expired';
    const content={taskId:task.taskId,problem,...(error instanceof McpTaskRequestError && error.protocolError ? {response:error.protocolError} : {})};
    // A failed control request says nothing about observing the Task. Keep an existing
    // result/interaction error as the primary diagnostic rather than hiding that evidence.
    await update(entry,prior=>{
      const primary=stage==='cancel' && prior.problem && ['result','interaction'].includes(prior.problem.stage) ? prior.problem : problem;
      return{task:prior.task,availability:stage==='cancel'?prior.availability:'unavailable',problem:primary,content};
    });
    if(unavailable(entry))entry.nextPoll=Infinity;
  };
  const observe = async(entry:Entry,response:McpTaskResponse,requested?:HostJobPending['mcpTask']) => {
    const original=entry.op.mcpTask!.task,next=response.task;
    if (next.taskId !== original.taskId || next.createdAt !== original.createdAt)
      throw new McpTaskRequestError('mcp-task-identity-or-terminal-changed',true,'protocol');
    if (Date.parse(next.lastUpdatedAt)<Date.parse(original.lastUpdatedAt)) return;
    // A get started before local terminal publication may return its earlier active snapshot.
    // Protocol timestamps need not be unique; the original observation revision is the fence.
    if(requested && entry.op.mcpTask!.revision>requested.revision && original.status!==requested.task.status
      && terminal(original.status) && !terminal(next.status))return;
    if(terminal(original.status)&&next.status!==original.status)throw new McpTaskRequestError('mcp-task-terminal-changed',true,'protocol');
    await update(entry,prior=>{
      const problem=prior.problem && prior.problem.stage !== 'status' && prior.problem.stage !== 'rebind' ? prior.problem : undefined;
      return{task:next,availability:problem && problem.stage!=='cancel' ? prior.availability : 'available',...(problem?{problem}:{}),content:response.result};
    });
  };
  const getStatus = async(entry:Entry) => {
    const requested=entry.op.mcpTask!;
    await observe(entry,await entry.lease!.get(requested.task.taskId,lifetime.signal),requested);
  };
  const publishResult = async(entry:Entry) => {
    const raw=entry.result,error=entry.resultError;
    if ((!raw&&!error) || entry.op.mcpTask!.resultReady) return;
    const task=entry.op.mcpTask!.task;
    if (!terminal(task.status)) {
      await update(entry,{task,availability:'unavailable',problem:{kind:'protocol',stage:'result'},content:{error:'mcp_result_before_matching_terminal_status',response:raw ?? error?.protocolError}});
      return;
    }
    const failed=task.status !== 'completed' || raw?.isError === true || !!error;
    await update(entry,{task,availability:error?'unavailable':'available',...(error?{problem:{kind:'protocol' as const,stage:'result' as const,...(error.rpcCode===undefined?{}:{rpcCode:error.rpcCode})}}:{}),content:{taskId:task.taskId,status:task.status},
      result:{kind:error?'protocol_error':'response',outcome:failed ? 'indeterminate' : 'succeeded',effect:failed ? 'unknown' : 'confirmed',
        content:error?{data:{taskId:task.taskId,protocolError:error.protocolError},parts:[]}:projectMcpOutput(raw!,'tool')}});
    if(!entry.op.mcpTask!.resultReady)return;
    delete entry.result;delete entry.resultError;
    await options.runtime.reconcileObservations();
  };
  const receiveResult = (entry:Entry) => {
    if (entry.resultFlight || entry.op.mcpTask!.resultReady || !entry.lease || entry.result || entry.resultError) return;
    entry.resultAttempted=true;
    entry.resultFlight=(async()=>{
      try {
        const raw=await entry.lease!.result(entry.op.mcpTask!.task.taskId,lifetime.signal);
        entry.result=raw;
        if (!terminal(entry.op.mcpTask!.task.status)) await getStatus(entry);
        await publishResult(entry);
      } catch(error) {
        if(!disposed){
          // Standard JSON-RPC management/validation errors do not establish an original task
          // result. Application errors on a known terminal Task retain their real error body.
          if(error instanceof McpTaskRequestError && error.protocolError && error.rpcCode !== undefined
            && ![-32700,-32600,-32601,-32602,-32603].includes(error.rpcCode)) {
            entry.resultError=error;
            if(!terminal(entry.op.mcpTask!.task.status)) {
              try {await getStatus(entry);}catch(statusError){await recordProblem(entry,statusError,'status');}
            }
            await publishResult(entry);
          }else await recordProblem(entry,error,'result');
        }
      }
    })().catch(report).finally(()=>{delete entry.resultFlight;if(!disposed){entry.nextPoll=unavailable(entry)?Infinity:Date.now()+(entry.op.mcpTask!.task.pollInterval ?? 1000);wake();}});
  };
  const retain = (entry:Entry,lease:McpTaskLease) => {
    entry.lease=lease;
    if(entry.op.mcpTask&&lease.bindInteraction)entry.unbindInteraction=lease.bindInteraction(entry.op.mcpTask.task.taskId,{operationId:entry.op.binding.operationId,executionOwner:entry.op.binding.executionOwner});
    entry.unobserve=lease.onChange((id,unsupported)=>{
      if(id !== (entry.op.mcpTask?.task.taskId ?? entry.acceptance?.task.taskId) || disposed)return;
      if(unsupported&&entry.op.mcpTask) void recordProblem(entry,new McpTaskRequestError('mcp-task-interaction-unsupported',false,'unsupported'),'interaction').catch(report);
      entry.nextPoll=0;wake();
    });
  };
  const forget = (id:string,entry:Entry) => {entry.unobserve?.();entry.unbindInteraction?.();entry.lease?.release();entries.delete(id);};
  const recordAcceptance=(entry:Entry):Promise<void>=>{
    if(!entry.acceptance)return Promise.resolve();
    if(entry.acceptanceFlight)return entry.acceptanceFlight;
    const response=entry.acceptance;
    entry.acceptanceFlight=request<HostJobPending,'runtime.host_job.accept'>('runtime.host_job.accept',{
      binding:entry.op.binding,task:response.task,content:{data:response.result,parts:[]},
    }).then(op=>{entry.op=op;delete entry.acceptance;entry.nextPoll=0;
      if(op.mcpTask&&!entry.unbindInteraction&&entry.lease?.bindInteraction)entry.unbindInteraction=entry.lease.bindInteraction(op.mcpTask.task.taskId,{operationId:op.binding.operationId,executionOwner:op.binding.executionOwner});})
      .finally(()=>{delete entry.acceptanceFlight;});
    return entry.acceptanceFlight;
  };
  const ensureLease=(entry:Entry):Promise<void>=>{
    if(entry.lease)return Promise.resolve();
    if(entry.recoveryFlight)return entry.recoveryFlight;
    entry.recoveryFlight=options.recover(entry.op,lifetime.signal).then(lease=>retain(entry,lease)).finally(()=>{delete entry.recoveryFlight;});
    return entry.recoveryFlight;
  };
  const cancelEntry=(entry:Entry):Promise<void>=>{
    if(entry.cancelFlight)return entry.cancelFlight;
    if(!entry.op.cancelRequested || terminal(entry.op.mcpTask!.task.status))return Promise.resolve();
    entry.cancelFlight=(async()=>{
      try {await ensureLease(entry);await observe(entry,await entry.lease!.cancel(entry.op.mcpTask!.task.taskId,lifetime.signal));receiveResult(entry);}
      catch(error){if(!disposed)await recordProblem(entry,error,'cancel');}
    })().finally(()=>{delete entry.cancelFlight;wake();});
    return entry.cancelFlight;
  };
  const syncEntry=(entry:Entry):Promise<void>=>{
    if(entry.pollFlight)return entry.pollFlight;
    if(Date.now()<entry.nextPoll)return Promise.resolve();
    entry.nextPoll=Date.now()+(entry.op.mcpTask!.task.pollInterval ?? 1000);
    entry.pollFlight=(async()=>{
      if(stopped(entry.op.mcpTask!.task.status)&&!entry.op.executorStopped)
        entry.op=await request<HostJobPending,'runtime.host_job.task.finish'>('runtime.host_job.task.finish',{binding:entry.op.binding});
      if(entry.op.mcpTask!.resultReady){
        entry.op=await request<HostJobPending,'runtime.host_job.task.finish'>('runtime.host_job.task.finish',{binding:entry.op.binding});
        // A cancelled task can retain a response without proving its writer stopped.
        if(entry.op.executorStopped)forget(entry.op.binding.operationId,entry);else entry.nextPoll=Infinity;
        return;
      }
      try {await ensureLease(entry);}catch(error){if(!disposed)await recordProblem(entry,error,'rebind');return;}
      try {
        await getStatus(entry);
        await publishResult(entry);
        const status=entry.op.mcpTask!.task.status;
        if(!entry.op.mcpTask!.resultReady && (status==='input_required'||terminal(status))) {
          if(status!=='cancelled'||!entry.resultAttempted)receiveResult(entry);
        }
        if(status==='cancelled'&&entry.resultAttempted&&!entry.resultFlight)entry.nextPoll=Infinity;
      }catch(error){if(!disposed)await recordProblem(entry,error,'status');}
    })().catch(report).finally(()=>{delete entry.pollFlight;schedule();});
    return entry.pollFlight;
  };
  const schedule=()=>{
    if(timer)clearTimeout(timer);timer=undefined;
    if(!started || disposed)return;
    const next=Math.min(...[...entries.values()].filter(entry=>!entry.pollFlight).map(entry=>entry.nextPoll));
    if(Number.isFinite(next)){timer=setTimeout(wake,Math.max(0,next-Date.now()));timer.unref?.();}
  };
  const sync=async()=>{
    await Promise.all([...entries.values()].filter(entry=>entry.acceptance&&entry.nextPoll<=Date.now()).map(async entry=>{
      try{await recordAcceptance(entry);}catch(error){entry.nextPoll=Date.now()+1000;report(error);}
    }));
    const pending=await request<HostJobPending[],'runtime.host_job.pending'>('runtime.host_job.pending',{});
    const remaining=new Set<string>();
    for(const op of pending){
      if(op.binding.domain !== DOMAIN || op.binding.subject.kind !== 'mcp' || !op.accepted || !op.mcpTask)continue;
      const id=op.binding.operationId;remaining.add(id);if(admitting.has(id))continue;
      let entry=entries.get(id);
      if(!entry){entry={op,nextPoll:0,resultAttempted:false,serial:Promise.resolve()};entries.set(id,entry);}
      else if(!entry.op.mcpTask || op.mcpTask.revision>=entry.op.mcpTask.revision){
        if(entry.acceptance){
          if(entry.acceptance.task.taskId!==op.mcpTask.task.taskId || entry.acceptance.task.createdAt!==op.mcpTask.task.createdAt)
            throw new McpTaskRequestError('mcp-task-acceptance-identity-changed',true,'protocol');
          delete entry.acceptance;
          entry.nextPoll=0;
        }
        if(op.cancelRequested && !entry.op.cancelRequested)entry.nextPoll=0;
        entry.op={...op,cancelRequested:op.cancelRequested||entry.op.cancelRequested,executorStopped:op.executorStopped||entry.op.executorStopped};
      }
      if(entry.op.cancelRequested && (!entry.op.mcpTask?.problem || entry.nextPoll<=Date.now()))void cancelEntry(entry).catch(report);
      void syncEntry(entry).catch(report);
    }
    for(const [id,entry]of entries)if(!remaining.has(id)&&!admitting.has(id)&&!entry.acceptance)forget(id,entry);
    schedule();
  };
  const reconcile=():Promise<void>=>{
    if(disposed)return Promise.resolve();dirty=true;
    if(work)return work;
    work=(async()=>{while(dirty&&!disposed){dirty=false;await sync();}})().finally(()=>{work=undefined;if(dirty&&!disposed)wake();});
    return work;
  };
  const wake=()=>{if(started&&!disposed)void reconcile().catch(report);};
  return {
    start(){if(started||disposed)return;started=true;removers.push(options.runtime.onReady(()=>{for(const entry of entries.values()){entry.nextPoll=0;entry.resultAttempted=false;}wake();}),options.runtime.onEvent(wake));wake();},
    reconcile,
    async submit(input:{call:HostToolCall;owner:ExecutorOwner;lease:McpTaskLease;tool:McpAuthorityTool;args:Record<string,unknown>;ttl?:number;signal:AbortSignal;beforeDispatch?:()=>void|Promise<void>}):Promise<ToolExecutionReceipt>{
      if(disposed)throw new McpTaskRequestError('mcp-task-owner-closed',false,'owner');
      const binding:HostJobBinding={operationId:input.call.operationId,executionOwner:input.owner,domain:DOMAIN,domainVersion:1,
        subject:{kind:'mcp',endpoint:input.lease.endpoint,dispatchId:input.call.operationId}};
      admitting.add(binding.operationId);let retained=false;
      try {
        const before=await request<HostJobPending,'runtime.host_job.begin'>('runtime.host_job.begin',{binding});
        if(before.accepted)return accepted(binding.operationId);
        if(before.cancelRequested || before.phase === 'terminal')throw new McpTaskRequestError('mcp-task-original-dispatch-unavailable',false,'owner');
        const response=await input.lease.start(input.tool.tool,input.args,{schemaVersion:input.tool.schemaVersion,signal:AbortSignal.any([input.signal,lifetime.signal]),
          ...(input.ttl === undefined?{}:{ttl:input.ttl}),...(input.beforeDispatch?{beforeDispatch:input.beforeDispatch}:{})});
        // A returned remote ID is retained even if Catalog's acceptance reply is interrupted.
        // Only this identical local acceptance may be retried; tools/call is never replayed.
        const entry:Entry={op:before,acceptance:response,nextPoll:0,resultAttempted:false,serial:Promise.resolve()};
        retain(entry,input.lease);entries.set(binding.operationId,entry);retained=true;
        await recordAcceptance(entry);
        return {...accepted(binding.operationId),completion:{kind:'job_accepted',operation_id:binding.operationId,phase:'accepted',effect:'confirmed',lifetime:'thread',content:{data:response.result,parts:[]}}};
      } finally {admitting.delete(binding.operationId);if(!retained)input.lease.release();wake();}
    },
    async control(input:{call:HostToolCall;owner:ExecutorOwner;action:McpTaskAction;targetOperationId:string;signal:AbortSignal}):Promise<ToolExecutionReceipt>{
      const operation=await request<Operation,'runtime.host_job.access'>('runtime.host_job.access',{runId:input.call.runId,targetOperationId:input.targetOperationId,control:input.action==='cancel'},input.signal);
      if(operation.host_job?.binding.subject.kind !== 'mcp' || !operation.host_job.mcpTask)throw new McpTaskRequestError('mcp-task-original-id-unavailable',false,'owner');
      if(input.action==='wait'){
        const op=await request<Operation,'runtime.host_job.observe'>('runtime.host_job.observe',{operationId:input.call.operationId,targetOperationId:input.targetOperationId,mode:'result'},input.signal);
        const completion=op.call_completion;
        if(completion?.kind!=='job_accepted')throw new Error('Original Task Wait acceptance is unavailable');
        return {executor_stopped:false,completion:{kind:completion.kind,operation_id:completion.operation_id,phase:completion.phase,effect:completion.effect,lifetime:completion.lifetime}};
      }
      if(input.action==='cancel'){
        await request('runtime.operation.cancel',{operationId:input.targetOperationId},input.signal);
        await reconcile();
        const entry=entries.get(input.targetOperationId);if(entry){entry.op={...entry.op,cancelRequested:true};await cancelEntry(entry);}
      }
      await reconcile();
      if(input.action==='get'){const entry=entries.get(input.targetOperationId);if(entry){entry.nextPoll=0;await syncEntry(entry);}}
      const view=await request<{operation:Operation;observation:unknown;result:OutputBody<ResolvedMedia>|null},'runtime.host_job.task.read'>('runtime.host_job.task.read',{runId:input.call.runId,targetOperationId:input.targetOperationId},input.signal);
      return {executor_stopped:true,completion:{kind:'result',outcome:'succeeded',effect:input.action==='cancel'?'confirmed':'none',content:{data:{operationId:input.targetOperationId,
        task:view.operation.host_job!.mcpTask,executorStopped:view.operation.external_receipt?.executor_stopped ?? false,cancelRequested:view.operation.cancel_requested,
        observation:view.observation,result:view.result?.data ?? null},parts:(view.result?.parts ?? []).map(part=>part.kind==='text'?part:{kind:'media' as const,media:{media_type:part.media.media_type,data_base64:part.media.data_base64}})}}};
    },
    async dispose(){if(disposed)return;disposed=true;lifetime.abort();if(timer)clearTimeout(timer);for(const stop of removers.splice(0))stop();
      await Promise.allSettled([...(work?[work]:[]),...[...entries.values()].flatMap(entry=>[entry.serial,...(entry.acceptanceFlight?[entry.acceptanceFlight]:[]),...(entry.resultFlight?[entry.resultFlight]:[]),...(entry.pollFlight?[entry.pollFlight]:[]),...(entry.cancelFlight?[entry.cancelFlight]:[]),...(entry.recoveryFlight?[entry.recoveryFlight]:[])])]);
      for(const [id,entry]of entries)forget(id,entry);
    },
  };
}
