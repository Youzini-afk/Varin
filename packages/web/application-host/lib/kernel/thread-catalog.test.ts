import { nativeThreadView } from './thread-view.test-helper.js';
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
  const exits = new Set<(error: Error) => void>();
  const runtime = new AgentRuntimeClient({ subscribeExit(listener: (error: Error) => void) { exits.add(listener); return () => exits.delete(listener); }, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
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
  return { api: createThreadsHttpAPI(), requests, request, adapter, failKernel: (error: Error) => { for (const listener of exits) listener(error); } };
}
afterEach(() => vi.unstubAllGlobals());
const target = { runtime: 'agent' as const, threadId: 'thread:original' };

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
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual(['runtime.thread.view']);
});

it('rejects an implicit snapshot identity before any native read', async () => {
  const f = fixture();
  await expect(f.adapter.snapshot({ runtime: 'agent', threadId: 'original-thread', branchId: 'original-branch' }))
    .rejects.toThrow('An explicit thread identity is required');
  expect(f.requests).not.toHaveBeenCalled();
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

it('preserves the native displayed Run failure projection and an unavailable read', async () => {
  const f = fixture();
  const identity = { runtime: 'agent' as const, threadId: 'thread:failure', branchId: 'branch:failure' };
  const run = { id: 'run:failed', thread_id: identity.threadId, branch_id: identity.branchId,
    state: 'failed', revision: 4, epoch: 1, configuration: {}, waiting_on: null, cancel_requested: false };
  const failure = { runId: run.id, cursor: 42, code: 'context_candidate_capacity', message: 'The context summary does not fit. The original history remains unchanged.' };
  let unreadable = false;
  f.requests.mockImplementation(async (method, params) => {
    expect(method).toBe('runtime.thread.view');
    expect(params).toEqual({ threadId: identity.threadId, branchId: identity.branchId, historyLimit: 20 });
    if (unreadable) throw new Error('Original failure unavailable');
    return nativeThreadView(identity, { runFailure: run.state === 'failed' ? failure : null });
  });
  expect((await f.api.snapshot(identity)).runFailure).toEqual(failure);
  // The Host transports the Catalog projection without per-component reads.
  expect(f.requests).toHaveBeenCalledOnce();
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.events.read')).toBe(false);
  run.state = 'cancelled';
  expect((await f.api.snapshot(identity)).runFailure).toBeNull();
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.view')).toBe(true);
  run.state = 'failed'; unreadable = true;
  await expect(f.api.snapshot(identity)).rejects.toMatchObject({ code: 'thread-request-failed' });
  expect(f.requests.mock.calls.some(([method]) => /cancel|resume|retry/.test(method))).toBe(false);
});

it('reads complete attention through authenticated Host without per-thread hydration or scope injection', async () => {
  const f = fixture();
  const view = { epoch: 7, eventCursor: 42,
    coverage: { native: 'complete', external: 'unsupported', scope: 'host' }, teamExecutions: [],
    branches: [], items: [], counts: { actionRequired: 0, affectedBranches: 0, unknownEffects: 0 } };
  f.requests.mockResolvedValue(view);
  await expect(f.api.attention()).resolves.toEqual(view);
  expect(f.requests.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['runtime.thread.attention.read', {}],
  ]);
  expect((await f.request('/api/threads/attention', {}, false)).status).toBe(401);
  expect((await f.request('/api/threads/attention', { threadId: 'invented-scope' })).status).toBe(400);
  expect(f.requests).toHaveBeenCalledOnce();
});

it('cancels only the original attention read and does not turn unavailable data into empty success', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.requests.mockImplementation(async (_method, _params, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = f.adapter.attention(controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.requests.mock.calls[0]?.[2]).toBe(controller.signal);
  controller.abort();
  await rejected;
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual(['runtime.thread.attention.read']);
});


it('rejects an attention snapshot whose kernel was replaced during the read', async () => {
  const f = fixture();
  f.requests.mockImplementation(async () => {
    f.failKernel(new Error('original kernel replaced'));
    return { epoch: 7, eventCursor: 42, coverage: { native: 'complete', external: 'unsupported', scope: 'host' },
      branches: [], items: [], teamExecutions: [], delegations: [], follows: [],
      counts: { actionRequired: 0, affectedBranches: 0, unknownEffects: 0 } };
  });
  await expect(f.adapter.attention()).rejects.toThrow('original kernel replaced');
});

it('keeps Source file discovery authenticated and validates metadata-only paging before the owner runs', async () => {
  const f = fixture();
  const page = { entries: [{ path: 'src', relativePath: 'src', name: 'src', type: 'directory' as const }], nextCursor: null };
  const files = vi.spyOn(f.adapter, 'files').mockResolvedValue(page);
  const draft = vi.spyOn(f.adapter, 'draftSourceFiles').mockResolvedValue(page);
  const identity = { runtime: 'agent', threadId: 'thread:files', branchId: 'branch:files' };
  const pending = { resourceOwner: { kind: 'managed_host', hostId: 'B', connectionId: 'B-connection', endpointIdentity: 'B-identity' }, path: '/B/project' };
  expect(await (await f.request('/api/threads/source/draft-files', { source: pending, query: 'src', type: 'directory', limit: 4 })).json()).toEqual(page);
  expect(draft).toHaveBeenCalledWith({ source: pending, query: 'src', type: 'directory', limit: 4 }, expect.any(AbortSignal));
  expect(await (await f.request('/api/threads/source/files', { ...identity, query: 'src' })).json()).toEqual(page);
  expect(files).toHaveBeenCalledWith(identity, { query: 'src' }, expect.any(AbortSignal));
  expect((await f.request('/api/threads/source/draft-files', { source: pending }, false)).status).toBe(401);
  for (const malformed of [{ limit: 0 }, { type: ['directory'] }, { cursor: '' }, { query: {} }, { root: '/elsewhere' }]) {
    expect((await f.request('/api/threads/source/files', { ...identity, ...malformed })).status).toBe(400);
  }
  expect((await f.request('/api/threads/source/draft-files', { source: { ...pending, workspaceId: 'unadmitted' } })).status).toBe(400);
  expect(draft).toHaveBeenCalledTimes(1); expect(files).toHaveBeenCalledTimes(1);
  expect(f.requests).not.toHaveBeenCalled();
});
