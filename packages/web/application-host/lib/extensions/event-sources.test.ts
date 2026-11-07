import { afterEach, describe, expect, it } from 'vitest';
import { HostCapabilityRegistry, HostServiceRegistry, type ApplicationExtensionRuntime,
  type HostCapabilityCallContext, type HostServiceInvocationContext, type HostServiceOwnerIdentity } from '@varin/extension-host';
import { VARIN_EVENTS_CAPABILITY, VARIN_CREDENTIALS_CAPABILITY, type JsonValue,
  type VarinEventBatch, type VarinExtensionServiceProvision } from '@varin/extension-contract';
import { PluginEventSources } from './event-sources.js';
import { PluginCredentialCapability } from './credentials.js';
import { bindPluginInvocationPrincipal } from './invocation-principal.js';
import { HostCredentialService } from '../credentials/service.js';
import { AuthorizationFlows } from '../authorization-flows.js';
import type { FollowupEventSourceSubscription, FollowupEventSourceCheckpoint, FollowupEventReceiveParams } from '../kernel/protocol.generated.js';

const owner: HostServiceOwnerIdentity = { extensionId: 'example.mail', extensionVersion: '1.0.0',
  entrypointId: 'host', instanceKey: 'first', generation: 1 };
const serviceDefinition: VarinExtensionServiceProvision = { id: 'example.mail.events', version: 1, contract: {
  methods: { connections: { inputSchema: true, outputSchema: true }, receive: { inputSchema: true, outputSchema: true } },
  events: { mail: { schema: { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false },
    durable: { sourceId: 'mail', displayName: 'Mail', connectionsMethod: 'connections', receiveMethod: 'receive',
      credentials: 'required', filterSchema: { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false },
      modes: ['poll', 'push'], recovery: 'history' } } },
} };
const batch = (expectedCursor: string | null, nextCursor: string): VarinEventBatch => ({ expectedCursor, nextCursor,
  events: [{ eventId: 'message', objectId: 'conversation', occurredAtMs: 100, attributes: { label: 'inbox' },
    content: { data: null, parts: [{ kind: 'text', text: 'Original message' }] } }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(recovery: 'history' | 'realtime' = 'history') {
  const service = structuredClone(serviceDefinition);
  service.contract!.events!.mail!.durable!.recovery = recovery;
  const services = new HostServiceRegistry('host'), capabilities = new HostCapabilityRegistry();
  const calls: Array<{ args: Record<string, JsonValue>; context: HostServiceInvocationContext; owner: HostServiceOwnerIdentity }> = [];
  const checkpoint: FollowupEventSourceCheckpoint = { identity: { principalId: 'alice', source: {
    extensionId: owner.extensionId, sourceId: 'mail', connectionId: 'mailbox', accountId: '' } }, cursor: 'saved', status: null };
  const subscriptions: FollowupEventSourceSubscription[] = [];
  let event: () => void = () => {}, exit: () => void = () => {}, ready: () => void = () => {};
  const received: FollowupEventReceiveParams[] = [];
  let accept = async (input: FollowupEventReceiveParams) => {
    received.push(input); checkpoint.cursor = input.nextCursor; checkpoint.status = input.status;
    return { accepted: input.events.length, duplicates: 0, checkpoint: structuredClone({ ...checkpoint, identity: input.identity }) };
  };
  const catalog = { eventTransportSources: async () => [], eventSourceSubscriptions: async () => structuredClone(subscriptions), eventSourceCheckpoint: async () => structuredClone(checkpoint),
    updateEventSourceStatus: async ({ status }: { status: FollowupEventSourceCheckpoint['status'] }) => { checkpoint.status = status; return structuredClone(checkpoint); },
    receivePluginEvents: (input: FollowupEventReceiveParams) => accept(input),
    onEvent: (listener: (event: { stream: string }) => void) => { event = () => listener({ stream: 'durable' }); return () => {}; },
    onExit: (listener: () => void) => { exit = listener; return () => {}; }, onReady: (listener: () => void) => { ready = listener; return () => {}; } };
  let enabled = true;
  const runtime = { services, capabilities, subscribe: (listener: () => void) => services.subscribe(listener),
    catalog: { snapshot: async () => ({ authoritative: true, extensions: [{ desired: { enabled }, capabilityGrants: grants, manifest: {
      id: owner.extensionId, version: owner.extensionVersion, entrypoints: { host: {} }, provides: { services: [service] } } }] }) },
    prepareEventSource: async (_extensionId: string, serviceId: string, version: number) => services.bind(serviceId, version),
  } as unknown as ApplicationExtensionRuntime;
  const secrets = new Map<string, string>();
  const credentials = new PluginCredentialCapability(runtime, new HostCredentialService('host', {
    read: async key => secrets.get(key) ?? null, modify: async (key, change) => { const next = change(secrets.get(key) ?? null);
      if (next === null) secrets.delete(key); else secrets.set(key, next); },
  }), new AuthorizationFlows()); credentials.start();
  const user = (principal: string): HostCapabilityCallContext => {
    const invocation = { id: crypto.randomUUID(), value: null }; bindPluginInvocationPrincipal(invocation, principal);
    return { owner, invocation, signal: new AbortController().signal };
  };
  const alice = user('alice');
  checkpoint.identity.source.accountId = (await credentials.call('put', { connectionId: 'mailbox', key: 'secret' }, alice) as { account: string }).account;
  const grants = [VARIN_EVENTS_CAPABILITY, VARIN_CREDENTIALS_CAPABILITY].map(capability => ({ capability, realm: 'host' as const, granted: true, manifestVersion: '1.0.0', updatedAt: '2026-11-08T00:00:00Z' }));
  const install = async (selected = owner) => services.replaceOwner(selected, [{ descriptor: service,
    handler: async (method, args, context) => {
      if (method === 'connections') return [{ connectionId: 'mailbox', displayName: 'My inbox' }];
      calls.push({ args: args[0] as Record<string, JsonValue>, context, owner: selected });
      if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return null;
    } }]);
  await install();
  const events = new PluginEventSources(runtime, catalog as never, credentials, 60_000, 'local-host');
  cleanups.push(async () => { await events.close(); credentials.close(); });
  const add = (followupId: string, principalId = 'alice', accountId = checkpoint.identity.source.accountId) => {
    subscriptions.push({ followupId, identity: { principalId, source: { ...checkpoint.identity.source, accountId } }, filter: {}, state: 'active' });
  };
  const submit = async (index: number, input: VarinEventBatch) => {
    const call = calls[index]!;
    return capabilities.invoke(call.owner, grants, VARIN_EVENTS_CAPABILITY, 'submit', input as unknown as JsonValue,
      call.context.signal, call.context.invocation);
  };
  return { events, credentials, runtime, services, calls, received, checkpoint, subscriptions, alice, user, add, submit, install,
    setAccept: (fn: typeof accept) => { accept = fn; }, change: () => event(), exit: () => exit(), ready: () => ready(),
    disable: () => { enabled = false; services.removeOwner(owner); } };
}

describe('durable plugin event ingress', () => {
  it('never turns a realtime-only reconnect into complete offline coverage', async () => {
    const f = await fixture('realtime'); f.add('one'); f.events.start(); await tick();
    const from = f.checkpoint.status!.coverage!.fromMs!;
    const input = batch('saved', 'next'); input.coverage = { kind: 'complete' };
    await f.submit(0, input);
    expect(f.received[0]!.status?.coverage).toEqual({ kind: 'from', fromMs: from });
  });
  it('admits typed original files and scopes echo claims to the actual receiving Host', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    const input = batch('saved', 'next');
    input.events[0]!.files = [{ fileId: 'pdf', filename: 'invoice.pdf', mimeType: 'application/pdf', bytesBase64: 'JVBERi0xLjQ=' }];
    input.events[0]!.state = { key: 'checks', sequence: 3, value: 'healthy' };
    input.events[0]!.echoOf = { ownerHostId: 'local-host', followupId: 'one', occurrenceId: 'receipt', operationId: 'send' };
    await f.submit(0, input);
    expect(f.received[0]!.events[0]!.files).toEqual(input.events[0]!.files);
    expect(f.received[0]!.events[0]!.state).toEqual(input.events[0]!.state);
    expect(f.received[0]!.events[0]!.echoOf?.ownerHostId).toBeNull();
    input.events[0]!.echoOf.ownerHostId = 'foreign-host'; await f.submit(0, input);
    expect(f.received[1]!.events[0]!.echoOf?.ownerHostId).toBe('foreign-host');
  });
  it('discovers real credential identities, validates declared filters and rejects replaced accounts', async () => {
    const f = await fixture();
    expect(await f.events.discover(null)).toMatchObject([{ available: false, code: 'authentication_required' }]);
    expect(await f.events.discover('alice')).toMatchObject([{ connections: [{ accountId: f.checkpoint.identity.source.accountId, available: true }] }]);
    expect(await f.events.discover('bob')).toMatchObject([{ connections: [{ available: false, accountId: null }] }]);
    await f.events.validateArrangement('alice', f.checkpoint.identity.source, { label: 'inbox' });
    await expect(f.events.validateArrangement('alice', f.checkpoint.identity.source, { nonexistent: true })).rejects.toThrow('source_filter_invalid');
    await f.credentials.call('put', { connectionId: 'mailbox', key: 'replacement' }, f.alice);
    await expect(f.events.validateArrangement('alice', f.checkpoint.identity.source, {})).rejects.toThrow('account_changed');
  });
  it('waits for Catalog acceptance before acknowledging and leaves failed cursor recoverable', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    expect(f.calls[0]?.args.cursor).toBe('saved');
    let release!: () => void;
    f.setAccept(async input => { await new Promise<void>(resolve => { release = resolve; }); return {
      accepted: 1, duplicates: 0, checkpoint: { ...f.checkpoint, cursor: input.nextCursor } }; });
    let accepted = false; const pending = f.submit(0, batch('saved', 'next')).then(() => { accepted = true; });
    await tick(); expect(accepted).toBe(false); release(); await pending; expect(accepted).toBe(true);
    f.setAccept(async () => { throw new Error('Catalog unavailable'); });
    await expect(f.submit(0, batch('next', 'failed'))).rejects.toThrow('Catalog unavailable');
    f.exit(); await tick(); f.ready(); await tick();
    expect(f.calls[1]?.args.cursor).toBe('saved');
  });
  it('shares same-user account listeners, isolates other users, and releases only the last active reference', async () => {
    const f = await fixture();
    const bob = (await f.credentials.call('put', { connectionId: 'mailbox', key: 'bob' }, f.user('bob')) as { account: string }).account;
    f.add('one'); f.add('another-bot'); f.add('bob', 'bob', bob); f.events.start(); await tick();
    expect(f.calls).toHaveLength(2);
    f.subscriptions[0]!.state = 'paused'; f.change(); await tick(); expect(f.calls[0]!.context.signal.aborted).toBe(false);
    f.subscriptions[1]!.state = 'paused'; f.change(); await tick(); expect(f.calls[0]!.context.signal.aborted).toBe(true);
    expect(f.calls[1]!.context.signal.aborted).toBe(false);
    await expect(f.submit(0, batch('saved', 'later'))).rejects.toThrow();
  });
  it('rejects unscoped submissions and account changes even when the remote listener is still active', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    await expect(f.events.call('submit', batch('saved', 'next') as unknown as JsonValue, f.alice)).rejects.toThrow('event_receiver_unavailable');
    await expect(f.submit(0, { ...batch('saved', 'next'), principalId: 'bob' } as VarinEventBatch)).rejects.toThrow('Invalid event batch');
    await f.credentials.call('put', { connectionId: 'mailbox', key: 'new-account' }, f.alice); await tick();
    expect(f.calls[0]!.context.signal.aborted).toBe(true);
    expect(f.received).toHaveLength(0);
  });
  it('moves background listeners to the newly published generation after the old callback drains', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    await f.install({ ...owner, generation: 2 }); await tick();
    expect(f.calls[0]!.context.signal.aborted).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.owner.generation).toBe(2);
    expect(f.calls[1]!.args.cursor).toBe('saved');
  });
  it('cannot mutate or resolve credentials during discovery or escape a receiver account', async () => {
    const f = await fixture();
    const user = f.user('alice'), release = f.credentials.bindConnectionDiscovery(user.invocation!);
    await expect(f.credentials.call('inspect', { connectionId: 'mailbox' }, user)).resolves.toMatchObject({ connected: true });
    await expect(f.credentials.call('resolve', { connectionId: 'mailbox' }, user)).rejects.toThrow();
    await expect(f.credentials.call('put', { connectionId: 'mailbox', key: 'injected' }, user)).rejects.toThrow();
    release();
    const releaseReceiver = f.credentials.bindEventReceiver(user.invocation!, 'mailbox', f.checkpoint.identity.source.accountId);
    await expect(f.credentials.call('resolve', { connectionId: 'mailbox', expectedAccount: f.checkpoint.identity.source.accountId }, user)).resolves.toEqual({ kind: 'api-key', key: 'secret' });
    await expect(f.credentials.call('put', { connectionId: 'mailbox', expectedAccount: f.checkpoint.identity.source.accountId, key: 'injected' }, user)).rejects.toThrow();
    await expect(f.credentials.call('inspect', { connectionId: 'different', expectedAccount: f.checkpoint.identity.source.accountId }, user)).rejects.toThrow();
    releaseReceiver();
  });
  it('recovers the authoritative checkpoint when acceptance succeeded but its reply was lost', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    f.setAccept(async input => { f.checkpoint.cursor = input.nextCursor; throw new Error('Transport disconnected'); });
    await expect(f.submit(0, batch('saved', 'committed'))).rejects.toThrow('Transport disconnected');
    f.exit(); await tick(); f.ready(); await tick();
    expect(f.calls[1]!.args.cursor).toBe('committed');
  });
  it('retires plugin listeners and retains checkpoint facts', async () => {
    const f = await fixture(); f.add('one'); f.events.start(); await tick();
    f.disable(); await tick();
    expect(f.calls[0]!.context.signal.aborted).toBe(true);
    expect(f.checkpoint.cursor).toBe('saved');
    expect(f.checkpoint.status?.code).toBe('plugin_disabled');
    expect(await f.events.discover('alice')).toMatchObject([{ available: false, code: 'plugin_disabled' }]);
  });
});
