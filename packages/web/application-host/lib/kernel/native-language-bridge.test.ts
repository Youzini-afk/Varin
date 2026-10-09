import { expect, it, vi } from 'vitest';
import { NativeLanguageBridge, type PrivateLanguageResponse, unavailableLanguageResult } from './native-language-bridge.js';
import { deferred } from './native-language.test-helper.js';
import type { NativeLanguageResult } from './native-language-owner.js';

const query = { runId: 'run', threadId: 'thread', workspaceId: 'workspace', executionWorkspaceId: 'workspace',
  liveRoot: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace' }, method: 'definition', path: 'source.ts', line: 0, character: 0 };
const request = (id: string, epoch = 'current') => ({ v: 1, kind: 'language-request', id, kernelEpoch: epoch, query });

it('does not dispatch old-epoch requests or let a late old-epoch result enter the new channel', async () => {
  let epoch = 'current';
  const replies: PrivateLanguageResponse[] = [];
  const failed = vi.fn();
  const bridge = new NativeLanguageBridge(() => epoch, async response => { replies.push(response); }, failed);
  const held = deferred<NativeLanguageResult>();
  const owner = vi.fn(async () => held.promise);
  bridge.setOwner(owner);
  expect(bridge.consume(request('old-input', 'old'))).toBe(true);
  expect(owner).not.toHaveBeenCalled();
  bridge.consume(request('old-result'));
  expect(owner).toHaveBeenCalledTimes(1);
  epoch = 'new';
  bridge.close();
  held.resolve(unavailableLanguageResult('OLD_RESULT_MUST_NOT_ESCAPE'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toEqual([]);
  bridge.consume(request('new-result', 'new'));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]).toMatchObject({ kernelEpoch: 'new', id: 'new-result' });
  expect(failed).not.toHaveBeenCalled();
  bridge.close();
});

it('cancels one active request without blocking another or committing an ignored late response', async () => {
  const replies: PrivateLanguageResponse[] = [];
  const bridge = new NativeLanguageBridge(() => 'current', async response => { replies.push(response); }, () => { throw new Error('unexpected transport failure'); });
  const held = deferred<NativeLanguageResult>();
  const signals: AbortSignal[] = [];
  bridge.setOwner(async (_query, signal) => { signals.push(signal); return signals.length === 1 ? held.promise : unavailableLanguageResult('other request completed'); });
  bridge.consume(request('slow'));
  bridge.consume(request('fast'));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]!.id).toBe('fast');
  bridge.consume({ v: 1, kind: 'language-cancel', id: 'slow', kernelEpoch: 'old' });
  expect(signals[0]!.aborted).toBe(false);
  bridge.consume({ v: 1, kind: 'language-cancel', id: 'slow', kernelEpoch: 'current' });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  expect(replies[1]).toMatchObject({ id: 'slow', result: { status: 'cancelled', items: [] } });
  held.resolve(unavailableLanguageResult('LATE_RESULT'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toHaveLength(2);
  expect(JSON.stringify(replies)).not.toContain('LATE_RESULT');
  bridge.close();
});

it('consumes malformed private traffic without dispatching an invalid query and leaves unrelated frames untouched', async () => {
  const replies: PrivateLanguageResponse[] = [];
  const owner = vi.fn(async () => unavailableLanguageResult('owner'));
  const bridge = new NativeLanguageBridge(() => 'current', async response => { replies.push(response); }, () => {});
  bridge.setOwner(owner);
  for (const invalid of [{ line: -1 }, { character: 1.5 }, { method: 'executeCommand' }, { liveRoot: {} }]) {
    bridge.consume({ ...request(`invalid-${replies.length}`), query: { ...query, ...invalid } });
    await vi.waitFor(() => expect(replies.at(-1)?.result.status).toBe('unavailable'));
  }
  expect(owner).not.toHaveBeenCalled();
  expect(bridge.consume({ v: 1, kind: 'public-event' })).toBe(false);
  bridge.close();
});
