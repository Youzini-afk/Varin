import type { PlanView, PlanForkCapture } from '@varin/protocol';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LiveSourceResolver } from './live-source.js';
import type { PolicyModelPreparer } from './policy-models.js';
import { waitWithSignal } from '../cancellation.js';
import type { AgentPolicyLease, AgentPolicyBinding } from './agent-policy.js';
import type { McpLease, McpBinding, LiveMcpBinding } from './mcp-bridge.js';
import type { McpCompositionSelection } from '@varin/pi-host/mcp-authority';
import { permissionService } from './permission-service.js';
import type { ContextJob, ContextCheckpoint } from '@varin/application-client';
import { startRunFromSource, type SourceLaunch } from './source-launch.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { RunModelSelection, RunModelSelections, ModelSessionConfiguration } from './protocol.generated.js';
import type {
  AdmissionInspectParams, AdmissionInspection, ChildTextPage, UnacceptedChildSource, ChildTask, ChildPrepareParams, ChildWait, ContextRefreshParams, ContextJobCreateParams, HistoryPage, HistoryPageParams, HistoryReference, HistoryBodyChunk, RunReconcileResult, ThreadSummary, LaunchIntent, LaunchSelectParams, InputSubmitParams, InputSubmitReceipt, Run, Operation,
  HistoryItem, RuntimeEvent, RuntimeStatus, RunStartReceipt, PolicyResumeReceipt, InputEnqueueParams, InputReceipt, QueuedInput, RunCancellationReceipt, OperationCancellationReceipt,
} from './protocol.generated.js';

export interface McpPreparation {
  runId: string; threadId: string; source: SourceLaunch | null; executionCwd?: string;
  requiredBinding?: McpCompositionSelection;
}
export type RunPolicyPreparer = (input: { runId: string; threadId: string }, signal?: AbortSignal) => Promise<AgentPolicyLease | undefined>;
export type McpPreparer = (input: McpPreparation, signal?: AbortSignal) => Promise<McpLease | undefined>;

/** Explicit authority client. Existing Pi thread routes are not silently redirected. */
export class AgentRuntimeClient {
  constructor(private readonly kernel: KernelClient, private readonly prepareMcpOwner?: McpPreparer, private readonly preparePolicyOwner?: RunPolicyPreparer, private readonly preparePolicyModels?: PolicyModelPreparer, private readonly resolveLiveSource?: LiveSourceResolver) {
    kernel.subscribeExit(() => {
      this.sourceGrants.clear(); this.mcpPreparations.clear();
      for (const controller of this.mcpUpdates.values()) controller.abort();
      this.mcpUpdates.clear();
    });
    kernel.onMcpReleased(runId => {
      this.mcpPreparations.delete(runId); this.mcpUpdates.get(runId)?.abort(); this.mcpUpdates.delete(runId);
    });
  }

  private readonly sourceGrants = new Map<string, Set<string>>();
  private readonly mcpPreparations = new Map<string, McpPreparation>();
  private readonly mcpUpdates = new Map<string, AbortController>();
  retainSourceGrant(runId: string, grantId: string): void {
    const grants = this.sourceGrants.get(runId) ?? new Set<string>(); grants.add(grantId); this.sourceGrants.set(runId, grants);
  }
  async releaseSourceGrant(runId: string, grantId: string): Promise<void> {
    await this.kernel.revokeGrant(grantId);
    const grants = this.sourceGrants.get(runId); grants?.delete(grantId);
    if (!grants?.size) this.sourceGrants.delete(runId);
  }
  async releaseSourceGrants(runId: string): Promise<void> {
    const grants = this.sourceGrants.get(runId);
    if (!grants) return;
    for (const grantId of grants) { await this.kernel.revokeGrant(grantId); grants.delete(grantId); }
    if (!grants.size) this.sourceGrants.delete(runId);
  }
  /** Host admission and nested resource assembly share the same Run/epoch cancellation owner. */
  async withRunPreparation<T>(runId: string, callerSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const registration = this.kernel.beginRunPreparation(runId);
    const signal = callerSignal ? AbortSignal.any([callerSignal, registration.signal]) : registration.signal;
    try { signal.throwIfAborted(); return await waitWithSignal(work(signal), signal); }
    finally { registration.release(); }
  }

  onExit(listener: (error: Error) => void): () => void { return this.kernel.subscribeExit(listener); }
  onReady(listener: () => void): () => void { return this.kernel.subscribeReady(listener); }

  onEvent(listener: Parameters<KernelClient["onAgentRuntimeEvent"]>[0]): () => void {
    return this.kernel.onAgentRuntimeEvent(listener);
  }

  decidePermission(operationId: string, permissionId: string, decision: 'allow_once' | 'deny'): Promise<Operation> {
    return permissionService(this.kernel).decide(operationId, permissionId, decision);
  }
  answerQuestion(operationId: string, answer: string, signal?: AbortSignal): Promise<Operation> {
    return this.kernel.agentRuntimeRequest('runtime.question.answer', { operationId, answer }, signal);
  }
  unacceptedChildSources(signal?: AbortSignal): Promise<UnacceptedChildSource[]> { return this.kernel.agentRuntimeRequest('runtime.child.sources.pending', {}, signal); }
  releaseUnacceptedChildSource(operationId: string, signal?: AbortSignal): Promise<Record<string, never>> { return this.kernel.agentRuntimeRequest('runtime.child.sources.release', { operationId }, signal); }
  readChildReport(operationId: string, itemId: string, offset = 0, maxBytes = 65536, signal?: AbortSignal): Promise<ChildTextPage> { return this.kernel.agentRuntimeRequest('runtime.child.report.read', { operationId, itemId, offset, maxBytes }, signal); }
  children(signal?: AbortSignal): Promise<ChildTask[]> { return this.kernel.agentRuntimeRequest('runtime.child.list', {}, signal); }
  child(operationId: string, signal?: AbortSignal): Promise<ChildTask> { return this.kernel.agentRuntimeRequest('runtime.child.inspect', { operationId }, signal); }
  childForThread(threadId: string, signal?: AbortSignal): Promise<ChildTask | null> { return this.kernel.agentRuntimeRequest('runtime.child.for_thread', { threadId }, signal); }
  prepareChild(input: ChildPrepareParams, signal?: AbortSignal): Promise<ChildTask> { return this.kernel.agentRuntimeRequest('runtime.child.prepare', input, signal); }
  failChild(operationId: string, code: 'preparation_failed' | 'source_unavailable' | 'credentials_unavailable' | 'binding_changed', signal?: AbortSignal): Promise<ChildTask> { return this.kernel.agentRuntimeRequest('runtime.child.fail', { operationId, code }, signal); }
  async cancelChild(operationId: string, signal?: AbortSignal): Promise<ChildTask> {
    const child = await this.child(operationId, signal);
    if (child.receipt) this.kernel.cancelRunPreparation(child.receipt.run_id);
    return this.kernel.agentRuntimeRequest('runtime.child.cancel', { operationId }, signal);
  }
  releaseChildResources(operationId: string, signal?: AbortSignal): Promise<ChildTask> { return this.kernel.agentRuntimeRequest('runtime.child.release', { operationId }, signal); }
  reconcileProcessWaits(signal?: AbortSignal): Promise<string[]> { return this.kernel.agentRuntimeRequest('runtime.process.wait.reconcile', {}, signal); }
  reconcileChildren(signal?: AbortSignal): Promise<string[]> { return this.kernel.agentRuntimeRequest('runtime.child.reconcile', {}, signal); }
  cancelChildWait(waitId: string, signal?: AbortSignal): Promise<ChildWait> { return this.kernel.agentRuntimeRequest('runtime.child.wait.cancel', { waitId }, signal); }
  status(signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.kernel.agentRuntimeRequest('runtime.status', {}, signal);
  }
  /** Use the Run epoch and actual ModelStep/tool-call or policy-action/node identity. */
  admission(input: AdmissionInspectParams, signal?: AbortSignal): Promise<AdmissionInspection> {
    return this.kernel.agentRuntimeRequest('runtime.admission.inspect', input, signal);
  }
  thread(threadId: string, signal?: AbortSignal): Promise<ThreadSummary> {
    return this.kernel.agentRuntimeRequest('runtime.thread.inspect', { threadId }, signal);
  }
  threads(signal?: AbortSignal): Promise<ThreadSummary[]> {
    return this.kernel.agentRuntimeRequest('runtime.thread.list', {}, signal);
  }
  createThread(threadId: string, branchId: string, signal?: AbortSignal): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.agentRuntimeRequest('runtime.thread.create', { threadId, branchId }, signal);
  }
  forkBranch(sourceBranchId: string, branchId: string, headId: string | null, signal?: AbortSignal, planCapture?: PlanForkCapture): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.agentRuntimeRequest('runtime.branch.fork', { sourceBranchId, branchId, headId, ...(planCapture === undefined ? {} : { planCapture }) }, signal);
  }
  planContains(branchId: string, headId: string | null, candidateHeadId: string | null, cursor?: string, signal?: AbortSignal): Promise<{status:'pending';cursor:string}|{status:'ready';visible:boolean}> {
    return this.kernel.agentRuntimeRequest('runtime.plan.contains', {branchId,headId,candidateHeadId,...(cursor === undefined ? {} : {cursor})}, signal);
  }
  planView(branchId: string, headId?: string | null, signal?: AbortSignal): Promise<PlanView> {
    return this.kernel.agentRuntimeRequest('runtime.plan.view', { branchId, headId: headId ?? null, current: headId === undefined }, signal);
  }
  refreshContext(input: ContextRefreshParams, signal?: AbortSignal): Promise<ContextCheckpoint> {
    return this.kernel.agentRuntimeRequest('runtime.context.refresh', input, signal);
  }
  context(branchId: string, signal?: AbortSignal): Promise<ContextCheckpoint | null> {
    return this.kernel.agentRuntimeRequest('runtime.context.inspect', { branchId }, signal);
  }
  contextJobs(branchId: string, signal?: AbortSignal): Promise<ContextJob[]> {
    return this.kernel.agentRuntimeRequest('runtime.context_job.list', { branchId }, signal);
  }
  contextJob(runId: string, signal?: AbortSignal): Promise<ContextJob> {
    return this.kernel.agentRuntimeRequest('runtime.context_job.inspect', { runId }, signal);
  }
  createContextJob(input: ContextJobCreateParams, signal?: AbortSignal): Promise<ContextJob> {
    return this.kernel.agentRuntimeRequest('runtime.context_job.create', input, signal);
  }
  publishContextJob(runId: string, signal?: AbortSignal): Promise<ContextCheckpoint> {
    return this.kernel.agentRuntimeRequest('runtime.context_job.publish', { runId }, signal);
  }
  resumeContextJob(runId:string,signal?:AbortSignal):Promise<Run|null> {
    return this.kernel.agentRuntimeRequest('runtime.context_job.resume',{runId},signal);
  }
  submit(input: InputSubmitParams, signal?: AbortSignal): Promise<InputSubmitReceipt> {
    return this.kernel.agentRuntimeRequest('runtime.input.submit', input, signal);
  }
  enqueue(input: InputEnqueueParams, signal?: AbortSignal): Promise<InputReceipt> {
    return this.kernel.agentRuntimeRequest('runtime.input.enqueue', input, signal);
  }
  editInput(inputId: string, expectedRevision: number, content: unknown, signal?: AbortSignal): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest('runtime.input.edit', { inputId, expectedRevision, content }, signal);
  }
  cancelInput(inputId: string, expectedRevision: number, signal?: AbortSignal): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest('runtime.input.cancel', { inputId, expectedRevision }, signal);
  }
  input(inputId: string, signal?: AbortSignal): Promise<QueuedInput> {
    return this.kernel.agentRuntimeRequest('runtime.input.inspect', { inputId }, signal);
  }
  inputs(branchId: string, signal?: AbortSignal): Promise<QueuedInput[]> {
    return this.kernel.agentRuntimeRequest('runtime.input.list', { branchId }, signal);
  }
  reconcilePlan(runId: string, signal?: AbortSignal): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest('runtime.plan.reconcile', { runId }, signal);
  }
  reconcileMemory(runId: string, signal?: AbortSignal): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest('runtime.memory.reconcile', { runId }, signal);
  }
  reconcileRun(runId: string, toolBinding: unknown, signal?: AbortSignal): Promise<RunReconcileResult> {
    return this.kernel.agentRuntimeRequest('runtime.run.reconcile', { runId, toolBinding }, signal);
  }
  failLaunch(runId: string, code: 'preparation_failed' | 'source_unavailable' | 'credentials_unavailable' | 'binding_changed', signal?: AbortSignal): Promise<LaunchIntent> {
    return this.kernel.agentRuntimeRequest('runtime.launch.fail', { runId, code }, signal);
  }
  selectLaunch(params: LaunchSelectParams, signal?: AbortSignal): Promise<LaunchIntent> {
    return this.kernel.agentRuntimeRequest('runtime.launch.select', params, signal);
  }
  /** Slow connection/schema preparation happens after input admission, before the first model request. */
  async prepareMcp(runId: string, source: SourceLaunch | null, executionCwd?: string, signal?: AbortSignal): Promise<McpBinding | undefined> {
    return this.withRunPreparation(runId, signal, async signal => {
      const existing = this.kernel.mcpBinding(runId);
      if (existing) return existing;
      const saved = await this.launch(runId, signal);
      const run = await this.run(runId, signal);
      if (await this.childForThread(run.thread_id, signal)) {
        if (saved?.selection.mcp_binding) throw new Error('Read-only child cannot acquire MCP capabilities');
        return undefined;
      }
      if (!this.prepareMcpOwner) {
        if (saved?.selection.mcp_binding) throw new Error('Saved MCP capabilities require their original Host owner');
        return undefined;
      }

      const input={ runId, threadId: run.thread_id, source, ...(executionCwd ? { executionCwd } : {}) };
      this.mcpPreparations.set(runId,input);
      const preparation = this.prepareMcpOwner({...input,...(saved?.selection.mcp_binding?{requiredBinding:saved.selection.mcp_binding}:{})}, signal);
      void preparation.then(lease => { if (signal.aborted) lease?.release(); }, () => undefined);
      const lease = await waitWithSignal(preparation, signal);
      if (!lease || lease.binding.tools.length === 0) {
        lease?.release();
        if (saved?.selection.mcp_binding) throw new Error('Saved MCP capabilities are unavailable');
        return undefined;
      }
      try {
        signal?.throwIfAborted();
        await this.kernel.agentRuntimeRequest('runtime.launch.mcp.prepare', { runId, binding: lease.binding }, signal);
        return await this.kernel.registerMcpOwner(runId, lease);
      } catch (error) { lease.release(); throw error; }
    });
  }
  /** Called by the actual MCP scope's configuration/tool events, never by each model request. */
  async refreshMcp(runId: string): Promise<void> {
    const input = this.mcpPreparations.get(runId);
    if (!input || !this.prepareMcpOwner) return;
    const controller = new AbortController();
    this.mcpUpdates.get(runId)?.abort(); this.mcpUpdates.set(runId, controller);
    const selectionId = randomUUID();
    try {
      await this.withRunPreparation(runId, controller.signal, async signal => {
        await this.kernel.agentRuntimeRequest('runtime.tools.select', { runId, selectionId }, signal);
        const work = this.prepareMcpOwner!(input, signal);
        void work.then(lease => { if (signal.aborted) lease?.release(); }, () => undefined);
        const lease = await waitWithSignal(work, signal);
        const binding = lease?.binding;
        if (isDeepStrictEqual(binding, this.kernel.mcpBinding(runId))
          && lease?.implementationIdentity===this.kernel.mcpImplementationIdentity(runId)) { lease?.release(); return; }
        let retained: LiveMcpBinding | undefined;
        try {
          signal.throwIfAborted();
          if (lease && binding?.tools.length) retained = await this.kernel.registerMcpCandidate(runId, lease);
          else lease?.release();
          const result = await this.kernel.agentRuntimeRequest<{ ready: boolean }, 'runtime.tools.ready'>('runtime.tools.ready', { runId, selectionId, ...(retained ? { binding: retained } : {}) }, signal);
          if (!result.ready && retained) this.kernel.discardMcpCandidate(runId, retained);
        } catch (error) {
          if (retained) this.kernel.discardMcpCandidate(runId, retained); else lease?.release();
          throw error;
        }
      });
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { if (this.mcpUpdates.get(runId) === controller) this.mcpUpdates.delete(runId); }
  }
  startFromSource(selection: SourceLaunch, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<RunStartReceipt> {
    return this.withRunPreparation(selection.runId, options.signal, signal => startRunFromSource(this.kernel, this, selection, { ...options, signal, ...(this.resolveLiveSource ? { resolveLiveSource: this.resolveLiveSource } : {}) }));
  }
  /** Reacquire fresh authority from a saved selection; unresolved model/effect waits still reject start. */
  async rebindLaunch(runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, options.signal, async signal => {
      options = { ...options, signal };
      const launch = await this.launch(runId, options.signal);
      if (!launch) throw new Error('Run has no durable launch selection');
      const source = launch.selection.source;
      if (!source) {
        const mcpNames = new Set(launch.selection.mcp_binding?.tools.map(tool => tool.name) ?? []);
        if (launch.selection.tools.some(tool => !['ask_user', 'dispatch', 'child_status', 'wait_child', 'child_report', 'wait_process', 'memory', 'todo'].includes(tool.name) && !mcpNames.has(tool.name))) throw new Error('Saved tools require an explicit Host resource rebind');
        await this.prepareMcp(runId, null, undefined, options.signal);
        return options.credentialOwner ? this.startRunWithCredentialOwner(runId, options.credentialOwner, options.signal) : this.startRun(runId, options.signal);
      }

      const names = { file_read: 'file_read', file_list: 'file_list', file_search: 'file_search', file_write: 'file_write', file_edit: 'file_edit', process_inspect: 'process_inspect', process_read: 'process_read', process_spawn: 'process_spawn', language_definition: 'language_definition', language_references: 'language_references', language_diagnostics: 'language_diagnostics', code_retrieval: 'code_retrieval' } as const;
      const tools = launch.selection.tools.filter(tool => !['ask_user', 'dispatch', 'child_status', 'wait_child', 'child_report', 'wait_process', 'memory', 'todo'].includes(tool.name) && !launch.selection.mcp_binding?.tools.some(mcp => mcp.name === tool.name)).map(tool => {
        if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
        return names[tool.name as keyof typeof names];
    });
    return this.startFromSource(this.sourceLaunch(runId, source, tools), options);
    });
  }
  /** Carry a thread's actual materialized environment into an admitted successor Run. */
  async continueFromLaunch(previousRunId: string, runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, options.signal, async signal => {
      options = { ...options, signal };
      const previous = await this.launch(previousRunId, options.signal);
      if (!previous) throw new Error('Previous Run has no source launch selection');
      if (previous.selection.credential_scope) {
        if (!options.credentialOwner) throw new Error('Continuation requires the selected credential owner');
        const actual = await options.credentialOwner.scope();
        const expected = previous.selection.credential_scope;
        if (actual.reference !== expected.reference || actual.authority !== expected.authority || actual.account !== expected.account || actual.generation !== expected.generation) throw new Error('Continuation credential selection changed');
      }
      const source = previous.selection.source;
      if (!source) {
        const credentialScope = options.credentialOwner ? await options.credentialOwner.scope() : undefined;
        await this.selectLaunch({ runId, source: null, enabledTools: [], ...(credentialScope ? { credentialScope } : {}) }, options.signal);
        await this.prepareMcp(runId, null, undefined, options.signal);
        return options.credentialOwner ? this.startRunWithCredentialOwner(runId, options.credentialOwner, options.signal) : this.startRun(runId, options.signal);
      }

      const names = { file_read: 'file_read', file_list: 'file_list', file_search: 'file_search', file_write: 'file_write', file_edit: 'file_edit', process_inspect: 'process_inspect', process_read: 'process_read', process_spawn: 'process_spawn', language_definition: 'language_definition', language_references: 'language_references', language_diagnostics: 'language_diagnostics', code_retrieval: 'code_retrieval' } as const;
      const tools = previous.selection.tools.filter(tool => !['ask_user', 'dispatch', 'child_status', 'wait_child', 'child_report', 'wait_process', 'memory', 'todo'].includes(tool.name) && !previous.selection.mcp_binding?.tools.some(mcp => mcp.name === tool.name)).map(tool => {
        if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
        return names[tool.name as keyof typeof names];
    });
    return this.startFromSource(this.sourceLaunch(runId, source, tools, previousRunId), options);
    });
  }
  private sourceLaunch(runId: string, source: NonNullable<LaunchIntent['selection']['source']>,
    tools: SourceLaunch['tools'], previousRunId?: string): SourceLaunch {
    const base = { runId, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, tools };
    if (source.mode === 'live_root') {
      if (!source.live_root || source.branch_id !== null || source.revision !== null || source.environment_run_id) throw new Error('Saved live environment is incomplete');
      return { ...base, mode: 'live_root', liveRoot: source.live_root };
    }
    if (source.branch_id === null || source.revision === null || source.live_root) throw new Error('Saved fixed environment is incomplete');
    const environmentRunId = source.environment_run_id ?? previousRunId;
    return { ...base, mode: source.mode, branchId: source.branch_id, revision: source.revision,
      ...(source.mode === 'materialized' && environmentRunId ? { environmentRunId } : {}) };
  }
  launch(runId: string, signal?: AbortSignal): Promise<LaunchIntent | null> {
    return this.kernel.agentRuntimeRequest('runtime.launch.inspect', { runId }, signal);
  }
  pendingLaunches(signal?: AbortSignal): Promise<LaunchIntent[]> {
    return this.kernel.agentRuntimeRequest('runtime.launch.list', {}, signal);
  }
  /** Pin a selected implementation before any executable launch; retries never change its identity. */
  async preparePolicy(runId: string, signal?: AbortSignal, credentialScope?: Awaited<ReturnType<ExistingHostCredentialOwner['scope']>>): Promise<AgentPolicyBinding | undefined> {
    const preparation = this.kernel.beginRunPreparation(runId);
    signal = signal ? AbortSignal.any([signal, preparation.signal]) : preparation.signal;
    try {
      const existing = this.kernel.policyBinding(runId);
      if (existing) return existing;
      const run = await this.run(runId, signal);
      signal.throwIfAborted();
      if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error('Run is no longer eligible for policy preparation');
      const saved = await this.launch(runId, signal);
      if (saved?.selection.policy.name === 'context_compaction') return undefined;
      if (await this.childForThread(run.thread_id, signal)) return undefined;
      const expectsPolicy = saved && saved.selection.policy.name !== 'default+questions+collaboration+process-wait';
      if (!this.preparePolicyOwner) {
        if (expectsPolicy) throw new Error('Saved policy requires its exact original artifact and configuration');
        return undefined;
      }
      const pendingLease = this.preparePolicyOwner({ runId, threadId: run.thread_id }, signal);
      void pendingLease.then(lease => { if (signal.aborted) lease?.release(); }, () => undefined);
      const lease = await waitWithSignal(pendingLease, signal);
      if (!lease) {
        if (expectsPolicy) throw new Error('Saved policy is unavailable');
        return undefined;
      }
      const registered: string[] = [];
      try {
        signal?.throwIfAborted();
        if (!saved) await this.selectLaunch({ runId, source: null, enabledTools: [], ...(credentialScope ? { credentialScope } : {}) }, signal);
        const roles = lease.requestedModelRoles ?? [];
        if (roles.length && !this.preparePolicyModels) throw new Error('Planning model preparation is unavailable');
        const prepared = this.preparePolicyModels ? await this.preparePolicyModels({ threadId: run.thread_id,
          requestedModelRoles: roles, ...(expectsPolicy ? { savedCapabilities: saved.selection.policy_models } : {}) }, signal) : [];
        for (const entry of prepared) {
          if (entry.capability.status !== 'available') continue;
          if (!entry.credentialOwner || !entry.capability.binding_id) throw new Error('Planning credential owner is missing');
          const scope = await this.kernel.registerCredentialOwner(runId, entry.credentialOwner, signal, entry.capability.binding_id);
          registered.push(entry.capability.binding_id);
          const expected = entry.capability.credential_scope;
          if (!expected || scope.reference !== expected.reference || scope.authority !== expected.authority
            || scope.account !== expected.account || scope.generation !== expected.generation) throw new Error('Planning credential scope changed');
        }
        // Rust constructs and checks the tool-free binding; the Host never supplies one.
        await this.kernel.agentRuntimeRequest('runtime.launch.policy.prepare', { runId, identity: lease.binding.identity,
          policyModels: prepared.map(entry => ({ ...entry.capability, binding: null })) }, signal);
        signal.throwIfAborted();
        return await this.kernel.registerPolicyOwner(runId, lease);
      } catch (error) {
        for (const bindingId of registered) this.kernel.unregisterCredentialOwner(runId, bindingId);
        lease.release(); throw error;
      }
    } finally { preparation.release(); }
  }

  async startRun(runId: string, signal?: AbortSignal, toolBinding?: unknown): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, signal, async signal => {
      const policyBinding = await this.preparePolicy(runId, signal);
      const mcpBinding = this.kernel.mcpLiveBinding(runId);
      try {
        await this.reconcileMemory(runId, signal);
        await this.reconcilePlan(runId, signal);
        return await this.kernel.agentRuntimeRequest('runtime.run.start', { runId, ...(policyBinding ? { policyBinding } : {}), ...(mcpBinding ? { mcpBinding } : {}), ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
      } catch (error) { this.kernel.unregisterCredentialOwner(runId); this.kernel.unregisterPolicyOwner(runId); throw error; }
    });
  }
  /** Private Host path: only nonsecret pinned scope crosses admission; credentials resolve later. */
  async startRunWithCredentialOwner(runId: string, owner: ExistingHostCredentialOwner, signal?: AbortSignal, toolBinding?: unknown): Promise<RunStartReceipt> {
    return this.withRunPreparation(runId, signal, async signal => {
      const selected = await this.modelSelections(runId,signal);
      const credentialScope = await this.kernel.registerCredentialOwner(runId, owner, signal,selected.active?.binding_id);
      try {
        const policyBinding = await this.preparePolicy(runId, signal, credentialScope);
        const mcpBinding = this.kernel.mcpLiveBinding(runId);
        await this.reconcileMemory(runId, signal);
        await this.reconcilePlan(runId, signal);
        return await this.kernel.agentRuntimeRequest('runtime.run.start', { runId, credentialScope, ...(policyBinding ? { policyBinding } : {}), ...(mcpBinding ? { mcpBinding } : {}),
          ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
      } catch (error) {
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
  modelSelections(runId: string, signal?: AbortSignal): Promise<RunModelSelections> {
    return this.kernel.agentRuntimeRequest('runtime.model.inspect',{runId},signal);
  }
  async selectModel(runId: string,key: string,configuration: ModelSessionConfiguration,owner: ExistingHostCredentialOwner,signal?: AbortSignal): Promise<RunModelSelection> {
    const bindingId = `model:${key}`;
    const credentialScope = await this.kernel.registerCredentialOwner(runId,owner,signal,bindingId);
    try {
      return await this.kernel.agentRuntimeRequest('runtime.model.select',{runId,key,configuration,credentialScope},signal,{settleCancellation:true});
    } catch(error) {
      this.kernel.unregisterCredentialOwner(runId,bindingId); throw error;
    }
  }
  async run(runId: string, signal?: AbortSignal): Promise<Run> {
    const run = await this.kernel.agentRuntimeRequest<Run, 'runtime.run.inspect'>('runtime.run.inspect', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) { this.kernel.cancelRunPreparation(runId); this.kernel.unregisterCredentialOwner(runId); this.kernel.unregisterMcpOwner(runId); this.kernel.unregisterPolicyOwner(runId); }
    return run;
  }
  resumeRun(runId: string, waitId: string, signal?: AbortSignal): Promise<PolicyResumeReceipt> {
    return this.kernel.agentRuntimeRequest('runtime.run.resume', { runId, waitId }, signal);
  }
  async cancelRun(runId: string, signal?: AbortSignal): Promise<RunCancellationReceipt> {
    this.kernel.cancelRunPreparation(runId);
    const run = await this.kernel.agentRuntimeRequest<RunCancellationReceipt, 'runtime.run.cancel'>('runtime.run.cancel', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) { this.kernel.cancelRunPreparation(runId); this.kernel.unregisterCredentialOwner(runId); this.kernel.unregisterMcpOwner(runId); this.kernel.unregisterPolicyOwner(runId); }
    return run;
  }
  operation(operationId: string, signal?: AbortSignal): Promise<Operation> {
    return this.kernel.agentRuntimeRequest('runtime.operation.inspect', { operationId }, signal);
  }
  cancelOperation(operationId: string, signal?: AbortSignal): Promise<OperationCancellationReceipt> {
    return this.kernel.agentRuntimeRequest('runtime.operation.cancel', { operationId }, signal);
  }
  historyPage(params: HistoryPageParams, signal?: AbortSignal): Promise<HistoryPage> {
    return this.kernel.agentRuntimeRequest('runtime.history.page', params, signal);
  }
  async historyItem(reference: HistoryReference, signal?: AbortSignal): Promise<HistoryItem> {
    const chunks: Buffer[] = [];
    let count = 1;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const chunk = await this.kernel.agentRuntimeRequest<HistoryBodyChunk, 'runtime.history.body'>('runtime.history.body', { itemId: reference.id, chunkIndex: index }, signal);
      if (chunk.itemId !== reference.id || chunk.contentRef !== reference.content_ref || chunk.chunkIndex !== index) throw new Error('History content identity changed');
      if (index === 0) { count = chunk.chunkCount; total = chunk.totalBytes; }
      else if (chunk.chunkCount !== count || chunk.totalBytes !== total) throw new Error('History content manifest changed');
      chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== total) throw new Error('History content length does not match its manifest');
    const body = JSON.parse(bytes.toString('utf8')) as Pick<HistoryItem, 'content' | 'provider'>;
    return { id: reference.id, thread_id: reference.thread_id, parent: reference.parent, source: reference.source, content: body.content, provider: body.provider };
  }
  activeOperations(threadId: string, branchId?: string, signal?: AbortSignal): Promise<Operation[]> {
    return this.kernel.agentRuntimeRequest('runtime.thread.operations.active', { threadId, ...(branchId ? { branchId } : {}) }, signal);
  }
  async history(branchId: string, signal?: AbortSignal): Promise<HistoryItem[]> {
    const pages: HistoryItem[][] = [];
    let head: string | undefined;
    let before: string | undefined;
    do {
      const page = await this.historyPage({branchId, limit: 20, ...(head ? {headId: head} : {}), ...(before ? {beforeId: before} : {})}, signal);
      head = page.head ?? undefined;
      pages.push(await Promise.all(page.items.map(item => this.historyItem(item, signal))));
      before = page.previous ?? undefined;
    } while (before);
    return pages.reverse().flat();
  }
  async observerEvents(observerId: string, threadId: string, limit: number, signal?: AbortSignal, throughCursor?: number): Promise<RuntimeEvent[]> {
    // Manual inspection can request the current head. The background observer always supplies
    // its already-processed source cursor so scope changes cannot be bypassed by prefetch.
    const head = throughCursor ?? (await this.status(signal)).eventCursor;
    return this.kernel.agentRuntimeRequest('runtime.observer.read', { observerId, threadId, limit, throughCursor: head }, signal);
  }
  observerDelivery(observerId: string, threadId: string, cursor: number,
    state: 'selected' | 'sent' | 'committed', signal?: AbortSignal): Promise<Record<string, never>> {
    return this.kernel.agentRuntimeRequest('runtime.observer.delivery', { observerId, threadId, cursor, state }, signal);
  }
  events(cursor: number, limit: number, signal?: AbortSignal): Promise<RuntimeEvent[]> {
    return this.kernel.agentRuntimeRequest('runtime.events.read', { cursor, limit }, signal);
  }
}
