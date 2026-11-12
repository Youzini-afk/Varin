import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createConversationOrganizationHttpAPI, type ExternalConversation } from '@varin/application-client';
import { KernelClientError } from '../kernel/kernel-error.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { ConversationOrganizationService } from './service.js';
import { registerConversationOrganizationRoutes } from './routes.js';
const snapshot = { initialized: true, revision: 4, rootRevision: 2, cursor: 9, containers: [], conversations: [], nextCursor: null };
function fixture() {
  const requests = vi.fn(async (method: string, _params: unknown): Promise<unknown> => method === 'runtime.organization.receipt' ? null : method === 'runtime.organization.read' ? snapshot : { key: 'key', revision: 5, cursor: 10, containers: [], positions: [], removed: [] });
  const runtime = new AgentRuntimeClient({ subscribeExit() { return () => {}; }, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const external = { list: vi.fn(async (): Promise<ExternalConversation[]> => []), inspect: vi.fn(), update: vi.fn() }, threads = { update: vi.fn(), delete: vi.fn() };
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
  return { requests, runtime, service, request, api: createConversationOrganizationHttpAPI(), readSettings, threads, external };
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
  expect(defaults).toEqual({projectId:'project',source:{...source,path:'/remote/original',selection:{mode:'live_root'}}});
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

it('admits mixed-node pagination unchanged and rejects unknown or mistyped fields before Catalog access', async () => {
  const f = fixture();
  const query = { pageNodes: true, containerId: 'parent', recursive: false, limit: 100000, cursor: 'opaque-cursor' };
  f.requests.mockResolvedValue({ ...snapshot, items: [] });
  expect((await f.api.read(query)).items).toEqual([]);
  expect(f.requests).toHaveBeenLastCalledWith('runtime.organization.read', { principalId: 'alice', query }, expect.any(AbortSignal));
  f.requests.mockClear();
  for (const body of [{ pageNodes: 'true' }, { pageNodes: null }, { page_nodes: true }, { principalId: 'bob', pageNodes: true }, { limit: 0 }]) {
    expect((await f.request('/api/conversation-organization/read', body)).status).toBe(400);
  }
  expect(f.requests).not.toHaveBeenCalled();
  expect((await f.request('/api/conversation-organization/read', { pageNodes: false })).status).toBe(200);
  expect(f.requests).toHaveBeenLastCalledWith('runtime.organization.read', { principalId: 'alice', query: { pageNodes: false } }, expect.any(AbortSignal));
});

it('injects original Settings names once per search request and preserves them for continuation', async () => {
  const f = fixture();
  f.readSettings.mockResolvedValue({ projects: [
    { id: 'named', path: '/work/named', label: 'Research' },
    { id: 'path-only', path: '/work/fallback', label: '' },
  ] });
  const query = { pageNodes: true, query: 'Research', limit: 1 };
  f.requests.mockResolvedValue({ ...snapshot, items: [], nextCursor: 'original-name-generation' });
  await f.api.read(query);
  await f.api.read({ ...query, cursor: 'original-name-generation' });
  expect(f.readSettings).toHaveBeenCalledTimes(2);
  expect(f.requests).toHaveBeenLastCalledWith('runtime.organization.read', {
    principalId: 'alice', query: { ...query, cursor: 'original-name-generation', projectNames: { named: 'Research', 'path-only': '/work/fallback' } },
  }, expect.any(AbortSignal));
  f.readSettings.mockResolvedValue({ projects: [{ id: 'named', path: '/work/named', label: 'Renamed' }] });
  f.requests.mockRejectedValue(new KernelClientError({ code: 'conflict', message: 'conflict: query generation changed' }));
  await expect(f.api.read({ ...query, cursor: 'original-name-generation' })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.requests).toHaveBeenLastCalledWith('runtime.organization.read', {
    principalId: 'alice', query: { ...query, cursor: 'original-name-generation', projectNames: { named: 'Renamed' } },
  }, expect.any(AbortSignal));
});

it('rejects caller project-name indices and reports unavailable Settings without publishing search results', async () => {
  const f = fixture();
  expect((await f.request('/api/conversation-organization/read', { query: 'name', projectNames: { fake: 'Injected' } })).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled(); expect(f.readSettings).not.toHaveBeenCalled();
  f.readSettings.mockRejectedValue(new Error('Settings unavailable'));
  await expect(f.api.read({ query: 'name' })).rejects.toMatchObject({ code: 'projects_unavailable' });
  expect(f.requests).not.toHaveBeenCalled();
  f.readSettings.mockClear();
  expect(await f.api.read()).toEqual(snapshot);
  expect(await f.api.read({ query: '   ' })).toEqual(snapshot);
  expect(f.readSettings).not.toHaveBeenCalled();
});

it('initializes the full saved project generation before first dispatch without resolving device sources', async () => {
  const f=fixture(); let initialized=false;
  f.readSettings.mockResolvedValue({ projects: [{id:'one',path:'/one'}, {id:'two',path:'/offline',source:{resourceOwner:{kind:'managed_host',hostId:'offline',connectionId:'c',endpointIdentity:'e'},workspaceId:'w'}}] });
  f.requests.mockImplementation(async method => {
    if(method==='runtime.organization.read')return {...snapshot,initialized};
    if(method==='runtime.thread.catalog.list')return [];
    if(method==='runtime.organization.initialize'){initialized=true;return {};}
    throw new Error(`Unexpected device or owner call: ${method}`);
  });
  await f.service.read('alice',{limit:1});
  expect(f.requests).toHaveBeenCalledWith('runtime.organization.initialize',expect.objectContaining({principalId:'alice',initial:expect.objectContaining({projects:[{id:'one'},{id:'two'}]})}),undefined);
  f.readSettings.mockRejectedValue(new Error('Settings changed after initialization'));
  await f.service.read('alice',{limit:1});
  expect(f.readSettings).toHaveBeenCalledTimes(1);
});

it('restores unowned native conversations using their original observed project while excluding another user', async () => {
  const f = fixture(); let initialized = false;
  f.readSettings.mockResolvedValue({ projects: [{ id: 'project', path: '/work' }] });
  f.requests.mockImplementation(async method => {
    if (method === 'runtime.organization.read') return { ...snapshot, initialized };
    if (method === 'runtime.thread.catalog.list') return [
      { thread_id: 'legacy', principal_id: null, observer_project_ids: ['project'] },
      { thread_id: 'own', principal_id: 'alice', observer_project_ids: ['project'] },
      { thread_id: 'foreign', principal_id: 'bob', observer_project_ids: ['project'] },
    ];
    if (method === 'runtime.organization.initialize') { initialized = true; return {}; }
    throw new Error(`Unexpected call ${method}`);
  });
  await f.service.read('alice');
  const init = f.requests.mock.calls.find(([method]) => method === 'runtime.organization.initialize')![1];
  expect(init).toMatchObject({ principalId: 'alice', initial: { key: 'visible-project-generation', positions: [
    { conversation: { kind: 'native', id: 'legacy' }, projectId: 'project' },
    { conversation: { kind: 'native', id: 'own' }, projectId: 'project' },
  ] } });
});

it('keeps public native metadata changes with the Host owner instead of granting them to every reader', async () => {
  const f = fixture();
  f.requests.mockResolvedValue({ principal_id: null });
  f.threads.update.mockResolvedValue({ revision: 2 });
  const allowed = vi.fn(async () => false);
  f.runtime.principalCanUseHostResources = allowed;
  const input = { key: 'public-edit', items: [{ conversation: { kind: 'native' as const, id: 'legacy' }, expectedRevision: 1, patch: { pinned: true } }] };
  expect((await f.api.metadata(input)).items[0]?.status).toBe('failed');
  expect(f.threads.update).not.toHaveBeenCalled();
  allowed.mockResolvedValue(true);
  expect((await f.api.metadata(input)).items[0]?.status).toBe('succeeded');
  expect(allowed).toHaveBeenCalledWith('alice');
});

it('migrates external positions by exact source owner and logical workspace before legacy local paths', async () => {
  const f=fixture();let initialized=false;
  const owner={kind:'managed_host' as const,hostId:'target',connectionId:'paired',endpointIdentity:'target-endpoint'};
  const remoteSource={resource_owner:owner,workspace_id:'remote-workspace',execution_workspace_id:'isolated-copy',branch_id:'child-branch',revision:null,mode:'materialized' as const,live_root:null};
  f.readSettings.mockResolvedValue({projects:[
    {id:'local',path:'/same/path'},
    {id:'remote',path:'/same/path',source:{resourceOwner:owner,workspaceId:'remote-workspace'}},
    {id:'adopted',path:'/old/local/path',versionedWorkspace:{workspaceId:'logical-native',executionWorkspaceId:'native-root',branchId:'main',adoptionOperationId:'adopt',state:'ready'}},
    {id:'registered-local',path:'/registered/local',source:{resourceOwner:{kind:'local'},workspaceId:'local-workspace'}},
    {id:'ambiguous-one',path:'/ambiguous-one',source:{resourceOwner:owner,workspaceId:'shared-workspace'}},
    {id:'ambiguous-two',path:'/ambiguous-two',source:{resourceOwner:owner,workspaceId:'shared-workspace'}},
  ]});
  const conversation=(id:string,patch:Partial<ExternalConversation>={}):ExternalConversation=>({
    id,principalId:'alice',configurationId:'fixture',harness:'codex',title:id,cwd:'/same/path',revision:1,
    createdAt:1,updatedAt:1,archived:false,pinned:false,deleted:false,...patch,
  });
  f.external.list.mockResolvedValue([
    conversation('remote-exact',{cwd:'/runtime/mount',executionSource:remoteSource}),
    conversation('remote-unknown',{executionSource:{...remoteSource,workspace_id:'unknown'}}),
    conversation('other-host',{executionSource:{...remoteSource,resource_owner:{...owner,hostId:'other'}}}),
    conversation('other-connection',{executionSource:{...remoteSource,resource_owner:{...owner,connectionId:'other'}}}),
    conversation('other-endpoint',{executionSource:{...remoteSource,resource_owner:{...owner,endpointIdentity:'other'}}}),
    conversation('local-typed',{executionSource:{...remoteSource,resource_owner:{kind:'local'},workspace_id:'local-workspace'}}),
    conversation('native-adopted',{nativeWorkspace:{resource_owner:{kind:'local'},mode:'native_workspace',workspace_id:'logical-native',execution_workspace_id:'isolated-native',branch_id:'child',revision:null,live_root:null}}),
    conversation('legacy-local'),
    conversation('legacy-workspace',{cwd:'/not-registered',workspaceId:'local-workspace'}),
    conversation('ambiguous',{executionSource:{...remoteSource,workspace_id:'shared-workspace'}}),
    conversation('foreign',{principalId:'bob',executionSource:remoteSource}),
    conversation('deleted',{deleted:true,executionSource:remoteSource}),
  ]);
  f.requests.mockImplementation(async method=>{
    if(method==='runtime.organization.read')return {...snapshot,initialized};
    if(method==='runtime.thread.catalog.list')return [];
    if(method==='runtime.organization.initialize'){initialized=true;return {};}
    throw new Error(`Unexpected source resolution: ${method}`);
  });
  await f.service.read('alice',{});
  const initialization=f.requests.mock.calls.find(([method])=>method==='runtime.organization.initialize')![1] as {initial:{positions:Array<{conversation:{id:string};projectId:string|null}>}};
  expect(Object.fromEntries(initialization.initial.positions.map(item=>[item.conversation.id,item.projectId]))).toEqual({
    'remote-exact':'remote','remote-unknown':null,'other-host':null,'other-connection':null,'other-endpoint':null,
    'local-typed':'registered-local','native-adopted':'adopted','legacy-local':'local','legacy-workspace':'registered-local','ambiguous':null,
  });
  // A later source/Settings generation cannot rewrite the already admitted migration.
  f.external.list.mockRejectedValue(new Error('target disconnected'));
  f.readSettings.mockRejectedValue(new Error('Settings unavailable'));
  await f.service.read('alice',{});
  expect(f.external.list).toHaveBeenCalledTimes(1);
  expect(f.requests.mock.calls.filter(([method])=>method==='runtime.organization.initialize')).toHaveLength(1);
});

it('point reads original typed metadata without loading directory pages or project sources', async () => {
  const f = fixture();
  const conversation = { kind: 'external' as const, id: 'unloaded-task' };
  const entry = { conversation, title: 'Unloaded task', archived: true, pinned: false, revision: 3,
    position: { conversation, containerId: 'nested-group', order: 2, revision: 4, explicit: true, inheritedFrom: null }, path: ['nested-group'],
    origin: { botId: 'original-bot', directBotId: null, conversation: { kind: 'native', id: 'original-session' } } };
  f.requests.mockResolvedValue(entry);
  expect(await f.api.entry(conversation)).toEqual(entry);
  expect(f.requests.mock.calls).toEqual([['runtime.organization.entry', { principalId: 'alice', conversation }, expect.any(AbortSignal)]]);
  expect(f.readSettings).not.toHaveBeenCalled(); expect(f.external.list).not.toHaveBeenCalled();
  for (const input of [{ conversation, principalId: 'bob' }, { conversation: { ...conversation, principalId: 'bob' } }, { conversation: { kind: 'container', id: 'nested-group' } }]) {
    expect((await f.request('/api/conversation-organization/entry', input)).status).toBe(400);
  }
  expect(f.requests).toHaveBeenCalledTimes(1);
  await expect(f.api.entry({ kind: 'native', id: conversation.id })).rejects.toMatchObject({ code: 'invalid_response' });
  f.requests.mockRejectedValue(new KernelClientError({ code: 'not-found', message: 'conversation unavailable in current organization' }));
  await expect(f.api.entry(conversation)).rejects.toMatchObject({ code: 'not_found', status: 404 });
});
