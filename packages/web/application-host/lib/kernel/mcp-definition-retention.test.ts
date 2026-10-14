import { beforeEach, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    return { promise, resolve, reject };
  };
  let dispatch: (signal: AbortSignal) => Promise<{ content: unknown[] }> = async () => ({ content: [] });
  const client = { callTool: (_tool: string, _args: unknown, options: { signal: AbortSignal }) => dispatch(options.signal), protocolVersion: '2025-11-25', serverCapabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
    onNotification: () => () => {}, onClose: () => () => {}, setRequestHandler: () => {}, connectionState: 'connected' };
  type Plan = { opening?: ReturnType<typeof deferred>; closing?: ReturnType<typeof deferred>; failure?: Error };
  const plans: Plan[] = [];
  const instances: Connection[] = [];
  class Connection {
    state = 'connecting';
    readonly directoriesReady = new Set(['tools']);
    readonly directoryStates = { tools: 'ready', resources: 'unprepared', resourceTemplates: 'unprepared', prompts: 'unprepared' };
    readonly environmentCurrent = true;
    prompts = [];
    getToolsClient() { return this.getClient(); }
    tools = [{ name: 'read', inputSchema: { type: 'object' } }];
    resources = []; resourceTemplates = []; timeoutMs = 1000;
    closeCalls = 0;
    readonly plan = plans.shift() ?? {};
    private opening?: Promise<typeof client>;
    constructor(readonly options: { entry: Entry; cwd: string; createTransport: (...args: unknown[]) => unknown }) { instances.push(this); }
    get name() { return this.options.entry.name; }
    get oauthUrl() { const config = this.options.entry.config; return config.url && !config.auth ? config.url : undefined; }
    async signOut() {}
    getClient() {
      return this.opening ??= (async () => {
        await this.plan.opening?.promise;
        if (this.state === 'closed') throw new Error('closed during opening');
        this.state = 'connected'; return client;
      })();
    }
    async requestOnce<T>(run: (value: typeof client) => Promise<T>) { return run(await this.getClient()); }
    async close() {
      this.closeCalls++;this.state = 'closed';
      await this.opening?.catch(() => undefined);
      await this.plan.closing?.promise;
      if (this.plan.failure) throw this.plan.failure;
    }
  }
  type Entry = { name: string; source: string; scope: 'global' | 'project'; config: { command?: string; url?: string; exposure: string; enabled?: boolean; auth?: { provider: string }; env?: Record<string, string> } };
  return { deferred, plans, instances, Connection, setDispatch: (run: typeof dispatch) => { dispatch = run; }, credential: 'original' as string | undefined, errors: [] as string[], entries: [] as Entry[] };
});

// Native authority and composition behavior with controlled connection/configuration ports.
// The separately owned transport/configuration suites exercise actual I/O.
vi.mock('../mcp/configuration.js', async importOriginal => {
  const original = await importOriginal<typeof import('../mcp/configuration.js')>();
  return { ...original, McpConfigurations: class {
    current() { return { servers: structuredClone(ports.entries), errors: 'errors' in ports ? ports.errors : [], sources: [...new Set(ports.entries.map(entry => entry.source))] }; }
    async prepare() { return this.current(); }
  } };
});
vi.mock('../mcp/auth.js', async importOriginal => {
  const original = await importOriginal<typeof import('../mcp/auth.js')>();
  return { ...original, McpOAuthCredentialStore: class {
    async prepare() {} binding() { return 'credential' in ports ? ports.credential : undefined; }
    tokens() { return undefined; } async remove() { if ('credential' in ports) ports.credential = undefined; return true; }
  } };
});
vi.mock('../mcp/connection.js', () => ({ McpServerConnection: ports.Connection, createDefaultTransport: () => {} }));
vi.mock('../mcp/directory.js', () => ({ McpDirectory: class { async get() {} async update() {} async close() {} } }));
vi.mock('../configuration-watch.js', () => ({ ConfigWatchManager: class {
  async watch() { return { watchId: 'test-watch' }; } unwatch() {} close() {}
} }));
import { McpAuthority, type McpAuthorityScope, type McpDefinitionLease } from '../mcp/authority.js';
import { McpCompositions } from '../mcp/compositions.js';
import type { McpProvenance } from '@varin/protocol';

// Actual native McpAuthority ownership and admission behavior through controlled ports.
// No SDK transport, process-tree, Source proof or end-to-end execution is exercised here.
const scope = (sessionId = 'parent'): McpAuthorityScope => ({
  resourceOwner: { kind: 'managed_host', hostId: 'host', connectionId: 'connection', endpointIdentity: 'endpoint' },
  sourceAuthority: { coordinator_host_id: 'coordinator', authority_id: `source:${sessionId}`, resource_epoch: `epoch:${sessionId}` },
  agentDir: '/test-mcp-definition/agent', configCwd: '/test-mcp-definition/project', executionCwd: `/test-mcp-definition/${sessionId}`,
  environmentId: `execution:${sessionId}`, executionScope: 'workspace', projectTrusted: true, sessionId,
});
const signal = new AbortController().signal;
const selected = (provenance: McpProvenance): McpProvenance => ({ servers: { test: provenance.servers.test! } });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const settled = (promise: Promise<unknown>) => { let done = false; void promise.then(() => { done = true; }, () => { done = true; }); return () => done; };
beforeEach(() => {
  ports.instances.length = 0; ports.plans.length = 0; ports.credential = 'original'; ports.errors = [];
  ports.entries = [{ name: 'test', source: '/test-mcp-definition/project/.varin/mcp.json', scope: 'project', config: { command: 'original', exposure: 'deferred', env: { SECRET: 'private-value' } } },
    { name: 'unselected', source: '/test-mcp-definition/project/.varin/mcp.json', scope: 'project', config: { command: 'unselected', exposure: 'deferred' } }];
});

it('retains deferred exact definitions past parent release and replacement, deriving independent child executions', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const provenance = selected(parent.binding.provenance), token = parent.retainDefinitions(provenance);
  expect(ports.instances).toHaveLength(0);
  expect(Object.isFrozen(token.provenance.servers.test!.owner)).toBe(true);
  expect(JSON.stringify(token)).not.toContain('private-value');
  ports.entries[0]!.config.command = 'replacement';
  const draining = parent.releaseAndDrain(), done = settled(draining);
  await tick(); expect(done()).toBe(false);
  expect(() => parent.retainDefinitions(provenance)).toThrow('mcp-lease-released');
  const childA = await authority.acquire(scope('child-a'), { servers: ['test'], deriveFrom: token });
  const childB = await authority.acquire(scope('child-b'), { servers: ['test'], deriveFrom: token });
  expect(ports.instances.map(instance => instance.options.entry.config.command)).toEqual(['original', 'original']);
  expect(ports.instances.map(instance => instance.options.cwd)).toEqual([scope('child-a').executionCwd, scope('child-b').executionCwd]);
  expect(Object.keys(childA.binding.provenance.servers)).toEqual(['test']);
  const a = childA.binding.provenance.servers.test!, b = childB.binding.provenance.servers.test!;
  expect(a.owner.source_authority).toEqual(scope('child-a').sourceAuthority);
  expect(a.definition_version).toBe(provenance.servers.test!.definition_version);
  expect(a.resource_key).not.toBe(provenance.servers.test!.resource_key);
  expect(a.resource_key).not.toBe(b.resource_key);
  await expect(childA.discover('unselected', signal)).rejects.toThrow('mcp-selected-server-not-configured');
  token.release(); token.release(); await draining;
  await expect(authority.acquire(scope('after-release'), { servers: [], deriveFrom: token })).rejects.toThrow('mcp-definition-lease-unavailable');
  await childA.releaseAndDrain(); expect(ports.instances.map(instance => instance.closeCalls)).toEqual([1, 0]);
  const tool = childB.binding.tools[0]!; expect(() => childB.assertCallable(tool.name, tool.schemaVersion)).not.toThrow();
  await childB.releaseAndDrain(); await authority.close();
});

it('validates every retained owner/version/resource and rejects forged or foreign tokens', async () => {
  const authority = new McpAuthority(), other = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const exact = selected(parent.binding.provenance);
  for (const kind of ['owner', 'version', 'resource', 'missing'] as const) {
    const wrong = structuredClone(exact);
    if (kind === 'owner') wrong.servers.test!.owner.source_authority!.resource_epoch = 'wrong';
    if (kind === 'version') wrong.servers.test!.definition_version = 'wrong';
    if (kind === 'resource') wrong.servers.test!.resource_key = 'wrong';
    if (kind === 'missing') wrong.servers.unknown = wrong.servers.test!;
    expect(() => parent.retainDefinitions(wrong)).toThrow('mcp_saved_definition_unavailable');
  }
  const token = parent.retainDefinitions(exact);
  await expect(authority.acquire(scope('child'), { servers: [], deriveFrom: { ...token } as McpDefinitionLease })).rejects.toThrow('mcp-definition-lease-unavailable');
  await expect(other.acquire(scope('child'), { servers: [], deriveFrom: token })).rejects.toThrow('mcp-definition-lease-unavailable');
  for (const options of [{ provenance: exact, deriveFrom: token }, { deriveFrom: token, deriveExactCurrent: exact }, { provenance: exact, deriveExactCurrent: exact }]) {
    await expect(authority.acquire(scope('child'), { servers: [], ...options })).rejects.toThrow('mcp-derivation-options-conflict');
  }
  expect(ports.instances).toHaveLength(0);
  token.release(); await parent.releaseAndDrain(); await authority.close(); await other.close();
});

it('keeps ordinary owner equality and permits only Source/execution-location changes through explicit derivation', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const provenance = selected(parent.binding.provenance), token = parent.retainDefinitions(provenance);
  await expect(authority.acquire(scope('child'), { servers: ['test'], provenance })).rejects.toThrow('mcp_configuration_source_changed');
  for (const changed of [{ resourceOwner: { ...scope().resourceOwner, endpointIdentity: 'different' } }, { agentDir: '/other-agent' },
    { configCwd: '/other-project' }, { projectTrusted: false }, { executionScope: 'global' as const }]) {
    await expect(authority.acquire({ ...scope('child'), ...changed } as McpAuthorityScope, { servers: ['test'], deriveFrom: token })).rejects.toThrow('mcp_configuration_source_changed');
  }
  expect(ports.instances).toHaveLength(0);
  token.release(); await parent.releaseAndDrain(); await authority.close();
});

it.each(['disable', 'remove', 'hide'] as const)('explicit %s withdraws deferred definitions permanently after it is observed', async mode => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance)), original = structuredClone(ports.entries);
  if (mode === 'disable') ports.entries[0]!.config.enabled = false;
  if (mode === 'remove') ports.entries.shift();
  if (mode === 'hide') ports.entries[0]!.config.exposure = 'hidden';
  await authority.inspect(scope('observer'));
  ports.entries = original;
  await expect(authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token })).rejects.toThrow('mcp-owner-revoked');
  expect(ports.instances).toHaveLength(0);
  token.release(); await parent.releaseAndDrain(); await authority.close();
});

it('does not revoke a retained project definition when inspecting an unrelated closed contribution', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  await authority.inspect({ ...scope('global'), configurationScopes: ['global'] });
  const child = await authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token });
  token.release(); await parent.releaseAndDrain(); await child.releaseAndDrain(); await authority.close();
});

it.each(['oauth', 'provider'] as const)('rejects a changed %s credential grant even for a never-connected retained definition', async kind => {
  ports.entries[0]!.config = { url: 'https://mcp.invalid', exposure: 'deferred', ...(kind === 'provider' ? { auth: { provider: 'provider' } } : {}) };
  let generation = 1;
  const authority = new McpAuthority({ credentialScope: async () => ({ reference: 'credential', generation }) });
  const parent = await authority.acquire(scope(), { servers: [] }), token = parent.retainDefinitions(selected(parent.binding.provenance));
  await tick(); generation = 2; ports.credential = 'replacement';
  await expect(authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token })).rejects.toThrow('mcp-credential-revoked');
  generation = 1; ports.credential = 'original';
  await expect(authority.acquire(scope('retry'), { servers: ['test'], deriveFrom: token })).rejects.toThrow('mcp-credential-revoked');
  expect(ports.instances).toHaveLength(0);
  token.release(); await parent.releaseAndDrain(); await authority.close();
});

it('requires exact current definitions for a fresh continuation and never substitutes retained history', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const original = selected(parent.binding.provenance), token = parent.retainDefinitions(original);
  ports.entries[0]!.config.command = 'replacement';
  await expect(authority.acquire(scope('continuation'), { servers: ['test'], deriveExactCurrent: original })).rejects.toThrow('mcp_saved_definition_unavailable');
  const current = await authority.acquire(scope('current'), { servers: [] }), exact = selected(current.binding.provenance);
  const child = await authority.acquire(scope('continuation'), { servers: ['test'], deriveExactCurrent: exact });
  expect(ports.instances[0]!.options.entry.config.command).toBe('replacement');
  expect(child.binding.provenance.servers.test!.definition_version).toBe(exact.servers.test!.definition_version);
  expect(child.binding.provenance.servers.test!.owner.source_authority).toEqual(scope('continuation').sourceAuthority);
  token.release(); await parent.releaseAndDrain();
  await expect(authority.acquire(scope('later'), { servers: [], deriveFrom: token })).rejects.toThrow('mcp-definition-lease-unavailable');
  await current.releaseAndDrain(); await child.releaseAndDrain(); await authority.close();
});

it('cannot complete acquisition with a token released while a child connection is still opening', async () => {
  const opening = ports.deferred(); ports.plans.push({ opening });
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  const acquiring = authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token });
  const rejected = expect(acquiring).rejects.toThrow('mcp-definition-lease-unavailable');
  await vi.waitFor(() => expect(ports.instances).toHaveLength(1));
  token.release(); await parent.releaseAndDrain(); opening.resolve();
  await rejected; expect(ports.instances[0]!.closeCalls).toBe(1); await authority.close();
});

it('failed configuration candidates do not permanently invalidate a retained definition', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  ports.errors = ['invalid']; await authority.inspect(scope('observer'));
  const retained = await authority.acquire(scope('child'), { servers: [], deriveFrom: token });
  expect(retained.inspect().configErrorCount).toBe(1);
  expect(retained.binding.provenance.servers.test!.definition_version).toBe(token.provenance.servers.test!.definition_version);
  await retained.releaseAndDrain();
  ports.errors = [];
  const child = await authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token });
  token.release(); await parent.releaseAndDrain(); await child.releaseAndDrain(); await authority.close();
});


it('withdrawal aborts already-admitted derived connections across changed Source identities', async () => {
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  const child = await authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token });
  const tool = child.binding.tools[0]!, revoked = child.revocationSignal(tool.name, tool.schemaVersion);
  token.release(); await parent.releaseAndDrain();
  ports.entries[0]!.config.enabled = false; await authority.inspect(scope('observer'));
  expect(revoked.aborted).toBe(true);
  expect(() => child.assertCallable(tool.name, tool.schemaVersion)).toThrow('mcp-owner-revoked');
  await child.releaseAndDrain(); await authority.close();
});

it('sign-out revokes a retained OAuth definition even when its deferred token predates the connection', async () => {
  ports.entries[0]!.config = { url: 'https://mcp.invalid', exposure: 'deferred' };
  const authority = new McpAuthority(), parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  const child = await authority.acquire(scope('child'), { servers: ['test'], deriveFrom: token });
  const tool = child.binding.tools[0]!, revoked = child.revocationSignal(tool.name, tool.schemaVersion);
  const signing = await authority.open(scope('signing'));
  const connection = await authority.connect(signing.scope, signing.config.servers[0]!);
  await authority.signOut(signing.scope, connection.handle);
  expect(revoked.aborted).toBe(true);
  ports.credential = 'original';
  await expect(authority.acquire(scope('retry'), { servers: [], deriveFrom: token })).rejects.toThrow('mcp-credential-revoked');
  token.release(); await parent.releaseAndDrain(); await child.releaseAndDrain(); authority.closeScope(signing.scope); await authority.close();
});


it('a composition retains its original direct generation and deferred gateway after ordinary replacement', async () => {
  ports.entries[0]!.config.exposure = 'direct';
  const authority = new McpAuthority(), compositions = new McpCompositions(authority, vi.fn());
  const owner = await compositions.observe(scope(), () => {});
  await vi.waitFor(() => {
    const candidate = owner.snapshot();
    try { expect(candidate.binding.tools).toHaveLength(1); } finally { candidate.release(); }
  });
  const original = owner.snapshot(), exact = original.binding.provenance;
  ports.entries[0]!.config.command = 'replacement-direct'; ports.entries[1]!.config.command = 'replacement-deferred';
  const replacement = await compositions.observe(scope(), () => {});
  await vi.waitFor(() => {
    const candidate = replacement.snapshot();
    try { expect(candidate.binding.provenance.servers.test!.definition_version).not.toBe(exact.servers.test!.definition_version); }
    finally { candidate.release(); }
  });
  const definitions = original.retainDefinitions(exact);
  expect(definitions.contributions).toHaveLength(2);
  expect(definitions.contributions.map(item => Object.keys(item.provenance.servers))).toEqual([['test'], ['unselected']]);
  original.release(); await owner.releaseAndDrain();
  const draining = replacement.releaseAndDrain(), done = settled(draining);
  await tick(); expect(done()).toBe(false);
  expect(() => original.retainDefinitions(exact)).toThrow('mcp_lease_released');
  const children = [];
  for (const contribution of definitions.contributions) {
    const name = Object.keys(contribution.provenance.servers)[0]!;
    children.push(await authority.acquire(scope('child'), { servers: [name], deriveFrom: contribution }));
  }
  expect(ports.instances.slice(-2).map(instance => instance.options.entry.config.command)).toEqual(['original', 'unselected']);
  definitions.release(); definitions.release(); await draining;
  for (const child of children) await child.releaseAndDrain();
  compositions.close(); await authority.close();
});

it('a derived provider relink permanently revokes its deferred definition token and sibling children', async () => {
  ports.entries[0]!.config = { url: 'https://mcp.invalid', exposure: 'deferred', auth: { provider: 'provider' } };
  let generation = 1;
  const authority = new McpAuthority({ credentialScope: async () => ({ reference: 'credential', generation }) });
  const parent = await authority.acquire(scope(), { servers: [] });
  const token = parent.retainDefinitions(selected(parent.binding.provenance));
  expect(ports.instances).toHaveLength(0);
  const childA = await authority.acquire(scope('child-a'), { servers: ['test'], deriveFrom: token });
  const childB = await authority.acquire(scope('child-b'), { servers: ['test'], deriveFrom: token });
  const toolA = childA.binding.tools[0]!, toolB = childB.binding.tools[0]!;
  const revokedB = childB.revocationSignal(toolB.name, toolB.schemaVersion);
  try {
    generation = 2;
    await expect(childA.callTool(toolA.name, {}, { schemaVersion: toolA.schemaVersion, signal })).rejects.toThrow('mcp-credential-revoked');
    expect(revokedB.aborted).toBe(true);
    generation = 1;
    await expect(authority.acquire(scope('retry'), { servers: ['test'], deriveFrom: token })).rejects.toThrow('mcp-credential-revoked');
    expect(() => childB.assertCallable(toolB.name, toolB.schemaVersion)).toThrow('mcp-owner-revoked');
    expect(ports.instances).toHaveLength(2);
  } finally {
    token.release(); await parent.releaseAndDrain(); await childA.releaseAndDrain(); await childB.releaseAndDrain(); await authority.close();
  }
});
