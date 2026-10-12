/** Decision execution under the existing Host inference owner. Catalog is the only durable
 * authority; these maps retain actual transport promises and unpublished original receipts. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseHarnessFastDecisionSettings, resolveFastDecisionPurpose,
  type HarnessFastDecisionPurpose, type HarnessFastDecisionPurposeStatus, type HarnessFastDecisionResult,
  type HarnessFastDecisionParams, type HarnessResolvedFastDecisionBinding } from '@varin/protocol';
import { requestClassifier, classifierWireUsage, classifierRawUsage, classifierWireResponseValid, ClassifierResponseError } from '@varin/pi-host/classifier';
import type { HostDecisionProviderBinding } from '@varin/pi-host/credentials';
import type { EgressRuntime } from '../../harness/egress.js';
import { ResearchDecisionFailure } from '../../harness/research-decide.js';
import type { AgentRuntimeClient } from '../../kernel/agent-runtime-client.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import type { InferenceBinding, InferenceReceipt, InferenceSettleParams, InferenceStatus, Operation } from '../../kernel/protocol.generated.js';
import type { ToolInvocationAuthority } from '../../kernel/tool-invocation.js';

export interface DecisionInferenceAuthority {
  resolveDecisionBinding(providerId: string, modelId: string, endpoint?: string): Promise<HostDecisionProviderBinding>;
}
export interface DecisionInferenceOptions {
  kernel: Pick<KernelClient, 'agentRuntimeRequest'>;
  runtime: Pick<AgentRuntimeClient, 'onEvent' | 'onExit' | 'onReady'>;
  egress: Pick<EgressRuntime, 'prepare'>;
  onError?(): void;
}
export interface DecisionInferenceLease {
  binding: HarnessResolvedFastDecisionBinding;
  execute(authority: ToolInvocationAuthority, input: Omit<HarnessFastDecisionParams, 'batchId' | 'configurationId' | 'providerId' | 'modelId' | 'protocol'>, signal: AbortSignal, guard?: () => Promise<void>): Promise<HarnessFastDecisionResult>;
  release(): void;
}
export type DecisionInferenceCapture = { status: 'ready'; lease: DecisionInferenceLease }
  | Exclude<HarnessFastDecisionPurposeStatus, { status: 'ready' }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function selection(document: unknown, purpose: HarnessFastDecisionPurpose) {
  if (!object(document) || document.harness !== undefined && !object(document.harness)) throw new Error('decision-settings-invalid');
  return resolveFastDecisionPurpose(parseHarnessFastDecisionSettings(object(document.harness) ? document.harness.fastDecision : undefined), purpose);
}
const cancelled = () => new DOMException('Decision request cancelled', 'AbortError');
const emptyUsage = (): InferenceReceipt['usage'] => ({ measurement: 'missing', inputTokens: null, outputTokens: null });
const knownFailure = (error: unknown): string => {
  const code = object(error) && typeof error.code === 'string' ? error.code : '';
  return code === 'decision-api-unavailable' ? 'The selected classifier API is unavailable. TypeSafe, Cloudflare System One and llama.cpp are supported.'
    : code === 'credential-scope-changed' ? 'The provider credential owner changed. Prepare a new decision.'
      : 'The selected decision connection is unavailable. Check its provider, endpoint and credentials.';
};

export function createDecisionInference(authority: DecisionInferenceAuthority, settings: () => Promise<unknown>, options: DecisionInferenceOptions) {
  let closed = false;
  const revisions = new Map<HarnessFastDecisionPurpose, number>();
  const disabled = new Set<HarnessFastDecisionPurpose>();
  const controllers = new Set<AbortController>();
  const calls = new Set<Promise<unknown>>();
  const active = new Map<string, { owner: ToolInvocationAuthority['executorOwner']; abort: AbortController; cancel(): void }>();
  const pending = new Map<string, InferenceSettleParams>();
  const report = () => options.onError?.();
  const readSelection = async (purpose: HarnessFastDecisionPurpose) => {
    const selected = selection(await settings(), purpose);
    if (selected.status === 'disabled') {
      if (!disabled.has(purpose)) revisions.set(purpose, (revisions.get(purpose) ?? 0) + 1);
      disabled.add(purpose);
    } else disabled.delete(purpose);
    return selected;
  };
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
    if (pending.has(params.operationId)) throw new Error('decision-receipt-publication-pending');
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
  const capture = async (purpose: HarnessFastDecisionPurpose): Promise<DecisionInferenceCapture> => {
    if (closed) return { status: 'unavailable', message: 'Decision inference is closed.' };
    let selected;
    try { selected = await readSelection(purpose); }
    catch { return { status: 'invalid', message: 'Fast decision settings are invalid. Check the selected purpose.' }; }
    if (selected.status !== 'ready') return selected;
    let provider: HostDecisionProviderBinding;
    try { provider = await authority.resolveDecisionBinding(selected.binding.providerId, selected.binding.modelId, selected.binding.endpoint); }
    catch (error) { return { status: 'unavailable', message: knownFailure(error) }; }
    try {
      if (!isDeepStrictEqual(await readSelection(purpose), selected)) return { status: 'unavailable', message: 'Decision settings changed while preparing the connection. Try again.' };
    } catch { return { status: 'invalid', message: 'Fast decision settings changed while preparing the connection.' }; }
    const generation = revisions.get(purpose) ?? 0;
    const binding: HarnessResolvedFastDecisionBinding = Object.freeze({ ...selected.binding,
      ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), configurationId: provider.configurationId });
    let released = false;
    const assertAvailable = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (closed || released) throw new ResearchDecisionFailure('The original decision binding was released.');
      try { await readSelection(purpose); } catch { /* A malformed new candidate cannot retire this accepted binding. */ }
      if (disabled.has(purpose) || generation !== (revisions.get(purpose) ?? 0)) throw new ResearchDecisionFailure('Fast decision was explicitly disabled for this purpose.');
      await provider.assertAvailable();
      signal.throwIfAborted();
    };
    const execute: DecisionInferenceLease['execute'] = (invocation, input, signal, guard) => {
      const work = (async (): Promise<HarnessFastDecisionResult> => {
        const controller = new AbortController();
        let ownerCancelled = false;
        controllers.add(controller);
        const combined = AbortSignal.any([signal, controller.signal]);
        const batchId = randomUUID();
        const base: HarnessFastDecisionResult = { batchId, providerId: binding.providerId, modelId: binding.modelId,
          answers: [], missing: input.questions.map(question => question.id) };
        const receipts: InferenceReceipt[] = [];
        let ordinal = 0;
        const observed = (): HarnessFastDecisionResult => {
          const usage: NonNullable<HarnessFastDecisionResult['usage']> = {};
          for (const field of ['inputTokens', 'outputTokens'] as const) {
            if (receipts.length && receipts.every(receipt => receipt.usage[field] !== null)) usage[field] = receipts.reduce((total, receipt) => total + receipt.usage[field]!, 0);
          }
          return { ...base, ...(Object.keys(usage).length ? { usage } : {}) };
        };
        const assertDelivery = async (result: HarnessFastDecisionResult) => {
          try { await assertAvailable(combined); await guard?.(); combined.throwIfAborted(); }
          catch {
            // Response accounting precedes this fence. Revocation suppresses answers, never
            // the original observed usage/provenance, and never switches to a new binding.
            throw new ResearchDecisionFailure('The original decision connection or material access is no longer available for delivery.',
              { ...result, answers: [], missing: [...base.missing] }, signal.aborted || ownerCancelled);
          }
        };
        try {
          if (input.purpose !== purpose) throw new ResearchDecisionFailure('Decision purpose differs from its frozen binding.');
          await assertAvailable(combined);
          // A recovered tool invocation never restarts the whole SDK batch, including its paid retries.
          const previous = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', {
            operationId: `inference:${invocation.operationId}:1`, allowMissing: true,
          });
          if (previous) throw new ResearchDecisionFailure('This decision already has an inference receipt. Inspect the original Operation before requesting a new decision.', observed());
          const auth = await provider.getAuth();
          await assertAvailable(combined);
          const connection = await options.egress.prepare(provider.requestUrl);
          const fetchImpl: typeof fetch = async (url, init) => {
            const destination = new URL(String(url)).toString();
            const route = provider.routes.find(value => value.requestUrl === destination);
            if (!route || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('decision-request-binding-changed');
            const requestSignal = init.signal ? AbortSignal.any([combined, init.signal]) : combined;
            requestSignal.throwIfAborted();
            await assertAvailable(requestSignal);
            await guard?.();
            requestSignal.throwIfAborted();
            const id = `inference:${invocation.operationId}:${++ordinal}`;
            const executionOwner = invocation.executorOwner;
            const selectedBinding: InferenceBinding = { purpose, providerId: binding.providerId, modelId: binding.modelId,
              api: provider.api, endpoint: destination, requestKind: route.requestKind, configurationId: binding.configurationId, credentialScope: provider.credentialScope };
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
                parentOperationId: invocation.operationId, executionOwner, ordinal, binding: selectedBinding,
                request: { input, wire: JSON.parse(init.body) },
              });
              admitted = true;
              active.set(id, entry);
              observeStatus(status);
              if (!status.live || status.dispatched || status.recovered) throw new Error('decision-original-request-unavailable');
              await assertAvailable(requestSignal);
              const ready = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.dispatch'>('runtime.inference.dispatch', { operationId: id, executionOwner });
              observeStatus(ready);
              if (!ready.live) throw new Error('decision-dispatch-cancelled');
              requestSignal.throwIfAborted();
              started = true;
              // Egress alone owns the dispatcher; SDK transport hints cannot replace its route.
              const { dispatcher: _dispatcher, ...requestInit } = init;
              response = await connection.fetch(destination, { ...requestInit, redirect: 'manual', signal: requestSignal });
              httpStatus = response.status;
              const bytes = new Uint8Array(await response.arrayBuffer());
              responseBody = Buffer.from(bytes).toString('base64');
              completed = true;
              try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Original invalid bytes still belong to this receipt. */ }
              const actual = route.requestKind === 'model_compute' ? classifierWireUsage(provider.api, raw) : undefined;
              if (actual) usage = { measurement: 'actual', inputTokens: actual.inputTokens ?? null, outputTokens: actual.outputTokens ?? null };
              const receipt: InferenceReceipt = { requestStarted: true, providerCompleted: true, localExecutorStopped: true,
                usage, httpStatus, problem: !response.ok ? 'http_rejected' : raw === null ? 'invalid_response'
                  : route.requestKind === 'model_compute' && !classifierWireResponseValid(provider.api, binding.modelId, input.questions, raw) ? 'invalid_response' : null };
              if (route.requestKind === 'model_compute') receipts.push(receipt);
              try { await publish({ operationId: id, executionOwner, receipt, response: { bodyBase64: responseBody, rawUsage: route.requestKind === 'model_compute' ? classifierRawUsage(provider.api, raw) : null } }); }
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
                if (route.requestKind === 'model_compute' && started) receipts.push(receipt);
                try { await publish({ operationId: id, executionOwner, receipt, response: { bodyBase64: responseBody, rawUsage: route.requestKind === 'model_compute' ? classifierRawUsage(provider.api, raw) : null } }); }
                catch { report(); }
              }
              if (requestSignal.aborted) throw cancelled();
              throw error;
            } finally { if (active.get(id) === entry) active.delete(id); }
          };
          const result = await requestClassifier({ baseUrl: provider.baseUrl, ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
            nativeModel: { ...(provider.nativeModel ?? { type: 'classifier' as const, api: provider.api as 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify',
              provider: binding.providerId, id: binding.modelId, name: binding.modelId, input: ['text'] as const, contextWindow: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), baseUrl: provider.baseUrl,
              api: provider.api as 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify' },
            ...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
            ...(auth?.auth.headers ? { headers: Object.fromEntries(Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
            model: binding.modelId, state: { goal: input.goal, materials: input.materials }, questions: input.questions, signal: combined, fetchImpl });
          if (combined.aborted) throw new ResearchDecisionFailure('Decision interrupted after retaining its original provider receipt.', observed(), signal.aborted || ownerCancelled);
          const { usage: _usage, ...answers } = result;
          const projected = { ...observed(), ...answers };
          await assertDelivery(projected);
          return projected;
        } catch (error) {
          if (error instanceof ResearchDecisionFailure) {
            if (!error.result && receipts.length) throw new ResearchDecisionFailure(error.message, observed(), error.cancelled || signal.aborted || ownerCancelled);
            throw error;
          }
          const partial = error instanceof ClassifierResponseError ? error.result : undefined;
          const { usage: _usage, ...answers } = partial ?? {};
          const result = { ...observed(), ...answers };
          if (receipts.length) await assertDelivery(result);
          const wasCancelled = signal.aborted || ownerCancelled;
          throw new ResearchDecisionFailure(wasCancelled ? 'Decision cancelled; inspect its original inference receipt.'
            : 'Decision failed; inspect its original inference receipt and provider configuration.', result, wasCancelled);
        } finally { controllers.delete(controller); }
      })();
      calls.add(work);
      void work.finally(() => calls.delete(work)).catch(() => {});
      return work;
    };
    return { status: 'ready', lease: { binding, execute, release: () => { released = true; } } };
  };
  return { capture,
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort(cancelled());
      await Promise.allSettled([...calls]);
      for (const params of [...pending.values()]) await publish(params);
      for (const remove of removers) remove();
    },
  };
}
