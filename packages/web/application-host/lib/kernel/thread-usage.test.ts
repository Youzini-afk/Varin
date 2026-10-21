import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createThreadsHttpAPI, switchRuntimeEndpoint } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter, type ThreadModelAuthority } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import type { KernelClient } from './kernel-client.js';
const identity = { runtime: 'agent' as const, threadId: 'thread:usage', branchId: 'branch:usage' };
const projection = { threadId: identity.threadId, branchId: identity.branchId, throughCursor: 91, notDispatchedRequests: 0, rows: [] };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const requests = vi.fn(async (method: string, _params: unknown, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'runtime.thread.inspect') return { branches: [{ branch_id: identity.branchId }] };
    if (method === 'runtime.thread.usage') return projection;
    if (method === 'runtime.operation.inspect') return { id: 'script', run_id: 'run:usage' };
    if (method === 'runtime.run.inspect') return { id: 'run:usage', thread_id: identity.threadId, branch_id: identity.branchId };
    if (method === 'runtime.operation.calls') return [{ operationId: 'nested', parentOperationId: 'script', name: 'file_read', depth: 0, phase: 'terminal', outcome: 'succeeded', effect: 'none', cancelRequested: false }];
    throw new Error(`Unexpected kernel call ${method}`);
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const source = vi.fn(); const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models as unknown as ThreadModelAuthority, source, vi.fn());
  const routes = new Map<string, (...args: unknown[]) => Promise<void>>(); const auth = vi.fn();
  const app = { post(path: string, authHandler: unknown, handler: (...args: unknown[]) => Promise<void>) { expect(authHandler).toBe(auth); routes.set(path, handler); }, get() {} };
  registerThreadRoutes(app as unknown as Express, adapter, auth);
  const call = async (body: unknown, method = 'usage') => {
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean; status(value: number): unknown; json(value: unknown): void };
    let value: unknown; let status = 200; response.writableEnded = false;
    response.status = next => { status = next; return response; }; response.json = next => { value = next; response.writableEnded = true; };
    await routes.get(`/api/threads/${method}`)!({ body }, response);
    return { status, value };
  };
  return { requests, source, models, call, adapter };
}
it('routes the original branch through the authenticated Host and native read-only owner', async () => {
  const f = fixture(); const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push({ url, body }); const result = await f.call(body);
    return Response.json(result.value, { status: result.status });
  });
  expect(await createThreadsHttpAPI().usage(identity)).toEqual(projection);
  expect(calls[0]).toEqual({ url: '/api/threads/usage', body: identity });
  expect(f.requests).toHaveBeenCalledWith('runtime.thread.usage', { threadId: identity.threadId, branchId: identity.branchId }, expect.any(AbortSignal));
  expect(f.source).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
});
it('reads the original nested calls through the authenticated operation route', async () => {
  const f = fixture();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/threads/operation/calls');
    const reply = await f.call(JSON.parse(String(init.body)), 'operation/calls');
    return Response.json(reply.value, { status: reply.status });
  });
  expect(await createThreadsHttpAPI().toolCalls('script')).toMatchObject([{ operationId: 'nested', parentOperationId: 'script', name: 'file_read' }]);
  expect(f.requests).toHaveBeenCalledWith('runtime.operation.calls', { operationId: 'script' }, expect.any(AbortSignal));
  expect((await f.call({ operationId: 'script', runId: 'foreign' }, 'operation/calls')).status).toBe(400);
});

it('rejects cross-thread branch selection and unsupported source fields before reading usage', async () => {
  const f = fixture();
  expect((await f.call({ ...identity, branchId: 'branch:foreign' })).status).toBe(400);
  expect((await f.call({ ...identity, directory: '/untrusted' })).status).toBe(400);
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.thread.usage')).toBe(false);
});
it('rejects a late original Host usage reply instead of publishing it as current Host data', async () => {
  let release!: (value: unknown) => void;
  vi.stubGlobal('fetch', async () => ({ ok: true, json: () => new Promise(resolve => { release = resolve; }) }));
  const pending = createThreadsHttpAPI().usage(identity);
  await new Promise(resolve => setImmediate(resolve));
  switchRuntimeEndpoint({ apiBaseUrl: 'http://usage-other.test', runtimeKey: 'usage-other' });
  release(projection);
  await expect(pending).rejects.toThrow('Application Host changed');
});
