import type { SemanticEmbedder } from './embedder.js';
import type { InferenceCall } from './inference-requests.js';
import type { LocalEmbeddingExecution } from './local-execution.js';

/** Native foreground lease. The HTTP/index DTOs intentionally do not describe local execution. */
export interface LocalInferenceLease {
  readonly identity: LocalEmbeddingExecution['identity'];
  readonly space: SemanticEmbedder['space'] & { configurationId: string };
  retain(): LocalInferenceLease;
  release(): void;
  assertAvailable(signal?: AbortSignal): Promise<void>;
  queryEmbedder(call: InferenceCall, input: {
    guard(signal: AbortSignal): Promise<void>;
    beforeDispatch?(signal: AbortSignal): Promise<void>;
    cached?: number[];
  }): SemanticEmbedder;
}
export function captureLocalInference(embedder: SemanticEmbedder, check: (signal?: AbortSignal) => Promise<void>): LocalInferenceLease {
  const execution = embedder.localExecution;
  if (embedder.status !== 'ready' || !execution || !embedder.retain || !embedder.space.configurationId) throw new Error('Installed local encoder is unavailable');
  const space = { ...embedder.space, configurationId: embedder.space.configurationId };
  const retain = (): LocalInferenceLease => {
    const releaseGeneration = embedder.retain!();
    const controller = new AbortController();
    let released = false;
    const assertAvailable = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (released) throw new Error('Local inference lease was released');
      await check(signal);
      signal?.throwIfAborted();
      if (released) throw new Error('Local inference lease was released');
    };
    return {
      identity: execution.identity, space,
      retain: () => { if (released) throw new Error('Local inference lease was released'); return retain(); },
      release: () => { if (released) return; released = true; controller.abort(); releaseGeneration(); },
      assertAvailable,
      queryEmbedder: (call, input) => {
        const result: SemanticEmbedder = {
          status: 'ready', space: { ...embedder.space }, ownsScheduling: true,
          prepare: async () => { await assertAvailable(call.signal); await embedder.prepare(); },
          countTokens: text => embedder.countTokens(text),
          embed: async (texts, params) => {
            const releaseWork = embedder.retain!();
            try {
              const signal = AbortSignal.any([call.signal, controller.signal, ...(params?.signal ? [params.signal] : [])]);
              const validate = async () => { await assertAvailable(signal); await input.guard(signal); signal.throwIfAborted(); };
              await validate();
              const purpose = params?.purpose ?? 'document';
              if (input.cached) {
                if (purpose !== 'query' || texts.length !== 1 || input.cached.length !== embedder.space.dim || input.cached.some(value => !Number.isFinite(value))) {
                  throw new Error('Local embedding cache identity is invalid');
                }
                return [[...input.cached]];
              }
              await embedder.prepare();
              const vectors: number[][] = [];
              const grain = embedder.inferenceBatchSize ?? texts.length;
              for (let offset = 0; offset < texts.length; offset += grain) {
                await validate();
                const batch = texts.slice(offset, offset + grain);
                const rows = await call.local({
                  binding: { requestKind: 'model_compute', purpose: purpose === 'query' ? 'code-retrieval-query-embedding' : 'code-retrieval-document-embedding',
                    providerId: embedder.space.provider, modelId: embedder.space.model, configurationId: embedder.space.configurationId!, executor: execution.identity },
                  request: { purpose, texts: batch }, signal, check: validate,
                  ...(input.beforeDispatch ? { beforeDispatch: input.beforeDispatch } : {}),
                  execute: (active, beforeDispatch) => execution.batch(batch, { signal: active, beforeDispatch, priority: 'foreground',
                    tokenLengths: batch.map(text => embedder.countTokens(text)) }),
                });
                await validate();
                vectors.push(...rows);
              }
              return vectors;
            } finally { releaseWork(); }
          },
          embedBatch: async request => {
            const vectors = await result.embed(request.items.map(item => item.text), { purpose: request.purpose, ...(request.signal ? { signal: request.signal } : {}) });
            return { batchId: request.batchId, space: result.space, items: request.items.map((item, index) => ({ id: item.id, index, vector: vectors[index]! })) };
          },
        };
        return result;
      },
    };
  };
  return retain();
}
