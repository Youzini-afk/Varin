/** Actual HTTP inference lifetime and receipt publication. Catalog is the sole durable owner. */
import { isDeepStrictEqual } from 'node:util';
import type { EgressRuntime } from '../../harness/egress.js';
import type { AgentRuntimeClient } from '../../kernel/agent-runtime-client.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import type { ExecutorOwner, InferenceBinding, InferenceReceipt, InferenceSettleParams, InferenceStatus, Operation, InferenceGenerateParams, InferenceSessionStatus } from '../../kernel/protocol.generated.js';
export interface InferenceInvocationAuthority { operationId: string; executorOwner: ExecutorOwner }
export interface InferenceRequestsOptions {
  kernel: Pick<KernelClient, 'agentRuntimeRequest'> & Partial<Pick<KernelClient, 'kernelEpoch'>>;
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
  /** Exact source-byte fence after durable dispatch intent, immediately before transport. */
  beforeDispatch?(signal: AbortSignal): Promise<void>;
  onReceipt?(receipt: InferenceReceipt): void;
  observe(raw: unknown): { usage?: InferenceReceipt['usage']; rawUsage: unknown; valid: boolean };
}
interface LocalInferenceRequest {
  binding: InferenceBinding & { executor: Extract<InferenceBinding['executor'], { kind: 'local_component' }> };
  request: unknown;
  signal?: AbortSignal;
  check(signal: AbortSignal): Promise<void>;
  beforeDispatch?(signal: AbortSignal): Promise<void>;
  /** Enqueues once; resolves only with worker settlement/exit, including cancellation. */
  execute(signal: AbortSignal, dispatch: () => Promise<void>): Promise<import('./local-execution.js').LocalEmbeddingSettlement>;
}
export interface InferenceCall {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  assertFresh(): Promise<void>;
  request(input: InferenceRequest): Promise<Response>;
  local(input: LocalInferenceRequest): Promise<number[][]>;
  generate(input: {
    request: Omit<InferenceGenerateParams, 'parentOperationId' | 'callerOwner' | 'ordinal'>;
    signal?: AbortSignal;
    check(signal: AbortSignal): Promise<void>;
    register(operationId: string, signal: AbortSignal): Promise<void>;
    release(operationId: string): void;
  }): Promise<string>;
}
const cancelled = () => new DOMException('Inference request cancelled', 'AbortError');
const emptyUsage = (): InferenceReceipt['usage'] => ({ measurement: 'missing', inputTokens: null, outputTokens: null });
export function createInferenceRequests(options: InferenceRequestsOptions) {
  let closed = false;
  const controllers = new Set<AbortController>();
  let change = 0;
  let lostEpoch = 0;
  const waiters = new Set<() => void>();
  const notify = () => { change++; for (const wake of [...waiters]) wake(); };
  const waitForChange = (after: number): Promise<void> => change !== after ? Promise.resolve() : new Promise(resolve => {
    const wake = () => { waiters.delete(wake); resolve(); }; waiters.add(wake);
    if (change !== after) wake();
  });
  const calls = new Set<Promise<unknown>>();
  const sessions = new Map<string, object>();
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
        operationId: params.operationId, executionOwner: params.executionOwner, requestStarted: params.receipt.requestStarted,
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
  const removers = [options.runtime.onEvent(() => { notify(); void reconcile(); }), options.runtime.onReady(() => { notify(); void reconcile(); }),
    options.runtime.onExit(() => { lostEpoch++; for (const controller of controllers) controller.abort(cancelled()); notify(); })];
  const run = <T>(invocation: InferenceInvocationAuthority, signal: AbortSignal, execute: (call: InferenceCall) => Promise<T>,
    delivery?: { deliverBeforeDrain: boolean }): Promise<T> => {
    let result: { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } | undefined;
    if (delivery?.deliverBeforeDrain) {
      let resolve!: (value: T) => void, reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      result = { promise, resolve, reject };
    }
    const work = (async () => {
      if (closed) throw new Error('Inference requests are closed');
      if (sessions.has(invocation.operationId)) throw new Error('Original inference session is already active');
      const session = {};
      sessions.set(invocation.operationId, session);
      const controller = new AbortController();
      let ownerCancelled = false;
      controllers.add(controller);
      const combined = AbortSignal.any([signal, controller.signal]);
      let ordinal = 0;
      let accepting = true;
      const ownedWork = new Set<Promise<unknown>>();
      const own = <T>(execute: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(new Error('Original inference session is closed'));
        const task = execute();
        ownedWork.add(task);
        void task.then(() => ownedWork.delete(task), () => ownedWork.delete(task));
        return task;
      };
      const call: InferenceCall = {
        operationId: invocation.operationId,
        signal: combined,
        get cancelled() { return signal.aborted || ownerCancelled; },
        async assertFresh() {
          combined.throwIfAborted();
          const previous = await options.kernel.agentRuntimeRequest<InferenceSessionStatus, 'runtime.inference.session'>('runtime.inference.session', {
            parentOperationId: invocation.operationId, executionOwner: invocation.executorOwner,
          });
          if (previous.hasRequests) throw new Error('Original inference exists; recovery never restarts its paid request');
        },
        generate(input) { return own(async () => {
          const generationSignal = input.signal ? AbortSignal.any([combined, input.signal]) : combined;
          generationSignal.throwIfAborted();
          await input.check(generationSignal);
          const ownEpoch = lostEpoch;
          const next = ++ordinal;
          const id = `inference:${invocation.operationId}:${next}`;
          let admitted = false;
          let cancelSent = false;
          const cancel = () => {
            notify();
            if (admitted && !cancelSent) {
              cancelSent = true;
              void options.kernel.agentRuntimeRequest('runtime.operation.cancel', { operationId: id }).catch(report);
            }
          };
          generationSignal.addEventListener('abort', cancel);
          try {
            await input.register(id, generationSignal);
            await input.check(generationSignal);
            generationSignal.throwIfAborted();
            let status: InferenceStatus;
            try {
              status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.generate'>('runtime.inference.generate', {
                ...input.request, parentOperationId: invocation.operationId, callerOwner: invocation.executorOwner, ordinal: next,
              });
              admitted = true;
            } catch (error) {
              // Lost admission ACK is resolved by the exact original identity, never another generation.
              const original = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: id, allowMissing: true });
              if (!original || original.execution_owner?.kind !== 'kernel') throw error;
              status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId: id, executionOwner: invocation.executorOwner });
              admitted = true;
            }
            const entry = { owner: invocation.executorOwner, abort: controller, cancel: () => { ownerCancelled = true; controller.abort(cancelled()); } };
            active.set(id, entry);
            if (generationSignal.aborted) cancel();
            while (true) {
              if (lostEpoch !== ownEpoch) throw new Error('Original generation owner was lost; it is not replayed');
              if (status.phase === 'terminal') {
                // Terminal recovery is not body-drain proof. The old worker cannot publish into this epoch.
                if (status.recovered || !status.receipt?.localExecutorStopped) throw new Error('Original generation is indeterminate');
                const original = await options.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: id });
                generationSignal.throwIfAborted();
                await input.check(generationSignal);
                const value = original.result?.kind === 'control' ? original.result.value : undefined;
                const response = value && typeof value === 'object' && 'response' in value ? value.response : undefined;
                const text = response && typeof response === 'object' && 'text' in response ? response.text : undefined;
                if (status.outcome !== 'succeeded' || typeof text !== 'string') throw new Error('Auxiliary generation failed; its original evidence was retained');
                return text;
              }
              const observed = change;
              status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId: id, executionOwner: invocation.executorOwner });
              observeStatus(status);
              if (status.phase !== 'terminal') await waitForChange(observed);
            }
          } finally {
            generationSignal.removeEventListener('abort', cancel);
            active.delete(id);
            input.release(id);
          }
        }); },
        local(input) { return own(async () => {
          const signal = input.signal ? AbortSignal.any([combined, input.signal]) : combined;
          signal.throwIfAborted();
          await input.check(signal);
          signal.throwIfAborted();
          const id = `inference:${invocation.operationId}:${++ordinal}`;
          const executionOwner = invocation.executorOwner;
          const entry = { owner: executionOwner, abort: controller, cancel: () => { ownerCancelled = true; controller.abort(cancelled()); } };
          let admitted = false;
          let settled = false;
          try {
            const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.admit'>('runtime.inference.admit', {
              parentOperationId: invocation.operationId, executionOwner, ordinal, binding: input.binding, request: input.request,
            });
            admitted = true;
            active.set(id, entry);
            observeStatus(status);
            if (status.dispatched || status.recovered || status.phase === 'terminal') { settled = true; throw new Error('inference-original-request-unavailable'); }
            if (!status.live) throw new Error('inference-original-request-unavailable');
            const result = await input.execute(signal, async () => {
              // This callback is invoked by the real worker only after its queue selects this request.
              signal.throwIfAborted();
              await input.check(signal);
              const ready = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.dispatch'>('runtime.inference.dispatch', { operationId: id, executionOwner });
              observeStatus(ready);
              if (!ready.live) throw cancelled();
              signal.throwIfAborted();
              await input.beforeDispatch?.(signal);
              await input.check(signal);
              signal.throwIfAborted();
            });
            const receipt: InferenceReceipt = { requestStarted: result.requestStarted, providerCompleted: result.completed,
              localExecutorStopped: true, usage: result.usage, httpStatus: null,
              problem: result.error ? 'executor_failed' : result.cancelled || signal.aborted ? 'cancelled' : null };
            settled = true;
            try { await publish({ operationId: id, executionOwner, receipt,
              response: result }); }
            catch (error) { controller.abort(cancelled()); throw error; }
            signal.throwIfAborted();
            if (result.error || !result.vectors) throw new Error(result.error ?? 'Local embedding did not complete');
            return result.vectors;
          } catch (error) {
            if (!admitted) {
              try {
                const original = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: id, allowMissing: true });
                admitted = !!original && isDeepStrictEqual(original.execution_owner, executionOwner);
                if (admitted) {
                  settled = true; // Unreadable original dispatch state is not never-started proof.
                  const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId: id, executionOwner });
                  settled = status.dispatched || status.recovered || status.phase === 'terminal';
                }
              } catch { /* Recovery observes the original intent; it never enqueues another request. */ }
            }
            if (admitted && !settled) {
              // execute() throws only during preparation, before enqueue. Every enqueued request
              // resolves with a physical settlement even if cancelled or its worker exits.
              await publish({ operationId: id, executionOwner, receipt: { requestStarted: false, providerCompleted: false,
                localExecutorStopped: true, usage: emptyUsage(), httpStatus: null, problem: signal.aborted ? 'cancelled' : 'not_dispatched' }, response: null });
            }
            throw error;
          } finally { if (active.get(id) === entry) active.delete(id); }
        }); },
        request(input) { return own(async () => {
          if (input.binding.executor.kind !== 'http') throw new Error('HTTP inference requires an HTTP executor');
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
            if (input.beforeDispatch) {
              await input.beforeDispatch(requestSignal);
              await input.check(requestSignal);
              requestSignal.throwIfAborted();
            }
            started = true;
            // Egress alone owns the dispatcher; SDK transport hints cannot replace its route.
            const { dispatcher: _dispatcher, ...requestInit }: RequestInit & { dispatcher?: unknown } = input.init;
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
            if (selectedBinding.requestKind === 'model_compute') input.onReceipt?.(receipt);
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
              if (selectedBinding.requestKind === 'model_compute' && started) input.onReceipt?.(receipt);
              try { await publish({ operationId: id, executionOwner, receipt, response: { bodyBase64: responseBody, rawUsage: selectedBinding.requestKind === 'model_compute' ? input.observe(raw).rawUsage : null } }); }
              catch { report(); }
            }
            if (requestSignal.aborted) throw cancelled();
            throw error;
          } finally { if (active.get(id) === entry) active.delete(id); }
        }); },
      };
      try {
        const value = await execute(call);
        result?.resolve(value);
        return value;
      } catch (error) { result?.reject(error); throw error; }
      finally {
        // Search observers may detach before their actual HTTP body or native generation.
        // Fence late scheduler work, then retain this exact session through real drain.
        accepting = false;
        controller.abort(cancelled());
        await Promise.allSettled([...ownedWork]);
        controllers.delete(controller);
        if (sessions.get(invocation.operationId) === session) sessions.delete(invocation.operationId);
      }
    })();
    calls.add(work);
    void work.finally(() => calls.delete(work)).catch(error => { result?.reject(error); });
    return result?.promise ?? work;
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
