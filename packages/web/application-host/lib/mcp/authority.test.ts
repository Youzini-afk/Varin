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
