import { Router, type Express } from 'express';
import { expect, it, vi } from 'vitest';
import { BrowserExecutionError, type BrowserOwner, type BrowserPage, type BrowserResourceCapability, type BrowserUseScope } from '@varin/protocol';
import { routerTransport } from '../extensions/direct-router.test-helper.js';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity } from '../harness/managed-remote-client.js';
import { BrowserResources } from './browser-resources.js';
import { ManagedBrowserPeers, managedBrowserResourceId, managedBrowserThread, registerManagedBrowserRoutes } from './browser-managed.js';
import { createBrowserSettings } from './browser-settings.js';

const prefix = '/api/harness/managed-execution/v1';
const mount = '/original/mount';
const page = (browserId = 'local-browser'): BrowserPage => ({ browserId, pageId: 'tab', title: 'Original tab',
  url: 'https://example.org', loading: false, canGoBack: false, canGoForward: false, retained: true });
function fixture() {
  let instanceId = 'browser-session', peerHostId = 'browser-host';
  let declared: BrowserResourceCapability[] = ['tabs', 'open', 'read', 'act', 'activate', 'upload', 'download'];
  let offline = false, lostReceipt = false, corruptReceipt = false;
  let operations: string[] | undefined;
  const scopes: BrowserUseScope[] = [];
  const original = new BrowserResources();
  const owner: BrowserOwner = {
    browserId: 'local-browser',
    resource: async () => ({ instanceId, state: 'online', capabilities: declared, ...(operations ? { operations } : {}) }),
    forScope: scope => { scopes.push(scope); return owner; },
    list: vi.fn(async () => [page()]),
    open: vi.fn(async () => page()),
    read: vi.fn(async () => ({ page: page(), observationId: 'original-observation', viewport: { width: 100, height: 200, scale: 1 }, frames: [] })),
    act: vi.fn(async (_pageId, action) => ({ page: page(), action: action.action })),
    activate: vi.fn(async () => {}),
    downloads: vi.fn(async () => [{ downloadId: 'file', pageId: 'tab', name: 'result.bin', url: '', receivedBytes: 3, state: 'completed' as const }]),
    readDownload: vi.fn(async () => ({ name: 'result.bin', bytes: new Uint8Array([0, 128, 255]) })),
    releaseDownload: vi.fn(async () => {}),
    upload: vi.fn(async () => ({ page: page(), action: 'upload' as const })),
    retainForThread: vi.fn(), releaseThread: vi.fn(async () => {}), subscribe: () => () => {},
  };
  original.register(owner, 'Chrome', 'Browser device');
  original.register({ ...owner, browserId: 'recursive-import' }, 'Other peer', 'Elsewhere', { remote: true });
  const routes = Router();
  let browserDocument: Record<string, unknown> = {};
  const browserSettings = createBrowserSettings({ resources: original, read: async () => browserDocument,
    update: async change => { browserDocument = change(browserDocument); } });
  routes.get(`${prefix}/identity`, (req, res) => {
    res.setHeader('X-Varin-Managed-Host', peerHostId);
    if (req.headers.authorization !== 'Bearer existing-host-token') { res.status(403).json({ error: 'Unpaired' }); return; }
    // Browsers do not require sources, storage, or Experiment capabilities.
    res.json({ protocolVersion: 1, hostId: peerHostId, capabilities: [], machine: { state: 'available' } });
  });
  registerManagedBrowserRoutes(routes as unknown as Express, { hostId: peerHostId, resources: original,
    settings: browserSettings,
    requireAuth: (_req, _res, next) => next(),
    clientId: async req => req.headers.authorization === 'Bearer existing-host-token' ? 'paired-coordinator' : undefined });
  const router = Router(); router.use(mount, routes);
  const transport = routerTransport(router);
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (offline) throw new Error('The original peer is offline');
    const response = await transport(new URL(String(input)), init);
    if (lostReceipt && String(input).endsWith('/browser/call') && JSON.parse(String(init.body)).method === 'act') {
      throw new Error('The response was lost after browser input');
    }
    if (corruptReceipt && String(input).endsWith('/browser/call') && JSON.parse(String(init.body)).method === 'act') {
      return Response.json({ value: { page: page('wrong-browser'), action: 'reload' } }, { headers: { 'X-Varin-Managed-Host': peerHostId } });
    }
    return response;
  });
  let settings = { desktopHosts: [{ id: 'original-connection', apiUrl: `https://original.example${mount}`,
    label: 'Office', clientToken: 'existing-host-token' }] };
  const targets = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never, resources: {} as never,
    readSettings: async () => settings, fetch: fetch as typeof globalThis.fetch });
  const resources = new BrowserResources();
  const peers = new ManagedBrowserPeers('coordinator', resources, targets, fetch as typeof globalThis.fetch);
  resources.setRefresh(() => peers.refresh());
  const peer = { kind: 'managed_host' as const, hostId: peerHostId, connectionId: 'original-connection', endpointIdentity: managedEndpointIdentity(settings.desktopHosts[0]!) };
  const binding = { browserId: managedBrowserResourceId(peer, 'local-browser'), instanceId, pageId: 'tab' };
  const raw = (body: unknown, token = 'existing-host-token') => transport(new URL(`https://original.example${mount}${prefix}/browser/call`), {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { owner, original, resources, peers, targets, scopes, fetch, binding, peer, raw, browserSettings,
    replaceInstance() { instanceId = 'new-browser-session'; }, replaceHost() { peerHostId = 'replacement-host'; },
    replaceEndpoint() { settings.desktopHosts[0]!.apiUrl = 'https://replacement.example/other'; },
    setOffline(value: boolean) { offline = value; }, loseReceipt() { lostReceipt = true; },
    corruptReceipt() { corruptReceipt = true; }, operations(value: string[]) { operations = value; },
    restrict() { declared = ['tabs', 'read']; },
    addConnection() { settings = { desktopHosts: [...settings.desktopHosts, { ...settings.desktopHosts[0]!, id: 'other-connection' }] }; },
  };
}
const call = { coordinatorHostId: 'coordinator', browserId: 'local-browser', instanceId: 'browser-session', method: 'list', args: [] };

it('manages the selected device configuration through its original mounted connection and maps viewing back to that resource', async () => {
  const f = fixture();
  const initial = await f.peers.configuration('original-connection');
  expect(initial.viewBrowserIds?.['local-browser']).toBe(f.binding.browserId);
  const saved = await f.peers.configuration('original-connection', { ...initial.settings, defaultBrowserId: 'local-browser' });
  expect((await f.browserSettings.read()).defaultBrowserId).toBe('local-browser');
  expect(saved.settings.revision).not.toBe(initial.settings.revision);
  await expect(f.peers.configuration('original-connection', initial.settings)).rejects.toThrow('changed');
  expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer existing-host-token')).toBe(true);
});

it('discovers local peer resources through existing mounted authenticated Host connections, never imported peers', async () => {
  const f = fixture();
  const discovered = await f.resources.list();
  expect(discovered).toHaveLength(1);
  expect(discovered[0]).toMatchObject({ browserId: f.binding.browserId, label: 'Chrome', deviceName: 'Office · Browser device', state: 'online' });
  expect(await f.resources.use(f.binding, {}, owner => owner.list())).toEqual([page(f.binding.browserId)]);
  expect(await f.resources.list({ localOnly: true })).toEqual([]);
  expect(f.fetch.mock.calls.every(([url, init]) => String(url).startsWith(`https://original.example${mount}/`) && init?.redirect === 'error')).toBe(true);
  expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer existing-host-token')).toBe(true);
  expect(JSON.stringify(discovered)).not.toContain('existing-host-token');
  expect(JSON.stringify(discovered)).not.toContain('original.example');
});

it('keeps different connections and mounts distinct even when Host and browser IDs match', async () => {
  const f = fixture(); f.addConnection();
  const discovered = await f.resources.list();
  expect(discovered).toHaveLength(2);
  expect(new Set(discovered.map(item => item.browserId)).size).toBe(2);
  expect(managedBrowserResourceId({ ...f.peer, endpointIdentity: 'another-mount' }, 'local-browser')).not.toBe(f.binding.browserId);
  expect(managedBrowserResourceId({ ...f.peer, hostId: 'another-host' }, 'local-browser')).not.toBe(f.binding.browserId);
});

it('rejects changed endpoint or Host identity before dispatch without falling back to another connection', async () => {
  const f = fixture(); await f.resources.list(); f.addConnection(); f.replaceEndpoint();
  await expect(f.resources.use(f.binding, {}, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toMatchObject({ effect: 'none' });
  expect(f.owner.act).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.some(([url]) => String(url).includes('replacement.example'))).toBe(false);
  const other = fixture(); await other.resources.list(); other.replaceHost();
  await expect(other.resources.use(other.binding, {}, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toMatchObject({ effect: 'none' });
  expect(other.owner.act).not.toHaveBeenCalled();
});

it('retains offline registrations and rejects a replacement instance instead of reusing the old page binding', async () => {
  const f = fixture(); await f.resources.list(); f.setOffline(true);
  expect(await f.resources.list()).toMatchObject([{ browserId: f.binding.browserId, instanceId: 'browser-session', state: 'interrupted' }]);
  await expect(f.resources.use(f.binding, {}, owner => owner.list())).rejects.toThrow('interrupted');
  f.setOffline(false); f.replaceInstance();
  expect(await f.resources.list()).toMatchObject([{ browserId: f.binding.browserId, instanceId: 'new-browser-session', state: 'online' }]);
  await expect(f.resources.use(f.binding, {}, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toThrow('original browser instance ended');
  expect(f.owner.act).not.toHaveBeenCalled();
});

it('forwards observations and file bytes from the original owner with a foreign Thread namespace and no local Run authority', async () => {
  const f = fixture(); await f.resources.list();
  const scope = { threadId: 'work', runId: 'never-a-local-run', operationId: 'operation' };
  const observed = await f.resources.use(f.binding, scope, owner => owner.read({ pageId: 'tab' }), { observes: true });
  expect(observed.page.browserId).toBe(f.binding.browserId);
  expect(f.scopes.at(-1)).toMatchObject({ threadId: managedBrowserThread('paired-coordinator', 'coordinator', 'work') });
  expect(f.scopes.at(-1)).not.toHaveProperty('runId');
  expect(f.scopes.at(-1)).not.toHaveProperty('operationId');
  expect(f.owner.retainForThread).toHaveBeenCalledWith('tab', managedBrowserThread('paired-coordinator', 'coordinator', 'work'));
  const result = await f.resources.use(f.binding, scope, owner => owner.readDownload('tab', 'file'));
  expect([...result.bytes]).toEqual([0, 128, 255]);
  await f.resources.use(f.binding, scope, owner => owner.upload('tab', 'input', [{ name: 'original.bin', bytes: new Uint8Array([255, 0, 128]) }]), { writes: true });
  expect(f.owner.upload).toHaveBeenCalledWith('tab', 'input', [{ name: 'original.bin', bytes: Buffer.from([255, 0, 128]) }]);
});

it('rejects unsupported file transfer and invalid methods or scope injection before touching the owner', async () => {
  const f = fixture(); f.restrict(); await f.resources.list();
  await expect(f.resources.use(f.binding, {}, owner => owner.readDownload('tab', 'file'))).rejects.toMatchObject({ effect: 'none' });
  expect(f.owner.readDownload).not.toHaveBeenCalled();
  for (const input of [ { ...call, method: '__proto__' }, { ...call, runId: 'local-run' },
    { ...call, method: 'controlPage', args: ['tab', ['takeover']] },
    { ...call, method: 'act', args: ['tab', { action: 'evaluate', script: '1', unexpected: true }] },
    { ...call, method: 'open', args: [{ url: 'https://example.org', instanceId: 'forged' }] },
    { ...call, browserId: 'recursive-import' } ]) {
    const response = await f.raw(input);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ effect: 'none' });
  }
  const unpaired = await f.raw(call, 'wrong-token'); expect(unpaired.status).toBe(403);
  expect(f.owner.list).not.toHaveBeenCalled(); expect(f.owner.act).not.toHaveBeenCalled();
});

it('remote takeover and handback govern the canonical page lane, with a fresh task observation required', async () => {
  const f = fixture(); await f.resources.list();
  expect(await f.resources.control(f.binding, 'takeover')).toMatchObject({ controller: 'human' });
  expect(await f.resources.currentUsage(f.binding)).toMatchObject({ controller: 'human' });
  const originalBinding = { ...f.binding, browserId: 'local-browser' };
  await expect(f.original.use(originalBinding, { threadId: 'local-task' }, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toThrow('user is controlling');
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toMatchObject({ effect: 'none' });
  await f.resources.control(f.binding, 'resume');
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toThrow('Read the current page');
  await f.resources.use(f.binding, { threadId: 'work' }, owner => owner.read({ pageId: 'tab' }), { observes: true });
  await f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true });
  expect(f.owner.act).toHaveBeenCalledTimes(1);
});

it('does not replay an action when its response is lost, including after peer rediscovery', async () => {
  const f = fixture(); await f.resources.list(); f.loseReceipt();
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true }))
    .rejects.toMatchObject({ effect: 'unknown', executorStopped: false });
  expect(f.owner.act).toHaveBeenCalledTimes(1);
  await f.resources.list(); await f.resources.list();
  expect(f.owner.act).toHaveBeenCalledTimes(1);
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true })).rejects.toThrow('has not confirmed that input stopped');
  expect(f.owner.act).toHaveBeenCalledTimes(1);
});

it('does not abort a dispatched mutation or free its page lane when the caller stops observing', async () => {
  const f = fixture(); await f.resources.list();
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const completion = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(f.owner.act).mockImplementationOnce(async (_pageId, action, signal) => {
    expect(signal).toBeUndefined(); started(); await completion; return { page: page(), action: action.action };
  });
  const controller = new AbortController();
  let settled = false;
  const active = f.resources.use(f.binding, { threadId: 'work', signal: controller.signal }, owner => owner.act('tab', { action: 'reload' }, controller.signal), { writes: true }).finally(() => { settled = true; });
  await entered; controller.abort();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(f.original.usage({ ...f.binding, browserId: 'local-browser' }).activeThreadId).toBe(managedBrowserThread('paired-coordinator', 'coordinator', 'work'));
  finish(); await active; expect(f.owner.act).toHaveBeenCalledTimes(1);
});

it('preserves a provider rejection before input as effect none', async () => {
  const f = fixture(); await f.resources.list();
  vi.mocked(f.owner.act).mockRejectedValueOnce(new BrowserExecutionError('Original page reference expired', 'none'));
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true }))
    .rejects.toMatchObject({ effect: 'none', executorStopped: true });
});

it('honors precise provider action capabilities instead of upgrading them to generic input', async () => {
  const f = fixture(); f.operations(['list', 'act:click:point', 'act:type:focused']); await f.resources.list();
  await f.resources.use(f.binding, {}, owner => owner.list());
  await f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'click', point: { x: 2, y: 3 }, observationId: 'observed' }), { writes: true });
  await f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'type', text: 'hello' }), { writes: true });
  await expect(f.resources.use(f.binding, {}, owner => owner.act('tab', { action: 'click', ref: 'element' }), { writes: true })).rejects.toMatchObject({ effect: 'none' });
  await expect(f.resources.use(f.binding, {}, owner => owner.act('tab', { action: 'type', text: 'hello', replace: true }), { writes: true })).rejects.toMatchObject({ effect: 'none' });
  expect(f.owner.act).toHaveBeenCalledTimes(2);
});

it('does not accept another browser page as the receipt of a dispatched mutation', async () => {
  const f = fixture(); await f.resources.list(); f.corruptReceipt();
  await expect(f.resources.use(f.binding, { threadId: 'work' }, owner => owner.act('tab', { action: 'reload' }), { writes: true }))
    .rejects.toMatchObject({ effect: 'unknown', executorStopped: false });
  expect(f.owner.act).toHaveBeenCalledTimes(1);
});

it('releases the original local browser binding without re-registering it or recursively releasing peers', async () => {
  const f = fixture(); await f.resources.list();
  const threadId = managedBrowserThread('paired-coordinator', 'coordinator', 'work');
  await f.resources.use(f.binding, { threadId: 'work' }, owner => owner.read({ pageId: 'tab' }), { observes: true });
  expect(await f.original.use({}, { threadId }, async (_owner, binding) => binding.browserId)).toBe('local-browser');
  await f.resources.releaseThread('work');
  expect(f.owner.releaseThread).toHaveBeenCalledExactlyOnceWith(threadId);
  await expect(f.original.use({}, { threadId }, async () => null)).rejects.toThrow('Choose a browser');
});
