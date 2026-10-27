import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

/** Execute the public HTTP client, authentication, parser, adapter and private RPC mapping.
 * Catalog behavior and persistence are exercised in the Rust owner's real-database tests. */
function fixture() {
  const requests = vi.fn(async (_method: string, _params: unknown, _signal?: AbortSignal): Promise<unknown> => []);
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const adapter = new ThreadAdapter(runtime, { resolveModel: vi.fn(), rebindModel: vi.fn() }, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...chain: RequestHandler[]) => routes.set(path, chain), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'host-session') { response.status(401).end(); return; }
    next();
  };
  registerThreadRoutes(app, adapter, requireAuth);
  const request = async (path: string, body: unknown, authenticated = true) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    const handlers = routes.get(path); if (!handlers) throw new Error(`Unknown route: ${path}`);
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  return { api: createThreadsHttpAPI(), requests, request, adapter };
}
afterEach(() => vi.unstubAllGlobals());
const target = { runtime: 'agent' as const, threadId: 'original-thread' };

it('propagates snapshot cancellation to the original native read without cancelling the Run', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.requests.mockImplementation(async (_method, _params, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = f.adapter.snapshot({ ...target, branchId: 'original-branch' }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.requests.mock.calls[0]?.[2]).toBe(controller.signal);
  controller.abort();
  await rejected;
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual(['runtime.status']);
});

it('lets an authenticated draft discover source Hosts without creating or granting a Thread', async () => {
  const f = fixture();
  const result = { targets: [{ resourceOwner: { kind: 'local' as const }, label: 'This Host', capabilities: [] }], unavailable: [] };
  const list = vi.fn(async () => result); const resolve = vi.fn();
  f.adapter.bindSourceDirectory({ list, resolve });
  await expect(f.api.sources.list(null)).resolves.toEqual(result);
  expect(list).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled(); expect(f.requests).not.toHaveBeenCalled();
  expect((await f.request('/api/threads/source/list', {}, false)).status).toBe(401);
  expect((await f.request('/api/threads/source/list', { runtime: 'agent' })).status).toBe(400);
  expect((await f.request('/api/threads/source/resolve', { resourceOwner: { kind: 'local' }, path: '/repo' })).status).toBe(400);
  expect(resolve).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledOnce();
});

it('uses the native product query and forwards original metadata/read command identities unchanged', async () => {
  const f = fixture();
  await f.api.list({ query: 'Research', archived: 'only' });
  await f.api.update({ ...target, key: 'rename', expectedRevision: 7, title: 'Research notes', pinned: true, archived: false });
  await f.api.delete({ ...target, key: 'hide', expectedRevision: 8 });
  await f.api.markRead({ ...target, key: 'read', throughCursor: 41 });
  expect(f.requests.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['runtime.thread.catalog.list', { query: 'Research', archived: 'only' }],
    ['runtime.thread.update', { threadId: target.threadId, key: 'rename', expectedRevision: 7, title: 'Research notes', pinned: true, archived: false }],
    ['runtime.thread.delete', { threadId: target.threadId, key: 'hide', expectedRevision: 8 }],
    ['runtime.thread.read', { threadId: target.threadId, key: 'read', throughCursor: 41 }],
  ]);
  expect(f.requests.mock.calls.some(([method]) => /cancel|release|stop/.test(method))).toBe(false);
});

it('keeps authentication, native identity and typed metadata boundaries ahead of Catalog writes', async () => {
  const f = fixture();
  const input = { ...target, key: 'update', expectedRevision: 1, pinned: true };
  expect((await f.request('/api/threads/update', input, false)).status).toBe(401);
  for (const body of [{ ...input, runtime: 'pi' }, { ...input, pinned: 'true' }, { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: 1.5 }, { ...input, branchId: 'pretend' }, { ...input, deleted_at_ms: 0 }]) {
    expect((await f.request('/api/threads/update', body)).status).toBe(400);
  }
  expect((await f.request('/api/threads/list', { archived: 'deleted' })).status).toBe(400);
  expect((await f.request('/api/threads/list', { query: {} })).status).toBe(400);
  expect((await f.request('/api/threads/read', { ...target, key: 'read', throughCursor: 1.5 })).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled();
});

it('projects original Catalog CAS conflicts without changing the submitted command for retry', async () => {
  const f = fixture();
  f.requests.mockRejectedValue(new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: Thread metadata revision changed' }));
  const command = { ...target, key: 'stable-intent', expectedRevision: 3, archived: true };
  await expect(f.api.update(command)).rejects.toMatchObject({ status: 409, code: 'thread-conflict' });
  await expect(f.api.update(command)).rejects.toMatchObject({ status: 409 });
  expect(f.requests.mock.calls[0]![1]).toEqual(f.requests.mock.calls[1]![1]);
});

it('projects only the displayed failed Run\'s original failure and preserves an unavailable read', async () => {
  const f = fixture();
  const identity = { runtime: 'agent' as const, threadId: 'thread:failure', branchId: 'branch:failure' };
  const run = { id: 'run:failed', thread_id: identity.threadId, branch_id: identity.branchId,
    state: 'failed', revision: 4, epoch: 1, configuration: {}, waiting_on: null, cancel_requested: false };
  const failure = { runId: run.id, cursor: 42, code: 'context_candidate_capacity', message: 'The context summary does not fit. The original history remains unchanged.' };
  let unreadable = false;
  f.requests.mockImplementation(async (method, params) => {
    switch (method) {
      case 'runtime.thread.inspect': return { thread_id: identity.threadId, parent_thread_id: null, observer_project_ids: [], branches: [
        { branch_id: identity.branchId, active_run_id: null, head: null, latest_run: run },
      ] };
      case 'runtime.status': return { eventCursor: 42 };
      case 'runtime.history.page': return { head: null, previous: null, items: [] };
      case 'runtime.context.inspect': case 'runtime.launch.inspect': case 'runtime.child.for_thread': return null;
      case 'runtime.model.inspect': return { desired: null, active: null };
      case 'runtime.family.list': return { rootThreadId: identity.threadId, members: [], nextCursor: null };
      case 'runtime.run.failure':
        expect(params).toEqual({ runId: run.id });
        if (unreadable) throw new Error('Original failure unavailable');
        return failure;
      default: return [];
    }
  });
  expect((await f.api.snapshot(identity)).runFailure).toEqual(failure);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.run.failure')).toHaveLength(1);
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.events.read')).toBe(false);
  run.state = 'cancelled';
  expect((await f.api.snapshot(identity)).runFailure).toBeNull();
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.run.failure')).toHaveLength(1);
  run.state = 'failed'; unreadable = true;
  await expect(f.api.snapshot(identity)).rejects.toMatchObject({ code: 'thread-request-failed' });
  expect(f.requests.mock.calls.some(([method]) => /cancel|resume|retry/.test(method))).toBe(false);
});
