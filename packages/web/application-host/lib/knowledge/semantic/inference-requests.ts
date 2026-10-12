/** Actual HTTP inference lifetime and receipt publication. Catalog is the sole durable owner. */
import { isDeepStrictEqual } from 'node:util';
import type { EgressRuntime } from '../../harness/egress.js';
import type { AgentRuntimeClient } from '../../kernel/agent-runtime-client.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import type { ExecutorOwner, InferenceBinding, InferenceReceipt, InferenceSettleParams, InferenceStatus, Operation } from '../../kernel/protocol.generated.js';
export interface InferenceInvocationAuthority { operationId: string; executorOwner: ExecutorOwner }
export interface InferenceRequestsOptions {
  kernel: Pick<KernelClient, 'agentRuntimeRequest'>;
  runtime: Pick<AgentRuntimeClient, 'onEvent' | 'onExit' | 'onReady'>;
  egress: Pick<EgressRuntime, 'prepare'>;
  onError?(): void;
}
interface InferenceRequest {
  binding: InferenceBinding;
  request: unknown;
  destination: string;
  init: RequestInit;
  connection: Awaited<ReturnType<EgressRuntime['prepare']>>;
  check(signal: AbortSignal): Promise<void>;
  observe(raw: unknown): { usage?: InferenceReceipt['usage']; rawUsage: unknown; valid: boolean };
}
export interface InferenceCall {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly receipts: readonly InferenceReceipt[];
  assertFresh(): Promise<void>;
  request(input: InferenceRequest): Promise<Response>;
}
const cancelled = () => new DOMException('Inference request cancelled', 'AbortError');
const emptyUsage = (): InferenceReceipt['usage'] => ({ measurement: 'missing', inputTokens: null, outputTokens: null });
export function createInferenceRequests(options: InferenceRequestsOptions) {
  let closed = false;
  const controllers = new Set<AbortController>();
  const calls = new Set<Promise<unknown>>();
  const active = new Map<string, { owner: ExecutorOwner; abort: AbortController; cancel(): void }>();
  const pending = new Map<string, InferenceSettleParams>();
  const report = () => options.onError?.();
  const protections = new Map<string, { promise: Promise<void>; release(): void }>();
  const protect = (id: string) => {
    let current = protections.get(id);
    if (!current) {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      current = { promise, release }; protections.set(id, current);
    }
    return current;
  };
  const observeStatus = (status: InferenceStatus) => {
    const entry = active.get(status.operationId);
    if (!entry) return;
    if (status.cancelRequested || status.outcome === 'cancelled') entry.cancel();
    else if (!status.live && (status.phase !== 'terminal' || status.recovered || !status.receipt?.localExecutorStopped)) entry.abort.abort(cancelled());
  };
  const attemptPublication = async (params: InferenceSettleParams): Promise<boolean> => {
    try {
      observeStatus(await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.settle'>('runtime.inference.settle', params));
      if (pending.get(params.operationId) === params) pending.delete(params.operationId);
      protections.get(params.operationId)?.release();
      protections.delete(params.operationId);
      return true;
    } catch { report(); }
    try {
      // The transport is drained, but its original bytes are not durably acknowledged.
      // Missing usage is a Catalog/Goal barrier, not a synthesized zero-cost receipt.
      observeStatus(await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.receipt_pending'>('runtime.inference.receipt_pending', {
        operationId: params.operationId, executionOwner: params.executionOwner, requestStarted: params.receipt.requestStarted === true,
      }));
      protections.get(params.operationId)?.release();
    } catch { report(); }
    return !pending.has(params.operationId);
  };
  const publish = async (params: InferenceSettleParams): Promise<void> => {
    pending.set(params.operationId, params);
    const protection = protect(params.operationId);
    if (await attemptPublication(params)) { protections.delete(params.operationId); return; }
    // Both writes failing retains the original callback. Event/ready reconciliation can
    // publish these exact bytes or the Missing barrier; caller cancellation is not proof.
    await protection.promise;
    if (pending.has(params.operationId)) throw new Error('inference-receipt-publication-pending');
    protections.delete(params.operationId);
  };
  let reconciling: Promise<void> | undefined;
  let dirty = false;
  const reconcile = () => {
    dirty = true;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      while (dirty) {
        dirty = false;
        for (const [id, entry] of active) {
          try {
            const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId: id, executionOwner: entry.owner });
            if (active.get(id) === entry) observeStatus(status);
          } catch { if (active.get(id) === entry) entry.abort.abort(cancelled()); report(); }
        }
        for (const params of [...pending.values()]) {
          await attemptPublication(params);
        }
      }
    })().finally(() => { reconciling = undefined; });
    return reconciling;
  };
  const removers = [options.runtime.onEvent(() => { void reconcile(); }), options.runtime.onReady(() => { void reconcile(); }),
    options.runtime.onExit(() => { for (const controller of controllers) controller.abort(cancelled()); })];
  const run = <T>(invocation: InferenceInvocationAuthority, signal: AbortSignal, execute: (call: InferenceCall) => Promise<T>): Promise<T> => {
    const work = (async () => {
      if (closed) throw new Error('Inference requests are closed');
      const controller = new AbortController();
      let ownerCancelled = false;
      controllers.add(controller);
      const combined = AbortSignal.any([signal, controller.signal]);
      const receipts: InferenceReceipt[] = [];
      let ordinal = 0;
      const call: InferenceCall = {
        signal: combined, receipts,
        get cancelled() { return signal.aborted || ownerCancelled; },
        async assertFresh() {
          combined.throwIfAborted();
          const previous = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', {
            operationId: `inference:${invocation.operationId}:1`, allowMissing: true,
          });
          if (previous) throw new Error('Original inference exists; recovery never restarts its paid request');
        },
        async request(input) {
          const requestSignal = input.init.signal ? AbortSignal.any([combined, input.init.signal]) : combined;
          requestSignal.throwIfAborted();
          await input.check(requestSignal);
          requestSignal.throwIfAborted();
          const id = `inference:${invocation.operationId}:${++ordinal}`;
          const executionOwner = invocation.executorOwner;
          const selectedBinding = input.binding;
          let admitted = false;
          let started = false;
          let completed = false;
          let responseBody: string | null = null;
          let httpStatus: number | null = null;
          let usage = emptyUsage();
          let raw: unknown = null;
          let response: Response | undefined;
          const entry = { owner: executionOwner, abort: controller, cancel: () => { ownerCancelled = true; controller.abort(cancelled()); } };
          // Global listeners are already installed. Register the durable identity after admission ACK.
          try {
            const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.admit'>('runtime.inference.admit', {
              parentOperationId: invocation.operationId, executionOwner, ordinal, binding: selectedBinding, request: input.request,
            });
            admitted = true;
            active.set(id, entry);
            observeStatus(status);
            if (!status.live || status.dispatched || status.recovered) throw new Error('inference-original-request-unavailable');
            await input.check(requestSignal);
            const ready = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.dispatch'>('runtime.inference.dispatch', { operationId: id, executionOwner });
            observeStatus(ready);
            if (!ready.live) throw new Error('inference-dispatch-cancelled');
            requestSignal.throwIfAborted();
            started = true;
            // Egress alone owns the dispatcher; SDK transport hints cannot replace its route.
            const { dispatcher: _dispatcher, ...requestInit } = input.init;
            response = await input.connection.fetch(input.destination, { ...requestInit, redirect: 'manual', signal: requestSignal });
            httpStatus = response.status;
            const bytes = new Uint8Array(await response.arrayBuffer());
            responseBody = Buffer.from(bytes).toString('base64');
            completed = true;
            try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Original invalid bytes still belong to this receipt. */ }
            const observed = input.observe(raw);
            if (observed.usage) usage = observed.usage;
            const receipt: InferenceReceipt = { requestStarted: true, providerCompleted: true, localExecutorStopped: true,
              usage, httpStatus, problem: !response.ok ? 'http_rejected' : raw === null || !observed.valid ? 'invalid_response' : null };
            if (selectedBinding.requestKind === 'model_compute') receipts.push(receipt);
            try { await publish({ operationId: id, executionOwner, receipt, response: { bodyBase64: responseBody, rawUsage: observed.rawUsage } }); }
            catch (error) { controller.abort(cancelled()); throw error; }
            // The SDK receives exactly these already drained bytes. Cancellation cannot erase their usage.
            return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
          } catch (error) {
            if (!admitted) {
              // Admission ACK can be lost. Reconcile only this exact original identity, never resend HTTP.
              try {
                const original = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: id, allowMissing: true });
                admitted = !!original && isDeepStrictEqual(original.execution_owner, executionOwner);
              } catch { /* Original durable admission remains inspectable after owner recovery. */ }
            }
            if (admitted && !completed) {
              const receipt: InferenceReceipt = { requestStarted: started, providerCompleted: false, localExecutorStopped: true,
                usage, httpStatus, problem: requestSignal.aborted ? 'cancelled' : started ? 'transport_failed' : 'not_dispatched' };
              if (selectedBinding.requestKind === 'model_compute' && started) receipts.push(receipt);
              try { await publish({ operationId: id, executionOwner, receipt, response: { bodyBase64: responseBody, rawUsage: selectedBinding.requestKind === 'model_compute' ? input.observe(raw).rawUsage : null } }); }
              catch { report(); }
            }
            if (requestSignal.aborted) throw cancelled();
            throw error;
          } finally { if (active.get(id) === entry) active.delete(id); }
        },
      };
      try { return await execute(call); }
      finally { controllers.delete(controller); }
    })();
    calls.add(work);
    void work.finally(() => calls.delete(work)).catch(() => {});
    return work;
  };
  return { run,
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort(cancelled());
      await Promise.allSettled([...calls]);
      for (const params of [...pending.values()]) await publish(params);
      for (const remove of removers) remove();
    },
  };
}
export type InferenceRequests = ReturnType<typeof createInferenceRequests>;
