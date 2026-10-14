import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpAuthority, type McpAuthorityScope } from './authority.js';
import { ConfigWatchManager } from '../configuration-watch.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-service-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://fixture/mcp', exposure: 'direct' } } }));
  const scope: McpAuthorityScope = { resourceOwner: { kind: 'local' }, agentDir: directory, configCwd: directory,
    executionCwd: directory, executionScope: 'global', environmentId: 'fixture', sessionId: 'one', projectTrusted: false };
  return { directory, file, scope };
}

test('shared preparation survives a cancelled first consumer and does not wait for resources', async () => {
  const { scope } = await fixture();
  const toolsStarted = deferred(), releaseTools = deferred();
  let initializations = 0;
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') { initializations++; return reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } }); }
    if (request.method === 'tools/list') { toolsStarted.resolve(); await releaseTools.promise; return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] }); }
    if (request.method === 'resources/list' || request.method === 'resources/templates/list') return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
    if (request.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'done' }] });
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const controller = new AbortController();
  const first = authority.acquire(scope, { servers: ['server'], signal: controller.signal });
  const second = authority.acquire({ ...scope, sessionId: 'two' }, { servers: ['server'] });
  await toolsStarted.promise;
  const cancelled = expect(first).rejects.toThrow(); controller.abort(); await cancelled;
  releaseTools.resolve();
  const lease = await second;
  expect(initializations).toBe(1);
  const tool = lease.binding.tools[0]!;
  expect(await lease.callTool(tool.name, {}, { schemaVersion: tool.schemaVersion, signal: new AbortController().signal })).toMatchObject({ content: [{ text: 'done' }] });
  await lease.releaseAndDrain();
  await authority.close();
  let networkCalls = 0;
  const reopened = new McpAuthority({ fetch: async () => { networkCalls++; throw new Error('offline'); } }); cleanup.push(() => reopened.close());
  const offline = await reopened.acquire(scope, { servers: [] });
  const cached = await offline.cachedTools(new AbortController().signal);
  expect(cached).toMatchObject([{ server: 'server', tool: 'read', cached: true }]);
  expect(cached[0]).not.toHaveProperty('schemaVersion');
  expect(offline.inspect().cachedToolCount).toBe(1);
  expect(offline.inspect().connectedServerCount).toBe(0);
  expect(networkCalls).toBe(0);
  await offline.releaseAndDrain();
});

test('invalid sources retain their own valid definitions while independent files still update', async () => {
  const { directory, file, scope } = await fixture();
  const external = join(directory, 'external.json');
  await writeFile(external, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
  await writeFile(file, JSON.stringify({ sources: ['external.json'], mcpServers: { server: { command: 'first' } } }));
  const authority = new McpAuthority(); cleanup.push(() => authority.close());
  expect((await authority.inspect(scope)).configuredServerCount).toBe(2);
  await writeFile(file, '{broken');
  await writeFile(external, JSON.stringify({ mcpServers: { other: { command: 'other', enabled: false } } }));
  const result = await authority.inspect(scope);
  expect(result.configErrorCount).toBeGreaterThan(0);
  expect(result.servers.find(server => server.name === 'server')?.status).toBe('unprepared');
  expect(result.servers.find(server => server.name === 'other')?.status).toBe('disabled');
});

test('watch failure leaves valid configuration usable and explicit unchanged reads do not trigger refresh loops', async () => {
  const { scope, file } = await fixture();
  const watch = vi.spyOn(ConfigWatchManager.prototype, 'watch').mockRejectedValue(new Error('watch unavailable'));
  const authority = new McpAuthority();
  let changes = 0;
  try {
    const unsubscribe = await authority.subscribe(scope, change => { if (change.kind === 'configuration') changes++; });
    const current = await authority.inspect(scope);
    expect(current.configuredServerCount).toBe(1);
    expect(current.configErrorCount).toBeGreaterThan(0);
    await authority.reload(scope); await authority.reload(scope);
    expect(changes).toBe(0);
    await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://fixture/mcp', enabled: false } } }));
    await authority.reload(scope);
    expect((await authority.inspect(scope)).servers[0]?.status).toBe('disabled');
    expect(changes).toBe(1);
    unsubscribe();
  } finally { await authority.close(); watch.mockRestore(); }
});

test('resource and prompt operations remain available while tools and templates have not completed', async () => {
  const { scope } = await fixture();
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.method === 'tools/list' || request.method === 'resources/templates/list') return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
    if (request.method === 'resources/list') return reply({ resources: [] });
    if (request.method === 'resources/read') return reply({ contents: [{ uri: request.params.uri, text: 'available' }] });
    if (request.method === 'prompts/list') return reply({ prompts: [{ name: 'ready' }] });
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const lease = await authority.acquire(scope, { servers: [] });
  const services = await lease.discoverServices('server', new AbortController().signal);
  const resource = services.find(service => service.kind === 'resources')!;
  expect(await lease.requestService(resource, { operation: 'resources/read', uri: 'fixture:///ready' }, { signal: new AbortController().signal }))
    .toMatchObject({ result: { contents: [{ text: 'available' }] } });
  const prompt = services.find(service => service.kind === 'prompts')!;
  expect(await lease.requestService(prompt, { operation: 'prompts/list' }, { signal: new AbortController().signal }))
    .toMatchObject({ result: { prompts: [{ name: 'ready' }] } });
  expect(lease.inspect().servers[0]?.directories?.tools).toBe('refreshing');
  await lease.releaseAndDrain();
});

test('an expired HTTP session rejects the original call once and only a new call reopens the original definition', async () => {
  const { scope, file } = await fixture();
  let initialized = 0, calls = 0;
  const targets: string[] = [], sessions: Array<string | null> = [];
  const authority = new McpAuthority({ fetch: async (url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown, headers?: Record<string, string>) => Response.json({ jsonrpc: '2.0', id: request.id, result }, headers ? { headers } : undefined);
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') { initialized++; return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }, { 'mcp-session-id': `session-${initialized}` }); }
    if (request.method === 'tools/list') return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    if (request.method === 'tools/call') {
      calls++; targets.push(String(url)); sessions.push(new Headers(init?.headers).get('mcp-session-id'));
      // A JSON-RPC-shaped body must not hide a known session's explicit HTTP expiration.
      return calls === 1 ? Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Session expired' } }, { status: 404 }) : reply({ content: [{ type: 'text', text: 'new operation' }] });
    }
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const lease = await authority.acquire(scope, { servers: ['server'] });
  const tool = lease.binding.tools[0]!;
  const invoke = () => lease.callTool(tool.name, {}, { schemaVersion: tool.schemaVersion, signal: new AbortController().signal });
  await expect(invoke()).rejects.toMatchObject({ code: 'mcp-session-expired', settlement: 'session_expired', dispatched: true });
  expect(calls).toBe(1); expect(initialized).toBe(1);
  expect(lease.inspect().servers[0]?.status).toBe('disconnected');
  await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://replacement/mcp', exposure: 'direct' } } }));
  await authority.reload(scope);
  expect(await invoke()).toMatchObject({ content: [{ text: 'new operation' }] });
  expect(calls).toBe(2); expect(initialized).toBe(2);
  expect(targets).toEqual(['http://fixture/mcp', 'http://fixture/mcp']);
  expect(sessions).toEqual(['session-1', 'session-2']);
  await lease.releaseAndDrain();
});

test('one unsupported schema stays discoverable without disabling valid sibling tools or weakening validation', async () => {
  const { scope } = await fixture();
  const dispatched: unknown[] = [];
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'integer', minimum: 2 }, minItems: 1 }, label: { type: 'string', 'x-mcp-header': 'Label' } }, required: ['items'], additionalProperties: false };
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.method === 'tools/list') return reply({ tools: [{ name: 'unsupported', inputSchema: { type: 'object', unsupportedAssertion: true } }, { name: 'valid', inputSchema: schema }] });
    if (request.method === 'tools/call') { dispatched.push(request.params.arguments); return reply({ content: [] }); }
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const lease = await authority.acquire(scope, { servers: ['server'] });
  const valid = lease.binding.tools.find(tool => tool.tool === 'valid')!;
  const unsupported = lease.binding.tools.find(tool => tool.tool === 'unsupported')!;
  expect(valid.exposure).toBe('direct'); expect(valid.inputSchema).toEqual(schema);
  expect(unsupported).toMatchObject({ exposure: 'deferred', problem: 'mcp-schema-unsupported' });
  expect(() => lease.validateArguments(unsupported.name, unsupported.schemaVersion, {})).toThrow('mcp-schema-unsupported');
  expect(() => lease.validateArguments(valid.name, valid.schemaVersion, { items: [1] })).toThrow('mcp-arguments-invalid');
  expect(() => lease.validateArguments(valid.name, valid.schemaVersion, { items: '[2]' })).toThrow('mcp-arguments-invalid');
  await lease.callTool(valid.name, { items: [2, 3], label: 'value' }, { schemaVersion: valid.schemaVersion, signal: new AbortController().signal });
  expect(dispatched).toEqual([{ items: [2, 3], label: 'value' }]);
  await lease.releaseAndDrain();
});

async function countedAuthority(scope: McpAuthorityScope, file: string, config: Record<string, unknown>) {
  await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://fixture/mcp', exposure: 'direct', ...config } } }));
  let initializations = 0;
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') { initializations++; return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); }
    if (request.method === 'tools/list') return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  return { authority, count: () => initializations, acquire: (sessionId: string) => authority.acquire({ ...scope, sessionId }, { servers: ['server'] }) };
}

test('explicit session isolation separates state while repeated consumers of that session share', async () => {
  const { scope, file } = await fixture();
  const peer = await countedAuthority(scope, file, { isolation: 'session' });
  const first = await peer.acquire('one'), second = await peer.acquire('two'), sibling = await peer.acquire('one');
  expect(peer.count()).toBe(2);
  expect(first.binding.tools[0]?.resourceKey).not.toBe(second.binding.tools[0]?.resourceKey);
  expect(first.binding.tools[0]?.resourceKey).toBe(sibling.binding.tools[0]?.resourceKey);
  await first.releaseAndDrain(); await second.releaseAndDrain();
  expect(sibling.inspect().connectedServerCount).toBe(1);
  await sibling.releaseAndDrain();
});

test('configured keep-alive survives view release and is reclaimed by explicit withdrawal', async () => {
  const { scope, file } = await fixture();
  const peer = await countedAuthority(scope, file, { lifecycle: { keepAlive: true } });
  const first = await peer.acquire('one'); await first.releaseAndDrain();
  const second = await peer.acquire('two');
  expect(peer.count()).toBe(1);
  await second.releaseAndDrain();
  await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://fixture/mcp', exposure: 'direct', lifecycle: { keepAlive: true }, enabled: false } } }));
  await peer.authority.reload(scope);
  expect((await peer.authority.inspect(scope)).servers[0]?.status).toBe('disabled');
  await expect(peer.acquire('three')).rejects.toThrow('mcp-selected-server-disabled');
});

test('configured idle release is cancelled by a new holder and runs after the last holder leaves', async () => {
  const { scope, file } = await fixture();
  const peer = await countedAuthority(scope, file, { lifecycle: { idleTimeoutSeconds: 0.04 } });
  const first = await peer.acquire('one'); await first.releaseAndDrain();
  const second = await peer.acquire('two');
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(second.inspect().connectedServerCount).toBe(1); expect(peer.count()).toBe(1);
  await second.releaseAndDrain();
  await expect.poll(async () => (await peer.authority.inspect(scope)).connectedServerCount).toBe(0);
  const third = await peer.acquire('three'); expect(peer.count()).toBe(2); await third.releaseAndDrain();
});

test('environment-backed credentials stay fixed, revoke changed bindings and never enter persistent discovery cache', async () => {
  const { scope, file } = await fixture();
  const variable = 'VARIN_MCP_TEST_ACCOUNT';
  const previous = process.env[variable];
  process.env[variable] = 'original-secret';
  cleanup.push(async () => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  await writeFile(file, JSON.stringify({ mcpServers: { server: { url: 'http://fixture/mcp', exposure: 'direct', headers: { authorization: `Bearer \${${variable}}` } } } }));
  const observed: string[] = [];
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') { observed.push(new Headers(init?.headers).get('authorization')!); return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); }
    if (request.method === 'tools/list') return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    if (request.method === 'tools/call') return reply({ content: [] });
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const old = await authority.acquire(scope, { servers: ['server'] }), original = old.binding.tools[0]!;
  process.env[variable] = 'replacement-secret';
  await expect(old.callTool(original.name, {}, { schemaVersion: original.schemaVersion, signal: new AbortController().signal })).rejects.toThrow('mcp-credential-revoked');
  const current = await authority.acquire({ ...scope, sessionId: 'new-consumer' }, { servers: ['server'] });
  expect(observed).toEqual(['Bearer original-secret', 'Bearer replacement-secret']);
  expect(current.binding.tools[0]?.schemaVersion).not.toBe(original.schemaVersion);
  expect(await current.cachedTools(new AbortController().signal)).toEqual([]);
  await old.releaseAndDrain(); await current.releaseAndDrain(); await authority.close();
  const reopened = new McpAuthority(); cleanup.push(() => reopened.close());
  expect(await reopened.directory(scope, new AbortController().signal)).toEqual([]);
});

test.each(['remote', 'graceful'] as const)('modern resource subscriptions outlive their view and report a %s stream gap', async ending => {
  const { scope } = await fixture();
  const { SUBSCRIPTION_ID_META_KEY } = await import('@modelcontextprotocol/client');
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let listenId: string, listenCalls = 0;
  const authority = new McpAuthority({ fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { resources: {} } });
    if (request.method === 'resources/list') return reply({ resultType: 'complete', resources: [] });
    if (request.method === 'resources/templates/list') return reply({ resultType: 'complete', resourceTemplates: [] });
    if (request.method === 'subscriptions/listen') {
      listenCalls++; listenId = request.id;
      return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: {
          _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id }, notifications: request.params.notifications,
        } })}\n\n`));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(null, { status: 202 });
  } }); cleanup.push(() => authority.close());
  const lease = await authority.acquire(scope, { servers: [] });
  const service = (await lease.discoverServices('server', new AbortController().signal))[0]!;
  expect(service.subscribe).toBe(true);
  const changes: string[] = [];
  const observer = await lease.observeResource(service, 'fixture:///subscribed', { signal: new AbortController().signal, onChange: change => changes.push(change.kind) });
  expect(listenCalls).toBe(1);
  lease.release();
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: {
    _meta: { [SUBSCRIPTION_ID_META_KEY]: listenId! }, uri: 'fixture:///subscribed',
  } })}\n\n`));
  await expect.poll(() => changes).toContain('updated');
  if (ending === 'remote') stream.close();
  else stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: listenId!, result: { resultType: 'complete' } })}\n\n`));
  await expect.poll(() => changes).toContain('gap');
  await observer.detach();
  await lease.releaseAndDrain();
});
