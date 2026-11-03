import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createThreadsHttpAPI } from '../src/threads-http.js';

it('keeps pending remote source and native branch discovery separate, with query cancellation', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return Response.json({ entries: [], nextCursor: null });
  };
  try {
    const api = createThreadsHttpAPI(), stop = new AbortController();
    const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
    const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'B', connectionId: 'B-connection', endpointIdentity: 'B-endpoint' }, path: '/same-name' };
    await api.sources.draftFiles({ source, type: 'directory', query: 'src', limit: 4 }, stop.signal);
    assert.deepEqual(calls[0], { path: '/api/threads/source/draft-files', body: { source, type: 'directory', query: 'src', limit: 4 }, signal: stop.signal });
    await api.sources.files(identity, { query: 'test', cursor: 'original-cursor' }, stop.signal);
    assert.deepEqual(calls[1], { path: '/api/threads/source/files', body: { ...identity, query: 'test', cursor: 'original-cursor' }, signal: stop.signal });
  } finally { globalThis.fetch = original; }
});
