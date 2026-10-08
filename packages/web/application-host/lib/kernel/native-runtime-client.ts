import type { KernelClient } from './kernel-client.js';
import type {
  NativeInputSubmitParams, NativeReceipt, NativeRun, NativeOperation,
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
  startRun(runId: string, signal?: AbortSignal, toolBinding?: unknown): Promise<NativeRunStartReceipt> {
    return this.kernel.nativeRuntimeRequest('runtime.run.start', { runId, ...(toolBinding === undefined ? {} : { toolBinding }) }, signal);
  }
  run(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    return this.kernel.nativeRuntimeRequest('runtime.run.inspect', { runId }, signal);
  }
  cancelRun(runId: string, signal?: AbortSignal): Promise<NativeRun> {
    return this.kernel.nativeRuntimeRequest('runtime.run.cancel', { runId }, signal);
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
