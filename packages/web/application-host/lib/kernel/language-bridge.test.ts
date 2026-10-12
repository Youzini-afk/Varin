import { expect, it, vi } from 'vitest';
import { LanguageBridge, type PrivateLanguageResponse, unavailableLanguageResult } from './language-bridge.js';
import { deferred } from './language.test-helper.js';
import type { LanguageResult } from './language-owner.js';

const physicalRoot = { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace' };
const query = { runId: 'run', threadId: 'thread', grantId: 'grant', source: { mode: 'live_root', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: null, revision: null, live_root: physicalRoot }, physicalRoot, method: 'definition', path: 'source.ts', line: 0, character: 0 };
const request = (id: string, epoch = 'current') => ({ v: 1, kind: 'language-request', id, kernelEpoch: epoch, query });

it('does not dispatch old-epoch requests or let a late old-epoch result enter the new channel', async () => {
  let epoch = 'current';
  const replies: PrivateLanguageResponse[] = [];
  const failed = vi.fn();
  const bridge = new LanguageBridge(() => epoch, async response => { replies.push(response); }, failed);
  const held = deferred<LanguageResult>();
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
  const bridge = new LanguageBridge(() => 'current', async response => { replies.push(response); }, () => { throw new Error('unexpected transport failure'); });
  const held = deferred<LanguageResult>();
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
  const bridge = new LanguageBridge(() => 'current', async response => { replies.push(response); }, () => {});
  bridge.setOwner(owner);
  for (const invalid of [{ line: -1 }, { character: 1.5 }, { method: 'executeCommand' }, { physicalRoot: {} }]) {
    bridge.consume({ ...request(`invalid-${replies.length}`), query: { ...query, ...invalid } });
    await vi.waitFor(() => expect(replies.at(-1)?.result.status).toBe('unavailable'));
  }
  expect(owner).not.toHaveBeenCalled();
  expect(bridge.consume({ v: 1, kind: 'public-event' })).toBe(false);
  bridge.close();
});

it('withdraws only the retired source and waits for its actual view drain', async () => {
  const held = deferred<LanguageResult>(), drain = deferred<void>();
  const responses: PrivateLanguageResponse[] = [];
  const signals = new Map<string, AbortSignal>();
  const owner = Object.assign(async (input: { runId: string }, signal: AbortSignal) => { signals.set(input.runId, signal); return held.promise; }, {
    releaseSource: vi.fn(async () => drain.promise),
  });
  const bridge = new LanguageBridge(() => 'current', async response => { responses.push(response); }, () => {});
  bridge.setOwner(owner);
  bridge.consume(request('one'));
  bridge.consume({ ...request('two'), query: { ...query, runId: 'other-run', grantId: 'other-grant' } });
  let finished = false;
  const retiring = bridge.releaseSource({ grantId: 'grant' }).then(() => { finished = true; });
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  expect(responses[0]).toMatchObject({ id: 'one', result: { status: 'cancelled' } });
  expect(signals.get('run')?.aborted).toBe(true);
  expect(signals.get('other-run')?.aborted).toBe(false);
  expect(finished).toBe(false);
  drain.resolve(); await retiring;
  expect(finished).toBe(true);
  held.resolve(unavailableLanguageResult('second source still works'));
  await vi.waitFor(() => expect(responses).toHaveLength(2));
  expect(responses[1]).toMatchObject({ id: 'two', result: { status: 'unavailable', message: 'second source still works' } });
  bridge.close();
});
