import { startNativeRunFromSource, type NativeSourceLaunch } from './native-source-launch.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import type { KernelClient } from './kernel-client.js';
import type {
  NativeLaunchIntent, NativeLaunchSelectParams, NativeInputSubmitParams, NativeReceipt, NativeRun, NativeOperation,
  NativeHistoryItem, NativeEvent, NativeStatus, NativeRunStartReceipt, NativeInputEnqueueParams, NativeInputReceipt, NativeQueuedInput,
} from './protocol.generated.js';

/** Explicit native-authority client. Existing Pi thread routes are not silently redirected. */
export class NativeRuntimeClient {
  constructor(private readonly kernel: KernelClient) {}

  status(signal?: AbortSignal): Promise<NativeStatus> {
    return this.kernel.nativeRuntimeRequest('runtime.status', {}, signal);
  }
  createThread(threadId: string, branchId: string, signal?: AbortSignal): Promise<{ threadId: string; branchId: string }> {
    return this.kernel.nativeRuntimeRequest('runtime.thread.create', { threadId, branchId }, signal);
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
    const names = { native_file_read: 'file_read', native_process_inspect: 'process_inspect', native_process_read: 'process_read', native_process_spawn: 'process_spawn' } as const;
    const tools = launch.selection.tools.map(tool => {
      if (!(tool.name in names)) throw new Error('Saved capability requires its original extension owner');
      return names[tool.name as keyof typeof names];
    });
    return this.startFromSource({ runId, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      branchId: source.branch_id, revision: source.revision, mode: source.materialized ? 'materialized' : 'fixed_branch', tools }, options);
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
  history(branchId: string, signal?: AbortSignal): Promise<NativeHistoryItem[]> {
    return this.kernel.nativeRuntimeRequest('runtime.history.read', { branchId }, signal);
  }
  events(cursor: number, limit: number, signal?: AbortSignal): Promise<NativeEvent[]> {
    return this.kernel.nativeRuntimeRequest('runtime.events.read', { cursor, limit }, signal);
  }
}
