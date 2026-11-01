import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestOpenAICompatibleEmbeddings } from '../src/node/embeddings.js';

test('embedding dispatch preserves gateway query and mount path without duplicating an existing endpoint suffix', async () => {
  for (const baseUrl of ['https://fixture.invalid/mount/v1/?tenant=a', 'https://fixture.invalid/mount/v1/embeddings?tenant=a']) {
    const result = await requestOpenAICompatibleEmbeddings({ baseUrl, model: 'fixture', input: ['text'], maxRetries: 0,
      fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://fixture.invalid/mount/v1/embeddings?tenant=a');
        assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture', input: ['text'], encoding_format: 'float' });
        return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
      } });
    assert.deepEqual(result.vectors, [[1, 2]]);
  }
});
