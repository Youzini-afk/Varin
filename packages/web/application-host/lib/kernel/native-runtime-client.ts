import type { NativeLiveSourceResolver } from './native-live-source.js';
import type { NativePolicyModelPreparer } from './native-policy-models.js';
import { waitWithSignal } from '../cancellation.js';
import type { NativeAgentPolicyLease, NativeAgentPolicyBinding } from './native-agent-policy.js';
import type { NativeMcpLease, NativeMcpBinding } from './native-mcp-bridge.js';
import { nativePermissionService } from './native-permission-service.js';
import type { NativeContextJob, NativeContextCheckpoint } from '@varin/application-client';
import { startNativeRunFromSource, type NativeSourceLaunch } from './native-source-launch.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import type { KernelClient } from './kernel-client.js';
import type {
  NativeChildTextPage, NativeUnacceptedChildSource, NativeChildTask, NativeChildPrepareParams, NativeChildWait, NativeContextRefreshParams, NativeContextJobCreateParams, NativeHistoryPage, NativeHistoryPageParams, NativeHistoryReference, NativeHistoryBodyChunk, NativeRunReconcileResult, NativeThreadSummary, NativeLaunchIntent, NativeLaunchSelectParams, NativeInputSubmitParams, NativeReceipt, NativeRun, NativeOperation,
  NativeHistoryItem, NativeEvent, NativeStatus, NativeRunStartReceipt, NativeInputEnqueueParams, NativeInputReceipt, NativeQueuedInput,
} from './protocol.generated.js';

export interface NativeMcpPreparation {
  runId: string; threadId: string; source: NativeSourceLaunch | null; executionCwd?: string;
}
export type NativeRunPolicyPreparer = (input: { runId: string; threadId: string }, signal?: AbortSignal) => Promise<NativeAgentPolicyLease | undefined>;
export type NativeMcpPreparer = (input: NativeMcpPreparation, signal?: AbortSignal) => Promise<NativeMcpLease | undefined>;

/** Explicit native-authority client. Existing Pi thread routes are not silently redirected. */
export class NativeRuntimeClient {
  constructor(private readonly kernel: KernelClient, private readonly prepareMcpOwner?: NativeMcpPreparer, private readonly preparePolicyOwner?: NativeRunPolicyPreparer, private readonly preparePolicyModels?: NativePolicyModelPreparer, private readonly resolveLiveSource?: NativeLiveSourceResolver) { kernel.subscribeExit(() => this.sourceGrants.clear()); }

  private readonly sourceGrants = new Map<string, Set<string>>();
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
  private async withRunPreparation<T>(runId: string, callerSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const registration = this.kernel.beginNativeRunPreparation(runId);
    const signal = callerSignal ? AbortSignal.any([callerSignal, registration.signal]) : registration.signal;
    try { signal.throwIfAborted(); return await waitWithSignal(work(signal), signal); }
    finally { registration.release(); }
  }

  onExit(listener: (error: Error) => void): () => void { return this.kernel.subscribeExit(listener); }
  onReady(listener: () => void): () => void { return this.kernel.subscribeReady(listener); }

  onEvent(listener: Parameters<KernelClient["onNativeRuntimeEvent"]>[0]): () => void {
    return this.kernel.onNativeRuntimeEvent(listener);
  }

  decidePermission(operationId: string, permissionId: string, decision: 'allow_once' | 'deny'): Promise<NativeOperation> {
    return nativePermissionService(this.kernel).decide(operationId, permissionId, decision);
  }
  answerQuestion(operationId: string, answer: string, signal?: AbortSignal): Promise<NativeOperation> {
    return this.kernel.nativeRuntimeRequest('runtime.question.answer', { operationId, answer }, signal);
  }
  unacceptedChildSources(signal?: AbortSignal): Promise<NativeUnacceptedChildSource[]> { return this.kernel.nativeRuntimeRequest('runtime.child.sources.pending', {}, signal); }
  releaseUnacceptedChildSource(operationId: string, signal?: AbortSignal): Promise<Record<string, never>> { return this.kernel.nativeRuntimeRequest('runtime.child.sources.release', { operationId }, signal); }
  readChildReport(operationId: string, itemId: string, offset = 0, maxBytes = 65536, signal?: AbortSignal): Promise<NativeChildTextPage> { return this.kernel.nativeRuntimeRequest('runtime.child.report.read', { operationId, itemId, offset, maxBytes }, signal); }
  children(signal?: AbortSignal): Promise<NativeChildTask[]> { return this.kernel.nativeRuntimeRequest('runtime.child.list', {}, signal); }
  child(operationId: string, signal?: AbortSignal): Promise<NativeChildTask> { return this.kernel.nativeRuntimeRequest('runtime.child.inspect', { operationId }, signal); }
  childForThread(threadId: string, signal?: AbortSignal): Promise<NativeChildTask | null> { return this.kernel.nativeRuntimeRequest('runtime.child.for_thread', { threadId }, signal); }
  prepareChild(input: NativeChildPrepareParams, signal?: AbortSignal): Promise<NativeChildTask> { return this.kernel.nativeRuntimeRequest('runtime.child.prepare', input, signal); }
  failChild(operationId: string, code: 'preparation_failed' | 'source_unavailable' | 'credentials_unavailable' | 'binding_changed', signal?: AbortSignal): Promise<NativeChildTask> { return this.kernel.nativeRuntimeRequest('runtime.child.fail', { operationId, code }, signal); }
  async cancelChild(operationId: string, signal?: AbortSignal): Promise<NativeChildTask> {
    const child = await this.child(operationId, signal);
    if (child.receipt) this.kernel.cancelNativeRunPreparation(child.receipt.run_id);
    return this.kernel.nativeRuntimeRequest('runtime.child.cancel', { operationId }, signal);
  }
  releaseChildResources(operationId: string, signal?: AbortSignal): Promise<NativeChildTask> { return this.kernel.nativeRuntimeRequest('runtime.child.release', { operationId }, signal); }
  reconcileChildren(signal?: AbortSignal): Promise<string[]> { return this.kernel.nativeRuntimeRequest('runtime.child.reconcile', {}, signal); }
  cancelChildWait(waitId: string, signal?: AbortSignal): Promise<NativeChildWait> { return this.kernel.nativeRuntimeRequest('runtime.child.wait.cancel', { waitId }, signal); }
  status(signal?: AbortSignal): Promise<NativeStatus> {
    return this.kernel.nativeRuntimeRequest('runtime.status', {}, signal);
  }
  thread(threadId: string, signal?: AbortSignal): Promise<NativeThreadSummary> {
    return this.kernel.nativeRuntimeRequest('runtime.thread.inspect', { threadId }, signal);
  }
  threads(signal?: AbortSignal): Promise<NativeThreadSummary[]> {
    return this.kernel.nativeRuntimeRequest('runtime.thread.list', {}, signal);
  }
  createThread(threadId: string, branchId: string, signal?: AbortSignal): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.nativeRuntimeRequest('runtime.thread.create', { threadId, branchId }, signal);
  }
  forkBranch(sourceBranchId: string, branchId: string, headId: string | null, signal?: AbortSignal): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.nativeRuntimeRequest('runtime.branch.fork', { sourceBranchId, branchId, headId }, signal);
  }
  refreshContext(input: NativeContextRefreshParams, signal?: AbortSignal): Promise<NativeContextCheckpoint> {
    return this.kernel.nativeRuntimeRequest('runtime.context.refresh', input, signal);
  }
  context(branchId: string, signal?: AbortSignal): Promise<NativeContextCheckpoint | null> {
    return this.kernel.nativeRuntimeRequest('runtime.context.inspect', { branchId }, signal);
  }
  contextJobs(branchId: string, signal?: AbortSignal): Promise<NativeContextJob[]> {
    return this.kernel.nativeRuntimeRequest('runtime.context_job.list', { branchId }, signal);
  }
  contextJob(runId: string, signal?: AbortSignal): Promise<NativeContextJob> {
    return this.kernel.nativeRuntimeRequest('runtime.context_job.inspect', { runId }, signal);
  }
  createContextJob(input: NativeContextJobCreateParams, signal?: AbortSignal): Promise<NativeContextJob> {
    return this.kernel.nativeRuntimeRequest('runtime.context_job.create', input, signal);
  }
  publishContextJob(runId: string, signal?: AbortSignal): Promise<NativeContextCheckpoint> {
    return this.kernel.nativeRuntimeRequest('runtime.context_job.publish', { runId }, signal);
  }
  submit(input: NativeInputSubmitParams, signal?: AbortSignal): Promise<NativeReceipt> {
    return this.kernel.nativeRuntimeRequest('runtime.input.submit', input, signal);
  }
  enqueue(input: NativeInputEnqueueParams, signal?: AbortSignal): Promise<NativeInputReceipt> {
    return this.kernel.nativeRuntimeRequest('runtime.input.enqueue', input, signal);
  }
  editInput(inputId: string, expectedRevision: number, content: unknown, signal?: AbortSignal): Promise<NativeQueuedInput> {
    return this.kernel.nativeRuntimeRequest('runtime.input.edit', { inputId, expectedRevision, content }, signal);
  }
  cancelInput(inputId: string, expectedRevision: number, signal?: AbortSignal): Promise<NativeQueuedInput> {
    return this.kernel.nativeRuntimeRequest('runtime.input.cancel', { inputId, expectedRevision }, signal);
  }
  input(inputId: string, signal?: AbortSignal): Promise<NativeQueuedInput> {
    return this.kernel.nativeRuntimeRequest('runtime.input.inspect', { inputId }, signal);
  }
  inputs(branchId: string, signal?: AbortSignal): Promise<NativeQueuedInput[]> {
    return this.kernel.nativeRuntimeRequest('runtime.input.list', { branchId }, signal);
  }
  reconcileRun(runId: string, toolBinding: unknown, signal?: AbortSignal): Promise<NativeRunReconcileResult> {
    return this.kernel.nativeRuntimeRequest('runtime.run.reconcile', { runId, toolBinding }, signal);
  }
  failLaunch(runId: string, code: 'preparation_failed' | 'source_unavailable' | 'credentials_unavailable' | 'binding_changed', signal?: AbortSignal): Promise<NativeLaunchIntent> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.fail', { runId, code }, signal);
  }
  selectLaunch(params: NativeLaunchSelectParams, signal?: AbortSignal): Promise<NativeLaunchIntent> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.select', params, signal);
  }
  /** Slow connection/schema preparation happens after input admission, before the first model request. */
  async prepareMcp(runId: string, source: NativeSourceLaunch | null, executionCwd?: string, signal?: AbortSignal): Promise<NativeMcpBinding | undefined> {
    return this.withRunPreparation(runId, signal, async signal => {
      const existing = this.kernel.nativeMcpBinding(runId);
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

      const preparation = this.prepareMcpOwner({ runId, threadId: run.thread_id, source, ...(executionCwd ? { executionCwd } : {}) }, signal);
      void preparation.then(lease => { if (signal.aborted) lease?.release(); }, () => undefined);
      const lease = await waitWithSignal(preparation, signal);
      if (!lease || lease.binding.tools.length === 0) {
        lease?.release();
        if (saved?.selection.mcp_binding) throw new Error('Saved MCP capabilities are unavailable');
        return undefined;
      }
      try {
        signal?.throwIfAborted();
        await this.kernel.nativeRuntimeRequest('runtime.launch.mcp.prepare', { runId, binding: lease.binding }, signal);
        return await this.kernel.registerNativeMcpOwner(runId, lease);
      } catch (error) { lease.release(); throw error; }
    });
  }
  startFromSource(selection: NativeSourceLaunch, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
    return this.withRunPreparation(selection.runId, options.signal, signal => startNativeRunFromSource(this.kernel, this, selection, { ...options, signal, ...(this.resolveLiveSource ? { resolveLiveSource: this.resolveLiveSource } : {}) }));
  }
  /** Reacquire fresh authority from a saved selection; unresolved model/effect waits still reject start. */
  async rebindLaunch(runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
    return this.withRunPreparation(runId, options.signal, async signal => {
      options = { ...options, signal };
      const launch = await this.launch(runId, options.signal);
      if (!launch) throw new Error('Run has no durable launch selection');
      const source = launch.selection.source;
      if (!source) {
        const mcpNames = new Set(launch.selection.mcp_binding?.tools.map(tool => tool.name) ?? []);
        if (launch.selection.tools.some(tool => !['native_ask_user', 'native_dispatch', 'native_child_status', 'native_wait_child', 'native_child_report'].includes(tool.name) && !mcpNames.has(tool.name))) throw new Error('Saved tools require an explicit Host resource rebind');
        await this.prepareMcp(runId, null, undefined, options.signal);
        return options.credentialOwner ? this.startRunWithCredentialOwner(runId, options.credentialOwner, options.signal) : this.startRun(runId, options.signal);
      }

      const names = { native_file_read: 'file_read', native_file_list: 'file_list', native_file_search: 'file_search', native_file_write: 'file_write', native_file_edit: 'file_edit', native_process_inspect: 'process_inspect', native_process_read: 'process_read', native_process_spawn: 'process_spawn', native_language_definition: 'language_definition', native_language_references: 'language_references', native_language_diagnostics: 'language_diagnostics', native_code_retrieval: 'code_retrieval' } as const;
      const tools = launch.selection.tools.filter(tool => !['native_ask_user', 'native_dispatch', 'native_child_status', 'native_wait_child', 'native_child_report'].includes(tool.name) && !launch.selection.mcp_binding?.tools.some(mcp => mcp.name === tool.name)).map(tool => {
        if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
        return names[tool.name as keyof typeof names];
    });
    return this.startFromSource(this.sourceLaunch(runId, source, tools), options);
    });
  }
  /** Carry a thread's actual materialized environment into an admitted successor Run. */
  async continueFromLaunch(previousRunId: string, runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
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

      const names = { native_file_read: 'file_read', native_file_list: 'file_list', native_file_search: 'file_search', native_file_write: 'file_write', native_file_edit: 'file_edit', native_process_inspect: 'process_inspect', native_process_read: 'process_read', native_process_spawn: 'process_spawn', native_language_definition: 'language_definition', native_language_references: 'language_references', native_language_diagnostics: 'language_diagnostics', native_code_retrieval: 'code_retrieval' } as const;
      const tools = previous.selection.tools.filter(tool => !['native_ask_user', 'native_dispatch', 'native_child_status', 'native_wait_child', 'native_child_report'].includes(tool.name) && !previous.selection.mcp_binding?.tools.some(mcp => mcp.name === tool.name)).map(tool => {
        if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
        return names[tool.name as keyof typeof names];
    });
    return this.startFromSource(this.sourceLaunch(runId, source, tools, previousRunId), options);
    });
  }
  private sourceLaunch(runId: string, source: NonNullable<NativeLaunchIntent['selection']['source']>,
    tools: NativeSourceLaunch['tools'], previousRunId?: string): NativeSourceLaunch {
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
  launch(runId: string, signal?: AbortSignal): Promise<NativeLaunchIntent | null> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.inspect', { runId }, signal);
  }
  pendingLaunches(signal?: AbortSignal): Promise<NativeLaunchIntent[]> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.list', {}, signal);
  }
  /** Pin a selected implementation before any executable launch; retries never change its identity. */
  async preparePolicy(runId: string, signal?: AbortSignal, credentialScope?: Awaited<ReturnType<ExistingHostCredentialOwner['scope']>>): Promise<NativeAgentPolicyBinding | undefined> {
    const preparation = this.kernel.beginNativeRunPreparation(runId);
    signal = signal ? AbortSignal.any([signal, preparation.signal]) : preparation.signal;
    try {
      const existing = this.kernel.nativePolicyBinding(runId);
      if (existing) return existing;
      const run = await this.run(runId, signal);
      signal.throwIfAborted();
      if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error('Run is no longer eligible for policy preparation');
      if (run.configuration && typeof run.configuration === 'object' && 'context_job' in run.configuration) return undefined;
      if (await this.childForThread(run.thread_id, signal)) return undefined;
      const saved = await this.launch(runId, signal);
      const expectsPolicy = saved && saved.selection.policy.name !== 'default+questions+collaboration';
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
          const scope = await this.kernel.registerNativeCredentialOwner(runId, entry.credentialOwner, signal, entry.capability.binding_id);
          registered.push(entry.capability.binding_id);
          const expected = entry.capability.credential_scope;
          if (!expected || scope.reference !== expected.reference || scope.authority !== expected.authority
            || scope.account !== expected.account || scope.generation !== expected.generation) throw new Error('Planning credential scope changed');
        }
        // Rust constructs and checks the tool-free binding; the Host never supplies one.
        await this.kernel.nativeRuntimeRequest('runtime.launch.policy.prepare', { runId, identity: lease.binding.identity,
          policyModels: prepared.map(entry => ({ ...entry.capability, binding: null })) }, signal);
        signal.throwIfAborted();
        return await this.kernel.registerNativePolicyOwner(runId, lease);
      } catch (error) {
        for (const bindingId of registered) this.kernel.unregisterNativeCredentialOwner(runId, bindingId);
        lease.release(); throw error;
      }
    } finally { preparation.release(); }
  }

  async startRun(runId: string, signal?: AbortSignal, toolBinding?: unknown): Promise<NativeRunStartReceipt> {
    return this.withRunPreparation(runId, signal, async signal => {
      const policyBinding = await this.preparePolicy(runId, signal);
      const mcpBinding = this.kernel.nativeMcpBinding(runId);
      try {
        return await this.kernel.nativeRuntimeRequest('runtime.run.start', { runId, ...(policyBinding ? { policyBinding } : {}), ...(mcpBinding ? { mcpBinding } : {}), ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
      } catch (error) { this.kernel.unregisterNativeCredentialOwner(runId); this.kernel.unregisterNativePolicyOwner(runId); throw error; }
    });
  }
  /** Private Host path: only nonsecret pinned scope crosses admission; credentials resolve later. */
  async startRunWithCredentialOwner(runId: string, owner: ExistingHostCredentialOwner, signal?: AbortSignal, toolBinding?: unknown): Promise<NativeRunStartReceipt> {
    return this.withRunPreparation(runId, signal, async signal => {
      const credentialScope = await this.kernel.registerNativeCredentialOwner(runId, owner, signal);
      try {
        const policyBinding = await this.preparePolicy(runId, signal, credentialScope);
        const mcpBinding = this.kernel.nativeMcpBinding(runId);
        return await this.kernel.nativeRuntimeRequest('runtime.run.start', { runId, credentialScope, ...(policyBinding ? { policyBinding } : {}), ...(mcpBinding ? { mcpBinding } : {}),
          ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
      } catch (error) {
        this.kernel.unregisterNativeCredentialOwner(runId);
        this.kernel.unregisterNativePolicyOwner(runId);
        throw error;
      }
    });
  }
  releaseRunCredentialOwner(runId: string): void {
    this.kernel.unregisterNativeCredentialOwner(runId);
    // A parked Run resumes with every frozen planning credential owner freshly rebound.
    this.kernel.unregisterNativePolicyOwner(runId);
  }
  async run(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    const run = await this.kernel.nativeRuntimeRequest<NativeRun, 'runtime.run.inspect'>('runtime.run.inspect', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) { this.kernel.cancelNativeRunPreparation(runId); this.kernel.unregisterNativeCredentialOwner(runId); this.kernel.unregisterNativeMcpOwner(runId); this.kernel.unregisterNativePolicyOwner(runId); }
    return run;
  }
  async cancelRun(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    this.kernel.cancelNativeRunPreparation(runId);
    const run = await this.kernel.nativeRuntimeRequest<NativeRun, 'runtime.run.cancel'>('runtime.run.cancel', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) { this.kernel.cancelNativeRunPreparation(runId); this.kernel.unregisterNativeCredentialOwner(runId); this.kernel.unregisterNativeMcpOwner(runId); this.kernel.unregisterNativePolicyOwner(runId); }
    return run;
  }
  operation(operationId: string, signal?: AbortSignal): Promise<NativeOperation> {
    return this.kernel.nativeRuntimeRequest('runtime.operation.inspect', { operationId }, signal);
  }
  cancelOperation(operationId: string, signal?: AbortSignal): Promise<NativeOperation> {
    return this.kernel.nativeRuntimeRequest('runtime.operation.cancel', { operationId }, signal);
  }
  historyPage(params: NativeHistoryPageParams, signal?: AbortSignal): Promise<NativeHistoryPage> {
    return this.kernel.nativeRuntimeRequest('runtime.history.page', params, signal);
  }
  async historyItem(reference: NativeHistoryReference, signal?: AbortSignal): Promise<NativeHistoryItem> {
    const chunks: Buffer[] = [];
    let count = 1;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const chunk = await this.kernel.nativeRuntimeRequest<NativeHistoryBodyChunk, 'runtime.history.body'>('runtime.history.body', { itemId: reference.id, chunkIndex: index }, signal);
      if (chunk.itemId !== reference.id || chunk.contentRef !== reference.content_ref || chunk.chunkIndex !== index) throw new Error('History content identity changed');
      if (index === 0) { count = chunk.chunkCount; total = chunk.totalBytes; }
      else if (chunk.chunkCount !== count || chunk.totalBytes !== total) throw new Error('History content manifest changed');
      chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== total) throw new Error('History content length does not match its manifest');
    const body = JSON.parse(bytes.toString('utf8')) as Pick<NativeHistoryItem, 'content' | 'provider'>;
    return { id: reference.id, thread_id: reference.thread_id, parent: reference.parent, source: reference.source, content: body.content, provider: body.provider };
  }
  activeOperations(threadId: string, signal?: AbortSignal): Promise<NativeOperation[]> {
    return this.kernel.nativeRuntimeRequest('runtime.thread.operations.active', { threadId }, signal);
  }
  history(branchId: string, signal?: AbortSignal): Promise<NativeHistoryItem[]> {
    return this.kernel.nativeRuntimeRequest('runtime.history.read', { branchId }, signal);
  }
  async observerEvents(observerId: string, threadId: string, limit: number, signal?: AbortSignal, throughCursor?: number): Promise<NativeEvent[]> {
    // Manual inspection can request the current head. The background observer always supplies
    // its already-processed source cursor so scope changes cannot be bypassed by prefetch.
    const head = throughCursor ?? (await this.status(signal)).eventCursor;
    return this.kernel.nativeRuntimeRequest('runtime.observer.read', { observerId, threadId, limit, throughCursor: head }, signal);
  }
  observerDelivery(observerId: string, threadId: string, cursor: number,
    state: 'selected' | 'sent' | 'committed', signal?: AbortSignal): Promise<Record<string, never>> {
    return this.kernel.nativeRuntimeRequest('runtime.observer.delivery', { observerId, threadId, cursor, state }, signal);
  }
  events(cursor: number, limit: number, signal?: AbortSignal): Promise<NativeEvent[]> {
    return this.kernel.nativeRuntimeRequest('runtime.events.read', { cursor, limit }, signal);
  }
}
