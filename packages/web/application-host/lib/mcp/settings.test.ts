import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpConfigurationSnapshot } from '@varin/application-client';
import { McpAuthority, type McpAuthorityScope, type McpAuthorityOptions } from './authority.js';
import { McpOAuthCredentialStore } from './auth.js';
import { createMcpSettings } from './settings.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function createSettings(directory: string, options: McpAuthorityOptions = {}) {
  const authority = new McpAuthority(options); cleanup.push(() => authority.close());
  const scope: McpAuthorityScope = { resourceOwner: { kind: 'local' }, agentDir: directory, configCwd: directory, executionCwd: directory, environmentId: 'test', executionScope: 'global', projectTrusted: false, sessionId: 'settings' };
  const settings = createMcpSettings({ authority, resolveScope: async () => scope, changed() {} }); cleanup.push(() => settings.close());
  return { authority, settings, scope, directory };
}
function fixture() {
  const result = createSettings('/unused');
  const unwatch = vi.fn(); vi.spyOn(result.authority, 'subscribe').mockResolvedValue(unwatch);
  return { ...result, unwatch };
}
async function configuredFixture(options: McpAuthorityOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-settings-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { test: { url: 'http://localhost:1234/mcp' } } }));
  return createSettings(directory, options);
}

test('a failed initial settings snapshot releases the undisclosed view and its watcher', async () => {
  const { authority, settings, unwatch } = fixture();
  vi.spyOn(authority, 'directory').mockRejectedValue(new Error('configuration unavailable'));
  await expect(settings.invoke('open', {})).rejects.toThrow('configuration unavailable');
  expect(unwatch).toHaveBeenCalledOnce();
  settings.close(); expect(unwatch).toHaveBeenCalledOnce();
});

test('cancelling settings preparation closes its view even while the independent directory read is pending', async () => {
  const { authority, settings, unwatch } = fixture();
  const started = deferred<void>(), pending = deferred<Awaited<ReturnType<McpAuthority['directory']>>>();
  vi.spyOn(authority, 'directory').mockImplementation(() => { started.resolve(); return pending.promise; });
  const controller = new AbortController();
  const opening = settings.invoke('open', {}, controller.signal);
  const rejected = expect(opening).rejects.toThrow();
  await started.promise; controller.abort();
  expect(unwatch).toHaveBeenCalledOnce();
  pending.resolve([]);
  await rejected;
  settings.close(); expect(unwatch).toHaveBeenCalledOnce();
});


test('closing settings during its initial directory read never publishes a closed view', async () => {
  const { authority, settings } = await configuredFixture();
  const started = deferred<void>(), resume = deferred<void>();
  const readDirectory = authority.directory.bind(authority);
  vi.spyOn(authority, 'directory').mockImplementationOnce(async (...args) => {
    const result = await readDirectory(...args); started.resolve(); await resume.promise; return result;
  });
  const inspect = vi.spyOn(authority, 'inspect');
  const opening = settings.invoke('open', {});
  const rejected = expect(opening).rejects.toMatchObject({ code: 'mcp-view-unavailable' });
  await started.promise; settings.close(); resume.resolve();
  await rejected;
  expect(inspect).not.toHaveBeenCalled();
});

test('closing a view while connection scope preparation is pending prevents connecting and releases that scope', async () => {
  const { authority, settings } = await configuredFixture();
  const view = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  const started = deferred<string>(), resume = deferred<void>();
  const openScope = authority.open.bind(authority);
  vi.spyOn(authority, 'open').mockImplementationOnce(async input => {
    const opened = await openScope(input); started.resolve(opened.scope); await resume.promise; return opened;
  });
  const closeScope = vi.spyOn(authority, 'closeScope');
  const connect = vi.spyOn(authority, 'connect').mockRejectedValue(new Error('closed view must not connect'));
  const connecting = settings.invoke('command', { view: view.view, name: 'test', command: 'connect' });
  const rejected = expect(connecting).rejects.toMatchObject({ code: 'mcp-view-unavailable' });
  const scope = await started.promise;
  await settings.invoke('close', { view: view.view }); resume.resolve();
  await rejected;
  expect(connect).not.toHaveBeenCalled();
  expect(closeScope).toHaveBeenCalledExactlyOnceWith(scope);
});


test('settings can acquire and release its own holder without disconnecting another consumer', async () => {
  const initializations: string[] = [];
  const { authority, settings, scope, directory } = await configuredFixture({ fetch: async (url, init) => {
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') { initializations.push(String(url)); return reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); }
    if (request.method === 'tools/list') return reply({ tools: [] });
    return new Response(null, { status: 202 });
  } });
  const lease = await authority.acquire({ ...scope, sessionId: 'other-run' }, { servers: ['test'] });
  cleanup.push(() => lease.releaseAndDrain());
  const opened = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  expect(opened.servers[0]).toMatchObject({ status: 'connected', holdsConnection: false, canSignIn: true, signInRequired: false, canSignOut: false });
  const command = (command: string) => settings.invoke('command', { view: opened.view, name: 'test', command }) as Promise<McpConfigurationSnapshot>;
  expect((await command('connect')).servers[0]).toMatchObject({ status: 'connected', holdsConnection: true });
  expect(initializations).toEqual(['http://localhost:1234/mcp']);
  expect((await command('reconnect')).servers[0]).toMatchObject({ status: 'connected', holdsConnection: true });
  expect(initializations).toEqual(['http://localhost:1234/mcp', 'http://localhost:1234/mcp']);
  expect((await command('disconnect')).servers[0]).toMatchObject({ status: 'connected', holdsConnection: false });
  expect(lease.inspect().connectedServerCount).toBe(1);
  await command('connect');
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { test: { url: 'http://localhost:5678/mcp' } } }));
  await authority.reload(scope);
  expect((await command('reconnect')).servers[0]).toMatchObject({ status: 'connected', holdsConnection: true });
  expect(initializations).toEqual(['http://localhost:1234/mcp', 'http://localhost:1234/mcp', 'http://localhost:5678/mcp']);
});

test('sign-out availability follows original stored tokens, not discovery metadata or a new settings cache', async () => {
  const { authority, settings, directory, scope } = await configuredFixture();
  const credentials = new McpOAuthCredentialStore(directory); await credentials.prepare();
  const store = credentials.forServer('test', 'http://localhost:1234/mcp');
  await store.save({ state: 'discovery-only' });
  const opened = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  expect(opened.servers[0]).toMatchObject({ canSignIn: true, canSignOut: false, signInRequired: false });
  await store.save({ tokens: { access_token: 'private-test-token', token_type: 'Bearer' }, expiresAt: 1 });
  await authority.reload(scope, 'credentials');
  const withGrant = await settings.invoke('read', { view: opened.view }) as McpConfigurationSnapshot;
  expect(withGrant.servers[0]).toMatchObject({ canSignIn: false, canSignOut: true });
  expect(JSON.stringify(withGrant)).not.toContain('private-test-token');
  const cleared = await settings.invoke('command', { view: opened.view, name: 'test', command: 'sign-out' }) as McpConfigurationSnapshot;
  expect(cleared.servers[0]).toMatchObject({ canSignIn: true, canSignOut: false });
  await credentials.prepare(true); expect(credentials.tokens('test', 'http://localhost:1234/mcp')).toBeUndefined();
});

test('a real authentication failure preserves sign-in recovery even with a stored grant', async () => {
  const { settings, directory } = await configuredFixture({ fetch: async () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }) });
  const credentials = new McpOAuthCredentialStore(directory); await credentials.prepare();
  await credentials.forServer('test', 'http://localhost:1234/mcp').save({ tokens: { access_token: 'rejected-test-token', token_type: 'Bearer' } });
  const opened = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  const failed = await settings.invoke('command', { view: opened.view, name: 'test', command: 'connect' }) as McpConfigurationSnapshot;
  expect(failed.servers[0]).toMatchObject({ status: 'needs-auth', holdsConnection: true, canSignIn: true, signInRequired: true, canSignOut: true });
});


test('an invalid OAuth record reports a per-server error without hiding independent servers or rewriting credentials', async () => {
  let fetches = 0;
  const { authority, settings, directory, scope } = await configuredFixture({ fetch: async () => { fetches++; throw new Error('offline fixture'); } });
  const credentials = new McpOAuthCredentialStore(directory); await credentials.prepare();
  await credentials.forServer('test', 'http://localhost:1234/mcp').save({ tokens: { access_token: 'private-test-token', token_type: 'Bearer' } });
  const retainedView = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  await settings.invoke('command', { view: retainedView.view, name: 'test', command: 'connect' });
  const path = join(directory, 'mcp-auth.json');
  const broken = JSON.parse(await readFile(path, 'utf8')) as Record<string, { version: number }>;
  Object.values(broken)[0]!.version = 999;
  const content = JSON.stringify(broken); await writeFile(path, content);
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { test: { url: 'http://localhost:1234/mcp' }, independent: { url: 'http://localhost:5678/mcp' } } }));
  await authority.reload(scope);
  const opened = await settings.invoke('read', { view: retainedView.view }) as McpConfigurationSnapshot;
  expect(opened.servers.find(server => server.name === 'test')).toMatchObject({ holdsConnection: true, canConnect: false, canSignIn: false, canSignOut: false, error: 'MCP credentials are unavailable. Check the MCP credential store.' });
  expect(opened.servers.find(server => server.name === 'independent')).toMatchObject({ canSignIn: true, canSignOut: false });
  const inspection = await authority.inspect(scope);
  expect(inspection.servers.find(server => server.name === 'test')?.hasStoredOAuthGrant).toBeUndefined();
  expect(inspection.servers.find(server => server.name === 'independent')?.hasStoredOAuthGrant).toBe(false);
  expect(JSON.stringify(opened)).not.toContain('private-test-token');
  const beforeRetry = fetches;
  await expect(settings.invoke('command', { view: opened.view, name: 'test', command: 'reconnect' })).rejects.toThrow('MCP credential is invalid');
  expect(fetches).toBe(beforeRetry);
  const released = await settings.invoke('command', { view: opened.view, name: 'test', command: 'disconnect' }) as McpConfigurationSnapshot;
  expect(released.servers.find(server => server.name === 'test')).toMatchObject({ holdsConnection: false, canSignOut: false });
  expect(await readFile(path, 'utf8')).toBe(content);
});
