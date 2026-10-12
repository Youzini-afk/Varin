/** Dedicated rerank over authorized immutable candidates, sharing the original HTTP owner. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseHarnessRerankSettings, type HarnessRerankResult, type HarnessResolvedRerankBinding, type HarnessRerankSettings } from '@varin/protocol';
import { requestHttpRerank, parseHttpRerankScores, RerankResponseError, type HttpRerankScore } from '@varin/pi-host/rerank';
import type { HostInferenceProviderBinding } from '@varin/pi-host/credentials';
import type { InferenceCall, InferenceInvocationAuthority, InferenceRequests, InferenceRequestsOptions } from './inference-requests.js';
export interface RerankInferenceAuthority {
  resolveRerankBinding(providerId: string, modelId: string, endpoint?: string): Promise<HostInferenceProviderBinding>;
}
export interface RerankInferenceLease {
  readonly binding: HarnessResolvedRerankBinding;
  assertAvailable(signal?: AbortSignal): Promise<void>;
  execute(authority: InferenceInvocationAuthority, input: { query: string; documents: Array<{ id: string; text: string; revision?: string }>; provenance?: unknown },
    signal: AbortSignal, guard?: () => Promise<void>): Promise<HarnessRerankResult>;
  consume(call: InferenceCall, input: { query: string; documents: Array<{ id: string; text: string; revision?: string }>; provenance?: unknown },
    guard?: () => Promise<void>): Promise<HarnessRerankResult>;
  release(): void;
}
export type RerankInferenceCapture = { status: 'ready'; lease: RerankInferenceLease }
  | { status: 'unconfigured' | 'invalid' | 'unavailable'; message?: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function selection(value: unknown) {
  if (!object(value) || value.harness !== undefined && !object(value.harness)) throw new Error('Invalid rerank settings');
  return parseHarnessRerankSettings(object(value.harness) ? value.harness.rerank : undefined);
}
function requireCandidateScores(scores: HttpRerankScore[], candidateCount: number): HttpRerankScore[] {
  if (candidateCount > 0 && scores.length === 0) throw new RerankResponseError('No submitted candidate received a rerank score');
  return scores;
}
export function createRerankInference(authority: RerankInferenceAuthority, settings: () => Promise<unknown>,
  options: InferenceRequestsOptions, requests: InferenceRequests) {
  let closed = false;
  let disabled = false;
  let revocationGeneration = 0;
  const readSelection = async () => {
    const selected = selection(await settings());
    // Removing this optional selection is the existing settings UI's Off action.
    if (!selected && !disabled) revocationGeneration++;
    disabled = !selected;
    return selected;
  };
  return {
    async capture(expected?: HarnessRerankSettings): Promise<RerankInferenceCapture> {
      if (closed) return { status: 'unavailable', message: 'Rerank inference is closed.' };
      let selected;
      try { selected = await readSelection(); if (expected && !isDeepStrictEqual(expected, selected)) return { status: 'unavailable', message: 'Rerank settings changed during query preparation.' }; }
      catch { return { status: 'invalid', message: 'Rerank settings are invalid.' }; }
      if (!selected) return { status: 'unconfigured' };
      let provider: HostInferenceProviderBinding;
      try { provider = await authority.resolveRerankBinding(selected.providerId, selected.modelId, selected.endpoint); }
      catch { return { status: 'unavailable', message: 'The selected rerank connection is unavailable.' }; }
      try { if (!isDeepStrictEqual(await readSelection(), selected)) return { status: 'unavailable', message: 'Rerank settings changed during preparation.' }; }
      catch { return { status: 'invalid', message: 'Rerank settings changed during preparation.' }; }
      const generation = revocationGeneration;
      const binding: HarnessResolvedRerankBinding = Object.freeze({ ...selected,
        ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), configurationId: provider.configurationId });
      let released = false;
      const assertAvailable = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (closed || released) throw new Error('Original rerank binding was released');
        try { await readSelection(); } catch { /* A malformed new candidate cannot retire this accepted binding. */ }
        if (disabled || generation !== revocationGeneration) throw new Error('Rerank was explicitly disabled');
        await provider.assertAvailable();
        signal?.throwIfAborted();
      };
      const consume: RerankInferenceLease['consume'] = async (call, input, guard) => {
            await assertAvailable(call.signal);
            const auth = await provider.getAuth();
            await assertAvailable(call.signal);
            const connection = await options.egress.prepare(provider.requestUrl);
            const scores = requireCandidateScores(await requestHttpRerank({ baseUrl: provider.baseUrl, ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
              ...(auth?.auth.apiKey ? { apiKey: auth.auth.apiKey } : {}),
              ...(auth?.auth.headers ? { headers: Object.fromEntries(Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
              model: binding.modelId, query: input.query, documents: input.documents, signal: call.signal,
              fetchImpl: async (url, init) => {
                const destination = new URL(String(url)).toString();
                if (destination !== provider.requestUrl || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Rerank request binding changed');
                return call.request({ binding: { requestKind: 'model_compute', purpose: 'code-retrieval-rerank',
                  providerId: binding.providerId, modelId: binding.modelId, api: 'http-rerank', endpoint: destination,
                  configurationId: binding.configurationId, credentialScope: provider.credentialScope },
                  request: { input, wire: JSON.parse(init.body) }, destination, init, connection,
                  check: async active => { await assertAvailable(active); await guard?.(); active.throwIfAborted(); },
                  observe: raw => {
                    let valid = false;
                    try { requireCandidateScores(parseHttpRerankScores(raw, input.documents), input.documents.length); valid = true; } catch { /* Receipt precedes projection. */ }
                    // The common rerank protocol has no defined token dimensions. Preserve raw
                    // evidence without inferring input from total or inventing a zero output.
                    return { valid, rawUsage: object(raw) ? { usage: raw.usage ?? null, meta: raw.meta ?? null } : null };
                  },
                });
              },
            }), input.documents.length);
            await assertAvailable(call.signal);
            await guard?.();
            call.signal.throwIfAborted();
            return { batchId: randomUUID(), providerId: binding.providerId, modelId: binding.modelId, scores };
      };
      return { status: 'ready', lease: { binding, assertAvailable, consume, release() { released = true; },
        execute(invocation, input, signal, guard) {
          return requests.run(invocation, signal, async call => {
            await assertAvailable(call.signal);
            await call.assertFresh();
            return consume(call, input, guard);
          });
        },
      } };
    },
    close() { closed = true; },
  };
}
