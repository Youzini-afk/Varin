import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createConversationOrganizationHttpAPI } from '@varin/application-client';
import { KernelClientError } from '../kernel/kernel-error.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { ConversationOrganizationService } from './service.js';
import { registerConversationOrganizationRoutes } from './routes.js';
const snapshot = { initialized: true, revision: 4, rootRevision: 2, cursor: 9, containers: [], conversations: [], nextCursor: null };
function fixture() {
  const requests = vi.fn(async (method: string, _params: unknown): Promise<unknown> => method === 'runtime.organization.receipt' ? null : method === 'runtime.organization.read' ? snapshot : { key: 'key', revision: 5, cursor: 10, containers: [], positions: [], removed: [] });
  const runtime = new AgentRuntimeClient({ subscribeExit() { return () => {}; }, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const external = { list: vi.fn(async () => []), inspect: vi.fn(), update: vi.fn() }, threads = { update: vi.fn(), delete: vi.fn() };
  const readSettings = vi.fn(async (): Promise<{projects?:unknown}> => ({ projects: [] }));
  const service = new ConversationOrganizationService({ runtime, external: external as never, threads: threads as never, readSettings });
  const routes = new Map<string, RequestHandler[]>();
  registerConversationOrganizationRoutes({ post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers) } as unknown as Express,
    service, (req, res, next) => { if (req.headers.authorization !== 'session') res.status(401).end(); else next(); }, async () => ({ principalId: 'alice' }));
  const request = async (path: string, body: unknown, auth = true) => {
    let status = 200, output: unknown;
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, status(code: number) { status = code; return this; }, json(value: unknown) { output = value; this.writableEnded = true; }, end() { this.writableEnded = true; } });
    const chain = routes.get(path)!;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = chain[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler({ body, headers: auth ? { authorization: 'session' } : {} } as Request, res as unknown as ExpressResponse, next)).then(() => { if (res.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  return { requests, service, request, api: createConversationOrganizationHttpAPI(), readSettings, threads, external };
}
afterEach(() => vi.unstubAllGlobals());
it('runs the real HTTP client through authenticated routes and private Catalog boundary', async () => {
  const f = fixture();
  expect(await f.api.read({ archived: 'include' })).toEqual(snapshot);
  expect(f.requests).toHaveBeenCalledWith('runtime.organization.read', { principalId: 'alice', query: { archived: 'include' } }, expect.any(AbortSignal));
  await f.api.command({ key: 'key', operation: { action: 'create', id: 'group', kind: 'group', parentId: null, name: 'Work', parents: [{ containerId: null, childrenRevision: 2 }] } });
  expect(f.requests).toHaveBeenLastCalledWith('runtime.organization.command', expect.objectContaining({ principalId: 'alice', command: expect.objectContaining({ key: 'key' }) }), expect.any(AbortSignal));
  expect((await f.request('/api/conversation-organization/read', { principalId: 'bob' })).status).toBe(400);
  expect((await f.request('/api/conversation-organization/read', {}, false)).status).toBe(401);
});
it('does not initialize or publish an empty project generation on corrupt project reads', async () => {
  const f = fixture(); f.requests.mockResolvedValue({ ...snapshot, initialized: false }); f.readSettings.mockResolvedValue({ projects: { invalid: true } });
  await expect(f.api.read()).rejects.toMatchObject({ code: 'projects_unavailable' });
  expect(f.requests.mock.calls.map(call => call[0])).toEqual(['runtime.organization.read']);
});
it('retains per-owner partial outcomes and blocks cross-principal metadata mutations', async () => {
  const f = fixture();
  f.requests.mockImplementation(async (method, input) => method === 'runtime.thread.inspect' ? { principal_id: (input as {threadId:string}).threadId === 'other' ? 'bob' : 'alice' } : snapshot);
  f.threads.update.mockResolvedValue({ revision: 2 });
  const result = await f.api.metadata({ key: 'batch', items: ['mine', 'other'].map(id => ({ conversation: { kind: 'native' as const, id }, expectedRevision: 1, patch: { archived: true } })) });
  expect(result.items.map(item => item.status)).toEqual(['succeeded', 'failed']);
  expect(result.items[1]?.code).toBe('forbidden'); expect(f.threads.update).toHaveBeenCalledTimes(1);
});
it('returns project registration as a real partial result when Catalog classification conflicts', async () => {
  const f = fixture(); f.readSettings.mockResolvedValue({ projects: [{ id: 'registered', path: '/work', label: 'Work' }] });
  f.requests.mockRejectedValue(new Error('Catalog disconnected after registration'));
  const result = await f.api.project({ projectId: 'registered', command: { key: 'classify', operation: { action: 'create', id: 'project-node', kind: 'project', parentId: null, projectId: 'registered', parents: [{ containerId: null, childrenRevision: 2 }] } } });
  expect(result).toMatchObject({ projectId: 'registered', registered: true, navigation: 'pending', failure: { code: 'unknown_outcome' } });
  expect(f.readSettings).toHaveBeenCalledTimes(1);
});
it('rejects a malformed metadata batch before any original owner is mutated', async () => {
  const f = fixture();
  const response = await f.request('/api/conversation-organization/metadata', { key: 'batch', items: [
    { conversation: { kind: 'native', id: 'mine' }, expectedRevision: 1, patch: { archived: true } },
    { conversation: { kind: 'native', id: 'other' }, expectedRevision: 1, patch: { principalId: 'alice' } },
  ] });
  expect(response.status).toBe(400); expect(f.threads.update).not.toHaveBeenCalled(); expect(f.requests).not.toHaveBeenCalled();
});

it('preserves a real kernel CAS conflict as a typed HTTP conflict', async () => {
  const f = fixture(); f.requests.mockRejectedValue(new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: parent revision changed' }));
  await expect(f.api.read()).rejects.toMatchObject({ code: 'conflict', status: 409 });
});
it('keeps per-object admission identity across subset retries and JSON field reordering', async () => {
  const f = fixture(); f.requests.mockResolvedValue({ principal_id: 'alice' }); f.threads.update.mockResolvedValue({ revision: 2 });
  await f.api.metadata({ key: 'batch', items: [{ conversation: { kind: 'native', id: 'mine' }, expectedRevision: 1, patch: { archived: true } }] });
  await f.request('/api/conversation-organization/metadata', { key: 'batch', items: [{ conversation: { id: 'mine', kind: 'native' }, expectedRevision: 1, patch: { archived: true } }] });
  expect(f.threads.update.mock.calls[0]).toEqual(f.threads.update.mock.calls[1]);
});
it('replays a project classification before consulting changed registration preconditions', async () => {
  const f = fixture(); const receipt = { key: 'classified', revision: 5, cursor: 10, containers: [], positions: [], removed: [] };
  f.readSettings.mockResolvedValue({ projects: [] });
  f.requests.mockImplementation(async method => method === 'runtime.organization.receipt' ? receipt : snapshot);
  const command = { key: 'classified', operation: { action: 'create' as const, id: 'project-node', kind: 'project' as const, parentId: null, projectId: 'removed-project', parents: [] } };
  expect(await f.api.command(command)).toEqual(receipt);
  expect(f.readSettings).not.toHaveBeenCalled();
  expect(await f.api.project({ projectId: 'removed-project', command })).toMatchObject({ registered: false, navigation: 'completed', receipt });
});
it('authorizes external tombstones through the original metadata owner and retains a stable retry key', async () => {
  const f = fixture(); f.external.inspect.mockResolvedValue({ id: 'external', principalId: 'alice', deleted: true });
  f.external.update.mockResolvedValue({ id: 'external', deleted: true, revision: 2 });
  const input = { key: 'delete-batch', items: [{ conversation: { kind: 'external' as const, id: 'external' }, expectedRevision: 1, patch: { deleted: true } }] };
  expect((await f.api.metadata(input)).items[0]?.status).toBe('succeeded');
  expect((await f.api.metadata(input)).items[0]?.status).toBe('succeeded');
  expect(f.external.list).not.toHaveBeenCalled(); expect(f.external.inspect).toHaveBeenCalledTimes(2);
  expect(f.external.update.mock.calls[0]).toEqual(f.external.update.mock.calls[1]);
});
it('freezes the selected project source without contacting the remote device and reuses it after registration changes', async () => {
  const f = fixture();
  const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'connection', endpointIdentity: 'endpoint' }, workspaceId: 'original-workspace' };
  const selected = { ...snapshot, containers: [{ id: 'project-node', kind: 'project', projectId: 'project', parentId: null }, { id: 'group', kind: 'group', projectId: null, parentId: 'project-node' }] };
  f.requests.mockImplementation(async method => {
    if (method === 'runtime.thread.inspect') throw new KernelClientError({code:'not-found',message:'Thread is new'});
    return method === 'runtime.organization.read' ? selected : null;
  });
  f.readSettings.mockResolvedValue({ projects: [{ id:'project', path:'/remote/original', label:'Research', source }] });
  const defaults = await f.service.creationDefaults('alice', 'new-thread', {containerId:'group'});
  expect(defaults).toEqual({projectId:'project',source:{...source,path:'/remote/original'}});
  f.readSettings.mockRejectedValue(new Error('Settings unreadable after admission'));
  f.requests.mockImplementation(async method => method === 'runtime.thread.inspect' ? {principal_id:'alice'} : defaults);
  expect(await f.service.creationDefaults('alice', 'new-thread', {containerId:'group'})).toEqual(defaults);
  expect(f.readSettings).toHaveBeenCalledTimes(1);
});
it('does not retrofit source descriptors into a legacy creation retry', async () => {
  const f = fixture(); f.requests.mockImplementation(async method => method === 'runtime.thread.inspect' ? {principal_id:'alice'} : {projectId:'legacy-project'});
  expect(await f.service.creationDefaults('alice', 'old-thread', {containerId:'group'})).toBeNull(); expect(f.readSettings).not.toHaveBeenCalled();
});

it('does not replay another principal’s external tombstone receipt', async () => {
  const f = fixture(); f.external.inspect.mockResolvedValue({ id: 'foreign-deleted', principalId: 'bob', deleted: true });
  const result = await f.api.metadata({ key: 'known-original-key', items: [{ conversation: { kind: 'external', id: 'foreign-deleted' }, expectedRevision: 1, patch: { deleted: true } }] });
  expect(result.items[0]).toMatchObject({ status: 'failed', code: 'forbidden' });
  expect(f.external.update).not.toHaveBeenCalled();
});
