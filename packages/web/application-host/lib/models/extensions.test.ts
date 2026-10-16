import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCapabilityRegistry, HostServiceRegistry, type ApplicationExtensionRuntime, type HostServiceOwnerIdentity } from '@varin/extension-host';
import { provideModels, type VarinBrokeredHostContext, type VarinHostServiceHandler, type VarinModelsImplementation } from '@varin/extension-sdk';
import { VARIN_MODELS_SERVICE, VARIN_MODEL_AUTHENTICATION_CAPABILITY, type ModelProtocolCall, type VarinModelsDescription, type VarinHostServiceComposition, type VarinExtensionCapabilityGrant } from '@varin/extension-contract';
import { ModelsExtensionOwner, type ModelAdapterContribution } from './extensions.js';
import { ModelsService } from './service.js';
import type { ModelChannel } from '@varin/application-client';
import { createModelAuthority } from '../kernel/model-authority.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const parse: ModelProtocolCall = { kind: 'parse', request_id: 'original-request', run_id: 'original-run', connection_identity: 'original-account', frame: 'event', state: null };
const description = (): VarinModelsDescription => ({
  adapters: [{ id: 'fixture.codec', version: '1', protocolFamily: 'fixture-stream', headers: { 'x-version': '1' } }], authentication: [],
  channels: [{ id: 'fixture.channel', name: 'Fixture', protocol: 'fixture-stream', authentication: ['none', 'credential'], operations: ['chat'],
    parametersSchema: { type: 'object', additionalProperties: false }, adapter: { id: 'fixture.codec', version: '1', endpointPath: '/stream' },
    credentialHeader: { name: 'x-fixture-key', prefix: 'Key ' }, catalog: [{ id: 'catalogue', name: 'Catalogue model', enabled: true, operations: ['chat'], contextWindow: 4096 }] }],
});
const channel = (authentication: ModelChannel['authentication'] = { kind: 'none' }): ModelChannel => ({ id: 'connection', name: 'Connection', type: 'fixture.channel', enabled: true,
  baseUrl: 'https://fixture.invalid/base', authentication, parameters: {}, models: [{ id: 'chat', name: 'Saved', enabled: true, operations: ['chat'], maxOutputTokens: 512 }] });
const unexpectedFetch: typeof fetch = async () => { throw new Error('Unexpected model fixture network request'); };
async function fixture(fetchImpl: typeof fetch = unexpectedFetch) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-model-contributions-'));
  const models = new ModelsService(directory, { projectTrusted: () => false, fetch: unexpectedFetch });
  const services = new HostServiceRegistry('model-fixture-host'), capabilities = new HostCapabilityRegistry();
  let generation = 0, composition: VarinHostServiceComposition, current: HostServiceOwnerIdentity;
  let grants: VarinExtensionCapabilityGrant[] = [];
  const selections = new Map<string, { composition: VarinHostServiceComposition; grants: VarinExtensionCapabilityGrant[] }>();
  const publications: Array<{ expectedRevision: number; adapters: ModelAdapterContribution[] }> = [], revoked: string[] = [];
  const retained = new Map<string, string>();
  let retainGate: (() => Promise<void>) | undefined;
  const runtime = {
    services, capabilities, subscribe: () => () => {},
    catalog: { snapshot: async () => ({ extensions: [...selections].map(([id, entry]) => ({ manifest: { id }, capabilityGrants: entry.grants })) }) },
    resolveServiceCompositions: async () => ({ routingRevision: generation, services: [...selections].map(([id, entry]) => ({ providerKey: `${id}:host:varin.models@1`, descriptor: VARIN_MODELS_SERVICE, composition: entry.composition })) }),
    prepareServiceCollection: async () => ({ routingRevision: generation, bindings: services.getSnapshot().providers.filter(provider => provider.status === 'active').map(provider => services.bind('varin.models', 1, provider.providerId)) }),
  } as unknown as ApplicationExtensionRuntime;
  const owner = new ModelsExtensionOwner(runtime, models, {
    publish: async input => { publications.push(structuredClone(input)); return { revision: input.expectedRevision + 1 }; },
    revoke: async id => { revoked.push(id); },
    retain: async (id, lease) => { retained.set(lease, id); await retainGate?.(); },
    release: async lease => { retained.delete(lease); },
  }, fetchImpl);
  const install = async (implementation: VarinModelsImplementation, granted = false, options: { extensionId?: string; stableComposition?: boolean } = {}) => {
    generation++; current = { extensionId: options.extensionId ?? 'fixture.models', extensionVersion: options.stableComposition ? '1.0.0' : `${generation}.0.0`, entrypointId: 'host', instanceKey: 'fixture-instance', generation };
    const selected = current;
    grants = [{ capability: VARIN_MODEL_AUTHENTICATION_CAPABILITY, realm: 'host', granted, manifestVersion: current.extensionVersion, updatedAt: new Date().toISOString() }];
    const selectedGrants = grants;
    const compositionId = options.stableComposition ? 'unchanged-artifact' : `generation-${generation}`;
    composition = { schemaVersion: 1, root: compositionId, nodes: [{ id: compositionId, extensionId: current.extensionId,
      entrypointId: 'host', extensionVersion: current.extensionVersion, artifactIntegrity: `sha256:${compositionId}`, activationConfiguration: null,
      grants: [{ capability: VARIN_MODEL_AUTHENTICATION_CAPABILITY, granted }], dependencies: [] }] };
    selections.set(current.extensionId, { composition, grants });
    let handler!: VarinHostServiceHandler;
    const register: VarinBrokeredHostContext['services']['provide'] = (_descriptor, implementation) => { handler = implementation; };
    provideModels({ services: { provide: register } } as unknown as VarinBrokeredHostContext, implementation);
    const replacement = services.prepareOwnerReplacement(current, [{ descriptor: structuredClone(VARIN_MODELS_SERVICE), handler: (method, args, context) => handler[method]!(args, {
      signal: context.signal, callId: 'original-broker-call', capabilities: { call: (capability, method, params) => capabilities.invoke(selected, selectedGrants, capability, method, params, context.signal) },
    }) }], { composition });
    replacement.commit();
    return replacement;
  };
  cleanup.push(async () => { await owner.close(); models.authorizations.close(); await rm(directory, { recursive: true, force: true }); });
  return { owner, models, services, install, publications, revoked, retained, directory, setRetainGate: (gate?: () => Promise<void>) => { retainGate = gate; }, current: () => current };
}
const codec = (version: number): VarinModelsImplementation => ({ description: description(), protocol: (_adapter, call) => call.kind === 'serialize'
  ? { kind: 'body', body: { version, request: call.request.request_id } }
  : { kind: 'parsed', events: [], state: { version, request: call.request_id, run: call.run_id }, finish: 'stop' } });

test('SDK contributions reach product catalog and fixed service pins; same-version replacement never redirects an accepted codec', async () => {
  const f = await fixture(); await f.install(codec(1)); await f.owner.start();
  const first = f.publications[0]!.adapters[0]!;
  const saved = await f.models.save(channel(), (await f.models.read()).revision);
  const original = await f.models.captureModel('connection', 'chat');
  expect([...f.retained.values()]).toEqual([first.bindingId]);
  expect(original.model).toMatchObject({ adapterId: 'fixture.codec', adapterVersion: '1', adapterIdentity: first.identity, adapterBindingId: first.bindingId, endpointPath: '/stream' });
  expect(saved.types.find(type => type.id === 'fixture.channel')!.catalog![0]!.id).toBe('catalogue');
  expect((await f.models.discover('connection', unexpectedFetch)).models[0]!.id).toBe('catalogue');
  const before = await readFile(join(f.directory, 'models.json'), 'utf8');
  await f.models.read(); await f.models.discover('connection', unexpectedFetch);
  expect(await readFile(join(f.directory, 'models.json'), 'utf8')).toBe(before);
  const replacement = await f.install(codec(2)); await f.owner.refresh();
  const second = f.publications[1]!.adapters[0]!; expect(second.bindingId).not.toBe(first.bindingId); expect(second.identity).not.toBe(first.identity);
  expect(await f.owner.protocol(first.bindingId, parse, new AbortController().signal)).toMatchObject({ state: { version: 1, request: 'original-request', run: 'original-run' } });
  expect(await f.owner.protocol(second.bindingId, parse, new AbortController().signal)).toMatchObject({ state: { version: 2 } });
  let retired = false; const retiring = replacement.finalize().then(() => { retired = true; }); await Promise.resolve(); expect(retired).toBe(false);
  f.owner.release(first.bindingId); original.release(); expect(f.retained.size).toBe(0); await retiring; expect(retired).toBe(true);
  const empty = { ...channel(), models: [] }; await f.models.save(empty, (await f.models.read()).revision);
  expect((await f.models.read()).channels[0]!.models).toEqual([]);
});

test('a bad replacement leaves the prior model catalog and Rust adapter publication intact', async () => {
  const f = await fixture(); await f.install(codec(1)); await f.owner.start();
  const invalid = codec(2); invalid.description.channels[0]!.id = 'openai';
  await f.install(invalid); await expect(f.owner.refresh()).rejects.toThrow('already registered');
  expect(f.publications).toHaveLength(1);
  expect((await f.models.read()).types.some(type => type.id === 'fixture.channel')).toBe(true);
  expect((await f.models.read()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'model-contributions-unavailable' })]));
});

test('cancel and kernel disconnect wait for actual callback drain, then republish a clean registry epoch', async () => {
  const f = await fixture(); let finish!: () => void, entered!: () => void, aborted = false;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  await f.install({ description: description(), protocol: async (_adapter, _call, signal) => {
    signal.addEventListener('abort', () => { aborted = true; }); entered(); await new Promise<void>(resolve => { finish = resolve; });
    return { kind: 'parsed', events: [], state: null, finish: null };
  } }); await f.owner.start();
  const id = f.publications[0]!.adapters[0]!.bindingId, controller = new AbortController();
  let settled = false; const call = f.owner.protocol(id, parse, controller.signal).then(() => { settled = true; });
  await arrived; controller.abort(); await Promise.resolve(); expect(aborted).toBe(true); expect(settled).toBe(false);
  let disconnected = false; const disconnect = f.owner.kernelDisconnected().then(() => { disconnected = true; });
  await Promise.resolve(); expect(disconnected).toBe(false); expect(f.services.ownerInUse(f.current())).toBe(true);
  finish(); await call; await disconnect;
  expect(f.services.ownerInUse(f.current())).toBe(false);
  expect((await f.models.read()).types.some(type => type.id === 'fixture.channel')).toBe(false);
  await f.owner.kernelReady(); expect(f.publications.at(-1)!.expectedRevision).toBe(0);
});

test('OAuth contributions require reviewed permission and retain their original refresh through replacement and cancelled observation', async () => {
  const f = await fixture(); let finish!: () => void, entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const implementation = codec(1);
  implementation.description.authentication.push({ id: 'fixture.oauth', name: 'Fixture OAuth', header: 'x-fixture-auth', prefix: 'Session ' });
  implementation.description.channels[0]!.oauthProviders = [{ id: 'fixture.oauth', name: 'Fixture OAuth' }];
  implementation.authenticate = async input => {
    if (input.kind !== 'refresh') throw new Error('fixture requires refresh'); entered(); await new Promise<void>(resolve => { finish = resolve; });
    return { kind: 'token', token: { ...input.token, accessToken: 'refreshed-by-original', expiresAt: Date.now() + 60_000 } };
  };
  await f.install(implementation, false); await expect(f.owner.start()).rejects.toThrow('not granted'); expect(f.publications).toHaveLength(0);
  await f.install(implementation, true); await f.owner.refresh();
  await f.models.credentials.linkOAuth({ kind: 'oauth', provider: 'fixture.oauth', accessToken: 'expired', expiresAt: 1 }, 'account');
  await f.models.save(channel({ kind: 'credential', reference: 'account' }), (await f.models.read()).revision);
  const captured = await f.models.credentials.captureResolver({ kind: 'credential', reference: 'account' }, 'connection');
  const controller = new AbortController(); const pending = captured.resolve(controller.signal);
  await arrived; controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); captured.release();
  const oldAdapter = f.publications.at(-1)!.adapters[0]!.bindingId;
  const replacement = await f.install(codec(2), false); await f.owner.refresh(); f.owner.release(oldAdapter);
  let drained = false; const draining = replacement.finalize().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
  finish(); await draining;
  expect(await f.models.credentials.store.read('account')).toContain('refreshed-by-original');
});

test('sign-in captures its original implementation before reading account identity and releases only after actual completion', async () => {
  for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
    const f = await fixture();
    let readIdentity!: () => void, continueIdentity!: () => void, entered!: () => void, finish!: () => void;
    const identityStarted = new Promise<void>(resolve => { readIdentity = resolve; });
    const identityGate = new Promise<void>(resolve => { continueIdentity = resolve; });
    const loginStarted = new Promise<void>(resolve => { entered = resolve; });
    const loginGate = new Promise<void>(resolve => { finish = resolve; });
    const calls: string[] = []; let replacementCalls = 0;
    const implementation: VarinModelsImplementation = {
      description: { channels: [], adapters: [], authentication: [{ id: 'fixture.oauth', name: 'Fixture account', header: 'authorization', prefix: 'Bearer ' }] },
      authenticate: async input => {
        calls.push(input.kind);
        if (input.kind === 'begin') return { kind: 'pending', authorizationUrl: 'https://accounts.fixture.invalid/authorize', state: 'original-state' };
        if (input.kind !== 'complete') throw new Error('Expected sign-in completion');
        expect(input.state).toBe('original-state'); entered();
        // The original callback deliberately remains active after cancellation.
        await loginGate;
        if (outcome === 'failed') throw new Error('Original sign-in failed');
        return { kind: 'token', token: { kind: 'oauth', provider: 'fixture.oauth', accessToken: 'original-token' } };
      },
    };
    await f.install(implementation, true); await f.owner.start();
    const originalOwner = f.current();
    const identity = f.models.credentials.identity.bind(f.models.credentials);
    const identitySpy = vi.spyOn(f.models.credentials, 'identity').mockImplementation(async reference => { readIdentity(); await identityGate; return identity(reference); });
    const flow = f.models.signIn('fixture.oauth', 'account');
    await identityStarted;
    const replacement = await f.install({ description: implementation.description, authenticate: async () => { replacementCalls++; throw new Error('Sign-in must not switch implementations'); } }, true);
    await f.owner.refresh();
    let drained = false; const draining = replacement.finalize().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(calls).toEqual([]);
    continueIdentity();
    await expect.poll(() => f.models.authorizations.read(flow.id).authorizationUrl).toBe('https://accounts.fixture.invalid/authorize');
    f.models.authorizations.reply(flow.id, 'https://callback.fixture.invalid/?code=original');
    await loginStarted;
    if (outcome === 'cancelled') f.models.authorizations.cancel(flow.id);
    await Promise.resolve(); expect(drained).toBe(false); expect(f.services.ownerInUse(originalOwner)).toBe(true);
    finish(); await draining;
    await expect.poll(() => f.models.authorizations.read(flow.id).status).toBe(outcome);
    expect(f.services.ownerInUse(originalOwner)).toBe(false);
    expect(calls).toEqual(['begin', 'complete']); expect(replacementCalls).toBe(0);
    const stored = await f.models.credentials.store.read('account');
    if (outcome === 'completed') expect(stored).toContain('original-token'); else expect(stored).toBeNull();
    identitySpy.mockRestore();
  }
});

test('authentication uses the reviewed exact-endpoint capability and an explicit custom header, with no network fallback', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ access_token: 'fresh-token' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const f = await fixture(fetchImpl); let wrongEndpoint = true;
  const implementation = codec(1);
  implementation.description.authentication.push({ id: 'fixture.oauth', name: 'Fixture account', header: 'x-fixture-session', prefix: 'Session ', endpoints: ['https://accounts.fixture.invalid/token'] });
  implementation.authenticate = async (input, _signal, client) => {
    if (input.kind !== 'refresh') throw new Error('Expected refresh');
    const result = await client.request(wrongEndpoint ? 'https://other.fixture.invalid/token' : 'https://accounts.fixture.invalid/token', { refresh_token: input.token.refreshToken! }) as { access_token: string };
    return { kind: 'token', token: { ...input.token, accessToken: result.access_token, expiresAt: Date.now() + 60_000 } };
  };
  await f.install(implementation, true); await f.owner.start();
  await f.models.credentials.linkOAuth({ kind: 'oauth', provider: 'fixture.oauth', accessToken: 'expired', refreshToken: 'original-refresh', expiresAt: 1 }, 'account');
  await f.models.save(channel({ kind: 'credential', reference: 'account' }), (await f.models.read()).revision);
  const accepted = await f.models.captureModel('connection', 'chat');
  await expect(accepted.authority.getAuth('connection')).rejects.toThrow('not granted'); expect(requests).toHaveLength(0);
  wrongEndpoint = false;
  expect(await accepted.authority.getAuth('connection')).toMatchObject({ auth: { headers: { 'x-fixture-session': 'Session fresh-token' } }, source: 'configured headers' });
  expect(requests).toHaveLength(1); expect(requests[0]!.init?.redirect).toBe('manual');
  expect(String(requests[0]!.init?.body)).toBe('refresh_token=original-refresh'); accepted.release();
  await f.models.storeCredential('explicit-key', 'api-key');
  await f.models.save(channel({ kind: 'credential', reference: 'api-key' }), (await f.models.read()).revision);
  const apiKey = await f.models.captureModel('connection', 'chat');
  expect(await apiKey.authority.getAuth('connection')).toMatchObject({ auth: { headers: { 'x-fixture-key': 'Key explicit-key' } }, source: 'configured headers' });
  apiKey.release();
  const freshOAuth = await f.models.credentials.captureResolver({ kind: 'credential', reference: 'account' }, 'connection');
  f.services.revokeOwner(f.current());
  await expect(freshOAuth.resolve()).rejects.toThrow();
  freshOAuth.release();
});

test('unrelated providers reuse the existing adapter identity, while a same-artifact worker restart gets a new binding', async () => {
  const f = await fixture(); await f.install(codec(1), false, { stableComposition: true }); await f.owner.start();
  const original = f.publications[0]!.adapters[0]!;
  await f.models.save(channel(), (await f.models.read()).revision);
  const authority = createModelAuthority(f.models);
  const originalSelection = await authority.resolveModel({ providerId: 'connection', modelId: 'chat' });
  const other = codec(2); other.description.channels[0]!.id = 'other.channel'; other.description.channels[0]!.adapter!.id = 'other.codec'; other.description.adapters[0]!.id = 'other.codec';
  await f.install(other, false, { extensionId: 'fixture.other' }); await f.owner.refresh();
  expect(f.publications[1]!.adapters.find(adapter => adapter.id === original.id)!.bindingId).toBe(original.bindingId);
  await f.install(codec(3), false, { stableComposition: true }); await f.owner.refresh();
  const replacement = f.publications[2]!.adapters.find(adapter => adapter.id === original.id)!;
  expect(replacement.bindingId).not.toBe(original.bindingId);
  expect(replacement.identity).toBe(original.identity);
  const restartedSelection = await authority.resolveModel({ providerId: 'connection', modelId: 'chat' });
  expect(originalSelection.configuration.adapterBindingId).toBe(original.bindingId);
  expect(restartedSelection.configuration.adapterBindingId).toBe(replacement.bindingId);
  expect(restartedSelection.configuration.adapterIdentity).toBe(originalSelection.configuration.adapterIdentity);
  expect(restartedSelection.configuration.configurationGeneration).toBe(originalSelection.configuration.configurationGeneration);
  originalSelection.credentialOwner.release(); restartedSelection.credentialOwner.release();
  expect(await f.owner.protocol(original.bindingId, parse, new AbortController().signal)).toMatchObject({ state: { version: 1 } });
  expect(await f.owner.protocol(replacement.bindingId, parse, new AbortController().signal)).toMatchObject({ state: { version: 3 } });
});

test('a capture pending its retained-lease reply keeps the original adapter through publication, and lost replies release that exact lease', async () => {
  const f = await fixture(); await f.install(codec(1)); await f.owner.start();
  await f.models.save(channel(), (await f.models.read()).revision);
  const original = f.publications[0]!.adapters[0]!;
  let arrive!: () => void, releaseReply!: () => void;
  const entered = new Promise<void>(resolve => { arrive = resolve; });
  f.setRetainGate(async () => { arrive(); await new Promise<void>(resolve => { releaseReply = resolve; }); });
  const preparing = f.models.captureModel('connection', 'chat'); await entered;
  await f.install(codec(2)); await f.owner.refresh();
  expect([...f.retained.values()]).toEqual([original.bindingId]);
  releaseReply(); const accepted = await preparing;
  expect(accepted.model.adapterIdentity).toBe(original.identity); expect(accepted.model.adapterBindingId).toBe(original.bindingId); accepted.release(); expect(f.retained.size).toBe(0);
  f.setRetainGate(async () => { throw new Error('retain reply was lost'); });
  await expect(f.models.captureModel('connection', 'chat')).rejects.toThrow('reply was lost');
  expect(f.retained.size).toBe(0);
});
