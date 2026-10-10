import type { PlanView, PlanForkCapture } from '@varin/protocol';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LiveSourceResolver } from './live-source.js';
import type { PolicyModelPreparer } from './policy-models.js';
import { waitWithSignal } from '../cancellation.js';
import type { AgentPolicyLease, AgentPolicyBinding, AgentPolicyArtifactBinding } from './agent-policy.js';
import type {
  HostToolLease,
  HostToolBinding,
  LiveHostToolBinding,
} from './tool-bridge.js';
import type {
  ExtensionToolPreparer,
  ExtensionToolScope,
  ExtensionToolLease,
} from './extension-tool-owner.js';
import type { LiveExtensionToolBinding } from './protocol.generated.js';
import type { McpCompositionSelection } from '@varin/pi-host/mcp-authority';
import { permissionService } from './permission-service.js';
import type {
  ContextJob,
  ContextCheckpoint,
  ThreadToolInspection, ThreadPolicyPreparation, ThreadPolicyInspection,
} from '@varin/application-client';
import {
  startRunFromSource,
  sourceToolSchemas,
  type SourceLaunch,
} from './source-launch.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { KernelClient } from './kernel-client.js';
import type {
  RunModelSelection,
  RunModelSelections,
  ModelSessionConfiguration,
} from './protocol.generated.js';
import type {
  AdmissionInspectParams,
  AdmissionInspection,
  ChildTextPage,
  UnacceptedChildSource,
  ChildTask,
  ChildPrepareParams,
  ChildSourceReadyParams, ChildSettleParams, ChildResultCandidateParams, ChildResultPublishedParams, HostToolReconcileParams,
  ChildWait,
  Followup,
  FollowupRegisterParams,
  FollowupControlParams,
  ContextRefreshParams,
  ResourceRefreshParams, ResourceSnapshotParams, ContextResources,
  ContextJobCreateParams,
  HistoryPage,
  HistoryPageParams,
  HistoryReference,
  HistoryBodyChunk,
  RunReconcileResult,
  ThreadSummary,
  LaunchIntent,
  LaunchSelectParams,
  InputSubmitParams,
  InputSubmitReceipt,
  Run,
  RunContextScope,
  Operation,
  HistoryItem,
  RuntimeEvent,
  RuntimeStatus,
  ContentCollectionReport,
  RunStartReceipt,
  PolicyResumeReceipt,
  PolicyModelCapability, PolicySelections, PolicySelection, PolicyTarget, PolicyStateMode,
  InputEnqueueParams,
  InputReceipt,
  QueuedInput,
  RunCancellationReceipt,
  OperationCancellationReceipt,
} from './protocol.generated.js';

export interface McpPreparation {
  runId: string;
  threadId: string;
  source: SourceLaunch | null;
  executionCwd?: string;
  requiredBinding?: McpCompositionSelection;
}
export interface RunPolicyScope { runId: string; threadId: string; projectId?: string }
export interface RunPolicyPreparer {
  prepare(input: RunPolicyScope & { requiredBinding?: AgentPolicyArtifactBinding }, signal?: AbortSignal): Promise<AgentPolicyLease | undefined>;
  observe(input: RunPolicyScope, changed: () => void, signal: AbortSignal): () => void;
}
interface PolicyPreparationAttempt { controller: AbortController; selectionId: string | null }
interface PolicyObservation { scope: RunPolicyScope; controller: AbortController; revision: number; pending?: PolicyPreparationAttempt | undefined; unobserve?: () => void; preparation: ThreadPolicyPreparation | null }
export type McpPreparer = (
  input: McpPreparation,
  signal?: AbortSignal,
) => Promise<HostToolLease | undefined>;

interface ToolCompositionState {
  mcp: LiveHostToolBinding | undefined;
  extensions: Map<string, LiveExtensionToolBinding>;
  scope?: ExtensionToolScope;
  controller: AbortController;
  revision: number;
  published: number;
  started: boolean;
  startReady: Promise<void>;
  wakeStart: () => void;
  closed: boolean;
  publishing?: Promise<void> | undefined;
}
/** Explicit authority client. Existing Pi thread routes are not silently redirected. */
export class AgentRuntimeClient {
  constructor(
    private readonly kernel: KernelClient,
    private readonly prepareMcpOwner?: McpPreparer,
    private readonly preparePolicyOwner?: RunPolicyPreparer,
    private readonly preparePolicyModels?: PolicyModelPreparer,
    private readonly resolveLiveSource?: LiveSourceResolver,
    private readonly prepareExtensionOwner?: ExtensionToolPreparer,
  ) {
    kernel.subscribeExit(() => {
      for (const runId of this.policyObservations.keys()) this.closePolicyObservation(runId);
      for (const run of this.toolCompositions.keys())
        this.releaseToolComposition(run);
      this.sourceGrants.clear();
      this.mcpPreparations.clear();
      for (const controller of this.mcpUpdates.values()) controller.abort();
      this.mcpUpdates.clear();
    });
    kernel.onToolReleased((runId) => {
      this.closePolicyObservation(runId);
      this.releaseToolComposition(runId);
      this.mcpPreparations.delete(runId);
      this.mcpUpdates.get(runId)?.abort();
      this.mcpUpdates.delete(runId);
    });
  }

  private readonly policyObservations = new Map<string, PolicyObservation>();
  private readonly toolCompositions = new Map<string, ToolCompositionState>();
  private toolComposition(runId: string): ToolCompositionState {
    let state = this.toolCompositions.get(runId);
    if (!state) {
      let wakeStart!: () => void;
      const startReady = new Promise<void>((resolve) => {
        wakeStart = resolve;
      });
      state = {
        mcp: this.kernel.mcpLiveBinding(runId),
        extensions: new Map(),
        controller: new AbortController(),
        revision: 0,
        published: 0,
        started: false,
        startReady,
        wakeStart,
        closed: false,
      };
      this.toolCompositions.set(runId, state);
    }
    return state;
  }
  private releaseToolComposition(runId: string): void {
    const state = this.toolCompositions.get(runId);
    if (!state) return;
    state.closed = true;
    state.controller.abort();
    state.scope?.close();
    this.toolCompositions.delete(runId);
    for (const live of state.extensions.values())
      this.kernel.discardExtensionTool(runId, live);
    if (state.mcp) this.kernel.discardMcpCandidate(runId, state.mcp);
  }
  /** Preparation is independent; only the short full-snapshot select/ready transaction is serialized. */
  private async publishToolComposition(
    runId: string,
    state: ToolCompositionState,
  ): Promise<void> {
    if (state.closed) return;
    // Only background contributions wait here. The initial Run starts with its already-ready
    // directory and wakes this same owner once its actual start RPC has been acknowledged.
    if (!state.started)
      await waitWithSignal(state.startReady, state.controller.signal);
    if (state.closed) return;
    if (state.publishing) return state.publishing;
    const work = (async () => {
      while (!state.closed && state.published !== state.revision) {
        const revision = state.revision,
          selectionId = randomUUID(),
          mcp = state.mcp,
          extensions = [...state.extensions.values()].sort((a, b) =>
            a.binding.providerKey.localeCompare(b.binding.providerKey),
          );
        await this.kernel.agentRuntimeRequest(
          'runtime.tools.select',
          { runId, selectionId },
          state.controller.signal,
        );
        const result = await this.kernel.agentRuntimeRequest<
          { ready: boolean },
          'runtime.tools.ready'
        >(
          'runtime.tools.ready',
          {
            runId,
            selectionId,
            ...(mcp ? { binding: mcp } : {}),
            extensionBindings: extensions,
          },
          state.controller.signal,
        );
        if (!result.ready) throw new Error('tool_composition_superseded');
        state.published = revision;
      }
    })();
    state.publishing = work;
    void work
      .finally(() => {
        if (state.publishing === work) state.publishing = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  private async prepareExtensions(
    runId: string,
    signal: AbortSignal,
  ): Promise<LiveExtensionToolBinding[]> {
    const state = this.toolComposition(runId);
    state.mcp = this.kernel.mcpLiveBinding(runId) ?? state.mcp;
    if (state.scope) return [...state.extensions.values()];
    const [run, launch] = await Promise.all([
      this.run(runId, signal),
      this.launch(runId, signal),
    ]);
    const required = launch?.selection.extension_bindings ?? [];
    if (!this.prepareExtensionOwner) {
      if (required.length)
        throw new Error(
          'Saved extension tools require their original Host owner',
        );
      return [];
    }
    if (await this.childForThread(run.thread_id, signal)) {
      if (required.length)
        throw new Error('Read-only child cannot acquire extension tools');
      return [];
    }
    const admittedScope = await this.kernel.agentRuntimeRequest<
      RunContextScope | null,
      'runtime.run.scope'
    >('runtime.run.scope', { runId }, signal);
    const projectId = admittedScope?.projectId;
    const scope = await this.prepareExtensionOwner(
      { runId, threadId: run.thread_id, ...(projectId ? { projectId } : {}) },
      required,
      AbortSignal.any([signal, state.controller.signal]),
    );
    if (state.closed) {
      scope.close();
      for (const e of scope.initial) e.lease.release();
      throw new Error('tool_composition_closed');
    }
    state.scope = scope;
    const initial: LiveExtensionToolBinding[] = [];
    const transferred = new Set<ExtensionToolLease>();
    try {
      for (const retained of scope.initial) {
        const live = await this.kernel.registerExtensionTool(runId, retained);
        transferred.add(retained);
        initial.push(live);
        state.extensions.set(
          `${live.binding.serviceId}@${live.binding.serviceVersion}`,
          live,
        );
      }
      if (initial.length)
        await this.kernel.agentRuntimeRequest(
          'runtime.launch.extensions.prepare',
          { runId, bindings: initial.map((e) => e.binding) },
          signal,
        );
      scope.start(async (key, retained, revoked) => {
        if (state.closed) {
          retained?.lease.release();
          return;
        }
        const selected = state.extensions.get(key);
        if (
          revoked &&
          (selected?.generation !== revoked.generation ||
            !isDeepStrictEqual(selected.binding, revoked.binding))
        )
          return;
        let live: LiveExtensionToolBinding | undefined;
        try {
          if (retained)
            live = await this.kernel.registerExtensionTool(runId, retained);
        } catch (error) {
          retained?.lease.release();
          throw error;
        }
        if (state.closed) {
          if (live) this.kernel.discardExtensionTool(runId, live);
          return;
        }
        const old = state.extensions.get(key);
        if (live) state.extensions.set(key, live);
        else state.extensions.delete(key);
        const revision = ++state.revision;
        try {
          await this.publishToolComposition(runId, state);
          if (old && old.ownerId !== live?.ownerId)
            this.kernel.discardExtensionTool(runId, old);
        } catch (error) {
          // A later snapshot may fail after this exact contribution was already accepted.
          if (state.published >= revision) {
            if (old && old.ownerId !== live?.ownerId)
              this.kernel.discardExtensionTool(runId, old);
            return;
          }
          if (state.extensions.get(key) === live) {
            if (old) state.extensions.set(key, old);
            else state.extensions.delete(key);
            state.revision++;
          }
          if (live && live.ownerId !== old?.ownerId)
            this.kernel.discardExtensionTool(runId, live);
          // tools.select withdrew the prior unactivated candidate. Restore the merged
          // valid snapshot now, without waiting for an unrelated provider notification.
          await this.publishToolComposition(runId, state).catch(
            () => undefined,
          );
          throw error;
        }
      });
      return initial;
    } catch (error) {
      this.releaseToolComposition(runId);
      throw error;
    } finally {
      for (const retained of scope.initial)
        if (!transferred.has(retained)) retained.lease.release();
    }
  }
  async inspectTools(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ThreadToolInspection> {
    const [launch, run] = await Promise.all([
      this.launch(runId, signal),
      this.run(runId, signal),
    ]);
    const active =
      this.kernel.isReady &&
      !!this.toolCompositions.get(runId) &&
      !['completed', 'failed', 'cancelled'].includes(run.state) &&
      !launch?.requires_rebind;
    const external = new Set([
      ...(launch?.selection.mcp_binding?.tools.map((t) => t.name) ?? []),
      ...(launch?.selection.extension_bindings.map((b) => b.tool.name) ?? []),
    ]);
    const callable = active
      ? (launch?.selection.tools ?? []).filter(
          (t) =>
            !external.has(t.name) ||
            this.kernel.toolAvailability(runId, t.name, t.version) === true,
        )
      : [];
    return {
      runId,
      generation: launch?.selection.tool_schema_generation ?? null,
      permission: 'checked_on_invocation' as const,
      callable,
      bindings: {
        mcp: launch?.selection.mcp_binding ?? null,
        extensions: launch?.selection.extension_bindings ?? [],
      },
      preparations: this.toolCompositions.get(runId)?.scope?.inspect() ?? [],
    };
  }
  private startedTools(runId: string): void {
    const state = this.toolCompositions.get(runId);
    if (!state) return;
    state.started = true;
    state.wakeStart();
  }

  private readonly sourceGrants = new Map<string, Set<string>>();
  private readonly mcpPreparations = new Map<string, McpPreparation>();
  private readonly mcpUpdates = new Map<string, AbortController>();
  retainSourceGrant(runId: string, grantId: string): void {
    const grants = this.sourceGrants.get(runId) ?? new Set<string>();
    grants.add(grantId);
    this.sourceGrants.set(runId, grants);
  }
  async releaseSourceGrant(runId: string, grantId: string): Promise<void> {
    await this.kernel.revokeGrant(grantId);
    const grants = this.sourceGrants.get(runId);
    grants?.delete(grantId);
    if (!grants?.size) this.sourceGrants.delete(runId);
  }
  async releaseSourceGrants(runId: string): Promise<void> {
    const grants = this.sourceGrants.get(runId);
    if (!grants) return;
    for (const grantId of grants) {
      await this.kernel.revokeGrant(grantId);
      grants.delete(grantId);
    }
    if (!grants.size) this.sourceGrants.delete(runId);
  }
  /** Host admission and nested resource assembly share the same Run/epoch cancellation owner. */
  async withRunPreparation<T>(
    runId: string,
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const registration = this.kernel.beginRunPreparation(runId);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, registration.signal])
      : registration.signal;
    try {
      signal.throwIfAborted();
      return await waitWithSignal(work(signal), signal);
    } finally {
      registration.release();
    }
  }

  onExit(listener: (error: Error) => void): () => void {
    return this.kernel.subscribeExit(listener);
  }
  onReady(listener: () => void): () => void {
    return this.kernel.subscribeReady(listener);
  }

  onEvent(
    listener: Parameters<KernelClient['onAgentRuntimeEvent']>[0],
  ): () => void {
    return this.kernel.onAgentRuntimeEvent(listener);
  }

  decidePermission(
    operationId: string,
    permissionId: string,
    decision: 'allow_once' | 'deny',
  ): Promise<Operation> {
    return permissionService(this.kernel).decide(
      operationId,
      permissionId,
      decision,
    );
  }
  answerQuestion(
    operationId: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<Operation> {
    return this.kernel.agentRuntimeRequest(
      'runtime.question.answer',
      { operationId, answer },
      signal,
    );
  }
  unacceptedChildSources(
    signal?: AbortSignal,
  ): Promise<UnacceptedChildSource[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.sources.pending',
      {},
      signal,
    );
  }
  releaseUnacceptedChildSource(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.sources.release',
      { operationId },
      signal,
    );
  }
  readChildReport(
    operationId: string,
    itemId: string,
    offset = 0,
    maxBytes = 65536,
    signal?: AbortSignal,
  ): Promise<ChildTextPage> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.report.read',
      { operationId, itemId, offset, maxBytes },
      signal,
    );
  }
  children(signal?: AbortSignal): Promise<ChildTask[]> {
    return this.kernel.agentRuntimeRequest('runtime.child.list', {}, signal);
  }
  child(operationId: string, signal?: AbortSignal): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.inspect',
      { operationId },
      signal,
    );
  }
  childForThread(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ChildTask | null> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.for_thread',
      { threadId },
      signal,
    );
  }
  reconcileHostTool(input: HostToolReconcileParams, signal?: AbortSignal): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest('runtime.host_tool.reconcile', input, signal);
  }
  readyChildSource(input: ChildSourceReadyParams, signal?: AbortSignal): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest('runtime.child.source.ready', input, signal);
  }
  settleChild(input: ChildSettleParams, signal?: AbortSignal): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest('runtime.child.settle', input, signal);
  }
  attachChildCandidate(input: ChildResultCandidateParams, signal?: AbortSignal): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest('runtime.child.result.candidate', input, signal);
  }
  attachChildResult(input: ChildResultPublishedParams, signal?: AbortSignal): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest('runtime.child.result.published', input, signal);
  }
  prepareChild(
    input: ChildPrepareParams,
    signal?: AbortSignal,
  ): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.prepare',
      input,
      signal,
    );
  }
  failChild(
    operationId: string,
    code:
      | 'preparation_failed'
      | 'source_unavailable'
      | 'credentials_unavailable'
      | 'binding_changed',
    signal?: AbortSignal,
  ): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.fail',
      { operationId, code },
      signal,
    );
  }
  async cancelChild(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ChildTask> {
    const child = await this.child(operationId, signal);
    if (child.receipt) this.kernel.cancelRunPreparation(child.receipt.run_id);
    return this.kernel.agentRuntimeRequest(
      'runtime.child.cancel',
      { operationId },
      signal,
    );
  }
  releaseChildResources(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ChildTask> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.release',
      { operationId },
      signal,
    );
  }
  reconcileProcessWaits(signal?: AbortSignal): Promise<string[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.process.wait.reconcile',
      {},
      signal,
    );
  }
  registerFollowup(input: FollowupRegisterParams, signal?: AbortSignal): Promise<Followup> {
    return this.kernel.agentRuntimeRequest('runtime.followup.register', input, signal);
  }
  followups(threadId: string, signal?: AbortSignal): Promise<Followup[]> {
    return this.kernel.agentRuntimeRequest('runtime.followup.list', { threadId }, signal);
  }
  controlFollowup(input: FollowupControlParams, signal?: AbortSignal): Promise<Followup> {
    return this.kernel.agentRuntimeRequest('runtime.followup.control', input, signal);
  }
  reconcileChildren(signal?: AbortSignal): Promise<string[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.reconcile',
      {},
      signal,
    );
  }
  cancelChildWait(waitId: string, signal?: AbortSignal): Promise<ChildWait> {
    return this.kernel.agentRuntimeRequest(
      'runtime.child.wait.cancel',
      { waitId },
      signal,
    );
  }
  status(signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.kernel.agentRuntimeRequest('runtime.status', {}, signal);
  }
  /** Explicit Host maintenance, independent of Run/input admission and Storage's own GC. */
  collectContent(signal?: AbortSignal): Promise<ContentCollectionReport> {
    return this.kernel.agentRuntimeRequest('runtime.content.collect', {}, signal);
  }
  /** Use the Run epoch and actual ModelStep/tool-call or policy-action/node identity. */
  admission(
    input: AdmissionInspectParams,
    signal?: AbortSignal,
  ): Promise<AdmissionInspection> {
    return this.kernel.agentRuntimeRequest(
      'runtime.admission.inspect',
      input,
      signal,
    );
  }
  thread(threadId: string, signal?: AbortSignal): Promise<ThreadSummary> {
    return this.kernel.agentRuntimeRequest(
      'runtime.thread.inspect',
      { threadId },
      signal,
    );
  }
  threads(signal?: AbortSignal): Promise<ThreadSummary[]> {
    return this.kernel.agentRuntimeRequest('runtime.thread.list', {}, signal);
  }
  createThread(
    threadId: string,
    branchId: string,
    signal?: AbortSignal,
  ): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.agentRuntimeRequest(
      'runtime.thread.create',
      { threadId, branchId },
      signal,
    );
  }
  forkBranch(
    sourceBranchId: string,
    branchId: string,
    headId: string | null,
    signal?: AbortSignal,
    planCapture?: PlanForkCapture,
  ): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.agentRuntimeRequest(
      'runtime.branch.fork',
      {
        sourceBranchId,
        branchId,
        headId,
        ...(planCapture === undefined ? {} : { planCapture }),
      },
      signal,
    );
  }
  planContains(
    branchId: string,
    headId: string | null,
    candidateHeadId: string | null,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<
    | { status: 'pending'; cursor: string }
    | { status: 'ready'; visible: boolean }
  > {
    return this.kernel.agentRuntimeRequest(
      'runtime.plan.contains',
      {
        branchId,
        headId,
        candidateHeadId,
        ...(cursor === undefined ? {} : { cursor }),
      },
      signal,
    );
  }
  planView(
    branchId: string,
    headId?: string | null,
    signal?: AbortSignal,
  ): Promise<PlanView> {
    return this.kernel.agentRuntimeRequest(
      'runtime.plan.view',
      { branchId, headId: headId ?? null, current: headId === undefined },
      signal,
    );
  }
  refreshResources(input: ResourceRefreshParams, signal?: AbortSignal): Promise<ContextCheckpoint> {
    return this.kernel.agentRuntimeRequest('runtime.resources.refresh', input, signal);
  }
  resourceSnapshot(input: ResourceSnapshotParams, signal?: AbortSignal): Promise<ContextResources> {
    return this.kernel.agentRuntimeRequest('runtime.resources.snapshot', input, signal);
  }
  refreshContext(
    input: ContextRefreshParams,
    signal?: AbortSignal,
  ): Promise<ContextCheckpoint> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context.refresh',
      input,
      signal,
    );
  }
  context(
    branchId: string,
    signal?: AbortSignal,
  ): Promise<ContextCheckpoint | null> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context.inspect',
      { branchId },
      signal,
    );
  }
  contextJobs(branchId: string, signal?: AbortSignal): Promise<ContextJob[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context_job.list',
      { branchId },
      signal,
    );
  }
  contextJob(runId: string, signal?: AbortSignal): Promise<ContextJob> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context_job.inspect',
      { runId },
      signal,
    );
  }
  createContextJob(
    input: ContextJobCreateParams,
    signal?: AbortSignal,
  ): Promise<ContextJob> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context_job.create',
      input,
      signal,
    );
  }
  publishContextJob(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ContextCheckpoint> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context_job.publish',
      { runId },
      signal,
    );
  }
  resumeContextJob(runId: string, signal?: AbortSignal): Promise<Run | null> {
    return this.kernel.agentRuntimeRequest(
      'runtime.context_job.resume',
      { runId },
      signal,
    );
  }
  inputReceipt(input: InputSubmitParams, signal?: AbortSignal): Promise<InputSubmitReceipt | null> {
    return this.kernel.agentRuntimeRequest('runtime.input.receipt', input, signal);
  }
  submit(
    input: InputSubmitParams,
    signal?: AbortSignal,
  ): Promise<InputSubmitReceipt> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.submit',
      input,
      signal,
    );
  }
  enqueue(
    input: InputEnqueueParams,
    signal?: AbortSignal,
  ): Promise<InputReceipt> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.enqueue',
      input,
      signal,
    );
  }
  editInput(
    inputId: string,
    expectedRevision: number,
    content: unknown,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.edit',
      { inputId, expectedRevision, content },
      signal,
    );
  }
  cancelInput(
    inputId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.cancel',
      { inputId, expectedRevision },
      signal,
    );
  }
  input(inputId: string, signal?: AbortSignal): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.inspect',
      { inputId },
      signal,
    );
  }
  inputs(branchId: string, signal?: AbortSignal): Promise<QueuedInput[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.input.list',
      { branchId },
      signal,
    );
  }
  reconcilePlan(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest(
      'runtime.plan.reconcile',
      { runId },
      signal,
    );
  }
  reconcileMemory(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest(
      'runtime.memory.reconcile',
      { runId },
      signal,
    );
  }
  reconcileRun(
    runId: string,
    toolBinding: unknown,
    signal?: AbortSignal,
  ): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest(
      'runtime.run.reconcile',
      { runId, toolBinding },
      signal,
    );
  }
  failLaunch(
    runId: string,
    code:
      | 'preparation_failed'
      | 'source_unavailable'
      | 'credentials_unavailable'
      | 'binding_changed',
    signal?: AbortSignal,
  ): Promise<LaunchIntent> {
    return this.kernel.agentRuntimeRequest(
      'runtime.launch.fail',
      { runId, code },
      signal,
    );
  }
  selectLaunch(
    params: LaunchSelectParams,
    signal?: AbortSignal,
  ): Promise<LaunchIntent> {
    return this.kernel.agentRuntimeRequest(
      'runtime.launch.select',
      params,
      signal,
    );
  }
  /** Slow connection/schema preparation happens after input admission, before the first model request. */
  async prepareMcp(
    runId: string,
    source: SourceLaunch | null,
    executionCwd?: string,
    signal?: AbortSignal,
  ): Promise<HostToolBinding | undefined> {
    return this.withRunPreparation(runId, signal, async (signal) => {
      const existing = this.kernel.mcpBinding(runId);
      if (existing) return existing;
      const saved = await this.launch(runId, signal);
      const run = await this.run(runId, signal);
      if (await this.childForThread(run.thread_id, signal)) {
        if (saved?.selection.mcp_binding)
          throw new Error('Read-only child cannot acquire MCP capabilities');
        return undefined;
      }
      if (!this.prepareMcpOwner) {
        if (saved?.selection.mcp_binding)
          throw new Error(
            'Saved MCP capabilities require their original Host owner',
          );
        return undefined;
      }

      const input = {
        runId,
        threadId: run.thread_id,
        source,
        ...(executionCwd ? { executionCwd } : {}),
      };
      this.mcpPreparations.set(runId, input);
      const preparation = this.prepareMcpOwner(
        {
          ...input,
          ...(saved?.selection.mcp_binding
            ? { requiredBinding: saved.selection.mcp_binding }
            : {}),
        },
        signal,
      );
      void preparation.then(
        (lease) => {
          if (signal.aborted) lease?.release();
        },
        () => undefined,
      );
      const lease = await waitWithSignal(preparation, signal);
      if (!lease || lease.binding.tools.length === 0) {
        lease?.release();
        if (saved?.selection.mcp_binding)
          throw new Error('Saved MCP capabilities are unavailable');
        return undefined;
      }
      try {
        signal?.throwIfAborted();
        await this.kernel.agentRuntimeRequest(
          'runtime.launch.mcp.prepare',
          { runId, binding: lease.binding },
          signal,
        );
        return await this.kernel.registerMcpOwner(runId, lease);
      } catch (error) {
        lease.release();
        throw error;
      }
    });
  }
  /** Called by the actual MCP scope's configuration/tool events, never by each model request. */
  async refreshMcp(runId: string): Promise<void> {
    const input = this.mcpPreparations.get(runId);
    if (!input || !this.prepareMcpOwner) return;
    const controller = new AbortController();
    this.mcpUpdates.get(runId)?.abort();
    this.mcpUpdates.set(runId, controller);
    try {
      await this.withRunPreparation(
        runId,
        controller.signal,
        async (signal) => {
          const work = this.prepareMcpOwner!(input, signal);
          void work.then(
            (lease) => {
              if (signal.aborted) lease?.release();
            },
            () => undefined,
          );
          const lease = await waitWithSignal(work, signal),
            state = this.toolComposition(runId);
          if (state.closed) {
            lease?.release();
            return;
          }
          if (
            isDeepStrictEqual(lease?.binding, state.mcp?.binding) &&
            lease?.implementationIdentity ===
              this.kernel.mcpImplementationIdentity(runId)
          ) {
            lease?.release();
            return;
          }
          let retained: LiveHostToolBinding | undefined;
          try {
            if (lease && lease.binding.tools.length)
              retained = await this.kernel.registerMcpCandidate(runId, lease);
            else lease?.release();
          } catch (error) {
            lease?.release();
            throw error;
          }
          if (signal.aborted || state.closed) {
            if (retained) this.kernel.discardMcpCandidate(runId, retained);
            return;
          }
          const old = state.mcp;
          state.mcp = retained;
          const revision = ++state.revision;
          try {
            await this.publishToolComposition(runId, state);
            if (old && old.ownerId !== retained?.ownerId)
              this.kernel.discardMcpCandidate(runId, old);
          } catch (error) {
            if (state.published >= revision) {
              if (old && old.ownerId !== retained?.ownerId)
                this.kernel.discardMcpCandidate(runId, old);
              return;
            }
            if (state.mcp === retained) {
              state.mcp = old;
              state.revision++;
            }
            if (retained && retained.ownerId !== old?.ownerId)
              this.kernel.discardMcpCandidate(runId, retained);
            await this.publishToolComposition(runId, state).catch(
              () => undefined,
            );
            throw error;
          }
        },
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.mcpUpdates.get(runId) === controller)
        this.mcpUpdates.delete(runId);
    }
  }
  startFromSource(
    selection: SourceLaunch,
    options: {
      credentialOwner?: ExistingHostCredentialOwner;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunStartReceipt> {
    return this.withRunPreparation(selection.runId, options.signal, (signal) =>
      startRunFromSource(this.kernel, this, selection, {
        ...options,
        signal,
        ...(this.resolveLiveSource
          ? { resolveLiveSource: this.resolveLiveSource }
          : {}),
      }),
    );
  }
  /** Reacquire fresh authority from a saved selection; unresolved model/effect waits still reject start. */
  async rebindLaunch(
    runId: string,
    options: {
      credentialOwner?: ExistingHostCredentialOwner;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, options.signal, async (signal) => {
      options = { ...options, signal };
      const launch = await this.launch(runId, options.signal);
      if (!launch) throw new Error('Run has no durable launch selection');
      const source = launch.selection.source;
      if (!source) {
        if (sourceToolSchemas(launch.selection).length)
          throw new Error(
            'Saved tools require an explicit Host resource rebind',
          );
        await this.prepareMcp(runId, null, undefined, options.signal);
        return options.credentialOwner
          ? this.startRunWithCredentialOwner(
              runId,
              options.credentialOwner,
              options.signal,
            )
          : this.startRun(runId, options.signal);
      }

      const names = {
        file_read: 'file_read',
        file_list: 'file_list',
        file_search: 'file_search',
        file_write: 'file_write',
        file_edit: 'file_edit',
        process_inspect: 'process_inspect',
        process_read: 'process_read',
        process_spawn: 'process_spawn',
        language_definition: 'language_definition',
        language_references: 'language_references',
        language_diagnostics: 'language_diagnostics',
        code_retrieval: 'code_retrieval',
      } as const;
      const tools = sourceToolSchemas(launch.selection).map((tool) => {
        if (!(tool.name in names))
          throw new Error(
            'Saved capability requires its original extension owner',
          );
        return names[tool.name as keyof typeof names];
      });
      return this.startFromSource(
        this.sourceLaunch(runId, source, tools),
        options,
      );
    });
  }
  /** Carry a thread's actual materialized environment into an admitted successor Run. */
  async continueFromLaunch(
    previousRunId: string,
    runId: string,
    options: {
      credentialOwner?: ExistingHostCredentialOwner;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, options.signal, async (signal) => {
      options = { ...options, signal };
      const previous = await this.launch(previousRunId, options.signal);
      if (!previous)
        throw new Error('Previous Run has no source launch selection');
      if (previous.selection.credential_scope) {
        if (!options.credentialOwner)
          throw new Error(
            'Continuation requires the selected credential owner',
          );
        const actual = await options.credentialOwner.scope();
        const expected = previous.selection.credential_scope;
        if (
          actual.reference !== expected.reference ||
          actual.authority !== expected.authority ||
          actual.account !== expected.account ||
          actual.generation !== expected.generation
        )
          throw new Error('Continuation credential selection changed');
      }
      const source = previous.selection.source;
      if (!source) {
        const credentialScope = options.credentialOwner
          ? await options.credentialOwner.scope()
          : undefined;
        await this.selectLaunch(
          {
            runId,
            source: null,
            enabledTools: [],
            ...(credentialScope ? { credentialScope } : {}),
          },
          options.signal,
        );
        await this.prepareMcp(runId, null, undefined, options.signal);
        return options.credentialOwner
          ? this.startRunWithCredentialOwner(
              runId,
              options.credentialOwner,
              options.signal,
            )
          : this.startRun(runId, options.signal);
      }

      const names = {
        file_read: 'file_read',
        file_list: 'file_list',
        file_search: 'file_search',
        file_write: 'file_write',
        file_edit: 'file_edit',
        process_inspect: 'process_inspect',
        process_read: 'process_read',
        process_spawn: 'process_spawn',
        language_definition: 'language_definition',
        language_references: 'language_references',
        language_diagnostics: 'language_diagnostics',
        code_retrieval: 'code_retrieval',
      } as const;
      const tools = sourceToolSchemas(previous.selection).map((tool) => {
        if (!(tool.name in names))
          throw new Error(
            'Saved capability requires its original extension owner',
          );
        return names[tool.name as keyof typeof names];
      });
      return this.startFromSource(
        this.sourceLaunch(runId, source, tools, previousRunId),
        options,
      );
    });
  }
  private sourceLaunch(
    runId: string,
    source: NonNullable<LaunchIntent['selection']['source']>,
    tools: SourceLaunch['tools'],
    previousRunId?: string,
  ): SourceLaunch {
    const base = {
      runId,
      workspaceId: source.workspace_id,
      executionWorkspaceId: source.execution_workspace_id,
      tools,
    };
    if (source.mode === 'live_root') {
      if (
        !source.live_root ||
        source.branch_id !== null ||
        source.revision !== null ||
        source.environment_run_id
      )
        throw new Error('Saved live environment is incomplete');
      return { ...base, mode: 'live_root', liveRoot: source.live_root };
    }
    if (
      source.branch_id === null ||
      source.revision === null ||
      source.live_root
    )
      throw new Error('Saved fixed environment is incomplete');
    const environmentRunId = source.environment_run_id ?? previousRunId;
    return {
      ...base,
      mode: source.mode,
      branchId: source.branch_id,
      revision: source.revision,
      ...(source.mode === 'materialized' && environmentRunId
        ? { environmentRunId }
        : {}),
    };
  }
  launch(runId: string, signal?: AbortSignal): Promise<LaunchIntent | null> {
    return this.kernel.agentRuntimeRequest(
      'runtime.launch.inspect',
      { runId },
      signal,
    );
  }
  pendingLaunches(signal?: AbortSignal): Promise<LaunchIntent[]> {
    return this.kernel.agentRuntimeRequest('runtime.launch.list', {}, signal);
  }
  async inspectPolicy(runId: string, signal?: AbortSignal): Promise<ThreadPolicyInspection> {
    return { ...await this.policySelections(runId, signal), preparation: structuredClone(this.policyObservations.get(runId)?.preparation ?? null) };
  }
  policySelections(runId: string, signal?: AbortSignal): Promise<PolicySelections> {
    return this.kernel.agentRuntimeRequest('runtime.policy.inspect', { runId }, signal);
  }
  private closePolicyObservation(runId: string): void {
    const state = this.policyObservations.get(runId);
    if (!state) return;
    this.policyObservations.delete(runId);
    state.controller.abort(); state.pending?.controller.abort(); state.unobserve?.();
  }
  private async policyScope(runId: string, threadId: string, signal?: AbortSignal): Promise<RunPolicyScope> {
    const admitted = await this.kernel.agentRuntimeRequest<RunContextScope | null, 'runtime.run.scope'>('runtime.run.scope', { runId }, signal);
    return { runId, threadId, ...(admitted?.projectId ? { projectId: admitted.projectId } : {}) };
  }
  private observePolicy(scope: RunPolicyScope): void {
    if (!this.preparePolicyOwner) return;
    const state = this.policyObservations.get(scope.runId) ?? { controller: new AbortController(), scope, revision: 0, preparation: null };
    if (state.unobserve) return;
    this.policyObservations.set(scope.runId, state);
    let initial = true;
    state.unobserve = this.preparePolicyOwner.observe(scope, () => {
      const first = initial; initial = false;
      void this.refreshPolicy(scope.runId, first).catch(() => undefined);
    }, state.controller.signal);
  }
  private async preparePolicyCredentials(runId: string, threadId: string, generation: number, lease: AgentPolicyLease,
    signal: AbortSignal, savedCapabilities?: readonly PolicyModelCapability[]): Promise<{ lease: AgentPolicyLease; models: PolicyModelCapability[] }> {
    const roles = lease.binding.artifact.modelRoles;
    if (roles.length && !this.preparePolicyModels) throw new Error('Planning model preparation is unavailable');
    const prepared = this.preparePolicyModels ? await waitWithSignal(this.preparePolicyModels({ threadId, generation,
      requestedModelRoles: roles, ...(savedCapabilities === undefined ? {} : { savedCapabilities }) }, signal), signal) : [];
    const registered: Array<{ bindingId: string; epoch: string | null }> = [];
    const releaseCredentials = () => {
      for (const entry of registered) if (this.kernel.kernelEpoch === entry.epoch) this.kernel.unregisterCredentialOwner(runId, entry.bindingId);
    };
    try {
      for (const entry of prepared) {
        if (entry.capability.status !== 'available') continue;
        const bindingId = entry.capability.binding_id;
        if (!entry.credentialOwner || !bindingId) throw new Error('Planning credential owner is missing');
        const scope = await this.kernel.registerCredentialOwner(runId, entry.credentialOwner, signal, bindingId);
        registered.push({ bindingId, epoch: this.kernel.kernelEpoch });
        if (!isDeepStrictEqual(scope, entry.capability.credential_scope)) throw new Error('Planning credential scope changed');
      }
      let released = false;
      return { models: prepared.map(entry => ({ ...entry.capability, binding: null })), lease: { ...lease,
        release: () => {
          if (released) return;
          released = true;
          releaseCredentials();
          lease.release();
        } } };
    } catch (error) {
      releaseCredentials();
      throw error;
    }
  }
  /** Routing updates prepare independently. Only Catalog's closed-boundary commit activates them. */
  async refreshPolicy(runId: string, initialObservation = false): Promise<PolicySelections> {
    const state = this.policyObservations.get(runId);
    if (!state || !this.preparePolicyOwner) return this.policySelections(runId);
    const revision = ++state.revision;
    state.pending?.controller.abort();
    const controller = new AbortController(), attempt: PolicyPreparationAttempt = { controller, selectionId: null }; state.pending = attempt;
    const signal = AbortSignal.any([state.controller.signal, controller.signal]);
    let lease: AgentPolicyLease | undefined;
    state.preparation = { status: 'preparing', code: null };
    try {
      lease = await this.preparePolicyLease(state.scope, signal);
      const target: PolicyTarget = lease ? { kind: 'extension', artifact: lease.binding.artifact } : { kind: 'default' };
      const selected = await this.policySelections(runId, signal);
      if (isDeepStrictEqual(target, selected.active.target)) {
        // A route returning to the active owner withdraws the older unactivated candidate.
        if (selected.desired && ['preparing', 'ready'].includes(selected.desired.status)
          && !isDeepStrictEqual(selected.desired.target, target)) {
          const cancelled = await this.kernel.agentRuntimeRequest<PolicySelection, 'runtime.policy.cancel'>('runtime.policy.cancel',
            { runId, selectionId: selected.desired.selection_id }, signal, { settleCancellation: true });
          if (cancelled.status === 'cancelled') this.kernel.unregisterPolicyOwner(runId, cancelled.generation);
          return this.policySelections(runId, signal);
        }
        return selected;
      }
      const desired = selected.desired;
      if (desired && isDeepStrictEqual(target, desired.target)) {
        if (['preparing', 'ready'].includes(desired.status)) return selected;
        if (initialObservation && (desired.status === 'cancelled' || desired.failure === 'policy_state_incompatible')) return selected;
      }
      if (state.revision !== revision) throw new Error('policy_preparation_superseded');
      const transferred = lease; lease = undefined;
      await this.publishPolicyCandidate(state.scope, selected.active.generation, selected.desired?.selection_id ?? null, target, 'preserve', transferred, signal, attempt);
      return this.policySelections(runId, signal);
    } catch (error) {
      if (state.revision === revision && !state.controller.signal.aborted && !controller.signal.aborted) {
        const code = error && typeof error === 'object' && 'code' in error && error.code === 'selected_unavailable' ? 'policy_route_unavailable' : 'policy_preparation_failed';
        state.preparation = { status: 'failed', code };
      }
      throw error;
    } finally {
      lease?.release();
      if (state.pending === attempt) {
        state.pending = undefined;
        if (state.preparation?.status === 'preparing') state.preparation = null;
      }
    }
  }
  private async preparePolicyLease(scope: RunPolicyScope & { requiredBinding?: AgentPolicyArtifactBinding }, signal: AbortSignal): Promise<AgentPolicyLease | undefined> {
    if (!this.preparePolicyOwner) {
      if (scope.requiredBinding) throw new Error('Saved policy requires its exact original artifact and configuration');
      return undefined;
    }
    const pending = this.preparePolicyOwner.prepare(scope, signal);
    void pending.then(lease => { if (signal.aborted) lease?.release(); }, () => undefined);
    return waitWithSignal(pending, signal);
  }
  private async publishPolicyCandidate(scope: RunPolicyScope, expectedGeneration: number, expectedSelectionId: string | null, target: PolicyTarget,
    stateMode: PolicyStateMode, preparedLease: AgentPolicyLease | undefined, signal: AbortSignal, attempt: PolicyPreparationAttempt): Promise<PolicySelection> {
    const runId = scope.runId, selectionId = randomUUID();
    let lease = preparedLease, registered = false, selected: PolicySelection | undefined;
    try {
      selected = await this.kernel.agentRuntimeRequest<PolicySelection, 'runtime.policy.select'>('runtime.policy.select',
        { runId, selectionId, expectedGeneration, expectedSelectionId, target, stateMode }, signal, { settleCancellation: true });
      attempt.selectionId = selected.selection_id;
      signal.throwIfAborted();
      if (target.kind === 'extension' && !lease) lease = await this.preparePolicyLease({ ...scope, requiredBinding: target.artifact }, signal);
      if (target.kind === 'extension' && (!lease || !isDeepStrictEqual(lease.binding.artifact, target.artifact))) throw new Error('policy_exact_binding_unavailable');
      let binding: AgentPolicyBinding | null = null, models: PolicyModelCapability[] = [];
      if (lease) {
        const prepared = await this.preparePolicyCredentials(runId, scope.threadId, selected.generation, lease, signal);
        lease = prepared.lease; models = prepared.models;
        signal.throwIfAborted();
        const retained = lease;
        const revoked = () => {
          // The bridge first rejects this generation's pending callbacks and drops its holder.
          // Notify Catalog afterward; a synchronous control reply must not suppress that rejection.
          void Promise.resolve().then(() => this.kernel.agentRuntimeRequest('runtime.policy.fail',
            { runId, selectionId, code: 'policy_binding_revoked' })).catch(() => undefined);
        };
        lease = { ...retained, release: () => { retained.revocationSignal.removeEventListener('abort', revoked); retained.release(); } };
        retained.revocationSignal.addEventListener('abort', revoked, { once: true });
        if (retained.revocationSignal.aborted) throw new Error('policy_binding_revoked');
        binding = await this.kernel.registerPolicyOwner(runId, selected.generation, lease);
        registered = true; lease = undefined;
      }
      signal.throwIfAborted();
      return await this.kernel.agentRuntimeRequest<PolicySelection, 'runtime.policy.ready'>('runtime.policy.ready',
        { runId, selectionId, generation: selected.generation, binding, policyModels: models }, signal, { settleCancellation: true });
    } catch (error) {
      if (selected) {
        // A lost ready reply may follow committed activation. Inspect before disposing its live owner.
        const current = await this.policySelections(runId).catch(() => undefined);
        const retained = current?.active.generation === selected.generation
          || current?.desired?.selection_id === selectionId && current.desired.status === 'ready';
        if (retained && current) {
          if (current.desired?.selection_id === selectionId) return current.desired;
          // An even newer desired selection does not erase this command's committed receipt.
          return await this.kernel.agentRuntimeRequest<PolicySelection, 'runtime.policy.select'>('runtime.policy.select',
            { runId, selectionId, expectedGeneration, expectedSelectionId, target, stateMode });
        }
        if (current) {
          await this.kernel.agentRuntimeRequest('runtime.policy.fail', { runId, selectionId,
            code: signal.aborted ? 'policy_preparation_cancelled' : 'policy_preparation_failed' }).catch(() => undefined);
          if (registered) this.kernel.unregisterPolicyOwner(runId, selected.generation);
        }
      }
      throw error;
    } finally { lease?.release(); }
  }
  async restartPolicy(runId: string, selectionId: string, signal?: AbortSignal): Promise<PolicySelection> {
    const run = await this.run(runId, signal), selected = await this.policySelections(runId, signal);
    if (!selected.desired || selected.desired.selection_id !== selectionId || selected.desired.status === 'active'
      || selected.desired.status === 'cancelled' || selected.desired.status === 'superseded') throw new Error('policy_selection_changed');
    const scope = await this.policyScope(runId, run.thread_id, signal);
    const state: PolicyObservation = this.policyObservations.get(runId) ?? { controller: new AbortController(), scope, revision: 0, preparation: null };
    this.policyObservations.set(runId, state);
    state.pending?.controller.abort();
    const controller = new AbortController(), attempt: PolicyPreparationAttempt = { controller, selectionId: null }; state.pending = attempt;
    const revision = ++state.revision;
    state.preparation = { status: 'preparing', code: null };
    const preparation = this.kernel.beginRunPreparation(runId);
    const combined = AbortSignal.any([preparation.signal, controller.signal, state.controller.signal, ...(signal ? [signal] : [])]);
    try {
      // The displayed exact target is retained even if current routing changed in the meantime.
      const check = await this.policySelections(runId, combined);
      if (check.desired?.selection_id !== selectionId || check.active.generation !== selected.active.generation) throw new Error('policy_selection_changed');
      return await this.publishPolicyCandidate(scope, selected.active.generation, selectionId, selected.desired.target, 'restart_state', undefined, combined, attempt);
    } catch (error) {
      if (state.revision === revision && !combined.aborted) state.preparation = { status: 'failed', code: 'policy_preparation_failed' };
      throw error;
    } finally {
      preparation.release();
      if (state.pending === attempt) { state.pending = undefined; if (state.preparation?.status === 'preparing') state.preparation = null; }
    }
  }
  async cancelPolicyUpdate(runId: string, selectionId: string, signal?: AbortSignal): Promise<PolicySelection> {
    const pending = this.policyObservations.get(runId)?.pending;
    const original = pending?.selectionId === selectionId ? pending : undefined;
    const current = await this.policySelections(runId, signal);
    if (current.desired?.selection_id !== selectionId) throw new Error('policy_selection_changed');
    const selection = await this.kernel.agentRuntimeRequest<PolicySelection, 'runtime.policy.cancel'>('runtime.policy.cancel', { runId, selectionId }, signal, { settleCancellation: true });
    if (selection.status === 'cancelled') {
      original?.controller.abort();
      this.kernel.unregisterPolicyOwner(runId, selection.generation);
    }
    return selection;
  }
  /** Restore committed identity first; current routing only prepares a later candidate. */
  async preparePolicy(runId: string, signal?: AbortSignal,
    credentialScope?: Awaited<ReturnType<ExistingHostCredentialOwner['scope']>>): Promise<AgentPolicyBinding | undefined> {
    const preparation = this.kernel.beginRunPreparation(runId);
    signal = signal ? AbortSignal.any([signal, preparation.signal]) : preparation.signal;
    let lease: AgentPolicyLease | undefined;
    try {
      const run = await this.run(runId, signal);
      if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error('Run is no longer eligible for policy preparation');
      let saved = await this.launch(runId, signal);
      if (saved?.selection.policy.name === 'context_compaction' || await this.childForThread(run.thread_id, signal)) return undefined;
      const generation = saved?.policy_generation ?? 0;
      const existing = this.kernel.policyBinding(runId, generation);
      if (existing) return existing;
      const required = saved?.policy_target.kind === 'extension' ? saved.policy_target.artifact : undefined;
      if (!this.preparePolicyOwner) {
        if (required) throw new Error('Saved policy requires its exact original artifact and configuration');
        return undefined;
      }
      const scope = await this.policyScope(runId, run.thread_id, signal);
      // Catalog projects the exact first-preparation admission predicate. Used defaults stay
      // defaults until the same replacement protocol commits a new generation.
      const first = !saved || saved.policy_preparable;
      if (!required && !first) { this.observePolicy(scope); return undefined; }
      lease = await this.preparePolicyLease({ ...scope, ...(required ? { requiredBinding: required } : {}) }, signal);
      if (!lease) {
        if (required) throw new Error('Saved policy is unavailable');
        this.observePolicy(scope); return undefined;
      }
      if (!saved) saved = await this.selectLaunch({ runId, source: null, enabledTools: [], ...(credentialScope ? { credentialScope } : {}) }, signal);
      const prepared = await this.preparePolicyCredentials(runId, run.thread_id, generation, lease, signal,
        required ? saved.selection.policy_models : undefined);
      lease = prepared.lease;
      await this.kernel.agentRuntimeRequest('runtime.launch.policy.prepare', { runId, identity: lease.binding.artifact.identity,
        target: { kind: 'extension', artifact: lease.binding.artifact }, policyModels: prepared.models }, signal);
      signal.throwIfAborted();
      const binding = await this.kernel.registerPolicyOwner(runId, generation, lease);
      lease = undefined;
      this.observePolicy(scope);
      return binding;
    } finally { lease?.release(); preparation.release(); }
  }

  async startRun(
    runId: string,
    signal?: AbortSignal,
    toolBinding?: unknown,
  ): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, signal, async (signal) => {
      const policyBinding = await this.preparePolicy(runId, signal);
      const mcpBinding = this.kernel.mcpLiveBinding(runId);
      const extensionBindings = await this.prepareExtensions(runId, signal);
      try {
        await this.reconcileMemory(runId, signal);
        await this.reconcilePlan(runId, signal);
        const receipt = await this.kernel.agentRuntimeRequest<
          RunStartReceipt,
          'runtime.run.start'
        >(
          'runtime.run.start',
          {
            runId,
            ...(extensionBindings.length ? { extensionBindings } : {}),
            ...(policyBinding ? { policyBinding } : {}),
            ...(mcpBinding ? { mcpBinding } : {}),
            ...(toolBinding === undefined ? {} : { toolBinding }),
          },
          signal,
        );
        this.startedTools(runId);
        return receipt;
      } catch (error) {
        this.releaseToolComposition(runId);
        throw error;
      }
    });
  }
  /** Private Host path: only nonsecret pinned scope crosses admission; credentials resolve later. */
  async startRunWithCredentialOwner(
    runId: string,
    owner: ExistingHostCredentialOwner,
    signal?: AbortSignal,
    toolBinding?: unknown,
  ): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, signal, async (signal) => {
      const selected = await this.modelSelections(runId, signal);
      const credentialScope = await this.kernel.registerCredentialOwner(
        runId,
        owner,
        signal,
        selected.active?.binding_id,
      );
      const credentialEpoch = this.kernel.kernelEpoch;
      try {
        const policyBinding = await this.preparePolicy(
          runId,
          signal,
          credentialScope,
        );
        const mcpBinding = this.kernel.mcpLiveBinding(runId);
        const extensionBindings = await this.prepareExtensions(runId, signal);
        await this.reconcileMemory(runId, signal);
        await this.reconcilePlan(runId, signal);
        const receipt = await this.kernel.agentRuntimeRequest<
          RunStartReceipt,
          'runtime.run.start'
        >(
          'runtime.run.start',
          {
            runId,
            ...(extensionBindings.length ? { extensionBindings } : {}),
            credentialScope,
            ...(policyBinding ? { policyBinding } : {}),
            ...(mcpBinding ? { mcpBinding } : {}),
            ...(toolBinding === undefined ? {} : { toolBinding }),
          },
          signal,
        );
        this.startedTools(runId);
        return receipt;
      } catch (error) {
        this.releaseToolComposition(runId);
        if (this.kernel.kernelEpoch === credentialEpoch) this.kernel.unregisterCredentialOwner(runId, selected.active?.binding_id ?? null);
        throw error;
      }
    });
  }
  releaseMainModelCredentials(runId: string, selected: RunModelSelections): void {
    // Main model rebind must not discard a retired-but-pinned policy or its planning credentials.
    this.kernel.unregisterCredentialOwner(runId, null);
    for (const binding of [selected.active, selected.desired]) if (binding) this.kernel.unregisterCredentialOwner(runId, binding.binding_id);
  }
  modelSelections(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunModelSelections> {
    return this.kernel.agentRuntimeRequest(
      'runtime.model.inspect',
      { runId },
      signal,
    );
  }
  async selectModel(
    runId: string,
    key: string,
    configuration: ModelSessionConfiguration,
    owner: ExistingHostCredentialOwner,
    signal?: AbortSignal,
  ): Promise<RunModelSelection> {
    const bindingId = `model:${key}`;
    const credentialScope = await this.kernel.registerCredentialOwner(
      runId,
      owner,
      signal,
      bindingId,
    );
    try {
      return await this.kernel.agentRuntimeRequest(
        'runtime.model.select',
        { runId, key, configuration, credentialScope },
        signal,
        { settleCancellation: true },
      );
    } catch (error) {
      this.kernel.unregisterCredentialOwner(runId, bindingId);
      throw error;
    }
  }
  async run(runId: string, signal?: AbortSignal): Promise<Run> {
    const run = await this.kernel.agentRuntimeRequest<
      Run,
      'runtime.run.inspect'
    >('runtime.run.inspect', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      this.closePolicyObservation(runId);
      this.kernel.cancelRunPreparation(runId);
      this.kernel.unregisterCredentialOwner(runId);
      this.kernel.unregisterToolOwners(runId);
      this.kernel.releaseRunPolicyOwners(runId);
    }
    return run;
  }
  resumeRun(
    runId: string,
    waitId: string,
    signal?: AbortSignal,
  ): Promise<PolicyResumeReceipt> {
    return this.kernel.agentRuntimeRequest(
      'runtime.run.resume',
      { runId, waitId },
      signal,
    );
  }
  async cancelRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunCancellationReceipt> {
    this.kernel.cancelRunPreparation(runId);
    this.closePolicyObservation(runId);
    const run = await this.kernel.agentRuntimeRequest<
      RunCancellationReceipt,
      'runtime.run.cancel'
    >('runtime.run.cancel', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      this.closePolicyObservation(runId);
      this.kernel.cancelRunPreparation(runId);
      this.kernel.unregisterCredentialOwner(runId);
      this.kernel.unregisterToolOwners(runId);
      this.kernel.releaseRunPolicyOwners(runId);
    }
    return run;
  }
  operation(operationId: string, signal?: AbortSignal): Promise<Operation> {
    return this.kernel.agentRuntimeRequest(
      'runtime.operation.inspect',
      { operationId },
      signal,
    );
  }
  cancelOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationCancellationReceipt> {
    return this.kernel.agentRuntimeRequest(
      'runtime.operation.cancel',
      { operationId },
      signal,
    );
  }
  historyPage(
    params: HistoryPageParams,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    return this.kernel.agentRuntimeRequest(
      'runtime.history.page',
      params,
      signal,
    );
  }
  async historyItem(
    reference: HistoryReference,
    signal?: AbortSignal,
  ): Promise<HistoryItem> {
    const chunks: Buffer[] = [];
    let count = 1;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const chunk = await this.kernel.agentRuntimeRequest<
        HistoryBodyChunk,
        'runtime.history.body'
      >(
        'runtime.history.body',
        { itemId: reference.id, chunkIndex: index },
        signal,
      );
      if (
        chunk.itemId !== reference.id ||
        chunk.contentRef !== reference.content_ref ||
        chunk.chunkIndex !== index
      )
        throw new Error('History content identity changed');
      if (index === 0) {
        count = chunk.chunkCount;
        total = chunk.totalBytes;
      } else if (chunk.chunkCount !== count || chunk.totalBytes !== total)
        throw new Error('History content manifest changed');
      chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== total)
      throw new Error('History content length does not match its manifest');
    const body = JSON.parse(bytes.toString('utf8')) as Pick<
      HistoryItem,
      'content' | 'provider'
    >;
    return {
      id: reference.id,
      thread_id: reference.thread_id,
      parent: reference.parent,
      source: reference.source,
      content: body.content,
      provider: body.provider,
    };
  }
  activeOperations(
    threadId: string,
    branchId?: string,
    signal?: AbortSignal,
  ): Promise<Operation[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.thread.operations.active',
      { threadId, ...(branchId ? { branchId } : {}) },
      signal,
    );
  }
  async history(
    branchId: string,
    signal?: AbortSignal,
  ): Promise<HistoryItem[]> {
    const pages: HistoryItem[][] = [];
    let head: string | undefined;
    let before: string | undefined;
    do {
      const page = await this.historyPage(
        {
          branchId,
          limit: 20,
          ...(head ? { headId: head } : {}),
          ...(before ? { beforeId: before } : {}),
        },
        signal,
      );
      head = page.head ?? undefined;
      pages.push(
        await Promise.all(
          page.items.map((item) => this.historyItem(item, signal)),
        ),
      );
      before = page.previous ?? undefined;
    } while (before);
    return pages.reverse().flat();
  }
  async observerEvents(
    observerId: string,
    threadId: string,
    limit: number,
    signal?: AbortSignal,
    throughCursor?: number,
  ): Promise<RuntimeEvent[]> {
    // Manual inspection can request the current head. The background observer always supplies
    // its already-processed source cursor so scope changes cannot be bypassed by prefetch.
    const head = throughCursor ?? (await this.status(signal)).eventCursor;
    return this.kernel.agentRuntimeRequest(
      'runtime.observer.read',
      { observerId, threadId, limit, throughCursor: head },
      signal,
    );
  }
  observerDelivery(
    observerId: string,
    threadId: string,
    cursor: number,
    state: 'selected' | 'sent' | 'committed',
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    return this.kernel.agentRuntimeRequest(
      'runtime.observer.delivery',
      { observerId, threadId, cursor, state },
      signal,
    );
  }
  events(
    cursor: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RuntimeEvent[]> {
    return this.kernel.agentRuntimeRequest(
      'runtime.events.read',
      { cursor, limit },
      signal,
    );
  }
}
