import { admitContextJobCandidate, contextCompactionScope } from './context-job-preparation.js';
import type { ContextCompactionOwner } from './context-compaction.js';
import type { SourceDirectory } from './thread-sources.js';
import { sourceFailureCode } from './source-admission-error.js';
import type { McpInteractionListParams, McpInteractionReadParams, McpInteractionRespondParams, McpSamplingOutputReviewParams } from '@varin/protocol';
import type { MediaReadParams, MediaReadChunk } from './protocol.generated.js';
import type { MessageSendParams, MessageListParams } from '@varin/protocol';
import type { FamilyRunsParams, FamilyReadParams, FamilyItemParams } from '@varin/protocol';
import type { ChildProfilePreparer } from './child-profiles.js';
import type { ThreadToolInspection, ThreadMcpSamplingRequestReview } from '@varin/application-client';
import type { PlanService } from './plan-service.js';
import type { ImageAttachment } from '@varin/protocol';
import { threadInput } from './thread-images.js';
import { materialInputText, parseThreadMaterials, type ThreadInputMaterials } from './thread-material-input.js';
import type { ThreadMaterialAttachment } from '@varin/application-client';
import { listThreadFollowups } from './thread-followups.js';
import { listThreadGoals } from './thread-goals.js';
import { createHash } from 'node:crypto';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadSubmit, ThreadSource, ThreadSnapshot, ThreadHistoryPage, ThreadCompact, ThreadContextState, ThreadPrepareSource, ThreadPreparedSource, ThreadResourceRefresh, ThreadChildContinuation, ThreadSourcesAPI } from '@varin/application-client';
import type { InputMode, InitialContext, InputSubmitParams, InputEnqueueParams, InputResourcePreparation, ContextResources, PreparedExplicitSkill, ModelSessionConfiguration, CredentialScope, AgentRuntimeStreamEvent, PolicyResumeReceipt } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { isAbortError, waitWithSignal } from '../cancellation.js';
import { modelCredentialBindingIdentity, waitForModelBinding } from './model-binding-lifetime.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextPreparer } from './thread-context.js';
import type { ThreadSkillInputPreparer } from './thread-skill-input.js';
import { parseExplicitSkillCommand } from '../agent-resources/activation.js';
import { KernelRequestError } from './kernel-error.js';
import { ResourceScopeError } from './thread-resource-scope.js';

export interface ThreadModelAuthority {
  listModels?(): Promise<ThreadModelInfo[]>;
  describeModel?(selection: ThreadModel): Promise<{ providerId: string; model: string; contextWindowTokens: number | null; maxOutputTokens: number | null; thinkingLevel?: string; modelOptions?: unknown }>;
  resolveModel(selection: ThreadModel, inherited?: { configuration: ModelSessionConfiguration; credentialScope: CredentialScope }): Promise<{ configuration: ModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }>;
  rebindModel(configuration: ModelSessionConfiguration, expectedScope: CredentialScope): Promise<ExistingHostCredentialOwner>;
}

/** This boundary has not invoked native generation admission. Do not infer that from error codes. */
export class ThreadPreAdmissionError extends Error {
  readonly code: string;
  constructor(readonly reason: unknown, fallbackCode = 'mcp_sampling_model_selection_failed') {
    super('Thread request preparation failed before admission');
    this.code = reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string'
      ? reason.code : fallbackCode;
  }
}

/** Projection and admission only: Rust owns all conversation, queue and execution facts. */
export class ThreadAdapter {
  constructor(readonly runtime: AgentRuntimeClient, private readonly models: ThreadModelAuthority,
    private readonly admitSource: (source: ThreadSource, identity: ThreadIdentity, runId?: string, signal?: AbortSignal) => Promise<void>,
    private readonly onLaunchError: (runId: string, error: unknown) => void,
    private readonly prepareWorkspace?: (input: ThreadPrepareSource, signal?: AbortSignal) => Promise<ThreadPreparedSource>,
    private readonly prepareContext?: ContextPreparer, private readonly plans?: PlanService,
    private readonly prepareSkillInput?: ThreadSkillInputPreparer,
    private readonly processTerminals?: import('@varin/application-client').ThreadProcessesAPI,
    private readonly prepareChildProfiles?: ChildProfilePreparer) {}

  private inputMaterials?: ThreadInputMaterials;
  bindMaterials(owner: ThreadInputMaterials): void { this.inputMaterials = owner; }
  private async prepareInput(input: ThreadIdentity & { text: string; images?: ImageAttachment[]; materials?: ThreadMaterialAttachment[] }, signal?: AbortSignal) {
    const selected = parseThreadMaterials(input.materials);
    if (!selected?.length) return threadInput(input.text, input.images);
    if (!this.inputMaterials) throw new Error('Thread material admission is unavailable');
    const materials = await this.inputMaterials(input, selected, signal);
    signal?.throwIfAborted();
    return threadInput(materialInputText(input.text, materials), input.images);
  }

  private compaction?: ContextCompactionOwner;
  bindCompaction(owner: ContextCompactionOwner): void { this.compaction = owner; }
  private sourceDirectory?: SourceDirectory;
  bindSourceDirectory(directory: SourceDirectory): void { this.sourceDirectory = directory; }
  private fileResolver?: import('./thread-file-target.js').ThreadFileTargetResolver;
  bindFileResolver(resolver: import('./thread-file-target.js').ThreadFileTargetResolver): void { this.fileResolver = resolver; }
  async fileTarget(input: ThreadIdentity & { itemId: string; path: string }, signal?: AbortSignal) {
    const entry = await this.recoveryEntry({ ...input, entryId: input.itemId }, signal);
    if (!this.fileResolver) throw new Error('File navigation is unavailable');
    const launch = await this.runtime.launch(entry.run_id, signal);
    return this.fileResolver(entry.run_id, launch?.selection.source ?? null, input.path, signal);
  }
  async usage(identity: ThreadIdentity, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.threadUsage(identity.threadId, identity.branchId, signal);
  }
  async listSourceTargets(identity: ThreadIdentity, signal?: AbortSignal) {
    await this.requireIdentity(identity);
    if (!this.sourceDirectory) throw new Error('Source directory is unavailable');
    return this.sourceDirectory.list(signal);
  }
  async resolveSource(identity: ThreadIdentity, request: Parameters<ThreadSourcesAPI['resolve']>[1], signal?: AbortSignal) {
    await this.requireIdentity(identity);
    if (!this.sourceDirectory) throw new Error('Source directory is unavailable');
    return this.sourceDirectory.resolve(request, signal);
  }

  private recoveryReader?: (identity: ThreadIdentity) => Promise<NonNullable<ThreadSnapshot['recovery']>>;
  bindRecoveryReader(reader: (identity: ThreadIdentity) => Promise<NonNullable<ThreadSnapshot['recovery']>>): void { this.recoveryReader = reader; }

  private async skillInput(identity: ThreadIdentity, resources: ContextResources | undefined, text: string, signal?: AbortSignal): Promise<PreparedExplicitSkill | null> {
    if (!parseExplicitSkillCommand(text)) return null;
    if (!this.prepareSkillInput) throw Object.assign(new Error('Skill input preparation is unavailable'), { code: 'resource-unavailable' });
    const prepared = await this.prepareSkillInput(identity, resources, text, signal);
    if (prepared.status !== 'ready') throw new ResourceScopeError(prepared);
    return prepared.skill;
  }

  private readonly contextRefreshes = new Map<string, Promise<void>>();
  private readonly admittedLaunches = new Map<string, {
    pending: Map<AbortSignal | undefined, { signal: AbortSignal | undefined; prepare: () => Promise<void>; release: () => void }>;
    work: Promise<void>;
  }>();
  private launchAdmitted(runId: string, prepare: () => Promise<void>, signal?: AbortSignal, release: () => void = () => {}): Promise<void> {
    if (signal?.aborted) { release(); return Promise.reject(signal.reason ?? new DOMException('Launch caller cancelled', 'AbortError')); }
    const existing = this.admittedLaunches.get(runId);
    if (existing) {
      // Repeated wakes from one caller epoch need one fresh authority read after the current
      // attempt drains. Keep other live epochs: cancelling the newest caller cannot erase them.
      existing.pending.get(signal)?.release();
      existing.pending.delete(signal);
      existing.pending.set(signal, { signal, prepare, release });
      return waitWithSignal(existing.work, signal);
    }
    const flight = { pending: new Map([[signal, { signal, prepare, release }]]), work: Promise.resolve() };
    flight.work = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      try {
        while (flight.pending.size) {
          const candidates = [...flight.pending.values()].filter(wake => {
            if (!wake.signal?.aborted) return true;
            wake.release(); return false;
          });
          flight.pending.clear();
          const next = candidates.pop();
          if (!next) continue;
          try { await next.prepare(); failed = false; for (const wake of candidates) wake.release(); }
          catch (error) {
            failed = true; failure = error;
            if (!isAbortError(error)) {
              for (const wake of candidates) wake.release();
              await this.recordLaunchFailure(runId, error);
            }
            else {
              // The selected epoch may have ended while another coalesced caller is still
              // valid. Preserve its own closure/credentials, behind any newer recorded wake.
              const newer = flight.pending;
              flight.pending = new Map(candidates.filter(wake => {
                if (!wake.signal?.aborted) return true;
                wake.release(); return false;
              }).map(wake => [wake.signal, wake]));
              for (const [key, wake] of newer) { flight.pending.get(key)?.release(); flight.pending.delete(key); flight.pending.set(key, wake); }
            }
          } finally { next.release(); }
        }
        if (failed) throw failure;
      } finally {
        for (const wake of flight.pending.values()) wake.release();
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
        const context = await waitWithSignal(this.prepareContext!.refresh!(checkpoint, signal), signal);
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
  async refreshPersonalization(identities?: readonly ThreadIdentity[]): Promise<void> {
    if (!this.prepareContext?.refresh) return;
    const selected = identities ?? (await this.runtime.threads()).filter(thread => thread.thread_id.startsWith('thread:'))
      .flatMap(thread => thread.branches.map(branch => ({ runtime: 'agent' as const, threadId: thread.thread_id, branchId: branch.branch_id })));
    const results = await Promise.allSettled(selected.map(identity => this.refreshContext(identity)));
    if (results.some(result => result.status === 'rejected')) throw new Error('Personalization refresh requires attention');
  }

  async openProcessTerminal(input: ThreadIdentity & { operationId: string }) {
    await this.requireIdentity(input);
    if (!this.processTerminals) throw new Error('Process terminals are unavailable');
    return this.processTerminals.openTerminal(input);
  }
  async decidePermission(input: ThreadIdentity & { operationId: string; permissionId: string; decision: 'allow_once' | 'deny' }) {
    await this.requireIdentity(input);
    const operation = await this.requireOperation(input.operationId);
    const run = await this.requireRun(operation.run_id);
    if (run.branch_id !== input.branchId || run.thread_id !== input.threadId) throw new Error('Permission belongs to another branch');
    return this.runtime.decidePermission(input.operationId, input.permissionId, input.decision);
  }
  async listMcpInteractions(input: ThreadIdentity & Omit<McpInteractionListParams, 'threadId' | 'branchId'>, signal?: AbortSignal) {
    await this.requireIdentity(input, signal);
    return this.runtime.listMcpInteractions({ threadId: input.threadId, branchId: input.branchId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.limit === undefined ? {} : { limit: input.limit }) }, signal);
  }
  async readMcpInteraction(input: ThreadIdentity & McpInteractionReadParams, signal?: AbortSignal) {
    await this.requireIdentity(input, signal);
    const view = await this.runtime.readMcpInteraction(input.operationId, input.interactionId, signal);
    if (view.record.threadId !== input.threadId || view.record.branchId !== input.branchId) {
      throw Object.assign(new Error('MCP request belongs to another branch'), { code: 'forbidden' });
    }
    return view;
  }
  async respondMcpInteraction(input: ThreadIdentity & McpInteractionRespondParams, signal?: AbortSignal) {
    await this.readMcpInteraction(input, signal);
    return this.runtime.respondMcpInteraction({ operationId: input.operationId, interactionId: input.interactionId,
      expectedRevision: input.expectedRevision, response: input.response }, signal);
  }
  async reviewMcpSamplingRequest(input: ThreadMcpSamplingRequestReview, signal?: AbortSignal) {
    await this.readMcpInteraction(input, signal);
    let model: Awaited<ReturnType<ThreadModelAuthority['resolveModel']>> | undefined;
    if (input.action === 'generate') {
      try { model = await waitForModelBinding(this.models.resolveModel(input.model), model => model.credentialOwner.release(), signal); }
      catch (error) { signal?.throwIfAborted(); throw new ThreadPreAdmissionError(error); }
    }
    try {
      signal?.throwIfAborted();
      return await this.runtime.reviewMcpSamplingRequest({ operationId: input.operationId, interactionId: input.interactionId,
        expectedRevision: input.expectedRevision, action: input.action,
        ...(input.action === 'generate' ? { editedRequest: input.editedRequest } : {}) }, model, signal);
    } finally { model?.credentialOwner.release(); }
  }
  async reviewMcpSamplingOutput(input: ThreadIdentity & McpSamplingOutputReviewParams, signal?: AbortSignal) {
    await this.readMcpInteraction(input, signal);
    return this.runtime.reviewMcpSamplingOutput({ operationId: input.operationId, interactionId: input.interactionId,
      expectedRevision: input.expectedRevision, action: input.action }, signal);
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
    const current = await this.runtime.operationStatus(operationId);
    await this.requireRun(current.run_id);
    if (current.executor === 'dispatch') {
      await this.runtime.cancelTree({ kind: 'child', operation_id: operationId }); return this.runtime.operationStatus(operationId);
    }
    if (current.executor === 'wait_child' && current.waiting_on) {
      await this.runtime.cancelChildWait(current.waiting_on); return this.runtime.operationStatus(operationId);
    }
    const result = await this.runtime.cancelOperation(operationId);
    if (result.executor === 'ask_user') await this.continueLaunch(result.run_id);
    return result;
  }
  async sendMessage(identity: ThreadIdentity, request: Omit<MessageSendParams, 'senderThreadId' | 'senderBranchId'>, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.sendMessage({ ...request, senderThreadId: identity.threadId, senderBranchId: identity.branchId }, signal);
  }
  async listMessages(identity: ThreadIdentity, request: Omit<MessageListParams, 'threadId' | 'branchId'>, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.listMessages({ ...request, threadId: identity.threadId, branchId: identity.branchId }, signal);
  }
  async getMessage(identity: ThreadIdentity, messageId: string, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.getMessage({ threadId: identity.threadId, branchId: identity.branchId, messageId }, signal);
  }
  async familyList(identity: ThreadIdentity, includeSelf?: boolean, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.familyList({ callerThreadId: identity.threadId, ...(includeSelf === undefined ? {} : { includeSelf }) }, signal);
  }
  async familyRuns(identity: ThreadIdentity, request: Omit<FamilyRunsParams, 'callerThreadId'>, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.familyRuns({ ...request, callerThreadId: identity.threadId }, signal);
  }
  async familyRead(identity: ThreadIdentity, request: Omit<FamilyReadParams, 'callerThreadId'>, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.familyRead({ ...request, callerThreadId: identity.threadId }, signal);
  }
  async familyItem(identity: ThreadIdentity, request: Omit<FamilyItemParams, 'callerThreadId'>, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    return this.runtime.familyItem({ ...request, callerThreadId: identity.threadId }, signal);
  }
  async continueChild(input: ThreadChildContinuation, signal?: AbortSignal) {
    let admissionStarted = false;
    try {
      await this.requireIdentity(input, signal);
      const child = await this.runtime.childForThread(input.threadId, signal);
      if (!child || child.child_branch_id !== input.branchId) throw new Error('Continuation requires the original child branch');
      const preparedInput = await this.prepareInput(input, signal);
      // This call is the durable input acceptance. Cold source/configuration preparation belongs
      // to the existing event-driven collaboration owner, including after Host restart.
      admissionStarted = true;
      return await this.runtime.acceptChildContinuation({ key: input.key, childOperationId: child.operation_id,
        previousRunId: input.previousRunId, expectedHead: input.expectedHead, input: preparedInput }, signal);
    } catch (error) {
      if (!admissionStarted || error instanceof KernelRequestError && error.method === 'runtime.child.continuation.accept' && error.settlement === 'not_dispatched') {
        throw new ThreadPreAdmissionError(error, 'thread-request-failed');
      }
      throw error;
    }
  }

  async childExecutions(identity: ThreadIdentity, operationId?: string, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    const child = operationId ? await this.runtime.child(operationId, signal) : await this.runtime.childForThread(identity.threadId, signal);
    if (!child) return [];
    // A historical fork remains readable without acquiring the original branch's executions.
    if (operationId === undefined && child.child_thread_id === identity.threadId && child.child_branch_id !== identity.branchId) return [];
    const own = child.child_thread_id === identity.threadId && child.child_branch_id === identity.branchId;
    const parent = child.parent_thread_id === identity.threadId && child.parent_branch_id === identity.branchId;
    if (!own && !parent) throw new Error('Delegated executions belong to another Thread branch');
    return this.runtime.childExecutions(child.operation_id, signal);
  }
  async readChildExecutionReport(identity: ThreadIdentity, executionId: string, itemId: string, offset = 0, maxBytes = 65536, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    const execution = await this.runtime.childExecution(executionId, signal);
    if (!(execution.child_thread_id === identity.threadId && execution.child_branch_id === identity.branchId)
      && !(execution.parent_thread_id === identity.threadId && execution.parent_branch_id === identity.branchId)) throw new Error('Report belongs to another Thread branch');
    return this.runtime.readChildExecutionReport(executionId, itemId, offset, maxBytes, signal);
  }
  async readChildReport(identity: ThreadIdentity, operationId: string, itemId: string, offset = 0, maxBytes = 65536, signal?: AbortSignal) {
    await this.requireIdentity(identity, signal);
    const child = await this.runtime.child(operationId, signal);
    if (child.parent_thread_id !== identity.threadId || child.parent_branch_id !== identity.branchId) throw new Error('Child belongs to another Thread branch');
    return this.runtime.readChildReport(operationId, itemId, offset, maxBytes, signal);
  }
  async children(identity: ThreadIdentity) {
    await this.requireIdentity(identity);
    return (await this.runtime.children()).filter(child => child.parent_thread_id === identity.threadId && child.parent_branch_id === identity.branchId);
  }
  async cancelChild(identity: ThreadIdentity, operationId: string) {
    await this.requireIdentity(identity);
    // Cancellation only needs the dispatch's durable ownership metadata. Hydrating its
    // instruction/report body can fail independently and must not block stopping work.
    const operation = await this.runtime.operationStatus(operationId);
    const run = await this.requireRun(operation.run_id);
    if (run.thread_id !== identity.threadId || run.branch_id !== identity.branchId) throw new Error('Child belongs to another Thread branch');
    return this.runtime.cancelTree({ kind: 'child', operation_id: operationId }, undefined, identity.threadId);
  }
  async cancelChildWait(identity: ThreadIdentity, waitId: string) {
    await this.requireIdentity(identity);
    if (!waitId.startsWith('child-wait:')) throw new Error('Not a child observation wait');
    const operation = await this.runtime.operationStatus(waitId.slice('child-wait:'.length));
    const run = await this.requireRun(operation.run_id);
    if (run.thread_id !== identity.threadId || run.branch_id !== identity.branchId) throw new Error('Wait belongs to another parent Thread branch');
    return this.runtime.cancelChildWait(waitId);
  }
  async cancelTree(identity: ThreadIdentity) {
    await this.requireIdentity(identity);
    return this.runtime.cancelTree({ kind: 'thread', thread_id: identity.threadId });
  }
  async listModels() {
    if (!this.models.listModels) throw new Error('Model catalog is unavailable');
    return this.models.listModels();
  }

  list(options: import('@varin/application-client').ThreadListOptions = {}, signal?: AbortSignal) {
    return this.runtime.threadCatalog(options, signal);
  }
  update(input: import('@varin/application-client').ThreadUpdate) {
    const { runtime: _runtime, ...command } = input;
    return this.runtime.updateThread(command);
  }
  delete(input: import('@varin/application-client').ThreadDelete) {
    const { runtime: _runtime, ...command } = input;
    return this.runtime.deleteThread(command);
  }
  markRead(input: import('@varin/application-client').ThreadRead) {
    const { runtime: _runtime, ...command } = input;
    return this.runtime.markThreadRead(command);
  }

  async create(key: string): Promise<ThreadIdentity> {
    const digest = createHash('sha256').update(key).digest('hex');
    const identity: ThreadIdentity = { runtime: 'agent', threadId: `thread:${digest}`, branchId: `branch:${digest}` };
    await this.runtime.createThread(identity.threadId, identity.branchId);
    return identity;
  }

  async prepareSource(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource> {
    await this.requireIdentity(input);
    if (!this.prepareWorkspace) throw new Error('Workspace source preparation is unavailable');
    signal?.throwIfAborted();
    return this.prepareWorkspace(input, signal);
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
  private async recoveryEntry(input: ThreadIdentity & { entryId: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    const page = await this.runtime.historyPage({ branchId: input.branchId, headId: input.entryId, limit: 1 }, signal);
    const selected = page.items.find(item => item.id === input.entryId);
    if (!selected) throw new Error('Selected history entry is unavailable');
    return selected;
  }
  async recoverySource(input: ThreadIdentity & { entryId: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    const range = await this.runtime.recoveryRange({ threadId: input.threadId, branchId: input.branchId, entryId: input.entryId }, signal);
    const selected = range.find(turn => turn.source?.resource_owner.kind === 'managed_host' && turn.source.mode !== 'fixed_branch')
      ?? range.find(turn => turn.source && turn.source.mode !== 'fixed_branch') ?? range.find(turn => turn.source);
    if (!selected?.source) return null;
    return { resourceOwner: selected.source.resource_owner, workspaceId: selected.source.workspace_id, mode: selected.source.mode, runId: selected.anchor.runId };
  }
  async prepareNavigation(input: ThreadIdentity & { entryId: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    const selection = await this.runtime.prepareNavigation({ threadId: input.threadId, branchId: input.branchId, entryId: input.entryId }, signal);
    const reference = await this.recoveryEntry(input, signal);
    if (reference.source !== 'user') return selection;
    const selected = await this.runtime.historyItem(reference, signal);
    const attachments = (selected.content as { attachments?: import('@varin/protocol').StoredMedia[] }).attachments;
    if (!attachments?.length) return { ...selection, editorImages: [] as ImageAttachment[] };
    const editorImages: ImageAttachment[] = [];
    for (const [partIndex, media] of attachments.entries()) {
      if (!media.media_type.startsWith('image/')) continue;
      const chunks: Buffer[] = []; let count = 1; let total = 0;
      for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
        const chunk = await this.runtime.mediaRead({ threadId: input.threadId, branchId: input.branchId,
          holder: { kind: 'history', itemId: input.entryId }, partIndex, chunkIndex, expectedContentRef: media.content_ref.content_object }, signal);
        if (chunk.partIndex !== partIndex || chunk.chunkIndex !== chunkIndex || chunk.media.content_ref.content_object !== media.content_ref.content_object
          || chunk.media.media_type !== media.media_type || chunk.chunkCount < 1 || chunkIndex > 0 && (chunk.chunkCount !== count || chunk.totalBytes !== total)) throw new Error('Original input media changed');
        count = chunk.chunkCount; total = chunk.totalBytes; chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== total) throw new Error('Original input media is incomplete');
      editorImages.push({ mimeType: media.media_type, data: bytes.toString('base64') });
    }
    return { ...selection, editorImages };
  }
  async navigate(input: ThreadIdentity & { key: string; expectedHeadId: string | null; targetHeadId: string | null; undoOf?: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    const { runtime: _, ...command } = input;
    return this.runtime.navigate(command, signal);
  }
  async navigationReceipt(input: ThreadIdentity & { key: string }, signal?: AbortSignal) {
    await this.requireIdentity(input);
    return this.runtime.navigationReceipt({ threadId: input.threadId, branchId: input.branchId, key: input.key }, signal);
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

  async compact(input: ThreadCompact, signal: AbortSignal = new AbortController().signal) {
    await this.requireIdentity(input, signal);
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.key])).digest('hex');
    const jobs = await this.runtime.contextJobs(input.branchId, signal);
    const previous = jobs.find(job => job.request.key === key);
    if (previous) {
      // Recalling an original key does not depend on today's algorithm package,
      // personalization configuration or credential availability.
      const run = await this.runtime.run(previous.receipt.run_id, signal);
      const configuration = run.configuration as ModelSessionConfiguration;
      if (previous.request.branch_id !== input.branchId || previous.request.through_id !== input.throughId
        || previous.request.expected_revision !== input.expectedRevision || previous.request.owner_run_id
        || configuration.providerId !== input.model.providerId || (configuration.catalogModelId ?? configuration.model) !== input.model.modelId
        || input.model.thinkingLevel !== undefined && configuration.thinkingLevel !== input.model.thinkingLevel
        || input.model.temperature !== undefined && (configuration.modelOptions as { temperature?: number } | undefined)?.temperature !== input.model.temperature) {
        throw new Error('Context job key already belongs to another selection');
      }
      void this.continueLaunch(previous.receipt.run_id).catch(() => undefined);
      return previous;
    }
    await this.refreshContext(input, signal);
    const checkpoint = await this.runtime.context(input.branchId, signal);
    const candidate = checkpoint && this.prepareContext?.compact ? await this.prepareContext.compact(checkpoint, signal) : undefined;
    const recipe = candidate ? { effective_system_prompt: candidate.effectiveSystemPrompt,
      instruction_sources: candidate.instructionSources, memory_checkpoint: candidate.memoryCheckpoint } : checkpoint?.proposal;
    const personalization = candidate?.personalization ?? checkpoint?.personalization;
    if (!this.models.describeModel) throw new Error('Model capacity description is unavailable');
    const description = await this.models.describeModel(input.model);
    let model: Awaited<ReturnType<ThreadModelAuthority['resolveModel']>> | undefined;
    try {
      const { job } = await admitContextJobCandidate(this.runtime, this.compaction,
        contextCompactionScope(input.threadId, personalization, candidate?.resources ?? checkpoint?.resources),
        { summaryRecipe: { strategy: { kind: 'builtin', name: 'manual', version: '1' }, mode: 'manual', configurationIdentity: null, additionalInstructions: null },
          key, branchId: input.branchId, throughId: input.throughId, expectedRevision: input.expectedRevision,
          effectiveSystemPrompt: recipe?.effective_system_prompt ?? '', instructionSources: recipe?.instruction_sources ?? [],
          memoryCheckpoint: recipe?.memory_checkpoint ?? null, ...(personalization ? { personalization } : {}),
          configuration: description }, signal, async () => {
          model = await waitForModelBinding(this.models.resolveModel(input.model), model => model.credentialOwner.release(), signal);
          if ((model.configuration.contextWindowTokens ?? null) !== description.contextWindowTokens
            || (model.configuration.maxOutputTokens ?? null) !== description.maxOutputTokens) throw new Error('Model capacity changed during compaction preparation');
          return { configuration: model.configuration, credentialScope: await model.credentialOwner.scope() };
        });
      void this.continueLaunch(job.receipt.run_id, model ? { credentialOwner: model.credentialOwner } : {}).catch(() => undefined);
      return job;
    } finally { model?.credentialOwner.release(); }
  }

  async refreshResources(input: ThreadResourceRefresh, signal?: AbortSignal) {
    await this.requireIdentity(input);
    if (!this.prepareContext?.refreshResources) throw new Error('Resource preparation is unavailable');
    const checkpoint = await this.runtime.context(input.branchId, signal);
    if (!checkpoint || checkpoint.revision !== input.expectedRevision) {
      throw Object.assign(new Error('Resource checkpoint changed'), { code: 'thread-conflict' });
    }
    const context = await this.prepareContext.refreshResources(checkpoint, {
      ...(input.instructionDirectories ? { instructionDirectories: input.instructionDirectories } : {}),
      ...(input.supportingFiles ? { supportingFiles: input.supportingFiles } : {}),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    return this.runtime.refreshResources({ branchId: input.branchId, expectedRevision: input.expectedRevision, context }, signal);
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

  async contextHistory(identity: ThreadIdentity, runId: string, cursor?: { headId: string; beforeId: string }): Promise<ThreadHistoryPage> {
    const job = await this.requireContextJob(identity, runId);
    return this.readHistoryPage(job.receipt.branch_id, cursor);
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

  /** Cold calendar work is prepared by the same source/model/context owners as User submission.
   * Catalog supplies the occurrence identity and original instruction; this cannot forge User input. */
  async prepareCalendarWork(preparation: import('./protocol.generated.js').CalendarPreparation, projectPath: string, signal: AbortSignal) {
    const { occurrence, definition } = preparation;
    if (definition.target.kind !== 'new_work') throw new Error('Calendar work is not a cold submission');
    const identity: ThreadIdentity = { runtime: 'agent', threadId: occurrence.thread_id, branchId: occurrence.branch_id };
    await this.requireIdentity(identity);
    signal.throwIfAborted();
    // Only an explicit project source resolves the coordinator's project path. A
    // workspace selection retains its registered Host and namespace even offline.
    const selected = definition.target.source;
    const location = selected.kind === 'workspace' ? selected
      : await this.resolveSource(identity, { resourceOwner: { kind: 'local' }, path: projectPath }, signal);
    signal.throwIfAborted();
    const { source } = await this.prepareSource({ ...identity, key: occurrence.id, resourceOwner: location.resourceOwner,
      workspaceId: location.workspaceId, mode: definition.target.sourceMode, content: { mode: 'saved-files' }, captureScopes: [] }, signal);
    signal.throwIfAborted();
    await this.admitSource(source, identity, undefined, signal);
    signal.throwIfAborted();
    const model = await waitForModelBinding(this.models.resolveModel(definition.target.model as ThreadModel), model => model.credentialOwner.release(), signal);
    try {
      if (!this.prepareContext) throw new Error('Calendar context preparation is unavailable');
      // The calendar definition is the admitted project scope, independently of
      // where its files execute. The resource owner still prepares the actual view.
      const initialContext = await this.prepareContext(identity, source, {
        mode: 'agent', threadRole: 'main', projectId: definition.project_id,
      }, signal);
      const skill = await this.skillInput(identity, initialContext.resources, preparation.instruction, signal);
      const childDispatch = this.prepareChildProfiles ? await this.prepareChildProfiles({ projectId: definition.project_id, modelOwner: model.credentialOwner, parent: {
        configuration: model.configuration, credential_scope: await model.credentialOwner.scope(),
      } }, signal) : undefined;
      signal.throwIfAborted();
      const receipt = await this.runtime.admitCalendar({ occurrenceId: occurrence.id, expectedRevision: occurrence.revision,
        ownerEpoch: preparation.owner_epoch, configuration: model.configuration, initialContext,
        ...(skill ? { inputPreparation: { expectedContextCheckpoint: null, skill } } : {}),
        launch: { inheritSource: false, source: { resourceOwner: source.resourceOwner, workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId,
          branchId: source.branchId ?? null, revision: source.revision ?? null, mode: source.mode, liveRoot: source.liveRoot ?? null, ...(source.environmentRunId ? { environmentRunId: source.environmentRunId } : {}) },
          enabledTools: source.tools, credentialScope: await model.credentialOwner.scope(), ...(childDispatch ? { childDispatch } : {}) },
      }, signal);
      // Admission transfers ownership to the Run. Retiring this preparation must not
      // cancel its newly admitted launch; withRunPreparation owns actual Run/epoch stop.
      if (receipt.run_id) void this.continueLaunch(receipt.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
      return receipt;
    } finally { model.credentialOwner.release(); }
  }

  async submit(input: ThreadSubmit) {
    let admissionStarted = false;
    try {
      const thread = await this.requireIdentity(input);
      await this.refreshContext(input);
      if (input.source) await this.admitSource(input.source, input);
      const model = await this.models.resolveModel(input.model);
      try {
        this.assertImagesSupported(input.images, model.configuration);
        const command: InputSubmitParams = { key: input.key, threadId: input.threadId, branchId: input.branchId,
          expectedHead: input.expectedHead, input: await this.prepareInput(input), configuration: model.configuration,
          launch: { inheritSource: input.source === undefined, source: input.source ? {
            resourceOwner: input.source.resourceOwner, workspaceId: input.source.workspaceId, executionWorkspaceId: input.source.executionWorkspaceId,
            branchId: input.source.branchId ?? null, revision: input.source.revision ?? null, mode: input.source.mode, liveRoot: input.source.liveRoot ?? null, ...(input.source.environmentRunId ? { environmentRunId: input.source.environmentRunId } : {}),
          } : null, enabledTools: input.source?.tools ?? [], credentialScope: await model.credentialOwner.scope() },
        };
        let initialContext: InitialContext | undefined;
        const explicitSkill = parseExplicitSkillCommand(input.text) !== null;
        const checkpoint = this.prepareContext || explicitSkill ? await this.runtime.context(input.branchId) : null;
        const preparesResources = this.prepareContext && (input.source !== undefined || !checkpoint);
        let inputPreparation: InputResourcePreparation | undefined;
        if (preparesResources || explicitSkill || this.prepareChildProfiles) {
          // An accepted command owns its original receipt. A later malformed settings file must not
          // make an uncertain reply depend on re-preparing a replacement resource generation.
          const existing = await this.runtime.inputReceipt(command);
          if (existing) {
            admissionStarted = true;
            void this.continueLaunch(existing.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
            return existing;
          }
          try {
            if (this.prepareContext && checkpoint && input.source) {
              if (!this.prepareContext!.forSource) throw new Error('Resource source preparation is unavailable');
              initialContext = await this.prepareContext!.forSource(checkpoint, input.source);
              command.expectedContextCheckpoint = checkpoint.id;
            } else if (this.prepareContext && !checkpoint) {
              let source = input.source ?? null;
              if (!source) {
                const latest = thread.branches.find(branch => branch.branch_id === input.branchId)?.latest_run;
                const previous = latest ? await this.runtime.launch(latest.id) : null;
                const inherited = previous?.selection.source;
                if (inherited) {
                  const base = { resourceOwner: inherited.resource_owner, workspaceId: inherited.workspace_id, executionWorkspaceId: inherited.execution_workspace_id, tools: [] };
                  if (inherited.mode === 'live_root' && inherited.live_root) source = { ...base, mode: 'live_root', liveRoot: inherited.live_root };
                  else if (inherited.mode !== 'live_root' && inherited.branch_id && inherited.revision !== null) source = {
                    ...base, branchId: inherited.branch_id, revision: inherited.revision, mode: inherited.mode, ...(inherited.environment_run_id ? { environmentRunId: inherited.environment_run_id } : {}),
                  };
                }
              }
              initialContext = await this.prepareContext.main(input, source);
            }
            if (this.prepareChildProfiles) {
              command.launch!.childDispatch = await this.prepareChildProfiles({ projectId: (initialContext?.personalization ?? checkpoint?.personalization)?.projectId ?? null, modelOwner: model.credentialOwner, parent: {
                configuration: model.configuration, credential_scope: command.launch!.credentialScope ?? null,
              } });
            }
            const skill = await this.skillInput(input, initialContext ? initialContext.resources : checkpoint?.resources, input.text);
            if (skill) inputPreparation = { expectedContextCheckpoint: initialContext ? null : checkpoint?.id ?? null, skill };
          } catch (error) {
            // Another identical request can finish after the first read. Only its authoritative,
            // matching receipt recovers this failure; a miss leaves the preparation error visible.
            const accepted = await this.runtime.inputReceipt(command);
            if (!accepted) throw error;
            admissionStarted = true;
            void this.continueLaunch(accepted.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
            return accepted;
          }
        }
        // The same Rust transaction accepts input, a new or replaced resource context, and the
        // explicit source/credential/tool selection. A competing checkpoint leaves all of them unchanged.
        admissionStarted = true;
        const receipt = await this.runtime.submit({ ...command, ...(initialContext ? { initialContext } : {}), ...(inputPreparation ? { inputPreparation } : {}) });
        // The shared launch owner closes the initial context-refresh gap before preparation.
        void this.continueLaunch(receipt.run_id, { credentialOwner: model.credentialOwner }).catch(() => undefined);
        return receipt;
      } finally { model.credentialOwner.release(); }
    } catch (error) {
      if (!admissionStarted || error instanceof KernelRequestError && error.method === 'runtime.input.submit' && error.settlement === 'not_dispatched') {
        throw new ThreadPreAdmissionError(error, 'thread-request-failed');
      }
      throw error;
    }
  }

  async enqueue(input: ThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; materials?: ThreadMaterialAttachment[]; mode: InputMode }) {
    let admissionStarted = false;
    try {
      const thread = await this.requireIdentity(input);
      const branch = thread.branches.find(candidate => candidate.branch_id === input.branchId)!;
      const previousId = branch.active_run_id ?? branch.latest_run?.id;
      if (!previousId) throw new Error('An initial model selection is required');
      const selected = await this.runtime.modelSelections(previousId);
      const launch = await this.runtime.launch(previousId);
      const configuration = selected.desired?.configuration ?? selected.active?.configuration ?? branch.latest_run?.configuration;
      const scope = selected.desired?.credential_scope ?? selected.active?.credential_scope ?? launch?.selection.credential_scope;
      // Capture before run() can observe terminal state and retire the predecessor's registrations.
      const credentialOwner = configuration && scope ? this.runtime.retainedModelOwner(configuration as ModelSessionConfiguration, scope) : undefined;
      try {
        const previous = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : branch.latest_run;
        if (!previous) throw new Error('An initial model selection is required');
        this.assertImagesSupported(input.images, selected.desired?.configuration ?? previous.configuration);
        const command: InputEnqueueParams = { key: input.key, threadId: input.threadId, branchId: input.branchId,
          mode: input.mode, input: await this.prepareInput(input) };
        let inputPreparation: InputResourcePreparation | undefined;
        if (parseExplicitSkillCommand(input.text)) {
          const existing = await this.runtime.enqueueReceipt(command);
          if (existing) {
            admissionStarted = true;
            await this.continueQueuedLaunch(existing.run_id, previousId, credentialOwner);
            return existing;
          }
          try {
            const checkpoint = await this.runtime.context(input.branchId);
            const skill = await this.skillInput(input, checkpoint?.resources, input.text);
            if (skill) inputPreparation = { expectedContextCheckpoint: checkpoint?.id ?? null, skill };
          } catch (error) {
            const accepted = await this.runtime.enqueueReceipt(command);
            if (!accepted) throw error;
            admissionStarted = true;
            await this.continueQueuedLaunch(accepted.run_id, previousId, credentialOwner);
            return accepted;
          }
        }
        admissionStarted = true;
        const receipt = await this.runtime.enqueue({ ...command, ...(inputPreparation ? { inputPreparation } : {}) });
        // Context is synchronized by the Run's request preparation. An accepted input receipt
        // must not wait for extension/MCP startup, source materialization or credential rebinding.
        await this.continueQueuedLaunch(receipt.run_id, previousId, credentialOwner);
        return receipt;
      } finally { credentialOwner?.release(); }
    } catch (error) {
      if (!admissionStarted || error instanceof KernelRequestError && error.method === 'runtime.input.enqueue' && error.settlement === 'not_dispatched') {
        throw new ThreadPreAdmissionError(error, 'thread-request-failed');
      }
      throw error;
    }
  }

  private async continueQueuedLaunch(runId: string, previousRunId: string, inherited?: ExistingHostCredentialOwner): Promise<void> {
    let owner = inherited;
    try {
      if (runId !== previousRunId) {
        const run = await this.runtime.run(runId);
        if (['completed', 'failed', 'cancelled'].includes(run.state)) return;
        const launch = await this.runtime.launch(runId);
        const scope = launch?.selection.credential_scope;
        if (!scope) throw new Error('Queued Run has no durable credential binding');
        const configuration = run.configuration as ModelSessionConfiguration;
        if (!owner || owner.bindingIdentity !== modelCredentialBindingIdentity(configuration)) {
          owner = this.runtime.retainedModelOwner(configuration, scope) ?? await this.models.rebindModel(configuration, scope);
        }
        await this.runtime.retainQueuedModel(runId, owner);
        // Cancellation can win while the registration checks its captured scope.
        const retainedRun = await this.runtime.run(runId);
        if (['completed', 'failed', 'cancelled'].includes(retainedRun.state)) return;
      }
      void this.continueLaunch(runId, owner ? { credentialOwner: owner } : {}).catch(() => undefined);
    } catch (error) {
      // Native admission already succeeded. Preserve that receipt and expose preparation
      // failure on its original Run, rather than asking the caller to submit new input.
      await this.recordLaunchFailure(runId, error);
    } finally { if (owner !== inherited) owner?.release(); }
  }

  async mediaRead(identity: ThreadIdentity, request: Omit<MediaReadParams, 'threadId' | 'branchId'>, signal?: AbortSignal): Promise<MediaReadChunk> {
    await this.requireIdentity(identity, signal);
    return this.runtime.mediaRead({ ...request, threadId: identity.threadId, branchId: identity.branchId }, signal);
  }
  async editInput(inputId: string, expectedRevision: number, text: string, images?: ImageAttachment[], signal?: AbortSignal) {
    const queued = await this.requireInput(inputId);
    if (queued.state !== 'queued' || queued.revision !== expectedRevision) {
      throw Object.assign(new Error('Queued input changed'), { code: 'thread-conflict' });
    }
    if (images?.length) this.assertImagesSupported(images, (await this.requireRun(queued.run_id)).configuration);
    const existing = typeof queued.content === 'string' ? { text: queued.content }
      : queued.content as { text?: string; attachments?: unknown[] };
    // Text-only edits preserve accepted media; an explicit images array replaces/removes it.
    const content = images === undefined
      ? { text }
      : threadInput(text, images);
    if (!text.length && !(images === undefined ? existing.attachments?.length : images.length)) throw new Error('Text or images are required');
    let inputPreparation: InputResourcePreparation | undefined;
    if (text !== (existing.text ?? '') && parseExplicitSkillCommand(text)) {
      const checkpoint = await this.runtime.context(queued.branch_id, signal);
      const skill = await this.skillInput({ runtime: 'agent', threadId: queued.thread_id, branchId: queued.branch_id }, checkpoint?.resources, text, signal);
      if (skill) inputPreparation = { expectedContextCheckpoint: checkpoint?.id ?? null, skill };
    }
    signal?.throwIfAborted();
    // The input owner preserves old activation when raw text is unchanged and removes it when
    // the replacement is ordinary text. Body, media and activation share the same revision CAS.
    return this.runtime.editInput({ inputId, expectedRevision, content, ...(inputPreparation ? { inputPreparation } : {}) }, signal);
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
    try {
      const previous = await this.runtime.modelSelections(run.id);
      const existing = [previous.desired, previous.active].find(selection => selection?.binding_id === `model:${input.key}`);
      // The original candidate already froze its prepared profile catalog. Repeated key delivery
      // never makes that accepted selection depend on current settings.
      const childDispatch = !existing && this.prepareChildProfiles ? await this.prepareChildProfiles({ modelOwner: model.credentialOwner, parent: {
        configuration: model.configuration, credential_scope: await model.credentialOwner.scope(),
      } }) : undefined;
      return await this.runtime.selectModel(run.id, input.key, model.configuration, model.credentialOwner, undefined, childDispatch);
    } finally { model.credentialOwner.release(); }
  }

  assertImagesSupported(images: readonly ImageAttachment[] | undefined, configuration: unknown): void {
    if (images?.length && (configuration as { acceptsImages?: boolean }).acceptsImages === false) {
      throw Object.assign(new Error('Selected model does not accept images'), { code: 'model-images-unsupported' });
    }
  }

  async requireIdentity(identity: ThreadIdentity, signal?: AbortSignal) {
    this.assertIdentity(identity);
    const thread = await this.runtime.thread(identity.threadId, signal);
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

  private readonly historyModelPresentations = new Map<string, import('@varin/protocol').ModelPresentation>();

  private async readHistoryPage(branchId: string, cursor?: { headId: string; beforeId?: string }): Promise<ThreadHistoryPage> {
    const page = await this.runtime.historyPage({ branchId, ...cursor, limit: 20 });
    const items = await Promise.all(page.items.map(item => this.runtime.historyItem(item)));
    const requests = new Map<string, string>();
    for (const item of items) {
      if (item.source !== 'assistant') continue;
      const id = (item.content as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') continue;
      // Runtime model_history_id encodes the request's byte length before the provider item ID.
      const prefix = /^model-item:(\d+):/.exec(id);
      if (prefix) requests.set(item.id, Buffer.from(id.slice(prefix[0].length)).subarray(0, Number(prefix[1])).toString('utf8'));
    }
    const missing = [...new Set(requests.values())].filter(id => !this.historyModelPresentations.has(id));
    if (missing.length) for (const view of await this.runtime.modelPresentations(missing)) this.historyModelPresentations.set(view.requestId, view);
    return { head: page.head, previous: page.previous, items: items.map(item => {
      const requestId = requests.get(item.id);
      const modelRequest = requestId && this.historyModelPresentations.get(requestId);
      return modelRequest ? { ...item, modelRequest } : item;
    }) };
  }

  async snapshot(identity: ThreadIdentity): Promise<ThreadSnapshot> {
    const { eventCursor } = await this.runtime.status();
    const thread = await this.requireIdentity(identity);
    const branch = thread.branches.find(branch => branch.branch_id === identity.branchId)!;
    const [page, inputs, activeOperations, context, followups, goals, childState, delegatedExecutions] = await Promise.all([
      this.readHistoryPage(identity.branchId, branch.head ? { headId: branch.head } : undefined),
      this.runtime.inputs(identity.branchId), this.runtime.activeOperations(identity.threadId, identity.branchId), this.context(identity),
      listThreadFollowups(this, identity),
      listThreadGoals(this, identity),
      this.children(identity).then(async children => ({ children,
        executions: (await Promise.all(children.map(child => this.runtime.childExecutions(child.operation_id)))).flat() })),
      this.childExecutions(identity),
    ]);
    const childActivity: NonNullable<ThreadSnapshot['childActivity']> = {};
    const latestExecutions = new Map(childState.executions.map(execution => [execution.child_operation_id, execution]));
    await Promise.all([...latestExecutions.values()].filter(execution => execution.state === 'ready' && execution.receipt).map(async execution => {
      const runId = execution.receipt!.run_id;
      const [run, launch] = await Promise.all([this.runtime.run(runId), this.runtime.launch(runId)]);
      childActivity[execution.execution_id] = launch?.preparation_failure ? { state: 'preparation_failed', reason: launch.preparation_failure }
        : run.waiting_on?.startsWith('preparation:') ? { state: 'preparing' }
          : ['completed', 'failed', 'cancelled'].includes(run.state) ? { state: 'settling' }
            : run.state === 'waiting' && launch?.pause ? { state: 'waiting' } : { state: 'running' };
    }));
    const history = page.items;
    if (history.some(item => item.thread_id !== identity.threadId) || inputs.some(item => item.thread_id !== identity.threadId)) {
      throw new Error('Branch does not belong to the selected thread');
    }
    const operationIds = new Set<string>();
    const observerIds = new Set<string>();
    const effectful = (effect: unknown) => ['dispatched', 'partial', 'confirmed', 'unknown'].includes(String(effect));
    for (const item of history) {
      const conversation = item.content as {
        provenance?: { kind?: string; reference?: { action_id?: string; node_id?: string } };
        content?: { kind?: string; output?: { data?: { operationId?: unknown } };
          result?: { request_id?: string; call_id?: string; completion?: { kind?: string; operation_id?: string; effect?: string } } };
      };
      const result = conversation?.content?.kind === 'tool_result' ? conversation.content.result : undefined;
      const completion = result?.completion;
      if (completion?.kind === 'job_accepted' && typeof completion.operation_id === 'string') operationIds.add(completion.operation_id);
      if (completion?.kind === 'result' && effectful(completion.effect)
        && typeof result?.request_id === 'string' && typeof result.call_id === 'string') {
        const original = `${result.request_id}:tool:${result.call_id}`;
        operationIds.add(original); observerIds.add(original);
      }
      if (conversation.provenance?.kind === 'policy_tool_data' && conversation.content?.kind === 'output') {
        const reference = conversation.provenance.reference;
        if (typeof reference?.action_id === 'string' && typeof reference.node_id === 'string') {
          const original = `${reference.action_id}:node:${reference.node_id}`;
          if (conversation.content.output?.data?.operationId === original) {
            operationIds.add(original); observerIds.add(original);
          }
        }
      }
    }
    const operations = new Map(activeOperations.map(operation => [operation.id, operation]));
    const visible = await Promise.all([...operationIds].filter(id => !operations.has(id)).map(async id => {
      // Read-only policy evidence may have no durable Operation. Only a real missing row is optional.
      const operation = observerIds.has(id) ? await this.runtime.findOperation(id) : await this.runtime.operation(id);
      if (!operation || observerIds.has(id) && (!operation.mcp_resource_subscription || !effectful(operation.effect))) return null;
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
    const recovery = this.recoveryReader ? await this.recoveryReader(identity) : undefined;
    return { identity, ...(recovery ? { recovery } : {}), eventCursor, thread, activeRun, history, historyPage: { head: page.head, previous: page.previous }, inputs,
      operations: [...operations.values()], followups, goals, launch, modelSelection, policySelection, context,
      children: childState.children, childExecutions: childState.executions, childActivity, delegatedExecutions };
  }

  private async recordLaunchFailure(runId: string, error: unknown): Promise<void> {
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    const code = sourceFailureCode(error) ?? (['credential-scope-changed', 'model-configuration-changed'].includes(errorCode) ? 'binding_changed'
      : errorCode.startsWith('credential-') ? 'credentials_unavailable' : 'preparation_failed');
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
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Launch caller cancelled', 'AbortError'));
    const release = options.credentialOwner?.retain();
    let started = false;
    return this.launchAdmitted(runId, () => this.runtime.withRunPreparation(runId, options.signal, async signal => {
      started = true;
      try {
        signal.throwIfAborted();
        let launch = await this.runtime.launch(runId, signal);
        if (!launch?.startable || !launch.requires_rebind) return;
        const run = await this.runtime.run(runId, signal);
        if (!run.thread_id.startsWith('thread:') && !run.thread_id.startsWith('context-job-thread:')) throw new Error('Run is not owned by a thread');
        const identity: ThreadIdentity = { runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id };
        if (run.thread_id.startsWith('thread:')) await this.refreshContext(identity, signal);
        if (run.thread_id.startsWith('context-job-thread:')) {
          const job = await this.runtime.contextJob(runId, signal);
          if (job.compaction.kind === 'text') {
            // A frozen pure candidate has no model dispatch or credential dependency.
            await this.runtime.startRun(runId, signal);
            return;
          }
        }
        const source = launch.selection.source;
        if (source && source.mode !== 'live_root' && source.branch_id !== null && source.revision !== null) {
          const admission = this.admitSource({ resourceOwner: source.resource_owner, mode: source.mode, workspaceId: source.workspace_id,
            executionWorkspaceId: source.execution_workspace_id, branchId: source.branch_id, revision: source.revision, tools: [], ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}) }, identity, run.id, signal);
          await waitWithSignal(admission, signal);
        }
        // live_root is validated by rebindLaunch's existing LiveSource owner.
        const scope = launch.selection.credential_scope;
        if (!scope && !run.thread_id.startsWith('context-job-thread:')) throw new Error('Run has no durable credential binding; resubmit its original input key');
        let owner: ExistingHostCredentialOwner | undefined;
        let desiredOwner: ExistingHostCredentialOwner | undefined;
        try {
          const supplied = options.credentialOwner;
          const suppliedOwner = supplied && (supplied.bindingIdentity === undefined
            || supplied.bindingIdentity === modelCredentialBindingIdentity(run.configuration as ModelSessionConfiguration)) ? supplied : undefined;
          owner = suppliedOwner ?? (scope ? this.runtime.retainedModelOwner(run.configuration as ModelSessionConfiguration, scope)
            ?? await waitForModelBinding(this.models.rebindModel(run.configuration as ModelSessionConfiguration, scope), owner => owner.release(), signal) : undefined);
          const selected = await this.runtime.modelSelections(runId, signal);
          const desired = selected.desired;
          desiredOwner = desired?.credential_scope && desired.id !== selected.active?.id && desired.status !== 'failed'
            ? this.runtime.retainedModelOwner(desired.configuration, desired.credential_scope)
              ?? await waitForModelBinding(this.models.rebindModel(desired.configuration, desired.credential_scope), owner => owner.release(), signal) : undefined;
          signal?.throwIfAborted();
          launch = await this.runtime.launch(runId, signal);
          if (!launch?.startable || !launch.requires_rebind) return;
          // Replacing the actual registration may still fail during source preparation.
          // Keep the admitted implementation available to Retry until a new registration wins.
          if (owner?.bindingIdentity) await this.runtime.retainQueuedModel(runId, owner);
          if (desiredOwner?.bindingIdentity) await this.runtime.retainQueuedModel(runId, desiredOwner);
          if (owner?.bindingIdentity || desiredOwner?.bindingIdentity) {
            // A terminal event can precede the final asynchronous scope check above.
            const retainedRun = await this.runtime.run(runId);
            if (['completed', 'failed', 'cancelled'].includes(retainedRun.state)) return;
          }
          signal.throwIfAborted();
          this.runtime.releaseMainModelCredentials(runId, selected);
          if (desired && desiredOwner) {
            await this.runtime.selectModel(runId, desired.id, desired.configuration, desiredOwner, signal);
            this.runtime.releaseQueuedModel(runId, desiredOwner);
          }
          if (run.thread_id.startsWith('context-job-thread:')) {
            if (owner) await this.runtime.startRunWithCredentialOwner(runId, owner, signal);
            else await this.runtime.startRun(runId, signal);
          } else await this.runtime.rebindLaunch(runId, { ...(owner ? { credentialOwner: owner } : {}), signal });
          if (owner) this.runtime.releaseQueuedModel(runId, owner);
        } finally {
          if (owner !== options.credentialOwner) owner?.release();
          desiredOwner?.release();
        }
      } finally { release?.(); }
    }), options.signal, () => { if (!started) release?.(); });
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
