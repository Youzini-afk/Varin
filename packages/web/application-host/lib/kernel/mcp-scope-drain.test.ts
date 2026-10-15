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
    constructor(readonly options: { entry: { name: string }; createTransport: (...args: unknown[]) => unknown }) { instances.push(this); }
    get name() { return this.options.entry.name; }
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
  return { deferred, plans, instances, Connection, setDispatch: (run: typeof dispatch) => { dispatch = run; }, credentialPreparation: undefined as ReturnType<typeof deferred> | undefined,
    entries: [] as { name: string; source: string; scope: string; config: { command: string; exposure: string } }[] };
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
import { McpAuthority, type McpAuthorityScope } from '../mcp/authority.js';
import { McpCompositions, type McpCompositionScope } from '../mcp/compositions.js';

// Controlled native connection ports exercise the real authority/composition ownership barriers. This suite
// starts no listener/process and provides no native process-tree or SDK transport implementation proof.
const scope = (sessionId = 'source'): McpAuthorityScope => ({ resourceOwner: { kind: 'local' },
  agentDir: '/test-mcp-drain/agent', configCwd: '/test-mcp-drain/project', executionCwd: '/test-mcp-drain/run',
  environmentId: 'test', executionScope: 'workspace', projectTrusted: true, sessionId });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const settled = (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
};
async function ready(owner: McpCompositionScope) {
  await vi.waitFor(() => { const snapshot = owner.snapshot(); try { expect(snapshot.binding.tools).toHaveLength(1); } finally { snapshot.release(); } });
}
beforeEach(() => {
  ports.instances.length = 0;ports.plans.length = 0;ports.credentialPreparation = undefined;ports.setDispatch(async () => ({ content: [] }));
  ports.entries = [{ name: 'test', source: '/test-mcp-drain/agent/mcp.json', scope: 'global', config: { command: 'original', exposure: 'direct' } }];
});

it('drains a cancelled discovery through late opening and the original transport close', async () => {
  const opening = ports.deferred(), closing = ports.deferred();ports.plans.push({ opening, closing });
  const authority = new McpAuthority(), lease = await authority.acquire(scope(), { servers: [] });
  const caller = new AbortController();
  const discovery = lease.discover('test', caller.signal);
  const rejected = expect(discovery).rejects.toMatchObject({ code: 'mcp-preparation-cancelled' });
  await vi.waitFor(() => expect(ports.instances).toHaveLength(1));
  caller.abort();await rejected;
  const draining = lease.releaseAndDrain(), done = settled(draining);
  expect(lease.releaseAndDrain()).toBe(draining);
  await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(1);
  opening.resolve();await tick();expect(done()).toBe(false);
  closing.resolve();await draining;expect(ports.instances[0]!.closeCalls).toBe(1);
  await authority.close();
});

it('releases only the selected scope while a sibling retains the shared connection', async () => {
  const closing = ports.deferred();ports.plans.push({ closing });
  const authority = new McpAuthority();
  const [a, b] = await Promise.all([authority.acquire(scope('a'), { servers: ['test'] }), authority.acquire(scope('b'), { servers: ['test'] })]);
  expect(ports.instances).toHaveLength(1);
  await a.releaseAndDrain();expect(ports.instances[0]!.closeCalls).toBe(0);
  const tool = b.binding.tools[0]!;expect(() => b.assertCallable(tool.name, tool.schemaVersion)).not.toThrow();
  const draining = b.releaseAndDrain(), done = settled(draining);
  await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(1);
  closing.resolve();await draining;await authority.close();
});

it('waits for an original task holder before closing its authority scope', async () => {
  const closing = ports.deferred();ports.plans.push({ closing });
  const authority = new McpAuthority(), lease = await authority.acquire(scope(), { servers: ['test'] });
  const task = await lease.taskOwner('test', undefined, new AbortController().signal);
  const draining = lease.releaseAndDrain(), done = settled(draining);
  await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(0);
  task.release();await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(1);
  closing.resolve();await draining;await authority.close();
});

it('composition drainage waits for cancelled credential preparation without creating a late connection', async () => {
  ports.credentialPreparation = ports.deferred();
  ports.entries[0]!.config = { url: 'https://mcp.invalid', auth: { provider: 'provider' }, exposure: 'direct' } as never;
  const authority = new McpAuthority({ credentialScope: async () => { await ports.credentialPreparation!.promise; return { reference: 'credential', generation: 1 }; } }), compositions = new McpCompositions(authority, vi.fn());
  const owner = await compositions.observe(scope(), () => {});
  await tick();
  const draining = owner.releaseAndDrain(), done = settled(draining);
  expect(owner.releaseAndDrain()).toBe(draining);
  await tick();expect(done()).toBe(false);expect(ports.instances).toHaveLength(0);
  ports.credentialPreparation.resolve();await draining;expect(ports.instances).toHaveLength(0);
  compositions.close();await authority.close();
});

it('composition drainage retains replaced snapshots and waits for both original closes', async () => {
  const oldClose = ports.deferred(), newClose = ports.deferred();ports.plans.push({ closing: oldClose }, { closing: newClose });
  const authority = new McpAuthority(), compositions = new McpCompositions(authority, vi.fn());
  const first = await compositions.observe(scope(), () => {});await ready(first);
  const original = first.snapshot();
  ports.entries[0]!.config.command = 'replacement';
  const second = await compositions.observe(scope(), () => {});
  await vi.waitFor(() => {
    const replacement = second.snapshot();
    try { expect(replacement.binding.tools[0]!.schemaVersion).not.toBe(original.binding.tools[0]!.schemaVersion); }
    finally { replacement.release(); }
  });
  expect(ports.instances).toHaveLength(2);
  await first.releaseAndDrain();expect(ports.instances.every(instance => !instance.closeCalls)).toBe(true);
  const draining = second.releaseAndDrain(), done = settled(draining);
  await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(0);
  original.release();await tick();expect(ports.instances[0]!.closeCalls).toBe(1);
  oldClose.resolve();await tick();expect(done()).toBe(false);
  newClose.resolve();await draining;expect(ports.instances.map(instance => instance.closeCalls)).toEqual([1, 1]);
  compositions.close();await authority.close();
});

it('composition drainage includes close failures from a cancelled preparation and preserves them on retry', async () => {
  const opening = ports.deferred(), failure = new Error('original close failed');ports.plans.push({ opening, failure });
  const authority = new McpAuthority(), compositions = new McpCompositions(authority, vi.fn());
  const owner = await compositions.observe(scope(), () => {});
  await vi.waitFor(() => expect(ports.instances).toHaveLength(1));
  owner.release();
  const draining = owner.releaseAndDrain(), rejected = expect(draining).rejects.toMatchObject({ code: 'mcp-close-failed', cause: failure });
  opening.resolve();await rejected;
  expect(owner.releaseAndDrain()).toBe(draining);
  await expect(owner.releaseAndDrain()).rejects.toMatchObject({ cause: failure });
  expect(ports.instances[0]!.closeCalls).toBe(1);
  compositions.close();await expect(authority.close()).rejects.toMatchObject({ cause: failure });
});

it('a snapshot still drains after the composition owner was closed first', async () => {
  const closing = ports.deferred();ports.plans.push({ closing });
  const authority = new McpAuthority(), compositions = new McpCompositions(authority, vi.fn());
  const owner = await compositions.observe(scope(), () => {});await ready(owner);
  const snapshot = owner.snapshot();compositions.close();
  const draining = owner.releaseAndDrain(), done = settled(draining);
  await tick();expect(done()).toBe(false);
  snapshot.release();await tick();expect(done()).toBe(false);
  closing.resolve();await draining;await authority.close();
});


it('waits for interrupted in-flight work to settle before the last transport close', async () => {
  const entered = ports.deferred(), finished = ports.deferred(), closing = ports.deferred();ports.plans.push({ closing });
  let requestSignal: AbortSignal | undefined;
  ports.setDispatch(async signal => { requestSignal = signal;entered.resolve();await finished.promise;return { content: [] }; });
  const authority = new McpAuthority(), lease = await authority.acquire(scope(), { servers: ['test'] });
  const tool = lease.binding.tools[0]!;
  const call = lease.callTool(tool.name, {}, { schemaVersion: tool.schemaVersion, signal: new AbortController().signal });
  await entered.promise;
  const draining = lease.releaseAndDrain(), done = settled(draining);
  await tick();expect(requestSignal?.aborted).toBe(true);expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(0);
  finished.resolve();await call;await tick();expect(done()).toBe(false);expect(ports.instances[0]!.closeCalls).toBe(1);
  closing.resolve();await draining;await authority.close();
});


it('adapts the original not-yet-started transport only through the trusted scoped hook', async () => {
  const original = { start: vi.fn() }, adapted = { start: vi.fn() };
  const factory = vi.fn(() => original), adapter = vi.fn((_scope, transport) => { expect(transport).toBe(original);return adapted; });
  const authority = new McpAuthority({ createTransport: factory as never, adaptTransport: adapter as never });
  const input = scope(), lease = await authority.acquire(input, { servers: ['test'] });
  const args = [{ name: 'test' }, '/cwd', undefined];
  expect(ports.instances[0]!.options.createTransport(...args)).toBe(adapted);
  expect(factory).toHaveBeenCalledWith(...args);
  expect(adapter).toHaveBeenCalledWith(input, original);
  expect(original.start).not.toHaveBeenCalled();expect(adapted.start).not.toHaveBeenCalled();
  await lease.releaseAndDrain();await authority.close();

  const unadapted = new McpAuthority({ createTransport: factory as never });
  const other = await unadapted.acquire(scope(), { servers: ['test'] });
  expect(ports.instances[1]!.options.createTransport(...args)).toBe(original);
  await other.releaseAndDrain();await unadapted.close();
});
