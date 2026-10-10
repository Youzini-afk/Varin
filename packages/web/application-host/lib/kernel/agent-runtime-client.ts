import type { PlanView, PlanForkCapture } from '@varin/protocol';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LiveSourceResolver } from './live-source.js';
import type { PolicyModelPreparer } from './policy-models.js';
import { waitWithSignal } from '../cancellation.js';
import type { AgentPolicyLease, AgentPolicyBinding } from './agent-policy.js';
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
  ThreadToolInspection,
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
  ChildWait,
  ContextRefreshParams,
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
  RunStartReceipt,
  PolicyResumeReceipt,
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
export type RunPolicyPreparer = (
  input: { runId: string; threadId: string },
  signal?: AbortSignal,
) => Promise<AgentPolicyLease | undefined>;
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
      for (const run of this.toolCompositions.keys())
        this.releaseToolComposition(run);
      this.sourceGrants.clear();
      this.mcpPreparations.clear();
      for (const controller of this.mcpUpdates.values()) controller.abort();
      this.mcpUpdates.clear();
    });
    kernel.onToolReleased((runId) => {
      this.releaseToolComposition(runId);
      this.mcpPreparations.delete(runId);
      this.mcpUpdates.get(runId)?.abort();
      this.mcpUpdates.delete(runId);
    });
  }

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
  /** Pin a selected implementation before any executable launch; retries never change its identity. */
  async preparePolicy(
    runId: string,
    signal?: AbortSignal,
    credentialScope?: Awaited<ReturnType<ExistingHostCredentialOwner['scope']>>,
  ): Promise<AgentPolicyBinding | undefined> {
    const preparation = this.kernel.beginRunPreparation(runId);
    signal = signal
      ? AbortSignal.any([signal, preparation.signal])
      : preparation.signal;
    try {
      const existing = this.kernel.policyBinding(runId);
      if (existing) return existing;
      const run = await this.run(runId, signal);
      signal.throwIfAborted();
      if (
        run.cancel_requested ||
        ['completed', 'failed', 'cancelled'].includes(run.state)
      )
        throw new Error('Run is no longer eligible for policy preparation');
      const saved = await this.launch(runId, signal);
      if (saved?.selection.policy.name === 'context_compaction')
        return undefined;
      if (await this.childForThread(run.thread_id, signal)) return undefined;
      const expectsPolicy =
        saved &&
        saved.selection.policy.name !==
          'default+questions+collaboration+process-wait';
      if (!this.preparePolicyOwner) {
        if (expectsPolicy)
          throw new Error(
            'Saved policy requires its exact original artifact and configuration',
          );
        return undefined;
      }
      const pendingLease = this.preparePolicyOwner(
        { runId, threadId: run.thread_id },
        signal,
      );
      void pendingLease.then(
        (lease) => {
          if (signal.aborted) lease?.release();
        },
        () => undefined,
      );
      const lease = await waitWithSignal(pendingLease, signal);
      if (!lease) {
        if (expectsPolicy) throw new Error('Saved policy is unavailable');
        return undefined;
      }
      const registered: string[] = [];
      try {
        signal?.throwIfAborted();
        if (!saved)
          await this.selectLaunch(
            {
              runId,
              source: null,
              enabledTools: [],
              ...(credentialScope ? { credentialScope } : {}),
            },
            signal,
          );
        const roles = lease.requestedModelRoles ?? [];
        if (roles.length && !this.preparePolicyModels)
          throw new Error('Planning model preparation is unavailable');
        const prepared = this.preparePolicyModels
          ? await this.preparePolicyModels(
              {
                threadId: run.thread_id,
                requestedModelRoles: roles,
                ...(expectsPolicy
                  ? { savedCapabilities: saved.selection.policy_models }
                  : {}),
              },
              signal,
            )
          : [];
        for (const entry of prepared) {
          if (entry.capability.status !== 'available') continue;
          if (!entry.credentialOwner || !entry.capability.binding_id)
            throw new Error('Planning credential owner is missing');
          const scope = await this.kernel.registerCredentialOwner(
            runId,
            entry.credentialOwner,
            signal,
            entry.capability.binding_id,
          );
          registered.push(entry.capability.binding_id);
          const expected = entry.capability.credential_scope;
          if (
            !expected ||
            scope.reference !== expected.reference ||
            scope.authority !== expected.authority ||
            scope.account !== expected.account ||
            scope.generation !== expected.generation
          )
            throw new Error('Planning credential scope changed');
        }
        // Rust constructs and checks the tool-free binding; the Host never supplies one.
        await this.kernel.agentRuntimeRequest(
          'runtime.launch.policy.prepare',
          {
            runId,
            identity: lease.binding.identity,
            policyModels: prepared.map((entry) => ({
              ...entry.capability,
              binding: null,
            })),
          },
          signal,
        );
        signal.throwIfAborted();
        return await this.kernel.registerPolicyOwner(runId, lease);
      } catch (error) {
        for (const bindingId of registered)
          this.kernel.unregisterCredentialOwner(runId, bindingId);
        lease.release();
        throw error;
      }
    } finally {
      preparation.release();
    }
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
        this.kernel.unregisterCredentialOwner(runId);
        this.kernel.unregisterPolicyOwner(runId);
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
        this.kernel.unregisterCredentialOwner(runId);
        this.kernel.unregisterPolicyOwner(runId);
        throw error;
      }
    });
  }
  releaseRunCredentialOwner(runId: string): void {
    this.kernel.unregisterCredentialOwner(runId);
    // A parked Run resumes with every frozen planning credential owner freshly rebound.
    this.kernel.unregisterPolicyOwner(runId);
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
      this.kernel.cancelRunPreparation(runId);
      this.kernel.unregisterCredentialOwner(runId);
      this.kernel.unregisterToolOwners(runId);
      this.kernel.unregisterPolicyOwner(runId);
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
    const run = await this.kernel.agentRuntimeRequest<
      RunCancellationReceipt,
      'runtime.run.cancel'
    >('runtime.run.cancel', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      this.kernel.cancelRunPreparation(runId);
      this.kernel.unregisterCredentialOwner(runId);
      this.kernel.unregisterToolOwners(runId);
      this.kernel.unregisterPolicyOwner(runId);
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
