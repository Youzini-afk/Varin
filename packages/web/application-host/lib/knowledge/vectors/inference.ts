/** Standalone Knowledge embedding consumes the original Catalog UtilityRun and inference transport. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { remoteEmbeddingSpaceParts, type HarnessEmbedParams, type HarnessEmbedResult } from '@varin/protocol';
import { parseOpenAICompatibleEmbeddings } from '@varin/protocol/node/embeddings';
import type { KernelClient } from '../../kernel/kernel-client.js';
import type { ExecutorOwner, KnowledgeInferenceView } from '../../kernel/protocol.generated.js';
import type { SemanticInference, SemanticInferenceLease } from '../semantic/runtime-inference.js';
import { createRemoteEmbedder } from '../semantic/remote-embedder.js';
import type { SemanticEmbedder } from '../semantic/embedder.js';
import { waitWithSignal } from '../../cancellation.js';
export type KnowledgeInferenceLease = Pick<SemanticInferenceLease, 'binding' | 'assertAvailable' | 'countTokens' | 'consume' | 'release'> & {
  identity: unknown;
  local?: SemanticEmbedder;
  retain(): KnowledgeInferenceLease;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function createKnowledgeInference(options: {
  kernel: Pick<KernelClient, 'agentRuntimeRequest'>;
  inference: Pick<SemanticInference, 'requests'>;
}) {
  const owner: ExecutorOwner = { kind: 'external', identity: 'knowledge.inference.v1', epoch: randomUUID() };
  const lifetime = new AbortController();
  const embedders = new Map<string, { lease: KnowledgeInferenceLease; embedder: SemanticEmbedder }>();
  const pending = new Map<string, Promise<HarnessEmbedResult>>();
  const localPending = new Map<SemanticEmbedder, Set<Promise<HarnessEmbedResult>>>();
  const embed = async (scopeId: string, lease: KnowledgeInferenceLease, input: HarnessEmbedParams & { signal?: AbortSignal }): Promise<HarnessEmbedResult> => {
    const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
    await lease.assertAvailable(signal);
    // Content-addressed original requests prevent background retries from re-billing an Unknown batch.
    // Caller batch labels are transport observations, not a reason to repeat the same paid work.
    const key = digest([scopeId, lease.identity, lease.binding, input.purpose, input.items.map(item => item.text)]);
    const operationId = `knowledge-inference:${key}`;
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const params: HarnessEmbedParams = { ...lease.binding, purpose: input.purpose, batchId: key,
          items: input.items.map((item, index) => ({ id: String(index), text: item.text })) };
        const recipe = { binding: lease.binding, identity: lease.identity, params };
        let original = await options.kernel.agentRuntimeRequest<KnowledgeInferenceView | null, 'runtime.knowledge_inference.read'>('runtime.knowledge_inference.read', { operationId, allowMissing: true });
        if (original && !isDeepStrictEqual(original.recipe, recipe)) throw new Error('Original Knowledge embedding recipe changed');
        if (original?.inference.length) {
          const request = original.inference[0]!;
          const state = object(request.result?.kind === 'control' ? request.result.value : undefined);
          const receipt = object(state.receipt);
          const response = object(state.response);
          if (original.inference.length !== 1 || request.phase !== 'terminal' || request.outcome !== 'succeeded'
            || receipt.localExecutorStopped !== true || receipt.providerCompleted !== true || receipt.problem !== null
            || (lease.binding.protocol !== 'local' && typeof response.bodyBase64 !== 'string')) throw new Error('Original Knowledge embedding is unresolved or failed; it will not be replayed');
          if (lease.binding.protocol === 'local') {
            const rows = response.vectors;
            if (!Array.isArray(rows) || rows.length !== params.items.length || rows.some(row => !Array.isArray(row) || row.length !== lease.binding.dimensions || row.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('Original local knowledge vectors are invalid');
            await lease.assertAvailable(signal);
            const dim = lease.binding.dimensions!;
            return { batchId: key, space: { ...lease.binding, dim, maxTokens: lease.binding.maxTokens!, spaceId: digest(remoteEmbeddingSpaceParts({ ...lease.binding, maxTokens: lease.binding.maxTokens!, dimensions: dim })).slice(0, 16) },
              items: rows.map((vector, index) => ({ id: String(index), index, vector })) };
          }
          const raw = JSON.parse(Buffer.from(response.bodyBase64 as string, 'base64').toString('utf8'));
          const parsed = parseOpenAICompatibleEmbeddings(raw, { input: params.items.map(item => item.text), model: params.modelId,
            ...(params.dimensions === undefined ? {} : { dimensions: params.dimensions }) });
          await lease.assertAvailable(signal);
          return { batchId: key, space: { ...lease.binding, maxTokens: lease.binding.maxTokens!, dim: parsed.dim,
            spaceId: digest(remoteEmbeddingSpaceParts({ ...lease.binding, maxTokens: lease.binding.maxTokens!, dimensions: parsed.dim })).slice(0, 16) },
            items: parsed.vectors.map((vector, index) => ({ id: String(index), index, vector })) };
        }
        if (original && (original.finished || original.cancelled || !isDeepStrictEqual(original.executionOwner, owner)))
          throw new Error('Original Knowledge embedding owner is unavailable; it will not be replayed');
        let succeeded = false;
        const cancel = () => { void options.kernel.agentRuntimeRequest('runtime.knowledge_inference.cancel', { operationId }).catch(() => {}); };
        signal.addEventListener('abort', cancel);
        try {
          await lease.assertAvailable(signal);
          try {
            original ??= await options.kernel.agentRuntimeRequest<KnowledgeInferenceView, 'runtime.knowledge_inference.admit'>('runtime.knowledge_inference.admit', {
              key, scopeId, purpose: params.purpose === 'query' ? 'knowledge-query-embedding' : 'knowledge-document-embedding', executionOwner: owner, recipe,
            });
          } catch (error) {
            original = await options.kernel.agentRuntimeRequest<KnowledgeInferenceView | null, 'runtime.knowledge_inference.read'>('runtime.knowledge_inference.read', { operationId, allowMissing: true });
            if (!original || !isDeepStrictEqual(original.recipe, recipe) || !isDeepStrictEqual(original.executionOwner, owner)) throw error;
          }
          if (signal.aborted) cancel();
          signal.throwIfAborted();
          if (!options.inference.requests) throw new Error('Native Knowledge inference transport is unavailable');
          const result = await options.inference.requests.run({ operationId, executorOwner: owner }, signal, async call => {
            await call.assertFresh();
            return lease.consume(call, { ...params, domain: 'knowledge', signal, guard: () => lease.assertAvailable(signal) });
          });
          succeeded = true;
          return result;
        } finally {
          signal.removeEventListener('abort', cancel);
          // run() retains the true response-body/receipt lifetime, including observer cancellation.
          if (original) await options.kernel.agentRuntimeRequest('runtime.knowledge_inference.finish', { operationId, executionOwner: owner, succeeded });
        }
      })();
      pending.set(key, work);
      const source = lease.local;
      const localWork = source ? localPending.get(source) ?? new Set<Promise<HarnessEmbedResult>>() : undefined;
      if (source && localWork) { localWork.add(work); localPending.set(source, localWork); }
      void work.finally(() => {
        if (pending.get(key) === work) pending.delete(key);
        if (source && localWork) {
          localWork.delete(work!);
          if (!localWork.size) localPending.delete(source);
        }
      }).catch(() => {});
    }
    const result = await waitWithSignal(work, signal);
    await lease.assertAvailable(signal);
    return { ...result, batchId: input.batchId, items: result.items.map((item, index) => ({ ...item, id: input.items[index]!.id })) };
  };
  return {
    async resolve(scopeId: string, selected: KnowledgeInferenceLease): Promise<SemanticEmbedder> {
      await selected.assertAvailable(lifetime.signal);
      const key = digest([scopeId, selected.binding, selected.identity]);
      const cached = embedders.get(key);
      if (cached) { await cached.lease.assertAvailable(lifetime.signal); return cached.embedder; }
      const lease = selected.retain();
      if (lease.local) {
        const source = lease.local;
        const local: SemanticEmbedder = { ...source, space: { ...source.space, maxTokens: lease.binding.maxTokens! },
          prepare: async () => { await lease.assertAvailable(lifetime.signal); await source.prepare(); },
          embed: async (texts, params) => {
            const vectors: number[][] = [];
            const grain = source.inferenceBatchSize ?? texts.length;
            for (let offset = 0; offset < texts.length; offset += grain) {
              const result = await embed(scopeId, lease, { ...lease.binding, purpose: params?.purpose ?? 'document', batchId: params?.batchId ?? randomUUID(),
                items: texts.slice(offset, offset + grain).map((text, index) => ({ id: String(index), text })), ...(params?.signal ? { signal: params.signal } : {}) });
              vectors.push(...result.items.map(item => item.vector));
            }
            return vectors;
          },
          embedBatch: async request => {
            const vectors = await local.embed(request.items.map(item => item.text), { purpose: request.purpose, ...(request.signal ? { signal: request.signal } : {}) });
            return { batchId: request.batchId, space: local.space, items: vectors.map((vector, index) => ({ id: request.items[index]!.id, index, vector })) };
          },
        };
        embedders.set(key, { lease, embedder: local });
        return local;
      }
      const remote = createRemoteEmbedder({ binding: lease.binding, countTokens: texts => lease.countTokens(texts),
        client: { embed: input => embed(scopeId, lease, input) } });
      // A credential generation cannot consume another account's cached vectors.
      const embedder: SemanticEmbedder = { ...remote, get space() { const base = remote.space; return { ...base,
        ...(base.spaceId ? { spaceId: digest([base.spaceId, object(lease.identity).credentialScope]).slice(0, 16) } : {}) }; },
        prepare: () => lease.assertAvailable(lifetime.signal) };
      embedders.set(key, { lease, embedder });
      return embedder;
    },
    async retireLocal(source: SemanticEmbedder): Promise<void> {
      const retired = [...embedders].filter(([, value]) => value.lease.local === source);
      for (const [key] of retired) embedders.delete(key);
      // Original requests retain their readers through physical settlement.
      // The component owner rejects new work on this generation before calling us.
      await Promise.allSettled([...(localPending.get(source) ?? [])]);
      for (const [, { lease }] of retired) lease.release();
    },
    async close(): Promise<void> {
      lifetime.abort();
      await Promise.allSettled([...pending.values()]);
      for (const { lease } of embedders.values()) lease.release();
      embedders.clear();
    },
  };
}
