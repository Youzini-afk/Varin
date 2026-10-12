/** Classifier selection and interpretation under the shared Host inference request owner. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseHarnessFastDecisionSettings, resolveFastDecisionPurpose,
  type HarnessFastDecisionPurpose, type HarnessFastDecisionPurposeStatus, type HarnessFastDecisionResult,
  type HarnessFastDecisionParams, type HarnessResolvedFastDecisionBinding } from '@varin/protocol';
import { requestClassifier, classifierWireUsage, classifierRawUsage, classifierWireResponseValid, ClassifierResponseError } from '@varin/pi-host/classifier';
import type { HostInferenceProviderBinding } from '@varin/pi-host/credentials';
import type { InferenceInvocationAuthority, InferenceRequests, InferenceRequestsOptions } from './inference-requests.js';
import { ResearchDecisionFailure } from '../../harness/research-decide.js';
import type { InferenceBinding } from '../../kernel/protocol.generated.js';

export interface DecisionInferenceAuthority {
  resolveDecisionBinding(providerId: string, modelId: string, endpoint?: string): Promise<HostInferenceProviderBinding>;
}
export interface DecisionInferenceSession {
  decide(input: Omit<HarnessFastDecisionParams, 'batchId' | 'configurationId' | 'providerId' | 'modelId' | 'protocol'>, guard?: () => Promise<void>): Promise<HarnessFastDecisionResult>;
}
export interface DecisionInferenceLease {
  binding: HarnessResolvedFastDecisionBinding;
  assertAvailable(signal: AbortSignal): Promise<void>;
  run<T>(authority: InferenceInvocationAuthority, signal: AbortSignal, consume: (session: DecisionInferenceSession) => Promise<T>): Promise<T>;
  release(): void;
}
export type DecisionInferenceCapture = { status: 'ready'; lease: DecisionInferenceLease }
  | Exclude<HarnessFastDecisionPurposeStatus, { status: 'ready' }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function selection(document: unknown, purpose: HarnessFastDecisionPurpose) {
  if (!object(document) || document.harness !== undefined && !object(document.harness)) throw new Error('decision-settings-invalid');
  return resolveFastDecisionPurpose(parseHarnessFastDecisionSettings(object(document.harness) ? document.harness.fastDecision : undefined), purpose);
}
const knownFailure = (error: unknown): string => {
  const code = object(error) && typeof error.code === 'string' ? error.code : '';
  return code === 'decision-api-unavailable' ? 'The selected classifier API is unavailable. TypeSafe, Cloudflare System One and llama.cpp are supported.'
    : code === 'credential-scope-changed' ? 'The provider credential owner changed. Prepare a new decision.'
      : 'The selected decision connection is unavailable. Check its provider, endpoint and credentials.';
};

export function createDecisionInference(authority: DecisionInferenceAuthority, settings: () => Promise<unknown>, options: InferenceRequestsOptions, requests: InferenceRequests) {
  let closed = false;
  const revisions = new Map<HarnessFastDecisionPurpose, number>();
  const disabled = new Set<HarnessFastDecisionPurpose>();
  const readSelection = async (purpose: HarnessFastDecisionPurpose) => {
    const selected = selection(await settings(), purpose);
    if (selected.status === 'disabled') {
      if (!disabled.has(purpose)) revisions.set(purpose, (revisions.get(purpose) ?? 0) + 1);
      disabled.add(purpose);
    } else disabled.delete(purpose);
    return selected;
  };
  const capture = async (purpose: HarnessFastDecisionPurpose): Promise<DecisionInferenceCapture> => {
    if (closed) return { status: 'unavailable', message: 'Decision inference is closed.' };
    let selected;
    try { selected = await readSelection(purpose); }
    catch { return { status: 'invalid', message: 'Fast decision settings are invalid. Check the selected purpose.' }; }
    if (selected.status !== 'ready') return selected;
    let provider: HostInferenceProviderBinding;
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
    const run: DecisionInferenceLease['run'] = (invocation, signal, consume) => {
      return requests.run(invocation, signal, async call => {
        const combined = call.signal;
        await assertAvailable(combined);
        // One original query/tool session owns every batch and actual HTTP ordinal.
        // Recovered work never restarts even the first paid request.
        await call.assertFresh();
        return consume({ decide: async (input, guard) => {
          const receiptStart = call.receipts.length;
          const batchId = randomUUID();
          const base: HarnessFastDecisionResult = { batchId, providerId: binding.providerId, modelId: binding.modelId,
            answers: [], missing: input.questions.map(question => question.id) };
          const receipts = () => call.receipts.slice(receiptStart);
          const observed = (): HarnessFastDecisionResult => {
            const usage: NonNullable<HarnessFastDecisionResult['usage']> = {};
            const batchReceipts = receipts();
            for (const field of ['inputTokens', 'outputTokens'] as const) {
              if (batchReceipts.length && batchReceipts.every(receipt => receipt.usage[field] !== null)) usage[field] = batchReceipts.reduce((total, receipt) => total + receipt.usage[field]!, 0);
            }
            return { ...base, ...(Object.keys(usage).length ? { usage } : {}) };
          };
          const assertDelivery = async (result: HarnessFastDecisionResult) => {
            try { await assertAvailable(combined); await guard?.(); combined.throwIfAborted(); }
            catch {
              // Response accounting precedes this fence. Revocation suppresses answers, never
              // the original observed usage/provenance, and never switches to a new binding.
              throw new ResearchDecisionFailure('The original decision connection or material access is no longer available for delivery.',
                { ...result, answers: [], missing: [...base.missing] }, call.cancelled);
            }
          };
          try {
            if (input.purpose !== purpose) throw new ResearchDecisionFailure('Decision purpose differs from its frozen binding.');
            await assertAvailable(combined);
            const auth = await provider.getAuth();
            await assertAvailable(combined);
            const connection = await options.egress.prepare(provider.requestUrl);
            const fetchImpl: typeof fetch = async (url, init) => {
              const destination = new URL(String(url)).toString();
              const route = provider.routes.find(value => value.requestUrl === destination);
              if (!route || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('decision-request-binding-changed');
              const selectedBinding: InferenceBinding = { purpose, providerId: binding.providerId, modelId: binding.modelId,
                api: provider.api, endpoint: destination, requestKind: route.requestKind, configurationId: binding.configurationId, credentialScope: provider.credentialScope };
              return call.request({ binding: selectedBinding, request: { input, wire: JSON.parse(init.body) }, destination, init, connection,
                check: async requestSignal => { await assertAvailable(requestSignal); await guard?.(); requestSignal.throwIfAborted(); },
                observe: raw => {
                  const actual = route.requestKind === 'model_compute' ? classifierWireUsage(provider.api, raw) : undefined;
                  return { ...(actual ? { usage: { measurement: 'actual' as const, inputTokens: actual.inputTokens ?? null, outputTokens: actual.outputTokens ?? null } } : {}),
                    rawUsage: route.requestKind === 'model_compute' ? classifierRawUsage(provider.api, raw) : null,
                    valid: route.requestKind !== 'model_compute' || classifierWireResponseValid(provider.api, binding.modelId, input.questions, raw) };
                } });
            };
            const result = await requestClassifier({ baseUrl: provider.baseUrl, ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
              nativeModel: { ...(provider.nativeModel ?? { type: 'classifier' as const, api: provider.api as 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify',
                provider: binding.providerId, id: binding.modelId, name: binding.modelId, input: ['text'] as const, contextWindow: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), baseUrl: provider.baseUrl,
                api: provider.api as 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify' },
              ...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
              ...(auth?.auth.headers ? { headers: Object.fromEntries(Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
              model: binding.modelId, state: { goal: input.goal, materials: input.materials }, questions: input.questions, signal: combined, fetchImpl });
            if (combined.aborted) throw new ResearchDecisionFailure('Decision interrupted after retaining its original provider receipt.', observed(), call.cancelled);
            const { usage: _usage, ...answers } = result;
            const projected = { ...observed(), ...answers };
            await assertDelivery(projected);
            return projected;
          } catch (error) {
            if (error instanceof ResearchDecisionFailure) {
              if (!error.result && receipts().length) throw new ResearchDecisionFailure(error.message, observed(), error.cancelled || call.cancelled);
              throw error;
            }
            const partial = error instanceof ClassifierResponseError ? error.result : undefined;
            const { usage: _usage, ...answers } = partial ?? {};
            const result = { ...observed(), ...answers };
            if (receipts().length) await assertDelivery(result);
            const wasCancelled = call.cancelled;
            throw new ResearchDecisionFailure(wasCancelled ? 'Decision cancelled; inspect its original inference receipt.'
              : 'Decision failed; inspect its original inference receipt and provider configuration.', result, wasCancelled);
          }
        } });
      });
    };
    return { status: 'ready', lease: { binding, assertAvailable, run, release: () => { released = true; } } };
  };
  return { capture, close() { closed = true; } };
}
