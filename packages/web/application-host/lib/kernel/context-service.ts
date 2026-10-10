import { createHash } from 'node:crypto';
import { waitWithSignal } from '../cancellation.js';
import type { ContextJob } from '@varin/application-client';
import type { ContextPreparer } from './thread-context.js';
import type { ModelSessionConfiguration, LaunchIntent, Run } from './protocol.generated.js';
import type { ContextPolicySnapshot } from './context-settings.js';
import type { ContextOwner, ContextQuery, ContextResult } from './context-bridge.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

interface Job {
  controller:AbortController;
  admission:Promise<ContextJob>;
  blocking:boolean;
  settled?:ContextResult;
}
type CompactQuery = Extract<ContextQuery,{action:'compact'}>;
/** Credentials remain with the existing model authority; Rust owns each summary Run and CAS. */
export class ContextService implements ContextOwner {
  private readonly jobs=new Map<string,Job>();
  constructor(private readonly runtime:AgentRuntimeClient,
    private readonly prepareContext:ContextPreparer,
    private readonly readPolicy:(run:Run,launch:LaunchIntent|null)=>Promise<ContextPolicySnapshot>,
    private readonly continueRun:(runId:string,signal?:AbortSignal)=>Promise<void>) {}
  close():void {for(const job of this.jobs.values()) job.controller.abort();this.jobs.clear();}
  async query(query:ContextQuery,signal:AbortSignal):Promise<ContextResult> {
    signal.throwIfAborted();
    const run=await this.runtime.run(query.runId,signal);
    if(run.cancel_requested || ['completed','failed','cancelled'].includes(run.state)) return {status:'failed',code:'context_owner_closed'};
    if(query.action==='policy') {
      const policy=await this.readPolicy(run,await this.runtime.launch(run.id,signal));
      signal.throwIfAborted();return {status:'ready',policy};
    }
    const launch=await this.runtime.launch(run.id,signal);
    const key=createHash('sha256').update(JSON.stringify(['automatic-context',run.id,query.expectedRevision,query.throughId,run.configuration,launch?.selection.credential_scope ?? null])).digest('hex');
    let work=this.jobs.get(key);
    if(!work) {
      const controller=new AbortController();
      const admission=this.admit(run,query,key,controller.signal);
      work={controller,admission,blocking:query.block};this.watch(key,work,run);
    }
    work.blocking ||= query.block;
    const job=await waitWithSignal(work.admission,signal);
    const [summary,checkpoint]=await Promise.all([this.runtime.run(job.receipt.run_id,signal),this.runtime.context(run.branch_id,signal)]);
    if(checkpoint && checkpoint.revision!==query.expectedRevision) return {status:'ready',published:true,jobRunId:summary.id};
    if(['failed','cancelled'].includes(summary.state)) return {status:'failed',code:'context_compaction_failed'};
    return work.settled ?? {status:'ready',published:false,jobRunId:summary.id};
  }
  private watch(key:string,work:Job,parent:Run):void {
    this.jobs.set(key,work);
    const publication=work.admission.then(job=>this.publish(job,parent.id,work)).catch(()=>{
      if(work.controller.signal.aborted) return {status:'failed',code:'context_preparation_cancelled'} as const;
      return {status:'failed',code:'context_compaction_failed'} as const;
    });
    // Admission and observation have distinct lifetimes. Cancelling one query cannot erase an
    // accepted job or cause a second paid generation. Epoch close stops only these observers.
    void publication.finally(()=>{if(this.jobs.get(key)===work) this.jobs.delete(key);}).catch(()=>undefined);
  }
  async recover():Promise<void> {
    const threads=await this.runtime.threads();
    const jobs=(await Promise.all(threads.filter(thread=>thread.thread_id.startsWith('thread:'))
      .flatMap(thread=>thread.branches.map(branch=>this.runtime.contextJobs(branch.branch_id))))).flat();
    for(const job of jobs) {
      const parentId=job.request.owner_run_id;if(!parentId || this.jobs.has(job.request.key)) continue;
      const parent=await this.runtime.run(parentId);
      if(parent.cancel_requested || parent.state==='cancelled') {await this.runtime.cancelRun(job.receipt.run_id);continue;}
      const controller=new AbortController();
      const admission=this.start(job,controller.signal).then(()=>job);
      this.watch(job.request.key,{controller,admission,blocking:parent.waiting_on?.startsWith('context-wait:')===true},parent);
    }
  }
  private async admit(run:Run,query:CompactQuery,key:string,signal:AbortSignal):Promise<ContextJob> {
    const [checkpoint,existing,launch]=await Promise.all([this.runtime.context(run.branch_id,signal),this.runtime.contextJobs(run.branch_id,signal),this.runtime.launch(run.id,signal)]);
    const previous=existing.find(job=>job.request.key===key);
    const candidate=!previous && checkpoint && this.prepareContext.compact ? await this.prepareContext.compact(checkpoint) : undefined;
    const recipe=previous?.request ?? (candidate ? {effective_system_prompt:candidate.effectiveSystemPrompt,instruction_sources:candidate.instructionSources,memory_checkpoint:candidate.memoryCheckpoint} : checkpoint?.proposal);
    const personalization=previous?.request.personalization ?? candidate?.personalization ?? checkpoint?.personalization;
    const configuration=run.configuration as ModelSessionConfiguration;
    const scope=launch?.selection.credential_scope;
    signal.throwIfAborted();
    const job=await this.runtime.createContextJob({key,ownerRunId:run.id,branchId:run.branch_id,throughId:query.throughId,expectedRevision:query.expectedRevision,
      effectiveSystemPrompt:recipe?.effective_system_prompt ?? '',instructionSources:recipe?.instruction_sources ?? [],memoryCheckpoint:recipe?.memory_checkpoint ?? null,
      ...(personalization?{personalization}:{}),configuration,...(scope?{credentialScope:scope}:{})},signal);
    signal.throwIfAborted();
    await this.start(job,signal);
    return job;
  }
  private async start(job:ContextJob,signal:AbortSignal):Promise<void> {
    const launch=await this.runtime.launch(job.receipt.run_id,signal);
    if(launch?.startable && launch.requires_rebind) await this.continueRun(job.receipt.run_id,signal);
  }
  private async publish(job:ContextJob,parentId:string,work:Job):Promise<ContextResult> {
    const signal=work.controller.signal;
    let dirty=true;let wake:(()=>void)|undefined;
    const notify=()=>{dirty=true;wake?.();};
    const remove=this.runtime.onEvent(event=>{if(event.stream==='durable') notify();});
    signal.addEventListener('abort',notify);
    try {
      for(;;) {
        signal.throwIfAborted();
        if(!dirty) {await new Promise<void>(resolve=>{wake=resolve;if(dirty || signal.aborted) resolve();});wake=undefined;continue;}
        dirty=false;
        const [run,parent,checkpoint]=await Promise.all([this.runtime.run(job.receipt.run_id,signal),this.runtime.run(parentId,signal),this.runtime.context(job.request.branch_id,signal)]);
        if(parent.cancel_requested || parent.state==='cancelled') {await this.runtime.cancelRun(run.id);return {status:'failed',code:'context_preparation_cancelled'};}
        if(!work.settled) {
          if(checkpoint && checkpoint.revision!==job.request.expected_revision) work.settled={status:'ready',published:true,jobRunId:run.id};
          else if(run.state==='completed') {
            try {await this.runtime.publishContextJob(run.id,signal);}
            catch(error) {
              const current=await this.runtime.context(job.request.branch_id,signal);
              if(!current || current.revision===job.request.expected_revision) throw error;
            }
            work.settled={status:'ready',published:true,jobRunId:run.id};
          } else if(['failed','cancelled'].includes(run.state)) work.settled={status:'failed',code:'context_compaction_failed'};
        }
        if(work.settled) {
          if(!work.blocking || ['completed','failed','cancelled'].includes(parent.state)) return work.settled;
          const resumed=await this.runtime.resumeContextJob(run.id,signal);
          if(resumed) {
            await this.continueRun(resumed.id);
            return work.settled;
          }
        }
      }
    } finally {remove();signal.removeEventListener('abort',notify);}
  }
}
