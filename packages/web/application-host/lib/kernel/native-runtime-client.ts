import type { NativeContextJob, NativeContextCheckpoint } from '@varin/application-client';
import { startNativeRunFromSource, type NativeSourceLaunch } from './native-source-launch.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import type { KernelClient } from './kernel-client.js';
import type {
  NativeContextJobCreateParams, NativeHistoryPage, NativeHistoryPageParams, NativeHistoryReference, NativeHistoryBodyChunk, NativeRunReconcileResult, NativeThreadSummary, NativeLaunchIntent, NativeLaunchSelectParams, NativeInputSubmitParams, NativeReceipt, NativeRun, NativeOperation,
  NativeHistoryItem, NativeEvent, NativeStatus, NativeRunStartReceipt, NativeInputEnqueueParams, NativeInputReceipt, NativeQueuedInput,
} from './protocol.generated.js';

/** Explicit native-authority client. Existing Pi thread routes are not silently redirected. */
export class NativeRuntimeClient {
  constructor(private readonly kernel: KernelClient) {}

  onExit(listener: (error: Error) => void): () => void { return this.kernel.subscribeExit(listener); }

  onEvent(listener: Parameters<KernelClient["onNativeRuntimeEvent"]>[0]): () => void {
    return this.kernel.onNativeRuntimeEvent(listener);
  }

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
  startFromSource(selection: NativeSourceLaunch, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
    return startNativeRunFromSource(this.kernel, this, selection, options);
  }
  /** Reacquire fresh authority from a saved selection; unresolved model/effect waits still reject start. */
  async rebindLaunch(runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
    const launch = await this.launch(runId, options.signal);
    if (!launch) throw new Error('Run has no durable launch selection');
    const source = launch.selection.source;
    if (!source) {
      if (launch.selection.tools.length) throw new Error('Saved tools require an explicit Host resource rebind');
      return options.credentialOwner ? this.startRunWithCredentialOwner(runId, options.credentialOwner, options.signal) : this.startRun(runId, options.signal);
    }
    if (source.branch_id === null || source.revision === null) throw new Error('Saved environment requires its original Host resource owner');
    const names = { native_file_read: 'file_read', native_file_write: 'file_write', native_file_edit: 'file_edit', native_process_inspect: 'process_inspect', native_process_read: 'process_read', native_process_spawn: 'process_spawn' } as const;
    const tools = launch.selection.tools.map(tool => {
      if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
      return names[tool.name as keyof typeof names];
    });
    return this.startFromSource({ runId, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      branchId: source.branch_id, revision: source.revision, mode: source.materialized ? 'materialized' : 'fixed_branch', tools,
      ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}) }, options);
  }
  /** Carry a thread's actual materialized environment into an admitted successor Run. */
  async continueFromLaunch(previousRunId: string, runId: string, options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {}): Promise<NativeRunStartReceipt> {
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
      return options.credentialOwner ? this.startRunWithCredentialOwner(runId, options.credentialOwner, options.signal) : this.startRun(runId, options.signal);
    }
    if (source.branch_id === null || source.revision === null) throw new Error('Environment continuation requires its original Host resource owner');
    const names = { native_file_read: 'file_read', native_file_write: 'file_write', native_file_edit: 'file_edit', native_process_inspect: 'process_inspect', native_process_read: 'process_read', native_process_spawn: 'process_spawn' } as const;
    const tools = previous.selection.tools.map(tool => {
      if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
      return names[tool.name as keyof typeof names];
    });
    return this.startFromSource({ runId, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      branchId: source.branch_id, revision: source.revision, mode: source.materialized ? 'materialized' : 'fixed_branch', tools,
      ...(source.materialized ? { environmentRunId: source.environment_run_id ?? previousRunId } : {}) }, options);
  }
  launch(runId: string, signal?: AbortSignal): Promise<NativeLaunchIntent | null> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.inspect', { runId }, signal);
  }
  pendingLaunches(signal?: AbortSignal): Promise<NativeLaunchIntent[]> {
    return this.kernel.nativeRuntimeRequest('runtime.launch.list', {}, signal);
  }
  startRun(runId: string, signal?: AbortSignal, toolBinding?: unknown): Promise<NativeRunStartReceipt> {
    return this.kernel.nativeRuntimeRequest('runtime.run.start', { runId, ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
  }
  /** Private Host path: only nonsecret pinned scope crosses admission; credentials resolve later. */
  async startRunWithCredentialOwner(runId: string, owner: ExistingHostCredentialOwner, signal?: AbortSignal, toolBinding?: unknown): Promise<NativeRunStartReceipt> {
    const credentialScope = await this.kernel.registerNativeCredentialOwner(runId, owner);
    try {
      return await this.kernel.nativeRuntimeRequest('runtime.run.start', { runId, credentialScope,
        ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
    } catch (error) {
      this.kernel.unregisterNativeCredentialOwner(runId);
      throw error;
    }
  }
  releaseRunCredentialOwner(runId: string): void { this.kernel.unregisterNativeCredentialOwner(runId); }
  async run(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    const run = await this.kernel.nativeRuntimeRequest<NativeRun, 'runtime.run.inspect'>('runtime.run.inspect', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) this.kernel.unregisterNativeCredentialOwner(runId);
    return run;
  }
  async cancelRun(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    const run = await this.kernel.nativeRuntimeRequest<NativeRun, 'runtime.run.cancel'>('runtime.run.cancel', { runId }, signal);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) this.kernel.unregisterNativeCredentialOwner(runId);
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
  events(cursor: number, limit: number, signal?: AbortSignal): Promise<NativeEvent[]> {
    return this.kernel.nativeRuntimeRequest('runtime.events.read', { cursor, limit }, signal);
  }
}
