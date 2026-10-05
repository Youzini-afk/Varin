import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { sessionUsageByModel } from '../src/session-usage.js';

test('counts native journal usage across model switches, inactive branches and auxiliary calls', () => {
  const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const message = (id: string, provider: string, model: string, tokens: ReturnType<typeof usage>, parentId: string | null = null): SessionEntry => ({
    type: 'message', id, parentId, timestamp: '2026-10-05T00:00:00Z',
    message: { role: 'assistant', content: [], api: 'openai-responses', provider, model,
      stopReason: 'stop', timestamp: 1, usage: tokens },
  });
  const entries: SessionEntry[] = [
    message('first', 'provider-a', 'model', usage(10, 5, 20, 3)),
    message('alternate', 'provider-a', 'model', usage(2, 1), 'first'),
    message('other-provider', 'provider-b', 'model', usage(7, 4), 'first'),
    { type: 'usage', id: 'auxiliary', parentId: 'first', timestamp: 'now', kind: 'context-refresh',
      provider: 'provider-a', model: 'small-model', usage: usage(4, 2, 6) },
    { type: 'compaction', id: 'compacted', parentId: 'other-provider', timestamp: 'now', summary: 'summary',
      firstKeptEntryId: 'other-provider', tokensBefore: 100, usage: usage(8, 2) },
  ];
  const rows = sessionUsageByModel(entries);
  assert.deepEqual(rows.map(({ provider, model, tokens }) => [provider, model, tokens.total]), [
    ['provider-a', 'model', 41], ['provider-b', 'model', 11], ['provider-a', 'small-model', 12], [null, null, 10],
  ]);
  assert.deepEqual(rows[0]?.tokens, { input: 12, output: 6, cacheRead: 20, cacheWrite: 3, total: 41 });
});
