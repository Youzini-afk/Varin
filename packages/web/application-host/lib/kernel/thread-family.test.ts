import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:caller', branchId: 'branch:caller' };
const target = { threadId: 'thread:sibling', branchId: 'branch:sibling' };
/** Actual API, authenticated route, adapter and runtime client. RPC facts are fixtures; family
 * membership, signed anchors, content IO and cancellation fencing are tested by the Rust owner. */
function fixture() {
  const facts = { reply: {} as unknown, fail: false, block: false };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (method === 'runtime.thread.inspect') return { thread_id: params.threadId, observer_project_ids: [],
      branches: [{ branch_id: identity.branchId, active_run_id: null, head: null, latest_run: null }] };
    if (method.startsWith('runtime.family.')) {
      if (facts.fail) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: private upstream detail' });
      if (facts.block) return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return facts.reply;
    }
    if (method === 'runtime.history.body') {
      const bytes = Buffer.from(JSON.stringify({ content: { type: 'text', text: 'original' }, provider: null }));
      return { itemId: params.itemId, contentRef: 'content:original', chunkIndex: 0, chunkCount: 1, totalBytes: bytes.length, bytesBase64: bytes.toString('base64') };
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  registerThreadRoutes({ post: (path: string, ...chain: RequestHandler[]) => routes.set(path, chain), get() {} } as unknown as Express,
    adapter, (req, res, next) => { if (req.headers.authorization !== 'host-session') res.status(401).end(); else next(); });
  const request = async (path: string, body: unknown, authenticated = true, signal?: AbortSignal) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; } });
    const closed = () => response.emit('close');
    signal?.addEventListener('abort', closed, { once: true });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    try {
      await new Promise<void>((resolve, reject) => {
        let index = 0;
        const next = (error?: unknown) => {
          if (error) { reject(error); return; }
          const handler = routes.get(path)![index++]; if (!handler) { resolve(); return; }
          Promise.resolve(handler(input, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
        }; next();
      });
      signal?.throwIfAborted();
      return Response.json(output ?? {}, { status });
    } finally { signal?.removeEventListener('abort', closed); }
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body)), true, init.signal ?? undefined));
  return { facts, runtime, requests, request, models, api: createThreadsHttpAPI().family! };
}
afterEach(() => vi.unstubAllGlobals());

it('keeps the caller separate from the target and preserves fixed view, Run and original-page identities through all consumers', async () => {
  const f = fixture();
  f.facts.reply = { rootThreadId: 'thread:root', members: [] };
  expect(await f.api.list(identity)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.family.list', { callerThreadId: identity.threadId }]);
  f.facts.reply = { ...target, runs: [{ runId: 'run:old', branchId: target.branchId, state: 'completed' }], nextCursor: 'run-cursor' };
  expect(await f.api.runs(identity, { ...target, cursor: 'run-cursor', limit: 2 })).toEqual(f.facts.reply);
  const query = { kind: 'search' as const, text: '/src/原文', direction: 'older' as const, scanLimit: 1 };
  const request = { ...target, runId: 'run:old', anchor: 'fixed-before-rollback', cursor: 'search-cursor', query };
  f.facts.reply = { ...target, runId: 'run:old', headId: 'old-head', anchor: request.anchor, items: [], nextCursor: 'scan-next', scanned: 1, scanComplete: false, hasEarlier: true, hasLater: false };
  expect(await f.api.read(identity, request)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.family.read', { ...request, callerThreadId: identity.threadId }]);
  const item = { ...target, runId: 'run:old', anchor: request.anchor, itemId: 'original-result', offset: 4096, maxBytes: 3 };
  f.facts.reply = { ...target, runId: 'run:old', headId: 'old-head', itemId: item.itemId, format: 'conversation_json', text: '原', offset: 4096, nextOffset: 4099, totalBytes: 10000 };
  expect(await f.api.item(identity, item)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.family.item', { ...item, callerThreadId: identity.threadId }]);
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method.startsWith('runtime.family.'))).toBe(true);
});

it('requires Host auth and caller branch identity, rejects caller overrides, and preserves explicit read failures', async () => {
  const f = fixture();
  for (const method of ['list', 'runs', 'read', 'item']) expect((await f.request(`/api/threads/family/${method}`, identity, false)).status).toBe(401);
  expect(f.requests).not.toHaveBeenCalled();
  for (const body of [
    { ...identity, request: { ...target, callerThreadId: 'thread:foreign', query: { kind: 'recent' } } },
    { ...identity, callerThreadId: 'thread:foreign', request: { ...target, query: { kind: 'recent' } } },
    { ...identity, runtime: 'pi', request: target },
  ]) expect((await f.request('/api/threads/family/read', body)).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled();
  await expect(f.api.list({ ...identity, branchId: target.branchId })).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect')).toBe(true);
  f.facts.fail = true;
  await expect(f.api.read(identity, { ...target, query: { kind: 'recent' } })).rejects.toMatchObject({ status: 409, code: 'thread-conflict' });
  const response = await f.request('/api/threads/family/read', { ...identity, request: { ...target, query: { kind: 'recent' } } });
  expect(await response.json()).toEqual({ code: 'thread-conflict', error: 'Thread request could not be completed' });
});

it('cancels an outstanding original read when the client closes, without cancelling the target Run', async () => {
  const f = fixture(); f.facts.block = true;
  const controller = new AbortController();
  const pending = f.api.read(identity, { ...target, query: { kind: 'recent' } }, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.requests.mock.calls.at(-1)![0]).toBe('runtime.family.read'));
  const readerSignal = f.requests.mock.calls.at(-1)![2]!;
  controller.abort(); await rejection;
  expect(readerSignal.aborted).toBe(true);
  expect(f.requests.mock.calls.some(([method]) => method.includes('cancel'))).toBe(false);
});

it('keeps the durable Run owner while hydrating ordinary public history', async () => {
  const f = fixture();
  const item = await f.runtime.historyItem({ id: 'original', thread_id: target.threadId, run_id: 'run:actual', parent: null, source: 'assistant', content_ref: 'content:original' });
  expect(item).toMatchObject({ id: 'original', run_id: 'run:actual', content: { type: 'text', text: 'original' }, provider: null });
});
