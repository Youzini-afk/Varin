import type { KernelClient } from './kernel-client.js';
import type {
  NativeInputSubmitParams, NativeReceipt, NativeRun, NativeOperation,
  NativeHistoryItem, NativeEvent, NativeStatus,
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
