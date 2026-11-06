import { describe, expect, it } from 'vitest';
import { parseVarinCredentialAuthenticationResult } from '@varin/extension-contract';
import { HostServiceRegistry, type ApplicationExtensionRuntime, type HostCapabilityCallContext } from '@varin/extension-host';
import { HostCredentialService, type SecretStore } from '../credentials/service.js';
import { AuthorizationFlows } from '../authorization-flows.js';
import { bindPluginInvocationPrincipal } from './invocation-principal.js';
import { PluginCredentialCapability } from './credentials.js';
function setup() {
  const values = new Map<string, string>();
  const store: SecretStore = { read: async key => values.get(key) ?? null, modify: async (key, change) => {
    const value = change(values.get(key) ?? null); if (value === null) values.delete(key); else values.set(key, value);
  } };
  const owner = new PluginCredentialCapability({} as ApplicationExtensionRuntime, new HostCredentialService('host', store), new AuthorizationFlows());
  const context = (user: string, extensionId = 'example.plugin') => {
    const controller = new AbortController();
    const invocation = { id: crypto.randomUUID(), value: null };
    const result: HostCapabilityCallContext = { invocation, signal: controller.signal,
      owner: { extensionId, entrypointId: 'main', extensionVersion: '1', generation: 1, instanceKey: 'one' } };
    const release = bindPluginInvocationPrincipal(invocation, user);
    return { context: result, release, controller };
  };
  return { owner, context, values };
}
describe('plugin Host credential capability', () => {
  it('isolates users, plugins and connections using trusted authority', async () => {
    const { owner, context } = setup();
    const alice = context('alice').context, bob = context('bob').context, other = context('alice', 'example.other').context;
    await owner.call('put', { connectionId: 'one', key: 'secret' }, alice);
    expect(await owner.call('resolve', { connectionId: 'one' }, alice)).toEqual({ kind: 'api-key', key: 'secret' });
    expect(await owner.call('inspect', { connectionId: 'one' }, bob)).toEqual({ connected: false });
    expect(await owner.call('inspect', { connectionId: 'one' }, other)).toEqual({ connected: false });
    expect(await owner.call('inspect', { connectionId: 'two' }, alice)).toEqual({ connected: false });
    expect(await owner.call('inspect', { connectionId: 'one' }, alice)).toMatchObject({ connected: true, kind: 'api-key' });
    await owner.call('remove', { connectionId: 'one' }, alice);
    await expect(owner.call('resolve', { connectionId: 'one' }, alice)).rejects.toThrow();
  });
  it('returns its own committed binding rather than a concurrent replacement identity', async () => {
    const { owner, context } = setup(); const user = context('alice').context;
    const store = owner.credentials.store, modify = store.modify.bind(store);
    let intervened = false;
    store.modify = async (reference, change) => {
      await modify(reference, change);
      if (!intervened) {
        intervened = true;
        await owner.credentials.replace({ kind: 'api-key', key: 'later' }, reference, await owner.credentials.identity(reference));
      }
    };
    const committed = await owner.call('put', { connectionId: 'one', key: 'first' }, user) as { account: string };
    const current = await owner.call('inspect', { connectionId: 'one' }, user) as { account: string };
    expect(committed.account).not.toBe(current.account);
    await expect(owner.call('resolve', { connectionId: 'one', expectedAccount: committed.account }, user)).rejects.toThrow('selected credential changed');
  });
  it('rejects caller-supplied principals and unauthenticated or invalidated scopes', async () => {
    const { owner, context } = setup(); const user = context('alice');
    await expect(owner.call('put', { connectionId: 'one', key: 'secret', principalId: 'bob' }, user.context)).rejects.toThrow();
    await expect(owner.call('inspect', { connectionId: 'one' }, { owner: user.context.owner, signal: user.context.signal })).rejects.toThrow();
    user.release(); await expect(owner.call('inspect', { connectionId: 'one' }, user.context)).rejects.toThrow();
  });
  it('does not admit credentials or flow access after Host shutdown', async () => {
    const { owner, context, values } = setup(); const user = context('alice').context;
    owner.close(); await expect(owner.call('put', { connectionId: 'one', key: 'secret' }, user)).rejects.toThrow();
    expect(values.size).toBe(0);
  });
  it('does not accept another scope authorization identifiers', async () => {
    const { owner, context } = setup(); const user = context('alice').context;
    for (const method of ['read', 'reply', 'cancel']) await expect(owner.call(method,
      { connectionId: 'one', id: 'unknown', ...(method === 'reply' ? { redirect: 'http://localhost/callback' } : {}) }, user)).rejects.toThrow();
  });
  it('rejects a previously selected account after replacement', async () => {
    const { owner, context } = setup(); const user = context('alice').context;
    const original = await owner.call('put', { connectionId: 'one', key: 'old' }, user) as { account: string };
    await owner.call('put', { connectionId: 'one', key: 'new' }, user);
    for (const method of ['resolve', 'remove', 'put', 'start']) await expect(owner.call(method,
      { connectionId: 'one', expectedAccount: original.account, ...(method === 'put' ? { key: 'stale' } : {}) }, user)).rejects.toThrow('selected credential changed');
  });

});

describe('plugin authorization lifetime', () => {
  async function fixture() {
    const base = setup(), user = base.context('alice');
    let releases = 0, refreshes = 0;
    const revoke = new AbortController();
    let finishRefresh!: (value: unknown) => void;
    const refresh = new Promise(resolve => { finishRefresh = resolve; });
    const runtime = {
      services: {
        getSnapshot: () => ({ providers: [{ ...user.context.owner, providerId: 'provider', status: 'active', descriptor: { id: 'example.auth', version: 1 } }] }),
        bindPinned: () => ({ release() {}, pin: () => ({ providerId: 'provider', revocationSignal: revoke.signal,
          assertAvailable: () => revoke.signal.throwIfAborted(), release: () => { releases++; },
          invoke: async (_method: string, args: { kind: string }[]) => {
            if (args[0]!.kind === 'begin') return { kind: 'pending', authorizationUrl: 'https://example.com/login', state: 'state' };
            if (args[0]!.kind === 'complete') return { kind: 'token', token: { kind: 'oauth', provider: 'example', accessToken: 'old', expiresAt: 0 } };
            refreshes++; return refresh;
          },
        }) }),
      },
    } as unknown as ApplicationExtensionRuntime;
    const owner = new PluginCredentialCapability(runtime, base.owner.credentials, new AuthorizationFlows());
    const adapter = { serviceId: 'example.auth', version: 1, provider: 'example' };
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const start = async () => {
      const result = await owner.call('start', { connectionId: 'one', adapter }, user.context) as { id: string };
      await tick(); return result.id;
    };
    return { ...base, owner, user, adapter, start, tick, revoke, releases: () => releases, refreshes: () => refreshes,
      finishRefresh: () => finishRefresh({ kind: 'token', token: { kind: 'oauth', provider: 'example', accessToken: 'new', expiresAt: Date.now() + 60000 } }) };
  }
  it('finishes authorization after the starting invocation is released, with fresh scoped replies', async () => {
    const f = await fixture(), id = await f.start(); f.user.release(); f.user.controller.abort();
    const next = f.context('alice').context;
    await expect(f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, f.context('bob').context)).rejects.toThrow();
    await f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, next); await f.tick();
    expect(await f.owner.call('read', { connectionId: 'one', id }, next)).toMatchObject({ status: 'completed' });
    expect(f.releases()).toBe(1);
  });
  it('does not let stale authorization replace a new credential', async () => {
    const f = await fixture(), id = await f.start();
    await f.owner.call('put', { connectionId: 'one', key: 'replacement' }, f.user.context);
    await f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, f.user.context); await f.tick();
    expect(await f.owner.call('read', { connectionId: 'one', id }, f.user.context)).toMatchObject({ status: 'failed' });
    expect(await f.owner.call('resolve', { connectionId: 'one' }, f.user.context)).toEqual({ kind: 'api-key', key: 'replacement' });
  });
  it('coalesces refresh and retains its pin after the first waiter cancels', async () => {
    const f = await fixture(), id = await f.start();
    await f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, f.user.context); await f.tick();
    const first = f.context('alice'), second = f.context('alice');
    const a = f.owner.call('resolve', { connectionId: 'one', adapter: f.adapter }, first.context);
    const b = f.owner.call('resolve', { connectionId: 'one', adapter: f.adapter }, second.context);
    await f.tick(); first.controller.abort(); first.release(); await expect(a).rejects.toThrow();
    expect(f.refreshes()).toBe(1); expect(f.releases()).toBe(1);
    f.finishRefresh(); expect(await b).toMatchObject({ accessToken: 'new' }); expect(f.releases()).toBe(3);
  });
  it('does not persist a cancelled authorization waiting on the credential transaction', async () => {
    const f = await fixture(), id = await f.start();
    let release!: () => void, entered!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const store = f.owner.credentials.store, modify = store.modify.bind(store);
    store.modify = async (reference, change) => { entered(); await queued; await modify(reference, change); };
    await f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, f.user.context);
    await waiting;
    await f.owner.call('cancel', { connectionId: 'one', id }, f.user.context);
    release(); await f.tick();
    expect(await f.owner.call('inspect', { connectionId: 'one' }, f.user.context)).toEqual({ connected: false });
    expect(await f.owner.call('read', { connectionId: 'one', id }, f.user.context)).toMatchObject({ status: 'cancelled' });
    expect(f.releases()).toBe(1);
  });
  it('reports the actual committed result when cancellation arrives after write admission', async () => {
    const f = await fixture(), id = await f.start();
    let release!: () => void, entered!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const store = f.owner.credentials.store, modify = store.modify.bind(store);
    store.modify = async (reference, change) => { await modify(reference, change); entered(); await queued; };
    await f.owner.call('reply', { connectionId: 'one', id, redirect: 'https://callback' }, f.user.context);
    await waiting;
    expect(await f.owner.call('cancel', { connectionId: 'one', id }, f.user.context)).toMatchObject({ status: 'pending' });
    release(); await f.tick();
    expect(await f.owner.call('read', { connectionId: 'one', id }, f.user.context)).toMatchObject({ status: 'completed' });
    expect(await f.owner.call('inspect', { connectionId: 'one' }, f.user.context)).toMatchObject({ connected: true });
  });
  it('releases authorization pins on close and owner revocation', async () => {
    for (const stop of ['close', 'revoke']) {
      const f = await fixture(); await f.start();
      if (stop === 'close') f.owner.close(); else f.revoke.abort();
      await f.tick(); expect(f.releases()).toBe(1);
    }
  });
});

it('permits HTTPS authorization and loopback HTTP but rejects remote cleartext URLs', () => {
  for (const authorizationUrl of ['https://example.com/login', 'http://localhost/callback', 'http://127.0.0.1/callback', 'http://[::1]/callback']) {
    expect(parseVarinCredentialAuthenticationResult({ kind: 'pending', authorizationUrl, state: null })).toMatchObject({ authorizationUrl });
  }
  for (const authorizationUrl of ['http://example.com/login', 'https://user:password@example.com/login', 'javascript:alert(1)']) {
    expect(() => parseVarinCredentialAuthenticationResult({ kind: 'pending', authorizationUrl, state: null })).toThrow();
  }
});

it('uses an admitted original generation after replacement, without selecting the new provider', async () => {
  const base = setup(), user = base.context('alice'), services = new HostServiceRegistry('host');
  const descriptor = { id: 'example.auth', version: 1 };
  let oldCalls = 0, newCalls = 0;
  await services.replaceOwner(user.context.owner, [{ descriptor, handler: async () => {
    oldCalls++; return { kind: 'pending', authorizationUrl: 'https://example.com/login', state: null };
  } }]);
  const admission = services.bind(descriptor.id, descriptor.version);
  const original = admission.pin(); admission.release();
  const replacement = services.prepareOwnerReplacement({ ...user.context.owner, generation: 2 }, [{ descriptor,
    handler: async () => { newCalls++; throw new Error('wrong generation'); } }]);
  replacement.commit();
  const capability = new PluginCredentialCapability({ services } as ApplicationExtensionRuntime, base.owner.credentials, new AuthorizationFlows());
  // Use the public adapter contract; no provider id or generation may come from plugin JSON.
  const state = await capability.call('start', { connectionId: 'one', adapter: { serviceId: descriptor.id, version: 1, provider: 'example' } }, user.context);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(oldCalls).toBe(1); expect(newCalls).toBe(0);
  capability.close(); await new Promise(resolve => setTimeout(resolve, 0));
  original.release(); await replacement.finalize();
  expect(state).toMatchObject({ status: 'pending' });
});

it('rejects a queued API key write after invocation authority ends', async () => {
  const f = setup(), user = f.context('alice');
  let release!: () => void, entered!: () => void;
  const queued = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const store = f.owner.credentials.store, modify = store.modify.bind(store);
  store.modify = async (reference, change) => { entered(); await queued; await modify(reference, change); };
  const put = f.owner.call('put', { connectionId: 'one', key: 'secret' }, user.context);
  await waiting; user.release(); user.controller.abort(); release();
  await expect(put).rejects.toThrow(); expect(f.values.size).toBe(0);
});
