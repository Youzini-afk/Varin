import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpOwnerRequest, McpOwnerResponse, McpOwnerConnectionSnapshot } from '@varin/protocol';
import type { HostServicesBridge } from '../src/harness/host-services-bridge.js';
import { createHostMcpOwner } from '../src/mcp-host-owner.js';

test('a delayed connection from a closed Pi MCP scope cannot register tools into its replacement', async () => {
  let generation = 0;
  let finishConnect!: (value: McpOwnerResponse) => void;
  const bridge = { request: async (_method: string, input: McpOwnerRequest): Promise<McpOwnerResponse> => {
    if (input.operation === 'open') return { scope: `scope-${++generation}`, config: { servers: [], errors: [] } };
    if (input.operation === 'connect') return new Promise(resolve => { finishConnect = resolve; });
    return {};
  } } as Pick<HostServicesBridge, 'request'>;
  const owner = createHostMcpOwner(bridge);
  const entry = { name: 'fixture', source: '/fixture/mcp.json', scope: 'global' as const, config: { command: 'node' } };
  const callbacks: string[] = [];
  await owner.loadConfig({} as never);
  const pending = owner.createConnection(entry, { onTools: connection => { callbacks.push(`tools:${connection.name}`); }, onChange: connection => { callbacks.push(`state:${connection.name}`); } });
  await owner.close();
  await owner.loadConfig({} as never);
  const old: McpOwnerConnectionSnapshot = { handle: 'old-connection', generation: 1, entry, state: 'connected', tools: [{ name: 'old-tool', inputSchema: { type: 'object' } }], schemaVersions: { 'old-tool': 'old-version' }, hasResources: false, resources: [], resourceTemplates: [], timeoutMs: 1000, credentialRevision: '1' };
  finishConnect({ connection: old });
  await assert.rejects(pending, /closed|stale|changed|released/i);
  assert.deepEqual(callbacks, []);
  await owner.close();
});

test('a delayed refresh cannot publish old declarations after its Pi MCP scope is replaced', async () => {
  const entry = { name: 'fixture', source: '/fixture/mcp.json', scope: 'global' as const, config: { command: 'node' } };
  const snapshot: McpOwnerConnectionSnapshot = { handle: 'connection-1', generation: 1, entry, state: 'connected', tools: [{ name: 'before', inputSchema: { type: 'object' } }], schemaVersions: { before: 'v1' }, hasResources: false, resources: [], resourceTemplates: [], timeoutMs: 1000, credentialRevision: '1' };
  let generation = 0; let finish!: (value: McpOwnerResponse) => void;
  const bridge = { request: async (_method: string, input: McpOwnerRequest): Promise<McpOwnerResponse> => {
    if (input.operation === 'open') return { scope: `scope-${++generation}`, config: { servers: [], errors: [] } };
    if (input.operation === 'connect') return { connection: snapshot };
    if (input.operation === 'snapshot') return new Promise(resolve => { finish = resolve; });
    return {};
  } } as Pick<HostServicesBridge, 'request'>;
  const owner = createHostMcpOwner(bridge); await owner.loadConfig({} as never);
  const tools: string[][] = [];
  await owner.createConnection(entry, { onTools: connection => { tools.push(connection.tools.map(tool => tool.name)); }, onChange: () => {} });
  const refreshing = owner.refresh();
  await owner.close(); await owner.loadConfig({} as never);
  finish({ connection: { ...snapshot, tools: [{ name: 'stale-after-close', inputSchema: { type: 'object' } }], schemaVersions: { 'stale-after-close': 'v2' } } });
  await assert.rejects(refreshing, /closed|stale|changed|released/i);
  assert.deepEqual(tools, [['before']]);
  await owner.close();
});
