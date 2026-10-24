import { KernelClientError } from './kernel-error.js';
import { admitContextJobCandidate, contextCompactionScope } from './context-job-preparation.js';
import type { ContextCompactionOwner } from './context-compaction.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { waitWithSignal } from '../cancellation.js';
import type { ContextJob } from '@varin/application-client';
import type { ContextPreparer } from './thread-context.js';
import type { ModelSessionConfiguration, LaunchIntent, Run } from './protocol.generated.js';
import type { ContextBudgetOwner, ContextBudgetScope } from './context-budget.js';
import type { ContextPolicySnapshot } from './context-settings.js';
import type { ContextOwner, ContextQuery, ContextResult } from './context-bridge.js';
import { ContextPreparationTiming } from './context-timing.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextAgentOwner } from './context-agent.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';

export interface ContextPolicyPreparation { policy:ContextPolicySnapshot; scope:ContextBudgetScope }
interface Job {
  controller:AbortController;
  admission:Promise<ContextJob>;
  blocking:boolean;
  settled?:ContextResult;
  measure?:()=>void;
  recovered?:boolean;
}
type CompactQuery = Extract<ContextQuery,{action:'compact'}>;
/** Credentials remain with the existing model authority; Rust owns each summary Run and CAS. */
export class ContextService implements ContextOwner {
  private readonly jobs=new Map<string,Job>();
  private readonly timing:ContextPreparationTiming;
  // close() ends the current kernel epoch, while the Host owner can be rebound.
  private lifetime=new AbortController();
  private compaction?:ContextCompactionOwner;
  private contextAgent?:ContextAgentOwner;
  bindContextAgent(owner:ContextAgentOwner):void {this.contextAgent=owner;}
  private publishObservations?: (run:Run,signal:AbortSignal)=>Promise<void>;
  bindObservations(publish:(run:Run,signal:AbortSignal)=>Promise<void>):void { this.publishObservations=publish; }
  bindCompaction(owner:ContextCompactionOwner):void {this.compaction=owner;}
  private readonly observations=new Map<string,{requestId:string;identity:string}>();
  constructor(private readonly runtime:AgentRuntimeClient,
    private readonly prepareContext:ContextPreparer,
    private readonly readPolicy:(run:Run,launch:LaunchIntent|null,signal:AbortSignal)=>Promise<ContextPolicyPreparation>,
    private readonly continueRun:(runId:string,signal?:AbortSignal,credentialOwner?:ExistingHostCredentialOwner)=>Promise<void>,
    private readonly budget:ContextBudgetOwner | null, now?:()=>number) { this.timing=new ContextPreparationTiming(now); }
  close():void {this.lifetime.abort();this.lifetime=new AbortController();for(const job of this.jobs.values()) job.controller.abort();this.jobs.clear();this.timing.clear();this.observations.clear();}
  async query(query:ContextQuery,signal:AbortSignal):Promise<ContextResult> {
    signal=AbortSignal.any([signal,this.lifetime.signal]);
    signal.throwIfAborted();
    const run=await this.runtime.run(query.runId,signal);
    signal.throwIfAborted();
    if(run.cancel_requested || ['completed','failed','cancelled'].includes(run.state)) return {status:'failed',code:'context_owner_closed'};
    if(query.action==='prepare' && this.publishObservations) { await waitWithSignal(this.publishObservations(run,signal),signal); signal.throwIfAborted(); }
    const launch=await this.runtime.launch(run.id,signal);
    signal.throwIfAborted();
    if (query.action === 'execution_environment') return { status: 'ready', environment: await this.runtime.executionEnvironmentForSource(launch?.selection.source, signal) };
    if(query.action==='prepare' || query.action==='decide') {
      const {policy,scope}=await this.readPolicy(run,launch,signal);
      signal.throwIfAborted();
      let timing;
      if (query.action==='prepare' && query.observation) {
        // Native adaptive timing describes the builtin fold only. Selecting an
        // algorithm must not inherit an unrelated earlier fold duration.
        const algorithmSelected=policy.enabled && this.compaction ? await this.compaction.selected(scope,signal) : false;
        const identity=createHash('sha256').update(JSON.stringify([run.thread_id,run.branch_id,run.configuration,
          launch?.selection ?? null,launch?.policy_generation ?? null,launch?.policy_target ?? null,
          policy.configurationIdentity,query.observation.identity,algorithmSelected])).digest('hex');
        this.observations.set(run.branch_id,{requestId:query.requestId,identity});
        timing=this.timing.observe(run.branch_id,identity,query.requestId,query.expectedRevision,query.observation);
      }
      if (!policy.enabled || !this.budget) return {status:'ready',policy,...(timing?{timing}:{}),external:false};
      if (scope.threadId!==run.thread_id) throw new Error('Context budget scope belongs to another Thread');
      if (query.action === 'prepare') return {status:'ready',policy,...(timing?{timing}:{}),external:await this.budget.selected(scope,signal)};
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
      const candidate:Job={controller,admission:Promise.resolve().then(()=>this.admit(run,query,key,candidate)),blocking:query.block};
      work=candidate;this.watch(key,work,run);
    }
    const job=await waitWithSignal(work.admission,signal);
    if(job.request.owner_run_id && job.request.owner_run_id!==run.id) {
      const original=await this.runtime.run(job.request.owner_run_id,signal);
      if(original.cancel_requested || original.state==='cancelled') return {status:'failed',code:'context_preparation_cancelled'};
    }
    const recipe=job.request.summary_recipe;
    const accepted={throughId:job.request.through_id,summaryRecipe:recipe,
      block:query.block};
    work.blocking ||= accepted.block;
    const [summary,checkpoint]=await Promise.all([this.runtime.run(job.receipt.run_id,signal),this.runtime.context(run.branch_id,signal)]);
    if(checkpoint && checkpoint.revision!==query.expectedRevision) return {status:'ready',published:true,jobRunId:summary.id,accepted};
    if(['failed','cancelled'].includes(summary.state)) return {status:'failed',code:'context_compaction_failed',accepted};
    return {...(work.settled ?? {status:'ready',published:false,jobRunId:summary.id}),accepted};
  }
  private watch(key:string,work:Job,parent:Run):void {
    this.jobs.set(key,work);
    const observation=work.admission.then(job=>{
      return this.observe(job,parent.id,work);
    }).catch(()=>{
      if(work.controller.signal.aborted) return {status:'failed',code:'context_preparation_cancelled'} as const;
      return {status:'failed',code:'context_compaction_failed'} as const;
    });
    // Admission and observation have distinct lifetimes. Cancelling one query cannot erase an
    // accepted job or cause a second paid generation. Epoch close stops only these observers.
    void observation.finally(()=>{if(this.jobs.get(key)===work) this.jobs.delete(key);}).catch(()=>undefined);
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
      this.watch(job.request.key,{controller,admission,blocking:true,recovered:true},parent);
    }
  }
  private async admit(run:Run,query:CompactQuery,key:string,work:Job):Promise<ContextJob> {
    const signal=work.controller.signal;
    const [checkpoint,existing,launch]=await Promise.all([this.runtime.context(run.branch_id,signal),this.runtime.contextJobs(run.branch_id,signal),this.runtime.launch(run.id,signal)]);
    const previous=existing.find(job=>job.request.key===key) ?? await this.accepted(existing,run,query.expectedRevision,launch,signal);
    if (previous) { await this.start(previous,signal); return previous; }
    const candidate=checkpoint && this.prepareContext.compact ? await this.prepareContext.compact(checkpoint, signal) : undefined;
    const recipe=(candidate ? {effective_system_prompt:candidate.effectiveSystemPrompt,instruction_sources:candidate.instructionSources,memory_checkpoint:candidate.memoryCheckpoint} : checkpoint?.proposal);
    const personalization=candidate?.personalization ?? checkpoint?.personalization;
    const configuration=run.configuration as ModelSessionConfiguration;
    const scope=launch?.selection.credential_scope;
    signal.throwIfAborted();
    const agentScope=contextCompactionScope(run.thread_id,personalization,candidate?.resources ?? checkpoint?.resources);
    const agent=await this.contextAgent?.prepare(agentScope,{configuration,...(scope?{credentialScope:scope}:{})},signal);
    const credentialScope=agent ? agent.credentialScope : scope;
    let job:ContextJob;
    let preparedOwner:ExistingHostCredentialOwner | undefined;
    try {
      try {
        const admission=await admitContextJobCandidate(this.runtime,this.compaction,
          agentScope,
          {summaryRecipe:{...query.summaryRecipe,...(agent?.instructions !== undefined?{agentInstructions:agent.instructions}:{})},key,ownerRunId:run.id,branchId:run.branch_id,throughId:query.throughId,expectedRevision:query.expectedRevision,
          effectiveSystemPrompt:recipe?.effective_system_prompt ?? '',instructionSources:recipe?.instruction_sources ?? [],memoryCheckpoint:recipe?.memory_checkpoint ?? null,
          ...(personalization?{personalization}:{}),configuration:agent?.configuration ?? configuration,
          ...(credentialScope?{credentialScope}:{})},signal,agent?.bind);
        job=admission.job;
        preparedOwner=agent?.credentialOwner;
        // Only a fully observed new admission can produce a duration. Recovered/accepted
        // jobs retain their original receipts, but observation time is not preparation time.
        const observed=this.observations.get(run.branch_id);
        if (!admission.recovered && observed?.requestId===query.requestId && query.summaryRecipe.strategy.kind==='builtin'
          && job.compaction.producer.kind==='builtin' && job.compaction.kind==='model_plan') {
          const measure=this.timing.start(run.branch_id,observed.identity);
          if(measure) work.measure=measure;
        }
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
      await this.start(job,signal,preparedOwner);
      return job;
    } finally { agent?.release(); }
  }
  private async accepted(jobs:ContextJob[],owner:Run,revision:number,launch:LaunchIntent|null,signal:AbortSignal):Promise<ContextJob|undefined> {
    for (const job of jobs) {
      if (!job.request.owner_run_id || job.request.branch_id!==owner.branch_id || job.request.expected_revision!==revision) continue;
      const [source,original]=await Promise.all([this.runtime.run(job.request.owner_run_id,signal),this.runtime.launch(job.request.owner_run_id,signal)]);
      if (isDeepStrictEqual(source.configuration,owner.configuration)
        && isDeepStrictEqual(original?.selection.credential_scope ?? null,launch?.selection.credential_scope ?? null)
        && isDeepStrictEqual(original?.policy_target ?? null,launch?.policy_target ?? null)
        && isDeepStrictEqual(original?.selection.policy ?? null,launch?.selection.policy ?? null)) return job;
    }
    return undefined;
  }
  private async start(job:ContextJob,signal:AbortSignal,credentialOwner?:ExistingHostCredentialOwner):Promise<void> {
    const launch=await this.runtime.launch(job.receipt.run_id,signal);
    if(launch?.startable && launch.requires_rebind) await this.continueRun(job.receipt.run_id,signal,credentialOwner);
  }
  private async observe(job:ContextJob,parentId:string,work:Job):Promise<ContextResult> {
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
            work.measure?.();delete work.measure;
            // Ready is only a candidate. The requesting worker recompiles current A/B/N
            // and publishes at its pre-dispatch boundary; this observer never changes history.
            work.settled={status:'ready',published:false,jobRunId:run.id};
          } else if(['failed','cancelled'].includes(run.state)) work.settled={status:'failed',code:'context_compaction_failed'};
        }
        if(work.settled) {
          if(!work.blocking) return work.settled;
          const resumed=await this.runtime.resumeContextJob(run.id,signal);
          if(resumed) {
            await this.continueRun(resumed.id);
            return work.settled;
          }
          if(work.recovered || ['completed','failed','cancelled'].includes(parent.state)) return work.settled;
        }
      }
    } finally {remove();signal.removeEventListener('abort',notify);}
  }
}
