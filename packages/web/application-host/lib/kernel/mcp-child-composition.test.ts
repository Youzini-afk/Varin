import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const modules = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../../../pi-host/src/mcp-authority.ts', import.meta.url));
  const resolve = (name: string) => { try { return require.resolve(name); } catch { return name; } };
  return { coding: resolve('@earendil-works/pi-coding-agent'), mcp: resolve('@earendil-works/pi-mcp'), jsonc: resolve('jsonc-parser') };
});
const sdk = vi.hoisted(() => {
  type Entry = { name: string; source: string; scope: string; config: { command: string; exposure: string } };
  const configurations = new Map<string, Entry[]>();
  const calls: Array<{ server: string; cwd: string }> = [];
  class Connection {
    state = 'connecting';
    tools = [{ name: 'read', inputSchema: { type: 'object' } }];
    resources = []; resourceTemplates = []; timeoutMs = 1000;
    constructor(readonly options: { entry: Entry; cwd: string }) {}
    get name() { return this.options.entry.name; }
    readonly client = {
      protocolVersion: '2025-11-25', serverCapabilities: { tools: {}, resources: {} },
      onNotification: () => () => {}, onClose: () => () => {}, setRequestHandler: () => {}, connectionState: 'connected',
      request: async (operation: string, params: { uri: string }) => {
        if (operation !== 'resources/read') throw new Error('Unexpected service request');
        return { contents: [{ uri: params.uri, text: JSON.stringify({ server: this.name, cwd: this.options.cwd }) }] };
      },
      callTool: async (_tool: string, _args: unknown, options: { beforeDispatch?: () => Promise<void> }) => {
        await options.beforeDispatch?.();
        const value = { server: this.name, cwd: this.options.cwd }; calls.push(value);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      },
    };
    async getClient() { this.state = 'connected'; return this.client; }
    async requestOnce<T>(run: (value: typeof this.client) => Promise<T>) { return run(await this.getClient()); }
    async close() { this.state = 'closed'; }
  }
  return { configurations, calls, Connection };
});
vi.mock(modules.coding, () => ({
  FileAuthStorageBackend: class {}, McpOAuthCredentialStore: class {},
  createMcpToolName: (server: string, tool: string) => `${server}_${tool}`,
  getMcpToolExposure: (config: { exposure: string }) => config.exposure,
  loadMcpConfig: ({ cwd }: { cwd: string }) => ({ servers: structuredClone(sdk.configurations.get(cwd) ?? []), errors: [] }),
  loadMcpRuntime: async () => ({ McpServerConnection: sdk.Connection, McpServerLog: class {}, createDefaultTransport: () => {} }),
  validateMcpServerConfig: (_name: string, config: unknown) => config,
}));
vi.mock(modules.mcp, () => ({ McpError: class extends Error {}, McpSessionExpiredError: class extends Error {},
  StdioTransport: class {}, StreamableHttpTransport: class {}, McpConnectionClosedError: class extends Error {},
  McpMessageTooLargeError: class extends Error {}, parseJsonRpcMessage: (value: unknown) => value }));
vi.mock(modules.jsonc, () => ({ applyEdits: () => {}, modify: () => {} }));
vi.mock('../../../../pi-host/src/tool-schema.js', () => ({ compileToolJsonSchema: () => () => true }));
vi.mock('../../../../pi-host/src/config-text-file-editor.js', () => ({ ConfigTextFileEditor: class {}, resolveConfigDocumentPath: () => {} }));
vi.mock('../../../../pi-host/src/config-watch-manager.js', () => ({ ConfigWatchManager: class {
  async watch() { return { watchId: 'test-watch' }; } unwatch() {} close() {}
} }));
vi.mock('../../../../pi-host/src/mcp-host-configuration.js', () => ({ mcpHostAgentDir: () => {}, mcpHostProjectTrusted: () => {}, readMcpHostPermissionPolicy: () => {} }));
vi.mock('@varin/pi-host/mcp-authority', async () => await import('../../../../pi-host/src/mcp-authority.js'));
vi.mock('@varin/pi-host/tool-schema', async () => await import('../../../../pi-host/src/tool-schema.js'));

import { McpAuthority, composeMcpAuthorityLeases, type McpAuthorityOwnedLease, type McpAuthorityScope } from '@varin/pi-host/mcp-authority';
import { createChildMcpPreparer } from './mcp-child-preparation.js';
import { createMcpLease } from './mcp-owner.js';
import type { McpPreparation } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { MCP_CAPABILITIES, type HostToolCall, type McpBinding } from './protocol.generated.js';
import type { McpToolLease } from './tool-bridge.js';

// Real child preparer, McpAuthority, lease composition and Host binding/permission adapter.
// SDK configuration, naming, schema compiler and connection ports are controlled; this suite
// does not prove SDK transport, JSON-schema validation, native process stops or remote Hosts.
const authorities: McpAuthority[] = [];
const leases: McpToolLease[] = [];
const signal = new AbortController().signal;
const input: McpPreparation = { runId: 'child-run', threadId: 'child', fixed: true,
  source: { resourceOwner: { kind: 'local' }, runId: 'child-run', workspaceId: 'original-project',
    executionWorkspaceId: 'child-workspace', mode: 'materialized', branchId: 'fixed-child', revision: 1, tools: [] },
  executionCwd: '/child-cwd' };
const scope = (configCwd: string, executionScope: 'global' | 'workspace'): McpAuthorityScope => ({
  resourceOwner: { kind: 'local' }, agentDir: '/agent', configCwd, projectTrusted: configCwd === '/project',
  executionCwd: executionScope === 'global' ? '/agent' : '/parent-cwd', executionScope,
  environmentId: executionScope === 'global' ? 'host:global' : 'host:parent', sessionId: 'parent',
});
const policy = async () => ({ mode: 'normal' as const, rules: [{ tool: '*', decision: 'allow' as const }] });
const entry = (name: string, project = false, exposure = 'direct') => ({ name,
  source: project ? '/project/.pi/mcp.json' : '/agent/mcp.json', scope: project ? 'project' : 'global',
  config: { command: 'original-definition', exposure } });
beforeEach(() => {
  sdk.calls.length = 0;
  sdk.configurations.set('/agent', [entry('global'), entry('workspace_global'), entry('shadowed')]);
  sdk.configurations.set('/project', [entry('global'), entry('shadowed', true), entry('project_service', true, 'deferred')]);
});
afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  for (const authority of authorities.splice(0)) await authority.close();
  vi.restoreAllMocks();
});
async function fixture() {
  const authority = new McpAuthority(); authorities.push(authority);
  const originals = await Promise.all([
    authority.acquire(scope('/agent', 'global'), { servers: ['global'] }),
    authority.acquire(scope('/agent', 'workspace'), { servers: ['workspace_global'] }),
    authority.acquire(scope('/project', 'workspace'), { servers: ['shadowed'] }),
  ]);
  const parent = createMcpLease({ kernel: {} as KernelClient, currentPolicy: policy,
    lease: composeMcpAuthorityLeases(originals.map((lease, index) => ({ lease,
      servers: [['global'], ['workspace_global'], ['shadowed', 'project_service']][index]! }))) });
  leases.push(parent);
  const state = { trusted: true };
  const options = { authority, kernel: {} as KernelClient, agentDir: '/agent', hostId: 'host',
    admitWorkspaceRegistration: vi.fn(async () => ({ canonicalPath: '/project' })),
    projectTrusted: vi.fn(() => state.trusted), currentPolicy: vi.fn(policy) };
  const prepare = createChildMcpPreparer(options);
  return { authority, parent, originals, state, options, prepare };
}
const call = (binding: McpBinding, server: string): HostToolCall => {
  const tool = binding.tools.find(value => value.name === `${server}_read`)!;
  return { runId: input.runId, origin: { kind: 'policy_action', action_id: 'action', node_id: server },
    operationId: `operation:${server}`, callId: `call:${server}`, name: tool.name, schemaVersion: tool.version, arguments: {} };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

it('groups complete frozen local owners and executes global/project contributions in their own child scopes', async () => {
  const f = await fixture();
  const acquire = vi.spyOn(f.authority, 'acquire');
  const child = await f.prepare({ ...input, delegatedBinding: f.parent.binding }, signal); leases.push(child);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(acquire.mock.calls.map(([owner, options]) => ({ cwd: owner.executionCwd, environment: owner.environmentId,
    config: owner.configCwd, scope: owner.executionScope, direct: options.servers, selected: Object.keys(options.provenance!.servers) }))).toEqual([
    { cwd: '/agent', environment: 'host:global', config: '/agent', scope: 'global', direct: ['global'], selected: ['global'] },
    { cwd: '/child-cwd', environment: 'host:child-workspace', config: '/project', scope: 'workspace', direct: ['shadowed'], selected: ['project_service', 'shadowed'] },
    { cwd: '/child-cwd', environment: 'host:child-workspace', config: '/agent', scope: 'workspace', direct: ['workspace_global'], selected: ['workspace_global'] },
  ]);
  expect(child.binding.tools).toEqual(f.parent.binding.tools);
  for (const [server, original] of Object.entries(f.parent.binding.provenance.servers)) {
    expect(child.binding.provenance.servers[server]!.owner).toEqual(original.owner);
    expect(child.binding.provenance.servers[server]!.definition_version).toBe(original.definition_version);
    if (server !== 'global') expect(child.binding.provenance.servers[server]!.resource_key).not.toBe(original.resource_key);
  }
  for (const server of ['global', 'shadowed', 'workspace_global']) {
    const invocation = call(child.binding, server);
    await child.authorize(invocation, signal);
    const result = await child.execute(invocation, signal, { kind: 'external', identity: 'child', epoch: 'epoch' });
    expect(result.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', effect: 'confirmed' });
  }
  expect(sdk.calls).toEqual([{ server: 'global', cwd: '/agent' }, { server: 'shadowed', cwd: '/child-cwd' }, { server: 'workspace_global', cwd: '/child-cwd' }]);
  expect(f.options.currentPolicy).toHaveBeenLastCalledWith('/project', true);
  const saved = structuredClone(child.binding); child.release();
  const restored = await f.prepare({ ...input, requiredBinding: saved }, signal); leases.push(restored);
  expect(restored.binding).toEqual(saved);
  await expect(f.prepare({ ...input, executionCwd: '/different-cwd', requiredBinding: saved }, signal)).rejects.toThrow('mcp_saved_binding_unavailable');
  const next = await f.prepare({ ...input, executionCwd: '/next-child-cwd', delegatedBinding: saved }, signal); leases.push(next);
  expect(next.binding.tools).toEqual(saved.tools);
  expect(next.binding.resources.shadowed_read).not.toBe(saved.resources.shadowed_read);
});

it('keeps the frozen server cut and original definitions after live additions and project shadow changes', async () => {
  const f = await fixture();
  sdk.configurations.get('/agent')!.push(entry('later_global'));
  sdk.configurations.get('/project')!.push(entry('later_project', true), entry('workspace_global', true));
  sdk.configurations.get('/project')!.find(value => value.name === 'shadowed')!.config.command = 'replacement-definition';
  const child = await f.prepare({ ...input, delegatedBinding: f.parent.binding }, signal); leases.push(child);
  expect(Object.keys(child.binding.provenance.servers).sort()).toEqual(Object.keys(f.parent.binding.provenance.servers).sort());
  expect(child.binding.provenance.servers.shadowed!.definition_version).toBe(f.parent.binding.provenance.servers.shadowed!.definition_version);
  const discover = MCP_CAPABILITIES.find(value => value.operation === 'discover')!;
  await expect(child.authorize({ ...call(child.binding, 'global'), name: discover.name, schemaVersion: discover.version,
    arguments: { server: 'later_project' } }, signal)).rejects.toThrow('mcp_arguments_invalid');
});

it('rechecks every group trust and preserves neutral global-only preparation for a source-less child', async () => {
  const f = await fixture();
  const child = await f.prepare({ ...input, delegatedBinding: f.parent.binding }, signal); leases.push(child);
  f.state.trusted = false;
  await expect(child.authorize(call(child.binding, 'global'), signal)).rejects.toThrow('project trust was revoked');
  const global = createMcpLease({ lease: f.originals[0]!, kernel: {} as KernelClient, currentPolicy: policy }); leases.push(global);
  const acquire = vi.spyOn(f.authority, 'acquire');
  const neutral = await f.prepare({ ...input, source: null, delegatedBinding: global.binding }, signal); leases.push(neutral);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(acquire.mock.calls[0]![0]).toMatchObject({ executionCwd: '/agent', executionScope: 'global', configCwd: '/agent' });
  await neutral.authorize(call(neutral.binding, 'global'), signal);
  expect(f.options.currentPolicy).toHaveBeenLastCalledWith('/agent', false);
});

it('rejects managed owners and unrelated project configurations before acquiring a sibling', async () => {
  const f = await fixture(), acquire = vi.spyOn(f.authority, 'acquire');
  const managed = structuredClone(f.parent.binding);
  managed.provenance.servers.shadowed!.owner.resource_owner = { kind: 'managed_host', hostId: 'B', connectionId: 'B-connection', endpointIdentity: 'B-endpoint' };
  await expect(f.prepare({ ...input, delegatedBinding: managed }, signal)).rejects.toThrow('original target Host execution owner');
  const unrelated = structuredClone(f.parent.binding);
  unrelated.provenance.servers.shadowed!.owner.configuration.config_cwd = '/other-project';
  await expect(f.prepare({ ...input, delegatedBinding: unrelated }, signal)).rejects.toThrow('configuration source is unavailable');
  const { executionCwd: _cwd, ...noView } = input;
  await expect(f.prepare({ ...noView, delegatedBinding: f.parent.binding }, signal)).rejects.toThrow('execution view matching its fixed source');
  expect(acquire).not.toHaveBeenCalled();
});

it('cancels the original group attempt and drains late candidates before reporting failed preparation', async () => {
  const f = await fixture();
  const originalAcquire = f.authority.acquire.bind(f.authority);
  const late = deferred<void>(), drain = deferred<void>();
  const children: McpAuthorityOwnedLease[] = [], drains: ReturnType<typeof vi.fn>[] = [];
  const acquire = vi.spyOn(f.authority, 'acquire').mockImplementation(async (owner, options) => {
    const lease = await originalAcquire(owner, options); children.push(lease);
    const release = lease.releaseAndDrain.bind(lease);
    const close = vi.spyOn(lease, 'releaseAndDrain').mockImplementation(async () => { await release(); await drain.promise; });
    drains.push(close);
    await late.promise; // An original acquisition reply can arrive after caller cancellation.
    return lease;
  });
  const caller = new AbortController();
  let settled = false;
  const preparing = f.prepare({ ...input, delegatedBinding: f.parent.binding }, caller.signal);
  const expected = expect(preparing).rejects.toThrow('cancel child');
  void preparing.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(children).toHaveLength(3));
  caller.abort(new Error('cancel child')); await tick();
  expect(settled).toBe(false);
  expect(acquire.mock.calls.every(([, options]) => options.signal!.aborted)).toBe(true);
  late.resolve(); await vi.waitFor(() => expect(drains.every(close => close.mock.calls.length === 1)).toBe(true));
  expect(settled).toBe(false); expect(acquire).toHaveBeenCalledTimes(3);
  drain.resolve(); await expected;
  // Draining child candidates never revokes the retained original parent's scopes.
  for (const lease of f.originals) expect(() => lease.inspect()).not.toThrow();
});

it('drains successful siblings on an unavailable original definition or a composed binding mismatch', async () => {
  const f = await fixture();
  const originalAcquire = f.authority.acquire.bind(f.authority);
  const drains: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(f.authority, 'acquire').mockImplementation(async (owner, options) => {
    const lease = await originalAcquire(owner, options);
    drains.push(vi.spyOn(lease, 'releaseAndDrain'));
    return lease;
  });
  const missing = structuredClone(f.parent.binding);
  missing.provenance.servers.shadowed!.definition_version = 'unavailable-original';
  await expect(f.prepare({ ...input, delegatedBinding: missing }, signal)).rejects.toThrow('mcp_saved_definition_unavailable');
  expect(drains.length).toBeGreaterThan(0);
  expect(drains.every(close => close.mock.calls.length === 1)).toBe(true);
  drains.length = 0;
  const changed = structuredClone(f.parent.binding);
  changed.tools.find(value => value.name === 'global_read')!.description = 'changed declaration';
  await expect(f.prepare({ ...input, delegatedBinding: changed }, signal)).rejects.toThrow('mcp_saved_schema_unavailable');
  expect(drains).toHaveLength(3);
  expect(drains.every(close => close.mock.calls.length === 1)).toBe(true);
});


it('keeps service-only mixed dependencies deferred and routes later reads to their actual child owners', async () => {
  const f = await fixture();
  const selected = structuredClone(f.parent.binding);
  const serviceNames = new Set(MCP_CAPABILITIES.filter(value => value.operation === 'discover' || value.operation === 'read_resource').map(value => value.name));
  selected.tools = selected.tools.filter(tool => serviceNames.has(tool.name));
  selected.routes = Object.fromEntries(Object.entries(selected.routes).filter(([name]) => serviceNames.has(name)));
  selected.resources = Object.fromEntries(Object.entries(selected.resources).filter(([name]) => name.startsWith('server:')));
  const acquire = vi.spyOn(f.authority, 'acquire');
  const child = await f.prepare({ ...input, delegatedBinding: selected }, signal); leases.push(child);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(acquire.mock.calls.every(([, options]) => options.servers.length === 0)).toBe(true);
  expect(child.binding.tools).toEqual(selected.tools);
  for (const [server, cwd] of [['global', '/agent'], ['project_service', '/child-cwd']]) {
    const invoke = async (operation: 'discover' | 'read_resource', args: Record<string, unknown>) => {
      const schema = MCP_CAPABILITIES.find(value => value.operation === operation)!;
      const invocation: HostToolCall = { runId: input.runId, origin: { kind: 'policy_action', action_id: operation, node_id: server! },
        operationId: `${operation}:${server}`, callId: `${operation}:${server}`, name: schema.name, schemaVersion: schema.version, arguments: args };
      await child.authorize(invocation, signal);
      return child.execute(invocation, signal, { kind: 'external', identity: 'child', epoch: 'epoch' });
    };
    const discovery = await invoke('discover', { server });
    if (discovery.completion.kind !== 'result') throw new Error('Discovery did not produce a result');
    const service = (discovery.completion.content.data as { services: { kind: string; schemaVersion: string }[] }).services.find(value => value.kind === 'resources')!;
    const read = await invoke('read_resource', { server, schemaVersion: service.schemaVersion, uri: 'fixture:///read' });
    expect(read.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', content: { parts: [
      { kind: 'text', text: JSON.stringify({ server, cwd }) },
    ] } });
  }
  const saved = structuredClone(child.binding); child.release();
  const restored = await f.prepare({ ...input, requiredBinding: saved }, signal); leases.push(restored);
  expect(restored.binding).toEqual(saved);
});

it('reports failed drainage while still releasing every original successful candidate', async () => {
  const f = await fixture();
  const originalAcquire = f.authority.acquire.bind(f.authority);
  const drains: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(f.authority, 'acquire').mockImplementation(async (owner, options) => {
    const lease = await originalAcquire(owner, options);
    const release = lease.releaseAndDrain.bind(lease);
    drains.push(vi.spyOn(lease, 'releaseAndDrain').mockImplementation(async () => {
      await release();
      if (owner.executionScope === 'global') throw new Error('original close failed');
    }));
    return lease;
  });
  const changed = structuredClone(f.parent.binding);
  changed.tools.find(value => value.name === 'global_read')!.description = 'changed declaration';
  const failure = await f.prepare({ ...input, delegatedBinding: changed }, signal).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors.map((error: Error) => error.message)).toEqual(['mcp_saved_schema_unavailable', 'original close failed']);
  expect(drains).toHaveLength(3);
  expect(drains.every(close => close.mock.calls.length === 1)).toBe(true);
});
