import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExternalAgentConfiguration, ExternalAgentSettings, ExternalConversationSnapshot, ExternalInteractionResponse } from '@varin/application-client';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { HarnessConnection } from './adapter.js';
import type { ExternalAttachmentOwner } from './attachments.js';
import { connectCodex } from './codex.js';
import { ExternalAgentsService } from './service.js';

vi.mock('./codex.js', () => ({ connectCodex: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function fixture(options: { connect?: boolean; probeUnconfirmed?: boolean } = {}) {
  const config: ExternalAgentConfiguration = { id: 'fixture', name: 'Fixture', harness: 'codex', command: process.execPath, args: [], enabled: true };
  let snapshot = {
    conversation: { id: 'external:test', configurationId: config.id, harness: 'codex', cwd: '/tmp', title: 'Test', revision: 1, createdAt: 1, updatedAt: 1, archived: false, pinned: false, deleted: false, needsReview: true },
    turns: [], items: [],
  } as unknown as ExternalConversationSnapshot;
  const settings: ExternalAgentSettings = { revision: 0, defaultAgent: null, agents: [config], capabilityCache: {} };
  let cacheGeneration = 0;
  const commands: Array<Record<string, unknown>> = [];
  let runtimeEvent: ((event: { stream: string }) => void) | undefined;
  const kernel = { onAgentRuntimeEvent: vi.fn((listener: typeof runtimeEvent) => { runtimeEvent = listener; return () => {}; }), agentRuntimeRequest: vi.fn(async (_method: string, params: { command: Record<string, unknown> }): Promise<unknown> => {
    commands.push(params.command);
    if (params.command.action === 'settings') return settings;
    if (params.command.action === 'claim_capabilities') return ++cacheGeneration;
    if (params.command.action === 'inspect_capabilities') return cacheGeneration ? {
      generation: cacheGeneration, agentVersion: settings.capabilityCache!.fixture?.agentVersion,
    } : null;
    if (params.command.action === 'cache_capabilities') {
      if (params.command.generation !== cacheGeneration) return null;
      if (params.command.invalidate) cacheGeneration++;
      if (params.command.capabilities) settings.capabilityCache![String(params.command.configurationId)] = {
        capabilities: params.command.capabilities as never, agentVersion: String(params.command.agentVersion), cachedAt: Date.now(),
      };
      else delete settings.capabilityCache![String(params.command.configurationId)];
    }
    if (params.command.action === 'bind') snapshot.conversation.sessionId = String(params.command.sessionId);
    if (params.command.action === 'child_list' || params.command.action === 'arrangement_pending') return [];
    if (params.command.action === 'read') return snapshot;
    if (params.command.action === 'cleanup_list') return [];
    if (params.command.action === 'update') return { ...snapshot.conversation, deleted: params.command.deleted === true };
    return {};
  }) };
  const children: Array<{ end(): void; terminating: boolean }> = [];
  let probe = async () => 'fixture 1';
  const spawnConnection = vi.fn();
  const spawn = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes('--version')) {
      const stdout = new PassThrough();
      const query = probe;
      const completion = new Promise<void>((resolve, reject) => { setTimeout(() => {
        if (options.probeUnconfirmed) reject(new Error('Version process still owned'));
        else void query().then(version => { stdout.end(`${version}\n`); resolve(); }, reject);
      }, 0); });
      return { stdout, stderr: new PassThrough(), completion, exitCode: 0, exitConfirmed: !options.probeUnconfirmed, release: vi.fn() };
    }
    spawnConnection();
    let end!: () => void;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitConfirmed: false, terminating: false,
      completion: new Promise<void>((resolve) => { end = resolve; }),
      release: vi.fn(async () => {}), discardOutput: vi.fn(),
      requestTermination: vi.fn(async () => { child.terminating = true; }),
      end() { child.exitConfirmed = true; end(); },
    });
    children.push(child);
    return child;
  });
  let fail!: (error: Error) => void;
  let change!: () => void;
  let failure: Error | undefined;
  const stop = vi.fn(async () => {});
  vi.mocked(connectCodex).mockImplementation(async (peer) => {
    failure = undefined;
    return {
      sessionId: 'native-test', capabilities: { models: [], resume: true, images: true, steering: false, protocol: { name: 'test', agentVersion: 'fixture 1' } },
      get failure() { return failure; },
      onFailure(listener) { fail = (error) => { failure = error; listener(error); }; return () => {}; },
      onCapabilities(listener) { change = listener; return () => {}; },
      prompt: vi.fn(), stop, close: () => peer.close(),
    } as HarnessConnection;
  });
  const service = new ExternalAgentsService({ kernel: kernel as unknown as KernelClient, spawn: spawn as never,
    directory: '/tmp/varin-service-portable', resolveWorkspace: async () => ({ workspaceId: 'workspace', root: '/tmp' }) });
  cleanups.push(async () => {
    const close = service.close();
    for (const child of children) child.end();
    await close;
  });
  if (options.connect !== false) await service.connect('external:test');
  return { service, settings, config, sweep: () => (service as unknown as { sweepIdle(): Promise<void> }).sweepIdle(), commands, spawn: spawnConnection, children, stop, kernel, fail: (error: Error) => fail(error), change: () => change(),
    setProbe(value: () => Promise<string>) { probe = value; },
    setSnapshot(value: Partial<ExternalConversationSnapshot>) { snapshot = { ...snapshot, ...value }; },
    get snapshot() { return snapshot; },
    durableEvent() { runtimeEvent?.({ stream: 'durable' }); },
  };
}

it('reconnect prepares the original session without silently acknowledging interrupted effects', async () => {
  const f = await fixture();
  expect(f.commands.some((command) => command.action === 'bind')).toBe(true);
  expect(f.commands.some((command) => command.action === 'reconnected')).toBe(false);
  await f.service.continueConversation('external:test');
  expect(f.commands.filter((command) => command.action === 'reconnected')).toEqual([{ action: 'reconnected', id: 'external:test', sessionId: 'native-test' }]);
});

it('invalidates a fatal session and joins its old process tree before creating another connection', async () => {
  const f = await fixture();
  f.fail(new Error('SDK session died'));
  expect((await f.service.read('external:test')).connected).toBe(false);
  let connected = false;
  const retry = f.service.connect('external:test').then(() => { connected = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(connected).toBe(false);
  f.children[0]!.end();
  await retry;
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it('publishes capability changes from the live connection instead of retaining its handshake snapshot', async () => {
  const f = await fixture(), events: unknown[] = [];
  const unsubscribe = f.service.subscribe('external:test', (event) => { events.push(event); return true; });
  const before = events.length;
  f.change();
  expect(events.length).toBe(before + 1);
  unsubscribe();
});

it('withdraws permission waits before native cancel and rejects stale UI answers', async () => {
  const f = await fixture();
  f.setSnapshot({ turns: [{ id: 'turn', conversationId: 'external:test', key: 'key', status: 'running', createdAt: 1, updatedAt: 1 }],
    conversation: { ...f.snapshot.conversation, activeTurn: 'turn' } });
  // The native adapter callback is a transient resource, not a second Catalog fixture.
  const owner = f.service as unknown as { connections: Map<string, { interactions: Map<string, unknown> }> };
  let answer: ExternalInteractionResponse | undefined;
  const cleanup = vi.fn();
  owner.connections.get('external:test')!.interactions.set('generation:turn:permission', {
    request: { id: 'generation:turn:permission', turnId: 'turn', kind: 'permission', title: 'Permission', options: [{ id: 'allow', label: 'Allow' }] },
    resolve(value: ExternalInteractionResponse) { answer = value; }, reject: vi.fn(), cleanup,
  });
  f.stop.mockImplementationOnce(async () => { expect(answer).toEqual({ cancelled: true }); });
  await f.service.stop('external:test', 'turn');
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(f.service.respond('external:test', 'generation:turn:permission', { optionId: 'allow' })).rejects.toMatchObject({ code: 'interaction_expired' });
});

it('explicit termination does not return until the process tree confirms exit', async () => {
  const f = await fixture();
  f.setSnapshot({ turns: [{ id: 'turn', conversationId: 'external:test', key: 'key', status: 'stopping', createdAt: 1, updatedAt: 1 }],
    conversation: { ...f.snapshot.conversation, activeTurn: 'turn' } });
  let stopped = false;
  const terminate = f.service.stop('external:test', 'turn', true).then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  f.children[0]!.end();
  await terminate;
  expect(stopped).toBe(true);
});

it('explicit disconnect joins an idle connection without deleting its retained binding', async () => {
  const f = await fixture();
  const disconnect = f.service.disconnect('external:test');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await expect(f.service.connect('external:test')).rejects.toMatchObject({ code: 'conversation_busy' });
  f.children[0]!.end();
  await disconnect;
  expect((await f.service.read('external:test')).connected).toBe(false);
  expect(f.commands.some((command) => command.action === 'update' || command.action === 'cleaned')).toBe(false);
});


it('retries failed metadata discovery on the same live session without dispatching input', async () => {
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  const connection = owner.connections.get('external:test')!.connection;
  connection.capabilities.modelsError = 'Temporary model discovery error';
  connection.capabilities.modelsRefresh = true;
  connection.refreshCapabilities = vi.fn(async () => {
    delete connection.capabilities.modelsError;
    connection.capabilities.models = [{ id: 'available', name: 'Available' }];
  });
  expect(await f.service.connect('external:test')).toMatchObject({ models: [{ id: 'available' }] });
  expect(connection.refreshCapabilities).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(connection.prompt).not.toHaveBeenCalled();
  await f.service.connect('external:test');
  expect(connection.refreshCapabilities).toHaveBeenCalledOnce();
});

it('rejects malformed interaction values before consuming the pending answer', async () => {
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { interactions: Map<string, unknown> }> };
  const resolve = vi.fn();
  owner.connections.get('external:test')!.interactions.set('request', {
    request: { id: 'request', turnId: 'turn', kind: 'question', title: 'Question', options: [] },
    resolve, reject: vi.fn(), cleanup: vi.fn(),
  });
  await expect(f.service.respond('external:test', 'request', { values: { field: {} } } as never)).rejects.toMatchObject({ code: 'invalid_answer' });
  await expect(f.service.respond('external:test', 'request', { cancelled: 'false' } as never)).rejects.toMatchObject({ code: 'invalid_answer' });
  expect(resolve).not.toHaveBeenCalled();
  expect(owner.connections.get('external:test')!.interactions.has('request')).toBe(true);
});


it.each([false, true])('never sends a late stop or force-stop to the next native turn (force=%s)', async (force) => {
  const f = await fixture();
  const turn = { id: 'old', conversationId: 'external:test', key: 'old', status: 'running' as const, createdAt: 1, updatedAt: 1 };
  f.setSnapshot({ turns: [turn], conversation: { ...f.snapshot.conversation, activeTurn: 'old' } });
  let observed!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { observed = resolve; });
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementation(async (method, params) => {
    if (params.command.action === 'observe' && params.command.status === 'stopping') { observed(); await pending; }
    return original(method, params);
  });
  const stopping = f.service.stop('external:test', 'old', force);
  await started;
  f.setSnapshot({ turns: [{ ...turn, status: 'completed' }, { ...turn, id: 'new', key: 'new' }], conversation: { ...f.snapshot.conversation, activeTurn: 'new' } });
  release(); await stopping;
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.children[0]!.terminating).toBe(false);
});

it('reserves authentication before awaiting Catalog and does not replace a newly active turn', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementationOnce(async (method, params) => { entered(); await waiting; return original(method, params); });
  const auth = f.service.authenticate('external:test', 'login');
  const rejected = expect(auth).rejects.toMatchObject({ code: 'turn_active' });
  await started;
  await expect(f.service.send('external:test', 'new', { text: 'new input' })).rejects.toMatchObject({ code: 'conversation_busy' });
  f.setSnapshot({ conversation: { ...f.snapshot.conversation, harness: 'acp', activeTurn: 'native-turn' } });
  release(); await rejected;
  expect(f.children[0]!.terminating).toBe(false);
});

it('begins native termination before joining a child task waiting on that connection', async () => {
  const f = await fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const owner = f.service as unknown as { childTasks: Map<string, unknown> };
  owner.childTasks.set('child', { controller: new AbortController(), work: waiting, recheck: false });
  const close = f.service.close();
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  f.children[0]!.end(); release();
  await close;
});

it('keeps a constrained form pending after invalid values and accepts corrected values', async () => {
  const f = await fixture();
  f.setSnapshot({ turns: [{ id: 'turn', conversationId: 'external:test', key: 'key', status: 'waiting_user', createdAt: 1, updatedAt: 1 }],
    conversation: { ...f.snapshot.conversation, activeTurn: 'turn' } });
  const owner = f.service as unknown as { connections: Map<string, { interactions: Map<string, unknown> }> };
  const resolve = vi.fn();
  owner.connections.get('external:test')!.interactions.set('bounded', {
    request: { id: 'bounded', turnId: 'turn', kind: 'question', title: 'Quantity', options: [],
      fields: [{ id: 'quantity', label: 'Quantity', type: 'number', required: true, integer: true, minimum: 1 }] },
    resolve, reject: vi.fn(), cleanup: vi.fn(),
  });
  await expect(f.service.respond('external:test', 'bounded', { values: { quantity: 0 } })).rejects.toMatchObject({ code: 'invalid_answer' });
  expect(resolve).not.toHaveBeenCalled();
  await f.service.respond('external:test', 'bounded', { values: { quantity: 2 } });
  expect(resolve).toHaveBeenCalledWith({ values: { quantity: 2 } });
});


it('never aborts a successor connection controller after a late preparation stop', async () => {
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, unknown>; connectionControllers: Map<string, AbortController> };
  const live = owner.connections.get('external:test');
  owner.connections.delete('external:test');
  const old = new AbortController(), next = new AbortController();
  owner.connectionControllers.set('external:test', old);
  const turn = { id: 'old', conversationId: 'external:test', key: 'old', status: 'preparing' as const, createdAt: 1, updatedAt: 1 };
  f.setSnapshot({ turns: [turn], conversation: { ...f.snapshot.conversation, activeTurn: 'old' } });
  let observed!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { observed = resolve; });
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementation(async (method, params) => {
    if (params.command.action === 'observe' && params.command.status === 'stopping') { observed(); await pending; }
    return original(method, params);
  });
  const stopping = f.service.stop('external:test', 'old');
  await started;
  f.setSnapshot({ turns: [{ ...turn, status: 'cancelled' }, { ...turn, id: 'new', key: 'new' }], conversation: { ...f.snapshot.conversation, activeTurn: 'new' } });
  owner.connectionControllers.set('external:test', next);
  release(); await stopping;
  expect(next.signal.aborted).toBe(false);
  owner.connectionControllers.delete('external:test');
  owner.connections.set('external:test', live);
});


it.each(['upload', 'send'] as const)('deletion seals and drains original file %s before retiring its records', async mode => {
  const f = await fixture();
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  let cancelled = false;
  const prepare = async (...args: unknown[]) => {
    const signal = args.at(-1) as AbortSignal;
    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    enter();
    await released;
    signal.throwIfAborted();
    throw new Error('Expected deletion to cancel original preparation');
  };
  f.service.bindAttachments({
    prepareExternal: prepare, uploadExternal: prepare,
    releaseExternal: vi.fn(), externalPath: vi.fn(), readExternal: vi.fn(),
  } as unknown as ExternalAttachmentOwner);
  const pending = mode === 'upload'
    ? f.service.uploadAttachment('external:test', { key: 'file', filename: 'data.bin', mimeType: '', byteLength: 1 }, (async function* () { yield Buffer.from('x'); })())
    : f.service.send('external:test', 'message', { text: '', attachments: [{ path: 'data.bin' }] });
  const outcome = pending.catch(error => error);
  await entered;
  const deletion = f.service.update('external:test', 1, { deleted: true });
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(f.commands.some(command => command.action === 'update')).toBe(false);
  await expect(f.service.uploadAttachment('external:test', { key: 'late', filename: 'late.bin', mimeType: '', byteLength: 0 }, (async function* () {})())).rejects.toMatchObject({ code: 'conversation_busy' });
  finish();
  for (const child of f.children) child.end();
  expect(await outcome).toBeInstanceOf(Error);
  await deletion;
  expect(f.commands.some(command => command.action === 'admit')).toBe(false);
  expect(f.commands.filter(command => command.action === 'update')).toHaveLength(1);
});

it('reclaims an unobserved preparation only after five minutes and joins exit before resuming its binding', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  const first = f.service.subscribe('external:test', () => true);
  const second = f.service.subscribe('external:test', () => true);
  now += 10 * 60_000;
  await f.sweep();
  first();
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
  second();
  now += 5 * 60_000 - 1;
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
  now++;
  let reclaimed = false;
  const sweep = f.sweep().then(() => { reclaimed = true; });
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  expect(reclaimed).toBe(false);
  expect((await f.service.read('external:test')).connection?.status).not.toBe('reclaimed');
  const resume = f.service.connect('external:test');
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.children[0]!.end();
  await sweep;
  await resume;
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(vi.mocked(connectCodex).mock.calls[1]?.[2]).toBe('native-test');
  expect(f.commands.some(command => command.action === 'update' || command.action === 'cleaned' || command.action === 'admit')).toBe(false);
});

it('gives a started conversation fifteen unobserved idle minutes and exposes reclaimed cached hints', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  f.setSnapshot({ turns: [{ id: 'done', conversationId: 'external:test', key: 'first', status: 'completed', createdAt: 1, updatedAt: 2 }] });
  now += 15 * 60_000 - 1;
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
  now++;
  const sweep = f.sweep();
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  f.children[0]!.end();
  await sweep;
  const snapshot = await f.service.read('external:test');
  expect(snapshot).toMatchObject({ connected: false, connection: { status: 'reclaimed' }, capabilitiesSource: 'cached' });
  expect(snapshot.capabilities).toMatchObject({ protocol: { agentVersion: 'fixture 1' } });
});

it.each(['queued', 'preparing', 'running', 'waiting_user', 'stopping'] as const)('never reclaims a durable %s input', async status => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  f.setSnapshot({ turns: [{ id: 'active', conversationId: 'external:test', key: 'input', status, createdAt: 1, updatedAt: 2 }] });
  now += 60 * 60_000;
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
});

it('keeps native background tasks and pending admissions alive and restarts idle grace when work settles', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }>; inputAdmissions: Map<string, Set<unknown>> };
  const connection = owner.connections.get('external:test')!.connection;
  Object.defineProperty(connection, 'backgroundTasks', { value: 2, configurable: true });
  now += 60 * 60_000;
  await f.sweep();
  Object.defineProperty(connection, 'backgroundTasks', { value: 0, configurable: true });
  owner.inputAdmissions.set('external:test', new Set([{}]));
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
  owner.inputAdmissions.delete('external:test');
  await f.sweep();
  now += 5 * 60_000 - 1;
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
});

it('abandons a reclaim candidate when an observer returns during the durable idle check', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  now += 5 * 60_000;
  let unsubscribe = () => {};
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementationOnce(async (method, params) => {
    unsubscribe = f.service.subscribe('external:test', () => true);
    return original(method, params);
  });
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
  unsubscribe();
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
});

it('counts a failed initial observation as already detached without holding the process forever', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  f.service.subscribe('external:test', () => false);
  now += 5 * 60_000;
  const sweep = f.sweep();
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  f.children[0]!.end();
  await sweep;
});

it('uses cached metadata before preparation, replaces it with real capabilities and never caches authentication', async () => {
  const f = await fixture({ connect: false });
  f.settings.capabilityCache!.fixture = {
    capabilities: { models: [{ id: 'previous', name: 'Previous' }], images: true, resume: true, steering: false },
    agentVersion: 'fixture 0', cachedAt: 1,
  };
  expect(await f.service.read('external:test')).toMatchObject({ connected: false, capabilitiesSource: 'cached', capabilities: { models: [{ id: 'previous' }] } });
  expect(f.spawn).not.toHaveBeenCalled();
  await f.service.connect('external:test');
  expect(await f.service.read('external:test')).toMatchObject({ connected: true, capabilitiesSource: 'live', capabilities: { models: [] } });
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  owner.connections.get('external:test')!.connection.capabilities.authentication = { methods: [{ id: 'login', name: 'Sign in', type: 'terminal', command: 'private login' }] };
  f.change();
  await Promise.resolve();
  const write = f.commands.filter(command => command.action === 'cache_capabilities').at(-1)!;
  expect(write.capabilities).not.toHaveProperty('authentication');
  expect(write).toMatchObject({ configuration: { harness: 'codex', command: process.execPath, args: [] }, agentVersion: 'fixture 1' });
});

it('validates Host draft defaults without applying them to admitted input', async () => {
  const f = await fixture();
  await f.service.configure({ agents: [{ ...f.config, defaults: { model: 'fixed', thinking: 'high', mode: 'plan' } }], defaultAgent: null }, 0, 'defaults');
  expect(f.commands.find(command => command.action === 'configure')).toMatchObject({ value: { agents: [{ defaults: { model: 'fixed' } }] } });
  f.config.defaults = { model: 'fixed', mode: 'plan' };
  await f.service.send('external:test', 'new-input', { text: 'Use CLI defaults' });
  expect(f.commands.find(command => command.action === 'admit')).toMatchObject({ input: { text: 'Use CLI defaults' } });
  expect(f.commands.find(command => command.action === 'admit')!.input).not.toHaveProperty('model');
  await expect(f.service.configure({ agents: [{ ...f.config, defaults: { model: '' } }], defaultAgent: null }, 0, 'invalid')).rejects.toMatchObject({ code: 'invalid_settings' });
});

it('uses the same branded executable version for detection and cached handshake metadata', async () => {
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  owner.connections.get('external:test')!.connection.capabilities.protocol!.agentVersion = '1';
  f.change();
  await Promise.resolve();
  expect(f.settings.capabilityCache!.fixture?.agentVersion).toBe('fixture 1');
  expect(await f.service.detect('fixture')).toMatchObject({ status: 'available', version: 'fixture 1' });
  expect(f.settings.capabilityCache!.fixture?.agentVersion).toBe('fixture 1');
});

it('keeps durable delegated work alive even before its transient Host task has started', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementation(async (method, params) => params.command.action === 'child_list'
    ? [{ conversation_id: 'external:test', report: null }] : original(method, params));
  now += 60 * 60_000;
  await f.sweep();
  expect(f.children[0]!.terminating).toBe(false);
});

it('never reports a failed process termination as reclaimed and retries closure before reconnecting', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  const connection = owner.connections.get('external:test')!.connection;
  const close = connection.close;
  connection.close = vi.fn().mockRejectedValueOnce(new Error('process exit unconfirmed')).mockImplementation(close);
  now += 5 * 60_000;
  await expect(f.sweep()).rejects.toThrow('process exit unconfirmed');
  expect(await f.service.read('external:test')).toMatchObject({ connected: false, connection: { status: 'failed' } });
  const reconnect = f.service.connect('external:test');
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.children[0]!.end();
  await reconnect;
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it('waits for an in-flight idle tree termination during Host shutdown', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  now += 5 * 60_000;
  const sweep = f.sweep();
  await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
  let stopped = false;
  const shutdown = f.service.close().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  f.children[0]!.end();
  await sweep;
  await shutdown;
  expect(stopped).toBe(true);
});

it('does not launch a session when its version probe failed with unconfirmed process exit', async () => {
  const f = await fixture({ connect: false, probeUnconfirmed: true });
  await expect(f.service.connect('external:test')).rejects.toThrow('process exit is unconfirmed');
  expect(f.spawn).not.toHaveBeenCalled();
  expect(await f.service.read('external:test')).toMatchObject({ connected: false, connection: { status: 'failed' } });
});


it.each([false, true])('preserves a non-resumable native session beyond idle expiry (started=%s)', async started => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  owner.connections.get('external:test')!.connection.capabilities.resume = false;
  if (started) f.setSnapshot({ turns: [{ id: 'done', conversationId: 'external:test', key: 'first', status: 'completed', createdAt: 1, updatedAt: 2 }] });
  now += 60 * 60_000;
  await f.sweep();
  const snapshot = await f.service.read('external:test');
  expect(f.children[0]!.terminating).toBe(false);
  expect(snapshot).toMatchObject({ connected: true, connection: { status: 'connected' }, conversation: { sessionId: 'native-test' } });
  expect(f.commands.some(command => command.action === 'update' || command.action === 'cleaned')).toBe(false);
});

it.each([false, true])('does not let an older detection invalidate a newer live program catalog (previous cache=%s)', async previousCache => {
  const f = await fixture({ connect: previousCache });
  let release!: (version: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const oldProbe = new Promise<string>(resolve => { release = resolve; });
  f.setProbe(async () => { entered(); return oldProbe; });
  const detection = f.service.detect('fixture');
  await started;
  if (previousCache) {
    const disconnected = f.service.disconnect('external:test');
    await vi.waitFor(() => expect(f.children[0]!.terminating).toBe(true));
    f.children[0]!.end();
    await disconnected;
  }
  f.setProbe(async () => 'fixture 2');
  await f.service.connect('external:test');
  const claims = f.commands.filter(command => command.action === 'claim_capabilities').length;
  expect(f.settings.capabilityCache!.fixture?.agentVersion).toBe('fixture 2');
  release('fixture 1.1');
  expect(await detection).toMatchObject({ status: 'available', version: 'fixture 1.1' });
  expect(f.commands.filter(command => command.action === 'claim_capabilities')).toHaveLength(claims);
  expect(f.settings.capabilityCache!.fixture?.agentVersion).toBe('fixture 2');
  // Normal same-version detection leaves this live writer able to refresh its real catalog.
  await f.service.detect('fixture');
  const owner = f.service as unknown as { connections: Map<string, { connection: HarnessConnection }> };
  owner.connections.get('external:test')!.connection.capabilities.models = [{ id: 'new-model', name: 'New model' }];
  f.change();
  await Promise.resolve();
  expect(f.settings.capabilityCache!.fixture?.capabilities.models).toEqual([{ id: 'new-model', name: 'New model' }]);
});


it('a durable arrangement advances the original live connection even when it cannot resume', async () => {
  const f = await fixture();
  const connection = await vi.mocked(connectCodex).mock.results[0]!.value as HarnessConnection;
  connection.capabilities.resume = false;
  const turn = { id: 'event-turn', conversationId: 'external:test', key: 'followup:occurrence', status: 'queued', createdAt: 1, updatedAt: 1,
    arrangementOccurrenceId: 'occurrence', arrangementLaunch: { command: f.config.command, args: f.config.args } } as ExternalConversationSnapshot['turns'][number];
  f.setSnapshot({ conversation: { ...f.snapshot.conversation, needsReview: false }, turns: [turn] });
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  f.kernel.agentRuntimeRequest.mockImplementation(async (method, params) => {
    const c = params.command;
    if (c.action === 'arrangement_pending') return turn.status === 'queued' ? ['external:test'] : [];
    if (c.action === 'begin') { turn.status = 'preparing'; f.snapshot.conversation.activeTurn = turn.id; return turn; }
    if (c.action === 'input') return { text: 'Original arrangement. Quoted new customer evidence.', task: 'Quoted new customer evidence.', _arrangement: true, _userInput: false };
    if (c.action === 'observe') { turn.status = c.status as typeof turn.status; if (turn.status === 'completed') delete f.snapshot.conversation.activeTurn; return turn; }
    return original(method, params);
  });
  vi.mocked(connection.prompt).mockImplementation(async (input, callbacks) => {
    expect(input.text).toContain('Quoted new customer evidence');
    expect(input).not.toHaveProperty('_arrangement');
    await callbacks.beforeDispatch!();
    return { status: 'completed' };
  });
  f.service.startChildren({} as never);
  f.durableEvent();
  await vi.waitFor(() => expect(turn.status).toBe('completed'));
  expect(connection.prompt).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.commands.some(c => c.action === 'create' || c.action === 'admit')).toBe(false);
});

it('an unsent arrangement keeps its original turn when the harness preparation fails', async () => {
  const f = await fixture();
  const connection = await vi.mocked(connectCodex).mock.results[0]!.value as HarnessConnection;
  const turn = { id: 'event-turn', conversationId: 'external:test', key: 'followup:occurrence', status: 'queued', createdAt: 1, updatedAt: 1,
    arrangementOccurrenceId: 'occurrence' } as ExternalConversationSnapshot['turns'][number];
  f.setSnapshot({ conversation: { ...f.snapshot.conversation, needsReview: false }, turns: [turn] });
  const original = f.kernel.agentRuntimeRequest.getMockImplementation()!;
  let deferred = 0;
  f.kernel.agentRuntimeRequest.mockImplementation(async (method, params) => {
    const c = params.command;
    if (c.action === 'arrangement_pending') return turn.status === 'queued' && !turn.blockedReason ? ['external:test'] : [];
    if (c.action === 'begin') { turn.status = 'preparing'; f.snapshot.conversation.activeTurn = turn.id; return turn; }
    if (c.action === 'input') return { text: 'Original arrangement with source evidence', _arrangement: true };
    if (c.action === 'defer') { deferred++; turn.status = 'queued'; turn.blockedReason = String(c.reason); delete f.snapshot.conversation.activeTurn; return turn; }
    return original(method, params);
  });
  vi.mocked(connection.prompt).mockRejectedValue(new Error('Sign in to the original harness account'));
  f.service.startChildren({} as never);
  f.durableEvent();
  await vi.waitFor(() => expect(deferred).toBe(1));
  f.durableEvent();
  await Promise.resolve(); await Promise.resolve();
  expect(turn.status).toBe('queued');
  expect(turn.blockedReason).toBe('Sign in to the original harness account');
  expect(connection.prompt).toHaveBeenCalledOnce();
  expect(f.commands.some(c => c.action === 'observe' && c.status === 'failed')).toBe(false);
});

it('returns an accepted original creation receipt before querying a now-offline source or disabled configuration',async()=>{
  const receipt={id:'external:legacy',configurationId:'removed-program',harness:'codex',cwd:'/original',title:'Accepted',revision:1};
  const actions:string[]=[];
  const kernel={agentRuntimeRequest:vi.fn(async(_method:string,input:{command:{action:string}})=>{
    actions.push(input.command.action);if(input.command.action==='create_receipt')return receipt;
    if(input.command.action==='cleanup_list')return[];throw new Error('Mutable readiness must not run during an accepted retry');
  })} as unknown as KernelClient;
  const resolveWorkspace=vi.fn(async()=>{throw new Error('offline');});
  const managed=vi.fn(()=>{throw new Error('offline');});
  const service=new ExternalAgentsService({kernel,spawn:vi.fn() as never,directory:'/unused',resolveWorkspace,managed});
  cleanups.push(()=>service.close());
  expect(await service.create({key:'old-key',configurationId:'removed-program',source:{resourceOwner:{kind:'managed_host',hostId:'remote',connectionId:'removed',endpointIdentity:'original'},path:'/original'}},'owner')).toEqual(receipt);
  expect(actions).toEqual(['create_receipt']);expect(managed).not.toHaveBeenCalled();expect(resolveWorkspace).not.toHaveBeenCalled();
});

it.each([false,true])('prepares project-only external children on the target owner and preserves cleanup (binding failure: %s)',async(bindingFails)=>{
  const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'external-project-owner-'));
  cleanups.push(()=>fs.rm(directory,{recursive:true,force:true}));
  const resourceOwner={kind:'managed_host' as const,hostId:'target',connectionId:'paired-target',endpointIdentity:'target-endpoint'};
  let child={operation_id:'original-project-dispatch',parent_run_id:'parent-run',parent_thread_id:'parent',parent_branch_id:'main',
    conversation_id:'external:child:original-project-dispatch',name:'Project work',binding:{configuration_id:'fixture',harness:'codex',launch:{command:'coordinator-program',args:[]}},
    project_source:{kind:'project',project:{id:'registered-project'},source_path:null},handoff:null,source:null,turn_id:null,report:null,
    dispatch_operation_id:null,message_kind:null,cancel_requested:false,resources_released:false,receipt_published:false,work_mode:'isolated_write'} as unknown as import('../kernel/protocol.generated.js').ExternalChild;
  const prepared={cwd:'/target/original-project-copy',workspaceId:'project-workspace',executionWorkspaceId:'project-copy',kind:'isolated',
    projectSource:{resourceOwner,workspaceId:'project-workspace',executionWorkspaceId:'project-copy',mode:'native_workspace',branchId:'original-project-branch'}};
  const sources={prepare:vi.fn(async()=>prepared),release:vi.fn(async()=>{}),remove:vi.fn(async()=>{})};
  const targetBinding={configurationIdentity:'frozen-target-config',configuration:{id:'fixture',name:'Target',harness:'codex',enabled:true,command:'target-only-program',args:['target-profile']},command:'target-only-program',args:['target-profile']};
  const externalBinding=vi.fn(async()=>{if(bindingFails)throw new Error('Target configuration unavailable');return targetBinding;});
  const actions:Array<Record<string,unknown>>=[];
  let notify:((event:{stream:string})=>void)|undefined;
  const kernel={onAgentRuntimeEvent:(listener:typeof notify)=>{notify=listener;return()=>{};},agentRuntimeRequest:vi.fn(async(_method:string,params:{command:Record<string,unknown>})=>{
    const c=params.command;actions.push(c);
    if(c.action==='settings')return {revision:1,defaultAgent:null,agents:[targetBinding.configuration]};
    if(c.action==='child_list')return [structuredClone(child)];
    if(['cleanup_list','list','arrangement_pending'].includes(String(c.action)))return [];
    if(c.action==='read')return {conversation:{id:child.conversation_id,needsReview:false},turns:child.turn_id?[{id:child.turn_id,status:'completed'}]:[],items:[]};
    if(c.action==='child_source'){child={...child,source:c.source};return structuredClone(child);}
    if(c.action==='create')return c;
    if(c.action==='child_input')return {text:'Original accepted task',_launch:targetBinding};
    if(c.action==='admit')return {id:'accepted-turn'};
    if(c.action==='child_link'){child={...child,turn_id:'accepted-turn'};return child;}
    if(c.action==='child_finish'){child={...child,report:{},resources_released:c.released===true,receipt_published:true};return child;}
    throw new Error(`Unexpected product action ${String(c.action)}`);
  })} as unknown as KernelClient;
  const resolveWorkspace=vi.fn(async()=>{throw new Error('Coordinator workspace must not be resolved');});
  const service=new ExternalAgentsService({kernel,directory,resolveWorkspace,spawn:vi.fn() as never,
    managed:()=>({coordinatorHostId:'coordinator',source:async()=>({externalBinding}) as never})});
  cleanups.push(()=>service.close());service.startChildren(sources);
  await vi.waitFor(()=>expect(actions.some(c=>c.action===(bindingFails?'child_finish':'child_link'))).toBe(true));
  expect(sources.prepare).toHaveBeenCalledOnce();
  expect(externalBinding).toHaveBeenCalledWith(expect.objectContaining({configurationId:'fixture',harness:'codex',source:expect.objectContaining({resource_owner:resourceOwner})}),expect.any(AbortSignal));
  expect(resolveWorkspace).not.toHaveBeenCalled();expect(await fs.readdir(directory)).toEqual([]);
  if(bindingFails){
    expect(sources.release).toHaveBeenCalledOnce();expect(sources.remove).toHaveBeenCalledWith(expect.objectContaining({source:prepared}),true);
    expect(actions.find(c=>c.action==='child_finish')).toMatchObject({released:true,failure:'Target configuration unavailable'});
    expect(actions.some(c=>c.action==='create')).toBe(false);
  }else{
    expect(actions.find(c=>c.action==='child_source')).toMatchObject({source:{executionBinding:{configurationIdentity:'frozen-target-config',launch:{command:'target-only-program',args:['target-profile']}}}});
    expect(actions.find(c=>c.action==='create')).toMatchObject({cwd:prepared.cwd,executionSource:{resource_owner:resourceOwner}});
    notify!({stream:'durable'});
    await vi.waitFor(()=>expect(sources.release,JSON.stringify(actions)).toHaveBeenCalledOnce());
    expect(sources.remove).not.toHaveBeenCalled();
  }
});
