import type { ImageAttachment } from '@varin/protocol';
import { nativeThreadInput } from './native-thread-images.js';
import { createHash } from 'node:crypto';
import type { NativeThreadIdentity, NativeThreadSubmit, NativeThreadSource, NativeThreadSnapshot, NativeThreadHistoryPage, NativeThreadCompact, NativeThreadContextState, NativeThreadPrepareSource, NativeThreadPreparedSource } from '@varin/application-client';
import type { NativeInputMode, NativeInitialContext, NativeModelSessionConfiguration, NativeCredentialScope, NativeRuntimeStreamEvent } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeRuntimeClient } from './native-runtime-client.js';

export interface NativeThreadModelAuthority {
  listModels?(): Promise<Array<{ providerId: string; modelId: string; name?: string; acceptsImages?: boolean }>>;
  resolveModel(selection: { providerId: string; modelId: string }): Promise<{ configuration: NativeModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }>;
  rebindModel(configuration: NativeModelSessionConfiguration, expectedScope: NativeCredentialScope): Promise<ExistingHostCredentialOwner>;
}

/** Projection and admission only: Rust owns all conversation, queue and execution facts. */
export class NativeThreadAdapter {
  constructor(readonly runtime: NativeRuntimeClient, private readonly models: NativeThreadModelAuthority,
    private readonly admitSource: (source: NativeThreadSource) => Promise<void>,
    private readonly onLaunchError: (runId: string, error: unknown) => void,
    private readonly prepareWorkspace?: (input: NativeThreadPrepareSource) => Promise<NativeThreadPreparedSource>,
    private readonly prepareContext?: (identity: NativeThreadIdentity, source: NativeThreadSource | null) => Promise<NativeInitialContext>) {}

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
  async answerQuestion(input: NativeThreadIdentity & { operationId: string; answer: string }) {
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
    const result = await this.runtime.cancelOperation(operationId);
    if (result.executor === 'native_ask_user') await this.continueQuestion(result.run_id);
    return result;
  }
  async listModels() {
    if (!this.models.listModels) throw new Error('Model catalog is unavailable');
    return this.models.listModels();
  }

  async create(key: string): Promise<NativeThreadIdentity> {
    const digest = createHash('sha256').update(key).digest('hex');
    const identity: NativeThreadIdentity = { runtime: 'nativeThread', threadId: `nativeThread:${digest}`, branchId: `nativeBranch:${digest}` };
    await this.runtime.createThread(identity.threadId, identity.branchId);
    return identity;
  }

  async prepareSource(input: NativeThreadPrepareSource): Promise<NativeThreadPreparedSource> {
    await this.requireIdentity(input);
    if (!this.prepareWorkspace) throw new Error('Workspace source preparation is unavailable');
    return this.prepareWorkspace(input);
  }

  async fork(input: NativeThreadIdentity & { key: string; headId: string | null }): Promise<NativeThreadIdentity> {
    await this.requireIdentity(input);
    const digest = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.headId, input.key])).digest('hex');
    const result = await this.runtime.forkBranch(input.branchId, `nativeBranch:${digest}`, input.headId);
    return { runtime: 'nativeThread', ...result };
  }

  async compact(input: NativeThreadCompact) {
    await this.requireIdentity(input);
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.key])).digest('hex');
    const [checkpoint, jobs] = await Promise.all([this.runtime.context(input.branchId), this.runtime.contextJobs(input.branchId)]);
    // An uncertain create retry keeps its original prompt/memory recipe even after publication.
    const previous = jobs.find(job => job.request.key === key);
    const recipe = previous?.request ?? checkpoint?.proposal;
    const model = await this.models.resolveModel(input.model);
    const job = await this.runtime.createContextJob({ key, branchId: input.branchId, throughId: input.throughId,
      expectedRevision: input.expectedRevision, effectiveSystemPrompt: recipe?.effective_system_prompt ?? '',
      instructionSources: recipe?.instruction_sources ?? [], memoryCheckpoint: recipe?.memory_checkpoint ?? null,
      configuration: model.configuration, credentialScope: await model.credentialOwner.scope() });
    const run = await this.runtime.run(job.receipt.run_id);
    if (['accepted', 'preparing', 'runnable'].includes(run.state)) {
      void this.runtime.startRunWithCredentialOwner(run.id, model.credentialOwner).catch(error => this.recordLaunchFailure(run.id, error));
    }
    return job;
  }

  async context(identity: NativeThreadIdentity): Promise<NativeThreadContextState> {
    const [checkpoint, jobs] = await Promise.all([this.runtime.context(identity.branchId), this.runtime.contextJobs(identity.branchId)]);
    return { checkpoint, jobs: await Promise.all(jobs.map(async job => ({ job, run: await this.runtime.run(job.receipt.run_id) }))) };
  }

  async requireContextJob(identity: NativeThreadIdentity, runId: string) {
    await this.requireIdentity(identity);
    const job = await this.runtime.contextJob(runId);
    if (job.request.branch_id !== identity.branchId) throw new Error('Context job does not belong to the selected branch');
    return job;
  }

  async publishContext(identity: NativeThreadIdentity, runId: string) {
    await this.requireContextJob(identity, runId);
    return this.runtime.publishContextJob(runId);
  }

  async cancelContext(identity: NativeThreadIdentity, runId: string) {
    await this.requireContextJob(identity, runId);
    return this.runtime.cancelRun(runId);
  }

  async resumeContext(identity: NativeThreadIdentity, runId: string): Promise<void> {
    await this.requireContextJob(identity, runId);
    await this.resumeContextRun(runId);
  }

  private async resumeContextRun(runId: string): Promise<void> {
    const run = await this.runtime.run(runId);
    const launch = await this.runtime.launch(runId);
    if (!launch?.selection.credential_scope) throw new Error('Context job has no durable credential binding');
    const { context_job: _recipe, ...configuration } = run.configuration as NativeModelSessionConfiguration & { context_job: unknown };
    const owner = await this.models.rebindModel(configuration as NativeModelSessionConfiguration, launch.selection.credential_scope);
    await this.runtime.startRunWithCredentialOwner(runId, owner);
  }

  assertIdentity(identity: NativeThreadIdentity): void {
    if (identity.runtime !== 'nativeThread' || !identity.threadId.startsWith('nativeThread:')) {
      throw new Error('An explicit nativeThread identity is required');
    }
  }

  async submit(input: NativeThreadSubmit) {
    const thread = await this.requireIdentity(input);
    if (input.source) await this.admitSource(input.source);
    const model = await this.models.resolveModel(input.model);
    this.assertImagesSupported(input.images, model.configuration);
    let initialContext: NativeInitialContext | undefined;
    if (this.prepareContext && !await this.runtime.context(input.branchId)) {
      let source = input.source ?? null;
      if (!source) {
        const latest = thread.branches.find(branch => branch.branch_id === input.branchId)?.latest_run;
        const previous = latest ? await this.runtime.launch(latest.id) : null;
        const inherited = previous?.selection.source;
        if (inherited?.branch_id && inherited.revision !== null) source = {
          workspaceId: inherited.workspace_id, executionWorkspaceId: inherited.execution_workspace_id,
          branchId: inherited.branch_id, revision: inherited.revision,
          mode: inherited.materialized ? 'materialized' : 'fixed_branch', tools: [],
        };
      }
      initialContext = await this.prepareContext(input, source);
    }
    // The same Rust transaction accepts input, initial context and source/credential/tool selection.
    const receipt = await this.runtime.submit({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      expectedHead: input.expectedHead, input: nativeThreadInput(input.text, input.images), configuration: model.configuration,
      ...(initialContext ? { initialContext } : {}),
      launch: { inheritSource: input.source === undefined, source: input.source ? {
        workspaceId: input.source.workspaceId, executionWorkspaceId: input.source.executionWorkspaceId,
        branchId: input.source.branchId, revision: input.source.revision, materialized: input.source.mode === 'materialized',
      } : null, enabledTools: input.source?.tools ?? [], credentialScope: await model.credentialOwner.scope() },
    });
    const run = await this.runtime.run(receipt.run_id);
    if (run.state === 'accepted' || run.state === 'preparing' || run.state === 'runnable') {
      const launch = this.runtime.rebindLaunch(receipt.run_id, { credentialOwner: model.credentialOwner });
      void launch.catch(error => this.recordLaunchFailure(receipt.run_id, error));
    }
    return receipt;
  }

  async enqueue(input: NativeThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; mode: NativeInputMode }) {
    const thread = await this.requireIdentity(input);
    const branch = thread.branches.find(candidate => candidate.branch_id === input.branchId)!;
    const previous = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : branch.latest_run;
    if (!previous) throw new Error('An initial model selection is required');
    this.assertImagesSupported(input.images, previous.configuration);
    const receipt = await this.runtime.enqueue({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      mode: input.mode, input: nativeThreadInput(input.text, input.images), configuration: previous.configuration });
    const launch = await this.runtime.launch(receipt.run_id);
    if (launch?.requires_rebind) {
      const run = await this.runtime.run(receipt.run_id);
      if (!launch.selection.credential_scope) throw new Error('Selected credential binding is unavailable');
      const owner = await this.models.rebindModel(run.configuration as NativeModelSessionConfiguration, launch.selection.credential_scope);
      try { await this.runtime.rebindLaunch(receipt.run_id, { credentialOwner: owner }); }
      catch (error) { await this.recordLaunchFailure(receipt.run_id, error); throw error; }
    }
    return receipt;
  }

  assertImagesSupported(images: readonly ImageAttachment[] | undefined, configuration: unknown): void {
    if (images?.length && (configuration as { acceptsImages?: boolean }).acceptsImages === false) {
      throw Object.assign(new Error('Selected model does not accept images'), { code: 'native-model-images-unsupported' });
    }
  }

  async requireIdentity(identity: NativeThreadIdentity) {
    this.assertIdentity(identity);
    const thread = await this.runtime.thread(identity.threadId);
    if (!thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new Error('Native branch does not belong to the selected thread');
    return thread;
  }

  async requireRun(runId: string) {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('nativeThread:')) throw new Error('Run is not owned by a nativeThread');
    return run;
  }

  async requireInput(inputId: string) {
    const input = await this.runtime.input(inputId);
    if (!input.thread_id.startsWith('nativeThread:')) throw new Error('Input is not owned by a nativeThread');
    return input;
  }

  async requireOperation(operationId: string) {
    const operation = await this.runtime.operation(operationId);
    await this.requireRun(operation.run_id);
    return operation;
  }

  async historyPage(identity: NativeThreadIdentity, cursor: { headId: string; beforeId: string }): Promise<NativeThreadHistoryPage> {
    await this.requireIdentity(identity);
    return this.readHistoryPage(identity.branchId, cursor);
  }

  private async readHistoryPage(branchId: string, cursor?: { headId: string; beforeId?: string }): Promise<NativeThreadHistoryPage> {
    const page = await this.runtime.historyPage({ branchId, ...cursor, limit: 20 });
    const items = await Promise.all(page.items.map(item => this.runtime.historyItem(item)));
    return { head: page.head, previous: page.previous, items };
  }

  async snapshot(identity: NativeThreadIdentity): Promise<NativeThreadSnapshot> {
    const thread = await this.requireIdentity(identity);
    const branch = thread.branches.find(branch => branch.branch_id === identity.branchId)!;
    const [page, inputs, activeOperations, context] = await Promise.all([
      this.readHistoryPage(identity.branchId, branch.head ? { headId: branch.head } : undefined),
      this.runtime.inputs(identity.branchId), this.runtime.activeOperations(identity.threadId), this.context(identity),
    ]);
    const history = page.items;
    if (history.some(item => item.thread_id !== identity.threadId) || inputs.some(item => item.thread_id !== identity.threadId)) {
      throw new Error('Native branch does not belong to the selected thread');
    }
    const operationIds = new Set<string>();
    for (const item of history) {
      const conversation = item.content as { content?: { kind?: string; result?: { completion?: { kind?: string; operation_id?: string } } } };
      const completion = conversation?.content?.kind === 'tool_result' ? conversation.content.result?.completion : undefined;
      if (completion?.kind === 'job_accepted' && typeof completion.operation_id === 'string') operationIds.add(completion.operation_id);
    }
    const operations = new Map(activeOperations.map(operation => [operation.id, operation]));
    const visible = await Promise.all([...operationIds].filter(id => !operations.has(id)).map(id => this.requireOperation(id)));
    for (const operation of visible) operations.set(operation.id, operation);
    const latest = branch.latest_run;
    const activeRun = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : null;
    const launch = latest ? await this.runtime.launch(latest.id) : null;
    return { identity, thread, activeRun, history, historyPage: { head: page.head, previous: page.previous }, inputs, operations: [...operations.values()], launch, context };
  }

  private async recordLaunchFailure(runId: string, error: unknown): Promise<void> {
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    const code = ['credential-scope-changed', 'native-model-configuration-changed'].includes(errorCode) ? 'binding_changed'
      : errorCode.startsWith('credential-') ? 'credentials_unavailable' : 'preparation_failed';
    try { await this.runtime.failLaunch(runId, code); }
    catch (recordError) { this.onLaunchError(runId, recordError); }
    this.onLaunchError(runId, error);
  }

  async recover(): Promise<void> {
    const pending = await this.runtime.pendingLaunches();
    await Promise.all(pending.map(async launch => {
      const run = await this.runtime.run(launch.run_id);
      if (['completed', 'failed', 'cancelled'].includes(run.state) || (run.state === 'waiting' && run.waiting_on?.startsWith('question:'))) return;
      try {
        if (run.thread_id.startsWith('nativeThread:')) await this.resume(run.id);
        else if (run.thread_id.startsWith('context-job-thread:')) {
          const job = await this.runtime.contextJob(run.id);
          const sources = await this.runtime.threads();
          if (!sources.some(thread => thread.thread_id.startsWith('nativeThread:') && thread.branches.some(branch => branch.branch_id === job.request.branch_id))) return;
          await this.resumeContextRun(run.id);
        }
      }
      catch (error) { await this.recordLaunchFailure(run.id, error); }
    }));
  }

  async resume(runId: string): Promise<void> {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('nativeThread:')) throw new Error('Run is not owned by a nativeThread');
    const launch = await this.runtime.launch(runId);
    if (!launch?.selection.credential_scope) throw new Error('Run has no durable credential binding; resubmit its original input key');
    const owner = await this.models.rebindModel(run.configuration as NativeModelSessionConfiguration, launch.selection.credential_scope);
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
    const remove = this.runtime.onEvent((event: NativeRuntimeStreamEvent) => {
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
