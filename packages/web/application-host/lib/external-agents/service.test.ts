import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExternalConversationSnapshot, ExternalInteractionResponse } from '@varin/application-client';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { HarnessConnection } from './adapter.js';
import type { ExternalAttachmentOwner } from './attachments.js';
import { connectCodex } from './codex.js';
import { ExternalAgentsService } from './service.js';

vi.mock('./codex.js', () => ({ connectCodex: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });

async function fixture() {
  const config = { id: 'fixture', name: 'Fixture', harness: 'codex', command: process.execPath, args: [], enabled: true };
  let snapshot = {
    conversation: { id: 'external:test', configurationId: config.id, harness: 'codex', cwd: '/tmp', title: 'Test', revision: 1, createdAt: 1, updatedAt: 1, archived: false, pinned: false, deleted: false, needsReview: true },
    turns: [], items: [],
  } as unknown as ExternalConversationSnapshot;
  const commands: Array<Record<string, unknown>> = [];
  const kernel = { agentRuntimeRequest: vi.fn(async (_method: string, params: { command: Record<string, unknown> }) => {
    commands.push(params.command);
    if (params.command.action === 'settings') return { revision: 0, defaultAgent: null, agents: [config] };
    if (params.command.action === 'read') return snapshot;
    if (params.command.action === 'cleanup_list') return [];
    if (params.command.action === 'update') return { ...snapshot.conversation, deleted: params.command.deleted === true };
    return {};
  }) };
  const children: Array<{ end(): void; terminating: boolean }> = [];
  const spawn = vi.fn(async () => {
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
      sessionId: 'native-test', capabilities: { models: [], resume: true, images: true, steering: false },
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
  await service.connect('external:test');
  return { service, commands, spawn, children, stop, kernel, fail: (error: Error) => fail(error), change: () => change(),
    setSnapshot(value: Partial<ExternalConversationSnapshot>) { snapshot = { ...snapshot, ...value }; },
    get snapshot() { return snapshot; },
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
