import { KernelClientError } from './kernel-client.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { waitWithSignal } from '../cancellation.js';
import type { ContextJob } from '@varin/application-client';
import type { ContextPreparer } from './thread-context.js';
import type { ModelSessionConfiguration, LaunchIntent, Run } from './protocol.generated.js';
import type { ContextBudgetOwner, ContextBudgetScope } from './context-budget.js';
import type { ContextPolicySnapshot } from './context-settings.js';
import type { ContextOwner, ContextQuery, ContextResult } from './context-bridge.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

export interface ContextPolicyPreparation { policy:ContextPolicySnapshot; scope:ContextBudgetScope }
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
    private readonly readPolicy:(run:Run,launch:LaunchIntent|null,signal:AbortSignal)=>Promise<ContextPolicyPreparation>,
    private readonly continueRun:(runId:string,signal?:AbortSignal)=>Promise<void>,
    private readonly budget:ContextBudgetOwner | null) {}
  close():void {for(const job of this.jobs.values()) job.controller.abort();this.jobs.clear();}
  async query(query:ContextQuery,signal:AbortSignal):Promise<ContextResult> {
    signal.throwIfAborted();
    const run=await this.runtime.run(query.runId,signal);
    if(run.cancel_requested || ['completed','failed','cancelled'].includes(run.state)) return {status:'failed',code:'context_owner_closed'};
    const launch=await this.runtime.launch(run.id,signal);
    if(query.action==='prepare' || query.action==='decide') {
      const {policy,scope}=await this.readPolicy(run,launch,signal);
      signal.throwIfAborted();
      if (!policy.enabled || !this.budget || query.action === 'prepare' && query.hasAcceptedJob) return {status:'ready',policy,external:false};
      if (scope.sessionId!==run.thread_id) throw new Error('Context budget scope belongs to another Thread');
      if (query.action === 'prepare') return {status:'ready',policy,external:await this.budget.selected(scope,signal)};
      const input={...query.input, inputBudgetTokens:Math.max(0,query.input.capacityTokens-policy.reserveTokens),
        settings:{reserveTokens:policy.reserveTokens,keepRecentTokens:policy.keepRecentTokens,
          backgroundPreparation:policy.backgroundPreparation,preparationWaterline:policy.preparationWaterline}};
      const result=await this.budget.decide(scope,input,signal);
      signal.throwIfAborted();
      return result ? {status:'ready',policy,external:true,decision:result.decision,
        ...(result.decision.kind==='compact'?{summaryRecipe:{strategy:result.strategy,mode:result.decision.mode,
          configurationIdentity:policy.configurationIdentity,additionalInstructions:result.decision.summaryInstructions ?? null}}:{})}
        : {status:'ready',policy,external:false};
    }
    const key=createHash('sha256').update(JSON.stringify(['automatic-context',run.id,query.expectedRevision,query.throughId,run.configuration,launch?.selection.credential_scope ?? null])).digest('hex');
    let work=this.jobs.get(key);
    if(!work) {
      const controller=new AbortController();
      const admission=this.admit(run,query,key,controller.signal);
      work={controller,admission,blocking:false};this.watch(key,work,run,query.nativeBlock);
    }
    const job=await waitWithSignal(work.admission,signal);
    const recipe=job.request.summary_recipe;
    const accepted={throughId:job.request.through_id,summaryRecipe:recipe,
      block:recipe.strategy.kind==='extension'?recipe.mode==='blocking':query.nativeBlock};
    work.blocking ||= accepted.block;
    const [summary,checkpoint]=await Promise.all([this.runtime.run(job.receipt.run_id,signal),this.runtime.context(run.branch_id,signal)]);
    if(checkpoint && checkpoint.revision!==query.expectedRevision) return {status:'ready',published:true,jobRunId:summary.id,accepted};
    if(['failed','cancelled'].includes(summary.state)) return {status:'failed',code:'context_compaction_failed',accepted};
    return {...(work.settled ?? {status:'ready',published:false,jobRunId:summary.id}),accepted};
  }
  private watch(key:string,work:Job,parent:Run,nativeBlock:boolean):void {
    this.jobs.set(key,work);
    const publication=work.admission.then(job=>{
      work.blocking ||= job.request.summary_recipe.strategy.kind==='extension'?job.request.summary_recipe.mode==='blocking':nativeBlock;
      return this.publish(job,parent.id,work);
    }).catch(()=>{
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
      this.watch(job.request.key,{controller,admission,blocking:false},parent,parent.waiting_on?.startsWith('context-wait:')===true);
    }
  }
  private async admit(run:Run,query:CompactQuery,key:string,signal:AbortSignal):Promise<ContextJob> {
    const [checkpoint,existing,launch]=await Promise.all([this.runtime.context(run.branch_id,signal),this.runtime.contextJobs(run.branch_id,signal),this.runtime.launch(run.id,signal)]);
    const previous=existing.find(job=>job.request.key===key) ?? await this.accepted(existing,run,query.expectedRevision,launch,signal);
    if (previous) { await this.start(previous,signal); return previous; }
    const candidate=checkpoint && this.prepareContext.compact ? await this.prepareContext.compact(checkpoint, signal) : undefined;
    const recipe=(candidate ? {effective_system_prompt:candidate.effectiveSystemPrompt,instruction_sources:candidate.instructionSources,memory_checkpoint:candidate.memoryCheckpoint} : checkpoint?.proposal);
    const personalization=candidate?.personalization ?? checkpoint?.personalization;
    const configuration=run.configuration as ModelSessionConfiguration;
    const scope=launch?.selection.credential_scope;
    signal.throwIfAborted();
    let job:ContextJob;
    try {
      job=await this.runtime.createContextJob({summaryRecipe:query.summaryRecipe,key,ownerRunId:run.id,branchId:run.branch_id,throughId:query.throughId,expectedRevision:query.expectedRevision,
        effectiveSystemPrompt:recipe?.effective_system_prompt ?? '',instructionSources:recipe?.instruction_sources ?? [],memoryCheckpoint:recipe?.memory_checkpoint ?? null,
        ...(personalization?{personalization}:{}),configuration,...(scope?{credentialScope:scope}:{})},signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof KernelClientError) || error.code!=='context-job-already-admitted') throw error;
      // Another detached preparation may have committed while our immutable source was loading.
      // The original Catalog admission fence prevents a second paid job, even for another key.
      const accepted=await this.accepted(await this.runtime.contextJobs(run.branch_id,signal),run,query.expectedRevision,launch,signal);
      if (!accepted) throw error;
      job=accepted;
    }
    signal.throwIfAborted();
    await this.start(job,signal);
    return job;
  }
  private async accepted(jobs:ContextJob[],owner:Run,revision:number,launch:LaunchIntent|null,signal:AbortSignal):Promise<ContextJob|undefined> {
    for (const job of jobs) {
      if (job.request.owner_run_id!==owner.id || job.request.expected_revision!==revision) continue;
      const [run,selected]=await Promise.all([this.runtime.run(job.receipt.run_id,signal),this.runtime.launch(job.receipt.run_id,signal)]);
      if (isDeepStrictEqual(run.configuration,owner.configuration) && isDeepStrictEqual(selected?.selection.credential_scope ?? null,launch?.selection.credential_scope ?? null)) return job;
    }
    return undefined;
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
