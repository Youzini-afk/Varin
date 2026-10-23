import type { HarnessEmbedResult } from '@varin/protocol';
import type { KnowledgeInferenceLease } from './inference.js';
import type { SemanticEmbedder } from '../semantic/embedder.js';
import { remoteEmbeddingSpaceId } from '../semantic/identity.js';

/** Retains the actual component generation while Catalog owns each original request. */
export function captureKnowledgeLocalLease(source: SemanticEmbedder, check: (signal?: AbortSignal) => Promise<void>): KnowledgeInferenceLease {
  if (source.status !== 'ready' || !source.localExecution || !source.retain || !source.space.configurationId) throw new Error('Local embedding component is not installed or unavailable');
  const execution = source.localExecution;
  // Tokenizer framing and packing overhead stay inside the model context.
  const maxTokens = Math.max(1, Math.floor(source.space.maxTokens * 0.9));
  const binding = { protocol: 'local' as const, providerId: source.space.provider, modelId: source.space.model,
    configurationId: source.space.configurationId, dimensions: source.space.dim, maxTokens };
  const identity = { ...binding, executor: execution.identity };
  const spaceId = remoteEmbeddingSpaceId({ ...binding, dimensions: source.space.dim });
  const retain = (): KnowledgeInferenceLease => {
    const releaseGeneration = source.retain!();
    let released = false;
    const assertAvailable = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (released) throw new Error('Local knowledge embedding lease was released');
      await check(signal);
      signal?.throwIfAborted();
      if (released) throw new Error('Local knowledge embedding lease was released');
    };
    return {
      binding, identity, local: source,
      assertAvailable,
      countTokens: async texts => { await assertAvailable(); await source.prepare(); return texts.map(text => source.countTokens(text)); },
      retain: () => { if (released) throw new Error('Local knowledge embedding lease was released'); return retain(); },
      release: () => { if (!released) { released = true; releaseGeneration(); } },
      consume: async (call, params): Promise<HarnessEmbedResult> => {
        const signal = params.signal ? AbortSignal.any([call.signal, params.signal]) : call.signal;
        const validate = async () => { await assertAvailable(signal); await params.guard(); signal.throwIfAborted(); };
        await validate();
        await source.prepare();
        const texts = params.items.map(item => item.text);
        const lengths = texts.map(text => source.countTokens(text));
        if (lengths.some(count => count > maxTokens)) throw new Error('Local embedding input exceeds the model packing window');
        const vectors = await call.local({
          binding: { requestKind: 'model_compute', purpose: params.purpose === 'query' ? 'knowledge-query-embedding' : 'knowledge-document-embedding',
            providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId, executor: execution.identity },
          request: { purpose: params.purpose, texts, dimensions: binding.dimensions }, signal, check: validate,
          execute: (active, beforeDispatch) => execution.batch(texts, { signal: active, beforeDispatch,
            priority: params.purpose === 'query' ? 'foreground' : 'background', tokenLengths: lengths }),
        });
        await validate();
        if (vectors.length !== texts.length || vectors.some(row => row.length !== binding.dimensions || row.some(value => !Number.isFinite(value)))) throw new Error('Local embedding returned invalid vectors');
        return { batchId: params.batchId, space: { ...binding, dim: binding.dimensions, spaceId },
          items: vectors.map((vector, index) => ({ id: params.items[index]!.id, index, vector })) };
      },
    };
  };
  return retain();
}
