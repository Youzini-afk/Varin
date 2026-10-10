import type { ThreadToolInspection } from '@varin/application-client';
import type { PlanService } from './plan-service.js';
import type { ImageAttachment } from '@varin/protocol';
import { threadInput } from './thread-images.js';
import { listThreadFollowups } from './thread-followups.js';
import { createHash } from 'node:crypto';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadSubmit, ThreadSource, ThreadSnapshot, ThreadHistoryPage, ThreadCompact, ThreadContextState, ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
import type { InputMode, InitialContext, ModelSessionConfiguration, CredentialScope, AgentRuntimeStreamEvent, PolicyResumeReceipt } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { isAbortError, waitWithSignal } from '../cancellation.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextPreparer } from './thread-context.js';

export interface ThreadModelAuthority {
  listModels?(): Promise<ThreadModelInfo[]>;
  resolveModel(selection: ThreadModel): Promise<{ configuration: ModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }>;
  rebindModel(configuration: ModelSessionConfiguration, expectedScope: CredentialScope): Promise<ExistingHostCredentialOwner>;
}

/** Projection and admission only: Rust owns all conversation, queue and execution facts. */
export class ThreadAdapter {
  constructor(readonly runtime: AgentRuntimeClient, private readonly models: ThreadModelAuthority,
    private readonly admitSource: (source: ThreadSource, identity: ThreadIdentity) => Promise<void>,
    private readonly onLaunchError: (runId: string, error: unknown) => void,
    private readonly prepareWorkspace?: (input: ThreadPrepareSource) => Promise<ThreadPreparedSource>,
    private readonly prepareContext?: ContextPreparer, private readonly plans?: PlanService) {}

  private readonly contextRefreshes = new Map<string, Promise<void>>();
  private readonly admittedLaunches = new Map<string, {
    pending: Map<AbortSignal | undefined, { signal: AbortSignal | undefined; prepare: () => Promise<void> }>;
    work: Promise<void>;
  }>();
  private launchAdmitted(runId: string, prepare: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Launch caller cancelled', 'AbortError'));
    const existing = this.admittedLaunches.get(runId);
    if (existing) {
      // Repeated wakes from one caller epoch need one fresh authority read after the current
      // attempt drains. Keep other live epochs: cancelling the newest caller cannot erase them.
      existing.pending.delete(signal);
      existing.pending.set(signal, { signal, prepare });
      return waitWithSignal(existing.work, signal);
    }
    const flight = { pending: new Map([[signal, { signal, prepare }]]), work: Promise.resolve() };
    flight.work = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      try {
        while (flight.pending.size) {
          const candidates = [...flight.pending.values()].filter(wake => !wake.signal?.aborted);
          flight.pending.clear();
          const next = candidates.pop();
          if (!next) continue;
          try { await next.prepare(); failed = false; }
          catch (error) {
            failed = true; failure = error;
            if (!isAbortError(error)) await this.recordLaunchFailure(runId, error);
            else {
              // The selected epoch may have ended while another coalesced caller is still
              // valid. Preserve its own closure/credentials, behind any newer recorded wake.
              const newer = flight.pending;
              flight.pending = new Map(candidates.filter(wake => !wake.signal?.aborted).map(wake => [wake.signal, wake]));
              for (const [key, wake] of newer) { flight.pending.delete(key); flight.pending.set(key, wake); }
            }
          }
        }
        if (failed) throw failure;
      } finally {
        // Delete before settling the Promise, so a wake in its completion microtasks cannot
        // join an already drained flight and disappear.
        if (this.admittedLaunches.get(runId) === flight) this.admittedLaunches.delete(runId);
      }
    });
    this.admittedLaunches.set(runId, flight);
    return waitWithSignal(flight.work, signal);
  }
  /** Serialize refresh reads per branch; an edit arriving during a read gets another fresh read. */
  private async refreshContext(identity: ThreadIdentity, signal?: AbortSignal): Promise<void> {
    if (!this.prepareContext?.refresh) return;
    const previous = this.contextRefreshes.get(identity.branchId) ?? Promise.resolve();
    const work = waitWithSignal(previous.catch(() => undefined), signal).then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const checkpoint = await this.runtime.context(identity.branchId, signal);
        if (!checkpoint) return;
        const context = await waitWithSignal(this.prepareContext!.refresh!(checkpoint), signal);
        signal?.throwIfAborted();
        if (context.effectiveSystemPrompt === checkpoint.proposal.effective_system_prompt
          && JSON.stringify(context.instructionSources) === JSON.stringify(checkpoint.proposal.instruction_sources)
          && context.memoryCheckpoint === checkpoint.proposal.memory_checkpoint
          && JSON.stringify(context.personalization) === JSON.stringify(checkpoint.personalization)) return;
        try {
          await this.runtime.refreshContext({ branchId: identity.branchId, expectedRevision: checkpoint.revision, context }, signal);
          return;
        } catch (error) {
          signal?.throwIfAborted();
          const latest = await this.runtime.context(identity.branchId, signal);
          // Only a real concurrent context commit warrants re-reading/retrying. Other failures
          // remain visible, and later input admission retries from the durable authority.
          if (!latest || latest.revision === checkpoint.revision) throw error;
        }
      }
    });
    this.contextRefreshes.set(identity.branchId, work);
    try { await work; }
    finally { if (this.contextRefreshes.get(identity.branchId) === work) this.contextRefreshes.delete(identity.branchId); }
  }
  async refreshPersonalization(): Promise<void> {
    if (!this.prepareContext?.refresh) return;
    const threads = await this.runtime.threads();
    const results = await Promise.allSettled(threads.filter(thread => thread.thread_id.startsWith('thread:'))
      .flatMap(thread => thread.branches.map(branch => this.refreshContext({ runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id }))));
    if (results.some(result => result.status === 'rejected')) throw new Error('Personalization refresh requires attention');
  }

  async decidePermission(input: ThreadIdentity & { operationId: string; permissionId: string; decision: 'allow_once' | 'deny' }) {
    await this.requireIdentity(input);
    const operation = await this.requireOperation(input.operationId);
    const run = await this.requireRun(operation.run_id);
    if (run.branch_id !== input.branchId || run.thread_id !== input.threadId) throw new Error('Permission belongs to another branch');
    return this.runtime.decidePermission(input.operationId, input.permissionId, input.decision);
  }
  async answerQuestion(input: ThreadIdentity & { operationId: string; answer: string }) {
    await this.requireIdentity(input);
    const operation = await this.requireOperation(input.operationId);
    const run = await this.requireRun(operation.run_id);
    if (run.branch_id !== input.branchId || run.thread_id !== input.threadId) throw new Error('Question belongs to another branch');
    const result = await this.runtime.answerQuestion(input.operationId, input.answer);
    await this.continueLaunch(result.run_id);
    return result;
  }
  async cancelOperation(operationId: string) {
    await this.requireOperation(operationId);
    const current = await this.runtime.operation(operationId);
    if (current.executor === 'dispatch') {
      await this.runtime.cancelChild(operationId); return this.runtime.operation(operationId);
    }
    if (current.executor === 'wait_child' && current.waiting_on) {
      await this.runtime.cancelChildWait(current.waiting_on); return this.runtime.operation(operationId);
    }
    const result = await this.runtime.cancelOperation(operationId);
    if (result.executor === 'ask_user') await this.continueLaunch(result.run_id);
    return result;
  }
  async readChildReport(identity: ThreadIdentity, operationId: string, itemId: string, offset = 0, maxBytes = 65536) {
    await this.requireIdentity(identity);
    const child = await this.runtime.child(operationId);
    if (child.parent_thread_id !== identity.threadId) throw new Error('Child belongs to another Thread');
    return this.runtime.readChildReport(operationId, itemId, offset, maxBytes);
  }
  async children(identity: ThreadIdentity) {
    await this.requireIdentity(identity);
    return (await this.runtime.children()).filter(child => child.parent_thread_id === identity.threadId);
  }
  async cancelChild(identity: ThreadIdentity, operationId: string) {
    await this.requireIdentity(identity);
    const child = await this.runtime.child(operationId);
    if (child.parent_thread_id !== identity.threadId) throw new Error('Child belongs to another parent Thread');
    return this.runtime.cancelChild(operationId);
  }
  async cancelChildWait(identity: ThreadIdentity, waitId: string) {
    await this.requireIdentity(identity);
    if (!waitId.startsWith('child-wait:')) throw new Error('Not a child observation wait');
    const operation = await this.runtime.operation(waitId.slice('child-wait:'.length));
    const run = await this.requireRun(operation.run_id);
    if (run.thread_id !== identity.threadId) throw new Error('Wait belongs to another parent Thread');
    return this.runtime.cancelChildWait(waitId);
  }
  async cancelTree(identity: ThreadIdentity): Promise<void> {
    const thread = await this.requireIdentity(identity);
    const children = await this.children(identity);
    await Promise.all(children.filter(child => !child.report).map(child => this.runtime.cancelChild(child.operation_id)));
    await Promise.all(thread.branches.filter(branch => branch.active_run_id).map(branch => this.runtime.cancelRun(branch.active_run_id!)));
  }
  async listModels() {
    if (!this.models.listModels) throw new Error('Model catalog is unavailable');
    return this.models.listModels();
  }

  async create(key: string): Promise<ThreadIdentity> {
    const digest = createHash('sha256').update(key).digest('hex');
    const identity: ThreadIdentity = { runtime: 'agent', threadId: `thread:${digest}`, branchId: `branch:${digest}` };
    await this.runtime.createThread(identity.threadId, identity.branchId);
    return identity;
  }

  async prepareSource(input: ThreadPrepareSource): Promise<ThreadPreparedSource> {
    await this.requireIdentity(input);
    if (!this.prepareWorkspace) throw new Error('Workspace source preparation is unavailable');
    return this.prepareWorkspace(input);
  }

  async readPlan(identity: ThreadIdentity, signal?: AbortSignal) {
    await this.requireIdentity(identity);
    if (!this.plans) throw new Error('Plan owner is unavailable');
    return this.plans.read(identity, signal);
  }
  async updatePlan(input: ThreadIdentity & { key: string; expectedHeadId: string | null; expectedRef: string | null; content: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    if (!this.plans) throw new Error('Plan owner is unavailable');
    return this.plans.update(input, signal);
  }
  async fork(input: ThreadIdentity & { key: string; headId: string | null }, signal?: AbortSignal): Promise<ThreadIdentity> {
    await this.requireIdentity(input);
    await this.refreshContext(input);
    const digest = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.headId, input.key])).digest('hex');
    const targetBranchId = `branch:${digest}`;
    const capture = this.plans && await this.plans.supports(input)
      ? await this.plans.capture(input, input.headId, targetBranchId, signal) : undefined;
    const result = await this.runtime.forkBranch(input.branchId, targetBranchId, input.headId, signal, capture);
    return { runtime: 'agent', ...result };
  }

  async compact(input: ThreadCompact) {
    await this.requireIdentity(input);
    await this.refreshContext(input);
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.key])).digest('hex');
    const [checkpoint, jobs] = await Promise.all([this.runtime.context(input.branchId), this.runtime.contextJobs(input.branchId)]);
    // An uncertain create retry keeps its original prompt/memory recipe even after publication.
    const previous = jobs.find(job => job.request.key === key);
    const candidate = !previous && checkpoint && this.prepareContext?.compact ? await this.prepareContext.compact(checkpoint) : undefined;
    const recipe = previous?.request ?? (candidate ? { effective_system_prompt: candidate.effectiveSystemPrompt,
      instruction_sources: candidate.instructionSources, memory_checkpoint: candidate.memoryCheckpoint } : checkpoint?.proposal);
    const personalization = previous?.request.personalization ?? candidate?.personalization ?? checkpoint?.personalization;
    const model = await this.models.resolveModel(input.model);
    const job = await this.runtime.createContextJob({ key, branchId: input.branchId, throughId: input.throughId,
      expectedRevision: input.expectedRevision, effectiveSystemPrompt: recipe?.effective_system_prompt ?? '',
      instructionSources: recipe?.instruction_sources ?? [], memoryCheckpoint: recipe?.memory_checkpoint ?? null,
      ...(personalization ? { personalization } : {}),
      configuration: model.configuration, credentialScope: await model.credentialOwner.scope() });
    void this.continueLaunch(job.receipt.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
    return job;
  }

  async context(identity: ThreadIdentity): Promise<ThreadContextState> {
    const [checkpoint, jobs] = await Promise.all([this.runtime.context(identity.branchId), this.runtime.contextJobs(identity.branchId)]);
    return { checkpoint, jobs: await Promise.all(jobs.map(async job => ({ job, run: await this.runtime.run(job.receipt.run_id) }))) };
  }

  async requireContextJob(identity: ThreadIdentity, runId: string) {
    await this.requireIdentity(identity);
    const job = await this.runtime.contextJob(runId);
    if (job.request.branch_id !== identity.branchId) throw new Error('Context job does not belong to the selected branch');
    return job;
  }

  async publishContext(identity: ThreadIdentity, runId: string) {
    await this.requireContextJob(identity, runId);
    // Explicit configuration changes are checked against the candidate even when their
    // notification refresh has not run yet. Ordinary notes do not advance this CAS.
    await this.refreshContext(identity);
    return this.runtime.publishContextJob(runId);
  }

  async cancelContext(identity: ThreadIdentity, runId: string) {
    await this.requireContextJob(identity, runId);
    return this.runtime.cancelRun(runId);
  }

  async resumeContext(identity: ThreadIdentity, runId: string): Promise<void> {
    await this.requireContextJob(identity, runId);
    await this.continueLaunch(runId);
  }

  assertIdentity(identity: ThreadIdentity): void {
    if (identity.runtime !== 'agent' || !identity.threadId.startsWith('thread:')) {
      throw new Error('An explicit thread identity is required');
    }
  }

  async submit(input: ThreadSubmit) {
    const thread = await this.requireIdentity(input);
    await this.refreshContext(input);
    if (input.source) await this.admitSource(input.source, input);
    const model = await this.models.resolveModel(input.model);
    this.assertImagesSupported(input.images, model.configuration);
    let initialContext: InitialContext | undefined;
    if (this.prepareContext && !await this.runtime.context(input.branchId)) {
      let source = input.source ?? null;
      if (!source) {
        const latest = thread.branches.find(branch => branch.branch_id === input.branchId)?.latest_run;
        const previous = latest ? await this.runtime.launch(latest.id) : null;
        const inherited = previous?.selection.source;
        if (inherited) {
          const base = { workspaceId: inherited.workspace_id, executionWorkspaceId: inherited.execution_workspace_id, tools: [] };
          if (inherited.mode === 'live_root' && inherited.live_root) source = { ...base, mode: 'live_root', liveRoot: inherited.live_root };
          else if (inherited.mode !== 'live_root' && inherited.branch_id && inherited.revision !== null) source = {
            ...base, branchId: inherited.branch_id, revision: inherited.revision, mode: inherited.mode,
          };
        }
      }
      initialContext = await this.prepareContext.main(input, source);
    }
    // The same Rust transaction accepts input, initial context and source/credential/tool selection.
    const receipt = await this.runtime.submit({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      expectedHead: input.expectedHead, input: threadInput(input.text, input.images), configuration: model.configuration,
      ...(initialContext ? { initialContext } : {}),
      launch: { inheritSource: input.source === undefined, source: input.source ? {
        workspaceId: input.source.workspaceId, executionWorkspaceId: input.source.executionWorkspaceId,
        branchId: input.source.branchId ?? null, revision: input.source.revision ?? null, mode: input.source.mode, liveRoot: input.source.liveRoot ?? null,
      } : null, enabledTools: input.source?.tools ?? [], credentialScope: await model.credentialOwner.scope() },
    });
    // The shared launch owner closes the initial context-refresh gap before preparation.
    void this.continueLaunch(receipt.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
    return receipt;
  }

  async enqueue(input: ThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; mode: InputMode }) {
    const thread = await this.requireIdentity(input);
    const branch = thread.branches.find(candidate => candidate.branch_id === input.branchId)!;
    const previous = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : branch.latest_run;
    if (!previous) throw new Error('An initial model selection is required');
    const selected = await this.runtime.modelSelections(previous.id);
    this.assertImagesSupported(input.images, selected.desired?.configuration ?? previous.configuration);
    const receipt = await this.runtime.enqueue({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      mode: input.mode, input: threadInput(input.text, input.images) });
    // Context is synchronized by the Run's request preparation. An accepted input receipt
    // must not wait for extension/MCP startup, source materialization or credential rebinding.
    void this.continueLaunch(receipt.run_id).catch(() => undefined);
    return receipt;
  }

  async inspectTools(identity:ThreadIdentity,runId:string,signal?:AbortSignal):Promise<ThreadToolInspection>{
    await this.requireIdentity(identity);const run=await this.runtime.run(runId,signal);
    if(run.thread_id!==identity.threadId||run.branch_id!==identity.branchId)throw new Error('Run does not belong to the selected Thread branch');
    return this.runtime.inspectTools(runId,signal);
  }
  async selectModel(input: ThreadIdentity & { runId: string; key: string; model: ThreadModel }) {
    await this.requireIdentity(input);
    const run = await this.requireRun(input.runId);
    if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) throw new Error('Run belongs to another branch');
    const model = await this.models.resolveModel(input.model);
    return this.runtime.selectModel(run.id,input.key,model.configuration,model.credentialOwner);
  }

  assertImagesSupported(images: readonly ImageAttachment[] | undefined, configuration: unknown): void {
    if (images?.length && (configuration as { acceptsImages?: boolean }).acceptsImages === false) {
      throw Object.assign(new Error('Selected model does not accept images'), { code: 'model-images-unsupported' });
    }
  }

  async requireIdentity(identity: ThreadIdentity) {
    this.assertIdentity(identity);
    const thread = await this.runtime.thread(identity.threadId);
    if (!thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new Error('Branch does not belong to the selected thread');
    return thread;
  }

  async requireRun(runId: string) {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('thread:')) throw new Error('Run is not owned by a thread');
    return run;
  }

  async requireInput(inputId: string) {
    const input = await this.runtime.input(inputId);
    if (!input.thread_id.startsWith('thread:')) throw new Error('Input is not owned by a thread');
    return input;
  }

  async requireOperation(operationId: string) {
    const operation = await this.runtime.operation(operationId);
    await this.requireRun(operation.run_id);
    return operation;
  }

  async historyPage(identity: ThreadIdentity, cursor: { headId: string; beforeId: string }): Promise<ThreadHistoryPage> {
    await this.requireIdentity(identity);
    return this.readHistoryPage(identity.branchId, cursor);
  }

  private async readHistoryPage(branchId: string, cursor?: { headId: string; beforeId?: string }): Promise<ThreadHistoryPage> {
    const page = await this.runtime.historyPage({ branchId, ...cursor, limit: 20 });
    const items = await Promise.all(page.items.map(item => this.runtime.historyItem(item)));
    return { head: page.head, previous: page.previous, items };
  }

  async snapshot(identity: ThreadIdentity): Promise<ThreadSnapshot> {
    const { eventCursor } = await this.runtime.status();
    const thread = await this.requireIdentity(identity);
    const branch = thread.branches.find(branch => branch.branch_id === identity.branchId)!;
    const [page, inputs, activeOperations, context, followups] = await Promise.all([
      this.readHistoryPage(identity.branchId, branch.head ? { headId: branch.head } : undefined),
      this.runtime.inputs(identity.branchId), this.runtime.activeOperations(identity.threadId, identity.branchId), this.context(identity),
      listThreadFollowups(this, identity),
    ]);
    const history = page.items;
    if (history.some(item => item.thread_id !== identity.threadId) || inputs.some(item => item.thread_id !== identity.threadId)) {
      throw new Error('Branch does not belong to the selected thread');
    }
    const operationIds = new Set<string>();
    for (const item of history) {
      const conversation = item.content as { content?: { kind?: string; result?: { completion?: { kind?: string; operation_id?: string } } } };
      const completion = conversation?.content?.kind === 'tool_result' ? conversation.content.result?.completion : undefined;
      if (completion?.kind === 'job_accepted' && typeof completion.operation_id === 'string') operationIds.add(completion.operation_id);
    }
    const operations = new Map(activeOperations.map(operation => [operation.id, operation]));
    const visible = await Promise.all([...operationIds].filter(id => !operations.has(id)).map(async id => {
      const operation = await this.runtime.operation(id);
      const run = await this.requireRun(operation.run_id);
      // Forked history retains the original receipt, not control over the source branch's job.
      return run.thread_id === identity.threadId && run.branch_id === identity.branchId ? operation : null;
    }));
    for (const operation of visible) if (operation) operations.set(operation.id, operation);
    const latest = branch.latest_run;
    const activeRun = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : null;
    const shownRun = activeRun ?? latest;
    const launch = shownRun ? await this.runtime.launch(shownRun.id) : null;
    const modelSelection = shownRun ? await this.runtime.modelSelections(shownRun.id) : {desired:null,active:null};
    const policySelection = shownRun && launch ? await this.runtime.inspectPolicy(shownRun.id) : null;
    return { identity, eventCursor, thread, activeRun, history, historyPage: { head: page.head, previous: page.previous }, inputs,
      operations: [...operations.values()], followups, launch, modelSelection, policySelection, context, children: await this.children(identity) };
  }

  private async recordLaunchFailure(runId: string, error: unknown): Promise<void> {
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    const code = ['credential-scope-changed', 'model-configuration-changed'].includes(errorCode) ? 'binding_changed'
      : errorCode.startsWith('credential-') ? 'credentials_unavailable' : 'preparation_failed';
    try { await this.runtime.failLaunch(runId, code); }
    catch (recordError) { this.onLaunchError(runId, recordError); }
    this.onLaunchError(runId, error);
  }

  async recover(signal?: AbortSignal): Promise<void> {
    const pending = await this.runtime.pendingLaunches(signal);
    await Promise.all(pending.filter(launch => launch.startable && launch.requires_rebind).map(async launch => {
      const run = await this.runtime.run(launch.run_id, signal);
      if (!run.thread_id.startsWith('thread:') && !run.thread_id.startsWith('context-job-thread:')) return;
      if (await this.runtime.childForThread(run.thread_id, signal)) return;
      if (run.thread_id.startsWith('context-job-thread:')) {
        const job = await this.runtime.contextJob(run.id, signal);
        // Automatic summaries retain their ContextService publication owner.
        if (job.request.owner_run_id) return;
        const sources = await this.runtime.threads(signal);
        if (!sources.some(thread => thread.thread_id.startsWith('thread:') && thread.branches.some(branch => branch.branch_id === job.request.branch_id))) return;
      }
      void this.continueLaunch(run.id, { signal }).catch(() => undefined);
    }));
  }

  /** User command consumes this exact Pause. Its durable receipt does not await cold assembly. */
  async resume(runId: string, waitId: string): Promise<PolicyResumeReceipt> {
    await this.requireRun(runId);
    const receipt = await this.runtime.resumeRun(runId, waitId);
    void this.continueLaunch(runId).catch(() => undefined);
    return receipt;
  }

  async inspectPolicy(identity: ThreadIdentity, runId: string) {
    await this.requireIdentity(identity);
    const run = await this.requireRun(runId);
    if (run.thread_id !== identity.threadId || run.branch_id !== identity.branchId) throw new Error('Run does not belong to the selected branch');
    return this.runtime.inspectPolicy(runId);
  }
  async restartPolicy(identity: ThreadIdentity, runId: string, selectionId: string, signal?: AbortSignal) {
    await this.inspectPolicy(identity, runId);
    return this.runtime.restartPolicy(runId, selectionId, signal);
  }
  async cancelPolicyUpdate(identity: ThreadIdentity, runId: string, selectionId: string, signal?: AbortSignal) {
    await this.inspectPolicy(identity, runId);
    return this.runtime.cancelPolicyUpdate(runId, selectionId, signal);
  }

  async retryPreparation(runId: string): Promise<void> {
    await this.requireRun(runId);
    const launch = await this.runtime.launch(runId);
    if (!launch?.startable || !launch.requires_rebind || launch.pause) throw new Error('Run is not eligible for preparation retry');
    await this.continueLaunch(runId);
  }

  /** The single Host launch entry for submission, recovered input and domain continuations.
   * The kernel projection includes worker/quiescence ownership, including asynchronous cold
   * assembly after start acknowledgement. A stale notification never releases that owner. */
  continueLaunch(runId: string, options: { signal?: AbortSignal | undefined; credentialOwner?: ExistingHostCredentialOwner } = {}): Promise<void> {
    return this.launchAdmitted(runId, () => this.runtime.withRunPreparation(runId, options.signal, async signal => {
      signal.throwIfAborted();
      let launch = await this.runtime.launch(runId, signal);
      if (!launch?.startable || !launch.requires_rebind) return;
      const run = await this.runtime.run(runId, signal);
      if (!run.thread_id.startsWith('thread:') && !run.thread_id.startsWith('context-job-thread:')) throw new Error('Run is not owned by a thread');
      const identity: ThreadIdentity = { runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id };
      if (run.thread_id.startsWith('thread:')) await this.refreshContext(identity, signal);
      const source = launch.selection.source;
      if (source && source.mode !== 'live_root' && source.branch_id !== null && source.revision !== null) {
        const admission = this.admitSource({ mode: source.mode, workspaceId: source.workspace_id,
          executionWorkspaceId: source.execution_workspace_id, branchId: source.branch_id, revision: source.revision, tools: [] }, identity);
        await waitWithSignal(admission, signal);
      }
      // live_root is validated by rebindLaunch's existing LiveSource owner.
      const scope = launch.selection.credential_scope;
      if (!scope && !run.thread_id.startsWith('context-job-thread:')) throw new Error('Run has no durable credential binding; resubmit its original input key');
      const owner = options.credentialOwner ?? (scope ? await waitWithSignal(this.models.rebindModel(run.configuration as ModelSessionConfiguration, scope), signal) : undefined);
      const selected = await this.runtime.modelSelections(runId, signal);
      const desired = selected.desired;
      const desiredOwner = desired?.credential_scope && desired.id !== selected.active?.id && desired.status !== 'failed'
        ? await waitWithSignal(this.models.rebindModel(desired.configuration, desired.credential_scope), signal) : undefined;
      signal?.throwIfAborted();
      launch = await this.runtime.launch(runId, signal);
      if (!launch?.startable || !launch.requires_rebind) return;
      this.runtime.releaseMainModelCredentials(runId, selected);
      if (desired && desiredOwner) await this.runtime.selectModel(runId, desired.id, desired.configuration, desiredOwner, signal);
      if (run.thread_id.startsWith('context-job-thread:')) {
        if (owner) await this.runtime.startRunWithCredentialOwner(runId, owner, signal);
        else await this.runtime.startRun(runId, signal);
      } else await this.runtime.rebindLaunch(runId, { ...(owner ? { credentialOwner: owner } : {}), signal });
    }), options.signal);
  }

  /** Listener registration precedes replay. Notifications only wake the durable cursor reader. */
  observe(cursor: number, emit: (event: unknown) => boolean, fail: (error: unknown) => void): () => void {
    let closed = false;
    let reading = false;
    let dirty = false;
    const replay = async () => {
      dirty = true;
      if (reading || closed) return;
      reading = true;
      try {
        while (!closed && dirty) {
          dirty = false;
          let events;
          do {
            events = await this.runtime.events(cursor, 256);
            for (const event of events) {
              if (closed) return;
              if (!emit(event)) { close(); return; }
              cursor = event.cursor;
            }
          } while (!closed && events.length === 256);
        }
      } catch (error) { close(); fail(error); }
      finally { reading = false; }
    };
    const remove = this.runtime.onEvent((event: AgentRuntimeStreamEvent) => {
      if (event.stream === 'durable') void replay();
      else if (!closed) {
        try { if (!emit(event)) close(); }
        catch (error) { close(); fail(error); }
      }
    });
    const removeExit = this.runtime.onExit(error => { close(); fail(error); });
    const close = () => { closed = true; remove(); removeExit(); };
    void replay();
    return close;
  }
}
