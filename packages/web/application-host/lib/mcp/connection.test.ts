import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServerConnection, createDefaultTransport } from './connection.js';
import { McpOAuthCredentialStore } from './auth.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Rpc = { id?: string | number; method: string; params?: Record<string, unknown> };
async function fixture(handle: (request: Rpc, signal: AbortSignal, headers: Headers) => unknown | Promise<unknown>, headers: Record<string, string> = { authorization: 'fixture' }) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-connection-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let notifications!: ReadableStreamDefaultController<Uint8Array>;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(new ReadableStream({ start(controller) { notifications = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    const request = JSON.parse(String(init?.body)) as Rpc;
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.id === undefined) return new Response(null, { status: 202 });
    const value = await handle(request, init!.signal!, new Headers(init?.headers));
    return value instanceof Response ? value : reply(value);
  };
  const connection = new McpServerConnection({ entry: { name: 'fixture', source: directory, config: { url: 'http://fixture/mcp', headers } },
    cwd: directory, credentials: new McpOAuthCredentialStore(directory), createTransport: (...args) => createDefaultTransport(...args, fetch), onTools() {} });
  cleanup.push(() => connection.close());
  return { connection, notify(method: string) { notifications.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`)); } };
}
const empty = (method: string) => ({ [method === 'tools/list' ? 'tools' : method === 'prompts/list' ? 'prompts' : method === 'resources/list' ? 'resources' : 'resourceTemplates']: [] });

test('handshake, resources, templates, prompts and tools publish independently', async () => {
  const tools = deferred<unknown>(), templates = deferred<unknown>();
  const { connection } = await fixture(request => request.method === 'tools/list' ? tools.promise : request.method === 'resources/templates/list' ? templates.promise
    : request.method === 'resources/list' ? { resources: [{ name: 'ready', uri: 'fixture:///ready' }] } : { prompts: [{ name: 'prompt' }] });
  await connection.getClient();
  expect(connection.state).toBe('connected');
  await expect.poll(() => connection.directoryStates.resources).toBe('ready');
  await expect.poll(() => connection.directoryStates.prompts).toBe('ready');
  expect(connection.directoryStates.tools).toBe('refreshing');
  expect(connection.directoryStates.resourceTemplates).toBe('refreshing');
  templates.resolve({ resourceTemplates: [] });
  await expect.poll(() => connection.directoryStates.resourceTemplates).toBe('ready');
  expect(connection.directoryStates.tools).toBe('refreshing');
  tools.resolve({ tools: [] });
  await connection.getToolsClient();
  expect(connection.directoryStates.tools).toBe('ready');
});

test('failed refresh retains the last valid directory and reports failure rather than empty success', async () => {
  let fail = false;
  const { connection, notify } = await fixture(request => {
    if (request.method === 'tools/list') return fail ? Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Unavailable' } })
      : { tools: [{ name: 'kept', inputSchema: { type: 'object' } }] };
    return empty(request.method);
  });
  await connection.getToolsClient();
  fail = true; notify('notifications/tools/list_changed');
  await expect.poll(() => connection.directoryStates.tools).toBe('failed');
  expect(connection.tools.map(tool => tool.name)).toEqual(['kept']);
  expect(connection.directoriesReady.has('tools')).toBe(false);
  expect(connection.state).toBe('connected');
  expect(connection.directoryStates.resources).toBe('ready');
});

test('list change during a pending page discards its stale candidate before publication', async () => {
  const first = deferred<unknown>();
  let calls = 0;
  const { connection, notify } = await fixture(request => request.method === 'tools/list'
    ? ++calls === 1 ? first.promise : { tools: [{ name: 'current', inputSchema: { type: 'object' } }] }
    : empty(request.method));
  await connection.getClient();
  await expect.poll(() => calls).toBe(1);
  notify('notifications/tools/list_changed');
  await new Promise(resolve => setTimeout(resolve, 0));
  first.resolve({ tools: [{ name: 'obsolete', inputSchema: { type: 'object' } }] });
  await connection.getToolsClient();
  expect(calls).toBe(2);
  expect(connection.tools.map(tool => tool.name)).toEqual(['current']);
});

test('reopening an immutable definition never resolves its environment references to a different account', async () => {
  const variable = 'VARIN_MCP_TEST_FROZEN_HEADER', previous = process.env[variable];
  process.env[variable] = 'first';
  cleanup.push(async () => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const observed: Array<string | null> = [];
  const { connection } = await fixture((request, _signal, headers) => {
    if (request.method === 'tools/list') observed.push(headers.get('authorization'));
    return empty(request.method);
  }, { authorization: `Bearer \${${variable}}` });
  await connection.getToolsClient();
  process.env[variable] = 'second';
  expect(connection.environmentCurrent).toBe(false);
  await connection.reconnect(); await connection.getToolsClient();
  expect(observed).toEqual(['Bearer first', 'Bearer first']);
});

test('a directory authorization failure is distinct from a failed connection or a successful empty list', async () => {
  const { connection } = await fixture(request => request.method === 'tools/list'
    ? new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer scope="tools"' } }) : empty(request.method));
  await connection.getClient();
  await expect.poll(() => connection.directoryStates.tools).toBe('needs-auth');
  expect(connection.state).toBe('connected');
  expect(connection.directoryStates.resources).toBe('ready');
  expect(connection.challenge).toBe('Bearer scope="tools"');
});
