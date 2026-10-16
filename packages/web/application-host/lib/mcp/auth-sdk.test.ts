import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth } from '@modelcontextprotocol/client';
import { McpOAuthCredentialStore, mcpAuthProvider, mcpCredentialPath, mcpOAuthFetch, oauthProvider } from './auth.js';
import { McpServerConnection, createDefaultTransport } from './connection.js';
import { McpAuthority, type McpAuthorityScope } from './authority.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function credentials() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-auth-sdk-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const owner = new McpOAuthCredentialStore(directory); await owner.prepare();
  return { directory, owner };
}

test('an unreadable reloaded credential store blocks the old token until the same store recovers', async () => {
  const { directory, owner } = await credentials();
  await owner.forServer('fixture', 'https://fixture/mcp').save({ tokens: { access_token: 'synthetic-token', token_type: 'Bearer' } });
  const provider = mcpAuthProvider('fixture', 'https://fixture/mcp', owner, {});
  const original = owner.binding('fixture', 'https://fixture/mcp');
  const path = mcpCredentialPath(directory), valid = await readFile(path, 'utf8');
  expect(await provider.token()).toBe('synthetic-token');
  await writeFile(path, '{broken'); await owner.prepare(true);
  await expect(provider.token()).rejects.toThrow();
  expect(() => owner.binding('fixture', 'https://fixture/mcp')).toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
  await writeFile(path, valid); await owner.prepare(true);
  expect(await provider.token()).toBe('synthetic-token');
  expect(owner.binding('fixture', 'https://fixture/mcp')).toEqual(original);
});

test('a real SDK refresh receives the original service headers and then connects with the rotated token', async () => {
  const { directory, owner } = await credentials();
  const url = 'https://fixture/mcp';
  await owner.forServer('fixture', url).save({
    tokens: { access_token: 'expired-token', refresh_token: 'synthetic-refresh', token_type: 'Bearer', issuer: 'https://fixture' },
    expiresAt: Date.now() - 1,
    client: { client_id: 'fixture-client', issuer: 'https://fixture' },
    discovery: { authorizationServerUrl: 'https://fixture', resourceMetadata: { resource: url, authorization_servers: ['https://fixture'] },
      authorizationServerMetadata: { issuer: 'https://fixture', authorization_endpoint: 'https://fixture/authorize', token_endpoint: 'https://fixture/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] } },
  });
  const original = owner.binding('fixture', url);
  const refreshHeaders: Headers[] = [], rpcHeaders: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (String(input) === 'https://fixture/token') {
      refreshHeaders.push(headers);
      if (headers.get('x-service-key') !== 'synthetic-service-key') return Response.json({ error: 'access_denied' }, { status: 403 });
      return Response.json({ access_token: 'rotated-token', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    rpcHeaders.push(headers);
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.method === 'tools/list') return reply({ tools: [] });
    return new Response(null, { status: 202 });
  };
  const connection = new McpServerConnection({ entry: { name: 'fixture', source: directory, config: { url, headers: { 'x-service-key': 'synthetic-service-key' }, oauth: { clientId: 'fixture-client' } } },
    cwd: directory, credentials: owner, fetch, createTransport: (...args) => createDefaultTransport(...args, fetch), onTools() {} });
  cleanup.push(() => connection.close());
  await connection.getToolsClient();
  expect(refreshHeaders).toHaveLength(1);
  expect(refreshHeaders[0]?.get('x-service-key')).toBe('synthetic-service-key');
  expect(refreshHeaders[0]?.get('content-type')).toBe('application/x-www-form-urlencoded');
  expect(rpcHeaders.every(headers => headers.get('authorization') === 'Bearer rotated-token')).toBe(true);
  expect(owner.tokens('fixture', url)?.refresh_token).toBe('rotated-refresh');
  expect(owner.binding('fixture', url)).toEqual(original);
});

test('SDK discovery receives frozen resource headers without forwarding them to a separate issuer', async () => {
  const { directory, owner } = await credentials();
  const variable = 'VARIN_MCP_AUTH_FIXTURE_HEADER', previous = process.env[variable];
  process.env[variable] = 'synthetic-original';
  cleanup.push(async () => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const seen: Array<{ url: string; header: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input); seen.push({ url, header: new Headers(init?.headers).get('x-service-key') });
    if (url === 'https://fixture/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: 'https://fixture/mcp', authorization_servers: ['https://issuer'] });
    if (url === 'https://issuer/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://issuer', authorization_endpoint: 'https://issuer/authorize', token_endpoint: 'https://issuer/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    throw new Error('Unexpected fixture request');
  };
  const connection = new McpServerConnection({ entry: { name: 'fixture', source: directory, config: { url: 'https://fixture/mcp', headers: { 'x-service-key': `\${${variable}}` } } },
    cwd: directory, credentials: owner, fetch, createTransport: (...args) => createDefaultTransport(...args, fetch), onTools() {} });
  cleanup.push(() => connection.close());
  process.env[variable] = 'synthetic-replacement';
  const redirects: URL[] = [];
  const store = owner.forServer('fixture', 'https://fixture/mcp');
  await store.save({ client: { client_id: 'fixture-client', issuer: 'https://issuer' } });
  const provider = oauthProvider({ store, settings: { clientId: 'fixture-client' },
    redirectUrl: 'http://127.0.0.1/callback', redirect: url => { redirects.push(url); } });
  expect(await auth(provider, { serverUrl: 'https://fixture/mcp', forceReauthorization: true, fetchFn: connection.oauthFetch() })).toBe('REDIRECT');
  expect(seen).toEqual([
    { url: 'https://fixture/.well-known/oauth-protected-resource/mcp', header: 'synthetic-original' },
    { url: 'https://issuer/.well-known/oauth-authorization-server', header: null },
  ]);
  expect(redirects[0]?.origin).toBe('https://issuer');
});

test('a configured OAuth client retains its SDK issuer binding before an authorization-code exchange', async () => {
  const { owner } = await credentials();
  const serverUrl = 'https://fixture/mcp', store = owner.forServer('fixture', serverUrl);
  await store.save({ client: { client_id: 'fixture-client', client_secret: 'synthetic-client-secret', issuer: 'https://original-issuer' }, verifier: 'synthetic-verifier',
    discovery: { authorizationServerUrl: 'https://changed-issuer', resourceMetadata: { resource: serverUrl, authorization_servers: ['https://changed-issuer'] },
      authorizationServerMetadata: { issuer: 'https://changed-issuer', authorization_endpoint: 'https://changed-issuer/authorize', token_endpoint: 'https://changed-issuer/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] } },
  });
  const provider = oauthProvider({ store, settings: { clientId: 'fixture-client', clientSecret: 'synthetic-client-secret' }, redirectUrl: 'http://127.0.0.1/callback' });
  let tokenRequests = 0;
  await expect(auth(provider, { serverUrl, authorizationCode: 'synthetic-code', fetchFn: async () => {
    tokenRequests++; return Response.json({ access_token: 'synthetic-other-issuer-token', token_type: 'Bearer' });
  } })).rejects.toThrow('Existing OAuth client information is required');
  expect(tokenRequests).toBe(0);
  expect(store.load()?.client?.issuer).toBe('https://original-issuer');
  expect(store.load()?.tokens).toBeUndefined();
});

test('OAuth service headers preserve SDK and Request header precedence and reject protected redirects', async () => {
  const seen: Array<{ headers: Headers; redirect: RequestInit['redirect'] }> = [];
  const fetch = mcpOAuthFetch('https://fixture/mcp', { authorization: 'service-value', 'x-service-key': 'synthetic-key', accept: 'service-type' }, async (_input, init) => {
    seen.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
    return new Response(null, { status: 204 });
  });
  await fetch(new Request('https://fixture/token', { headers: { authorization: 'Basic sdk-value', accept: 'application/json' } }));
  expect(seen[0]?.headers.get('authorization')).toBe('Basic sdk-value');
  expect(seen[0]?.headers.get('accept')).toBe('application/json');
  expect(seen[0]?.headers.get('x-service-key')).toBe('synthetic-key');
  expect(seen[0]?.redirect).toBe('error');
  await fetch('https://issuer/token', { headers: { authorization: 'Basic issuer-value' }, redirect: 'manual' });
  expect(seen[1]?.headers.get('authorization')).toBe('Basic issuer-value');
  expect(seen[1]?.headers.get('x-service-key')).toBeNull();
  expect(seen[1]?.redirect).toBe('manual');
  for (const location of ['https://fixture/another', 'https://other/target']) {
    let requests = 0;
    const redirected = mcpOAuthFetch('https://fixture/mcp', { 'x-service-key': 'synthetic-key' }, async () => {
      requests++; return new Response(null, { status: 307, headers: { location } });
    });
    await expect(redirected('https://fixture/metadata')).rejects.toThrow('MCP OAuth HTTP request failed');
    expect(requests).toBe(1);
  }
  const rejected = mcpOAuthFetch('https://fixture/mcp', { 'x-service-key': 'synthetic-key' }, async () => { throw new Error('synthetic-private-diagnostic'); });
  await expect(rejected('https://fixture/token')).rejects.toThrow(/^MCP OAuth HTTP request failed$/);
});

test('the original authority lease blocks dispatch while credentials are unknown and recovers without replacing its grant', async () => {
  const { directory, owner } = await credentials();
  const url = 'https://fixture/mcp';
  await owner.forServer('fixture', url).save({ tokens: { access_token: 'synthetic-token', token_type: 'Bearer' } });
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url, exposure: 'direct' } } }));
  const scope: McpAuthorityScope = { resourceOwner: { kind: 'local' }, agentDir: directory, configCwd: directory,
    executionCwd: directory, executionScope: 'global', environmentId: 'fixture', sessionId: 'original', projectTrusted: false };
  let calls = 0;
  const authority = new McpAuthority({ fetch: async (_input, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.method === 'tools/list') return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    if (request.method === 'tools/call') { calls++; return reply({ content: [{ type: 'text', text: 'done' }] }); }
    return new Response(null, { status: 202 });
  } });
  cleanup.push(() => authority.close());
  const lease = await authority.acquire(scope, { servers: ['fixture'] }); cleanup.push(() => lease.releaseAndDrain());
  const tool = lease.binding.tools[0]!;
  const invoke = () => lease.callTool(tool.name, {}, { schemaVersion: tool.schemaVersion, signal: new AbortController().signal });
  await invoke(); expect(calls).toBe(1);
  const path = mcpCredentialPath(directory), valid = await readFile(path, 'utf8');
  await writeFile(path, '{broken'); await authority.reload(scope, 'credentials');
  await expect(invoke()).rejects.toThrow(); expect(calls).toBe(1);
  const unavailable = await authority.inspect(scope);
  expect(unavailable.servers[0]?.hasStoredOAuthGrant).toBeUndefined();
  expect(unavailable.servers[0]?.credentialError).toBeDefined();
  expect(await readFile(path, 'utf8')).toBe('{broken');
  await writeFile(path, valid); await authority.reload(scope, 'credentials');
  await expect(invoke()).resolves.toMatchObject({ content: [{ text: 'done' }] }); expect(calls).toBe(2);
});
