import { afterEach, expect, test } from 'vitest';
import { McpClient } from './client.js';
import { StreamableHttpTransport } from './transport.js';

type Rpc = { id?: string | number; method: string; params?: Record<string, unknown> };
const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function fixture(modern: boolean, handle: (request: Rpc, headers: Headers) => Response | Promise<Response>) {
  const client = new McpClient({ name: 'fixture', version: '1', capabilities: { elicitation: { form: {} } } }); clients.push(client);
  const transport = new StreamableHttpTransport('http://fixture/mcp', { fetch: async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body)) as Rpc;
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'server/discover') return modern ? reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } })
      : Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }, { status: 404 });
    if (request.method === 'initialize') return reply({ protocolVersion: request.params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (request.id === undefined) return new Response(null, { status: 202 });
    return handle(request, new Headers(init?.headers));
  } });
  await client.connect(transport); return client;
}

test('legacy discovery fallback dispatches array parameters unchanged and receives a real response', async () => {
  const requests: Rpc[] = [];
  const client = await fixture(false, request => {
    requests.push(request);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'done' }] } });
  });
  const settled: boolean[] = [];
  await client.callTool('read', { pages: [2, 3] }, { onRequestSettled: (_id, received) => settled.push(received) });
  expect(requests[0]?.params?.arguments).toEqual({ pages: [2, 3] });
  expect(requests).toHaveLength(1); expect(settled).toEqual([true]);
});

test('modern input requests use the original call, guards and explicit requestState continuation', async () => {
  const calls: Rpc[] = [], headers: Headers[] = [], outcomes: string[] = [];
  let guarded = false;
  const client = await fixture(true, (request, actualHeaders) => {
    if (request.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{ name: '选择', inputSchema: { type: 'object', properties: { label: { type: 'string', 'x-mcp-header': 'Label' } } } }] } });
    calls.push(request); headers.push(actualHeaders);
    if (!request.params?.requestState) return Response.json({ jsonrpc: '2.0', id: request.id, result: { resultType: 'input_required', requestState: 'original-state',
      inputRequests: { question: { method: 'elicitation/create', params: { message: 'Continue?', requestedSchema: { type: 'object', properties: {} } } } } } });
    expect(guarded).toBe(true);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'finished' }] } });
  });
  client.setRequestHandler('elicitation/create', (_params, context) => {
    expect(context.relatedRequestId).toBe(calls[0]?.id);
    context.beforeResponse(() => { guarded = true; }); context.onResponseSettled(state => outcomes.push(state));
    return { action: 'accept', content: {} };
  });
  await client.listTools();
  const result = await client.callTool('选择', { label: '中文' });
  expect(result.content).toEqual([{ type: 'text', text: 'finished' }]);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.params?.arguments).toEqual({ label: '中文' });
  expect(calls[1]?.params?.inputResponses).toEqual({ question: { action: 'accept', content: {} } });
  expect(headers[0]?.get('mcp-method')).toBe('tools/call');
  expect(headers[0]?.get('mcp-name')).toBe(`=?base64?${Buffer.from('选择').toString('base64')}?=`);
  expect(headers[0]?.get('mcp-param-label')).toBe(`=?base64?${Buffer.from('中文').toString('base64')}?=`);
  expect(outcomes).toEqual(['sent']);
});

test('an ended modern response stream finishes the original wait without replaying its tool request', async () => {
  let calls = 0;
  const client = await fixture(true, () => {
    calls++;
    return new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"work","progress":1}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const settled: boolean[] = [];
  await expect(client.callTool('slow', {}, { onRequestSettled: (_id, received) => settled.push(received) })).rejects.toThrow();
  expect(calls).toBe(1); expect(settled).toEqual([false]);
});

test('cancelling a credential wait stops its dispatch while another caller shares the refresh', async () => {
  let finish!: (value: string) => void;
  const refreshing = new Promise<string>(resolve => { finish = resolve; });
  const dispatched: number[] = [];
  const transport = new StreamableHttpTransport('http://fixture/mcp', { authProvider: { token: () => refreshing }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); dispatched.push(request.id);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refreshed');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
  } });
  await transport.start();
  try {
    const controller = new AbortController();
    const first = transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, { requestSignal: controller.signal });
    const second = transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    const cancelled = expect(first).rejects.toThrow(); controller.abort(); await cancelled;
    expect(dispatched).toEqual([]);
    finish('refreshed'); await second;
    expect(dispatched).toEqual([2]);
  } finally { finish('refreshed'); await transport.close(); }
});
