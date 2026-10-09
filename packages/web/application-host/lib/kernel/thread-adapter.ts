import type { PlanService } from './plan-service.js';
import type { ImageAttachment } from '@varin/protocol';
import { threadInput } from './thread-images.js';
import { createHash } from 'node:crypto';
import type { ThreadIdentity, ThreadSubmit, ThreadSource, ThreadSnapshot, ThreadHistoryPage, ThreadCompact, ThreadContextState, ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
import type { InputMode, InitialContext, ModelSessionConfiguration, CredentialScope, AgentRuntimeStreamEvent } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextPreparer } from './thread-context.js';

export interface ThreadModelAuthority {
  listModels?(): Promise<Array<{ providerId: string; modelId: string; name?: string; acceptsImages?: boolean }>>;
  resolveModel(selection: { providerId: string; modelId: string }): Promise<{ configuration: ModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }>;
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
  private readonly admittedLaunches = new Map<string, Promise<void>>();
  private launchAdmitted(runId: string, prepare: () => Promise<void>): void {
    if (this.admittedLaunches.has(runId)) return;
    const work = Promise.resolve().then(prepare).catch(error => this.recordLaunchFailure(runId, error));
    this.admittedLaunches.set(runId, work);
    void work.finally(() => {
      if (this.admittedLaunches.get(runId) === work) this.admittedLaunches.delete(runId);
    }).catch(() => undefined);
  }
  /** Serialize refresh reads per branch; an edit arriving during a read gets another fresh read. */
  private async refreshContext(identity: ThreadIdentity): Promise<void> {
    if (!this.prepareContext?.refresh) return;
    const previous = this.contextRefreshes.get(identity.branchId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      for (;;) {
        const checkpoint = await this.runtime.context(identity.branchId);
        if (!checkpoint) return;
        const context = await this.prepareContext!.refresh!(checkpoint);
        if (context.effectiveSystemPrompt === checkpoint.proposal.effective_system_prompt
          && JSON.stringify(context.instructionSources) === JSON.stringify(checkpoint.proposal.instruction_sources)
          && context.memoryCheckpoint === checkpoint.proposal.memory_checkpoint
          && JSON.stringify(context.personalization) === JSON.stringify(checkpoint.personalization)) return;
        try {
          await this.runtime.refreshContext({ branchId: identity.branchId, expectedRevision: checkpoint.revision, context });
          return;
        } catch (error) {
          const latest = await this.runtime.context(identity.branchId);
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

  private readonly questionResumptions = new Map<string, Promise<void>>();
  private async continueQuestion(runId: string): Promise<void> {
    const existing = this.questionResumptions.get(runId);
    if (existing) return existing;
    const work = (async () => {
      const run = await this.runtime.run(runId);
      if (run.state === 'runnable') {
        // The answer transaction follows parked-worker quiescence. Replace only that finished
        // worker's live bridge entry; resume still verifies the persisted principal/generation.
        this.runtime.releaseRunCredentialOwner(runId);
        await this.resume(runId);
      }
    })();
    this.questionResumptions.set(runId, work);
    try { await work; } finally { if (this.questionResumptions.get(runId) === work) this.questionResumptions.delete(runId); }
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
    await this.continueQuestion(result.run_id);
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
    if (result.executor === 'ask_user') await this.continueQuestion(result.run_id);
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
    const run = await this.runtime.run(job.receipt.run_id);
    if (['accepted', 'preparing', 'runnable'].includes(run.state)) {
      void this.runtime.startRunWithCredentialOwner(run.id, model.credentialOwner).catch(error => this.recordLaunchFailure(run.id, error));
    }
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
    await this.resumeContextRun(runId);
  }

  private async resumeContextRun(runId: string): Promise<void> {
    const run = await this.runtime.run(runId);
    const launch = await this.runtime.launch(runId);
    if (!launch?.selection.credential_scope) throw new Error('Context job has no durable credential binding');
    const { context_job: _recipe, ...configuration } = run.configuration as ModelSessionConfiguration & { context_job: unknown };
    const owner = await this.models.rebindModel(configuration as ModelSessionConfiguration, launch.selection.credential_scope);
    await this.runtime.startRunWithCredentialOwner(runId, owner);
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
    // Close the first-admission gap: a note commit can occur after assembly while no checkpoint
    // yet exists for the background refresh. Never launch that missed revision indefinitely.
    this.launchAdmitted(receipt.run_id, async () => {
      await this.refreshContext(input);
      const run = await this.runtime.run(receipt.run_id);
      if (run.state === 'accepted' || run.state === 'preparing' || run.state === 'runnable') {
        await this.runtime.rebindLaunch(receipt.run_id, { credentialOwner: model.credentialOwner });
      }
    });
    return receipt;
  }

  async enqueue(input: ThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; mode: InputMode }) {
    const thread = await this.requireIdentity(input);
    const branch = thread.branches.find(candidate => candidate.branch_id === input.branchId)!;
    const previous = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : branch.latest_run;
    if (!previous) throw new Error('An initial model selection is required');
    this.assertImagesSupported(input.images, previous.configuration);
    const receipt = await this.runtime.enqueue({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      mode: input.mode, input: threadInput(input.text, input.images), configuration: previous.configuration });
    // Context is synchronized by the Run's request preparation. An accepted input receipt
    // must not wait for extension/MCP startup, source materialization or credential rebinding.
    this.launchAdmitted(receipt.run_id, async () => {
      const launch = await this.runtime.launch(receipt.run_id);
      if (launch?.requires_rebind) {
        const run = await this.runtime.run(receipt.run_id);
        if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state)) return;
        await this.refreshContext(input);
        if (!launch.selection.credential_scope) throw new Error('Selected credential binding is unavailable');
        const owner = await this.models.rebindModel(run.configuration as ModelSessionConfiguration, launch.selection.credential_scope);
        await this.runtime.rebindLaunch(receipt.run_id, { credentialOwner: owner });
      }
    });
    return receipt;
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
    const [page, inputs, activeOperations, context] = await Promise.all([
      this.readHistoryPage(identity.branchId, branch.head ? { headId: branch.head } : undefined),
      this.runtime.inputs(identity.branchId), this.runtime.activeOperations(identity.threadId, identity.branchId), this.context(identity),
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
    const launch = latest ? await this.runtime.launch(latest.id) : null;
    return { identity, eventCursor, thread, activeRun, history, historyPage: { head: page.head, previous: page.previous }, inputs,
      operations: [...operations.values()], launch, context, children: await this.children(identity) };
  }

  private async recordLaunchFailure(runId: string, error: unknown): Promise<void> {
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    const code = ['credential-scope-changed', 'model-configuration-changed'].includes(errorCode) ? 'binding_changed'
      : errorCode.startsWith('credential-') ? 'credentials_unavailable' : 'preparation_failed';
    try { await this.runtime.failLaunch(runId, code); }
    catch (recordError) { this.onLaunchError(runId, recordError); }
    this.onLaunchError(runId, error);
  }

  async recover(): Promise<void> {
    const pending = await this.runtime.pendingLaunches();
    await Promise.all(pending.map(async launch => {
      const run = await this.runtime.run(launch.run_id);
      if (['completed', 'failed', 'cancelled'].includes(run.state) || (run.state === 'waiting' && (run.waiting_on?.startsWith('question:') || run.waiting_on?.startsWith('child-wait:') || run.waiting_on?.startsWith('process-wait:')))) return;
      if (await this.runtime.childForThread(run.thread_id)) return;
      try {
        if (run.thread_id.startsWith('thread:')) await this.resume(run.id);
        else if (run.thread_id.startsWith('context-job-thread:')) {
          const job = await this.runtime.contextJob(run.id);
          const sources = await this.runtime.threads();
          if (!sources.some(thread => thread.thread_id.startsWith('thread:') && thread.branches.some(branch => branch.branch_id === job.request.branch_id))) return;
          await this.resumeContextRun(run.id);
        }
      }
      catch (error) { await this.recordLaunchFailure(run.id, error); }
    }));
  }

  async resume(runId: string): Promise<void> {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('thread:')) throw new Error('Run is not owned by a thread');
    await this.refreshContext({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id });
    const launch = await this.runtime.launch(runId);
    if (!launch?.selection.credential_scope) throw new Error('Run has no durable credential binding; resubmit its original input key');
    const owner = await this.models.rebindModel(run.configuration as ModelSessionConfiguration, launch.selection.credential_scope);
    await this.runtime.rebindLaunch(runId, { credentialOwner: owner });
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
