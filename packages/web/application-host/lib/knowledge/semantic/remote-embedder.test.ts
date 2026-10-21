import { expect, it, vi } from 'vitest';
import { requestOpenAICompatibleEmbeddings } from '@varin/protocol/node/embeddings';
import { remoteEmbeddingSpaceId } from './identity.js';
import { createRemoteEmbedder } from './remote-embedder.js';
import { embedInScheduledBatches } from './embed-scheduler.js';
import type { RemoteEmbedClient } from './remote-embedder.js';

const binding = { protocol: 'openai-compatible' as const, providerId: 'fixture', modelId: 'embedding',
  configurationId: 'original', dimensions: 2, maxTokens: 96 };
const space = { ...binding, dim: 2, spaceId: remoteEmbeddingSpaceId({ ...binding, dimensions: 2 }) };

it('packs each request by token work and splits an explicitly rejected batch without losing result order', async () => {
  const successful: string[][] = [], rejected: number[] = [];
  const client: RemoteEmbedClient = { embed: async input => {
    const result = await requestOpenAICompatibleEmbeddings({ baseUrl: 'https://fixture.invalid', model: input.modelId,
      input: input.items.map(item => item.text), maxRetries: 0, fetchImpl: async (_url, init) => {
        const texts: string[] = JSON.parse(String(init?.body)).input;
        expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(binding.maxTokens);
        if (texts.length > 3) {
          rejected.push(texts.length);
          return Response.json({ error: { code: 'invalid_request', message: 'The maximum batch size is 3' } }, { status: 400 });
        }
        successful.push(texts);
        return Response.json({ data: texts.map((text, index) => ({ index, embedding: [Number(text), 1] })) });
      } });
    return { batchId: input.batchId, space, items: result.vectors.map((vector, index) => ({ id: input.items[index]!.id, index, vector })) };
  } };
  const embedder = createRemoteEmbedder({ binding, client, countTokens: async texts => texts.map(text => text.length) });
  const texts = Array.from({ length: 2175 }, (_, index) => String(index));
  const vectors = await embedInScheduledBatches({ embedder, texts, priority: 'background', purpose: 'document' });
  expect(vectors).toEqual(texts.map(text => [Number(text), 1]));
  expect(successful.flat()).toEqual(texts);
  expect(rejected.length).toBeGreaterThan(0);
  expect(embedder.selectBatchSize!([1, 1, 1, 1])).toBeLessThanOrEqual(3);
});

it('reports ordinary HTTP 400 once without treating invalid parameters as a batch limit or exposing source', async () => {
  const fetch = vi.fn(async () => Response.json({ error: { code: 'invalid_request', message: 'Unknown model; private source: secret text' } }, { status: 400 }));
  const embedder = createRemoteEmbedder({ binding, client: { embed: async input => {
    await requestOpenAICompatibleEmbeddings({ baseUrl: 'https://fixture.invalid', model: input.modelId,
      input: input.items.map(item => item.text), maxRetries: 0, fetchImpl: fetch });
    throw new Error('Unreachable');
  } } });
  const error = await embedder.embed(['one', 'two']).then((): never => { throw new Error('Expected failure'); }, (error: Error) => error);
  expect(error.message).toContain('Embedding HTTP 400');
  expect(error.message).not.toContain('secret text');
  expect(fetch).toHaveBeenCalledOnce();
});

it('rejects a single over-window input before making a paid request', async () => {
  const embed = vi.fn();
  const embedder = createRemoteEmbedder({ binding, client: { embed }, countTokens: async texts => texts.map(text => text.length * 2) });
  await expect(embedder.embed(['长'.repeat(60)])).rejects.toMatchObject({ code: 'embedding-input-limit' });
  expect(embed).not.toHaveBeenCalled();
});
