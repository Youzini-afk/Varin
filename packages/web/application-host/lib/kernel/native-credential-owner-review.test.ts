import { expect, it } from 'vitest';
import { createNativeModelAuthority } from './native-model-authority.js';
import { NativeCredentialBridge, type PrivateCredentialResponse } from './native-credential-bridge.js';
import { ExistingHostCredentialOwner, type NativeCredentialOwnerOptions, type NativeCredentialScope } from './native-credential-owner.js';

const scope: NativeCredentialScope = { reference: 'fake-ref', authority: 'fake-authority', account: 'fake-local-binding-handle', generation: 7 };
function owner(overrides: Partial<NativeCredentialOwnerOptions> = {}) {
  return new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint: 'https://model.example.test/v1/responses', currentScope: async () => ({ ...scope }), runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-test-key' } }) }, ...overrides });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('credential adapter resolves exclusively through the injected existing owner and preserves explicit headers', async () => {
  const calls: string[] = [];
  const credential = owner({ runtime: { getAuth: async providerId => { calls.push(providerId); return { auth: { apiKey: 'fake-unused-key', baseUrl: 'https://model.example.test/v1', headers: { authorization: 'Bearer fake-owner-value', 'x-fixture': 'retained', 'x-removed': null } } }; } } });
  const resolved = await credential.resolve(scope);
  expect(calls).toEqual(['fixture-provider']);
  expect(resolved.scope).toEqual(scope);
  expect(resolved.headers).toMatchObject({ authorization: 'Bearer fake-owner-value', 'x-fixture': 'retained' });
  expect(resolved.headers).not.toHaveProperty('x-removed');
});

it('scope change before lookup rejects without reading credentials', async () => {
  let called = false;
  const credential = owner({ currentScope: async () => ({ ...scope, generation: 8 }), runtime: { getAuth: async () => { called = true; return { auth: { apiKey: 'fake-key' } }; } } });
  await expect(credential.resolve(scope)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  expect(called).toBe(false);
});

it('scope change during refresh rejects the stale result', async () => {
  let generation = scope.generation;
  const credential = owner({ currentScope: async () => ({ ...scope, generation }), runtime: { getAuth: async () => { generation++; return { auth: { apiKey: 'fake-stale-key' } }; } } });
  await expect(credential.resolve(scope)).rejects.toMatchObject({ code: 'credential-scope-changed' });
});

it.each([
  'https://another.example.test/v1',
  'https://model.example.test/unrelated',
  'https://model.example.test/v1?tenant=different',
])('credential refresh cannot reroute the frozen endpoint to %s', async baseUrl => {
  const credential = owner({ runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-key', baseUrl } }) } });
  await expect(credential.resolve(scope)).rejects.toMatchObject({ code: 'credential-endpoint-changed' });
});

it('caller cancellation leaves the existing owner refresh and persistence alive', async () => {
  const refresh = deferred<{ auth: { apiKey: string } }>();
  const entered = deferred<void>();
  const persisted = deferred<void>();
  let calls = 0;
  const credential = owner({ runtime: { getAuth: async () => { calls++; entered.resolve(); const result = await refresh.promise; persisted.resolve(); return result; } } });
  const controller = new AbortController();
  const result = credential.resolve(scope, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ code: 'credential-cancelled' });
  await entered.promise;
  controller.abort();
  await rejected;
  refresh.resolve({ auth: { apiKey: 'fake-refreshed-key' } });
  await persisted.promise;
  expect(calls).toBe(1);
  expect((await credential.resolve(scope)).headers.authorization).toBe('Bearer fake-refreshed-key');
  expect(calls).toBe(2);
});

it('pre-cancelled lookup never enters the credential owner', async () => {
  let calls = 0;
  const credential = owner({ runtime: { getAuth: async () => { calls++; return undefined; } } });
  const controller = new AbortController();
  controller.abort();
  await expect(credential.resolve(scope, controller.signal)).rejects.toMatchObject({ code: 'credential-cancelled' });
  expect(calls).toBe(0);
});

it('credential failures expose a code without leaking owner messages or causes', async () => {
  const credential = owner({ runtime: { getAuth: async () => { throw new Error('fake-private-credential-and-response'); } } });
  const error = await credential.resolve(scope).catch(value => value as Error);
  expect(error).toMatchObject({ code: 'credential-resolution-failed', message: 'credential-resolution-failed' });
  expect(String(error)).not.toContain('fake-private-credential-and-response');
  expect(error).not.toHaveProperty('cause');
});

it('Codex credentials remain bound to the selected account and bearer authority', async () => {
  const valid = owner({ providerFamily: 'openai-codex-responses', currentProviderAccount: async () => 'fake-provider-account' });
  expect((await valid.resolve(scope)).headers).toMatchObject({ authorization: 'Bearer fake-test-key', 'chatgpt-account-id': 'fake-provider-account' });
  const crossed = owner({ providerFamily: 'openai-codex-responses', currentProviderAccount: async () => 'fake-provider-account', runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-key', headers: { 'chatgpt-account-id': 'another-fake-account' } } }) } });
  await expect(crossed.resolve(scope)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  const missing = owner({ providerFamily: 'openai-codex-responses', currentProviderAccount: async () => 'fake-provider-account', allowAnonymous: true, runtime: { getAuth: async () => ({ auth: {} }) } });
  await expect(missing.resolve(scope)).rejects.toMatchObject({ code: 'codex-credential-binding-required' });
  await expect(owner({ providerFamily: 'openai-codex-responses' }).resolve(scope)).rejects.toMatchObject({ code: 'codex-provider-account-required' });
});

it('anonymous mode requires explicit permission and cannot disguise a missing owner result', async () => {
  await expect(owner({ runtime: { getAuth: async () => ({ auth: {} }) } }).resolve(scope)).rejects.toMatchObject({ code: 'credential-missing' });
  expect((await owner({ allowAnonymous: true, runtime: { getAuth: async () => ({ auth: {} }) } }).resolve(scope)).headers).toEqual({});
  await expect(owner({ allowAnonymous: true, runtime: { getAuth: async () => undefined } }).resolve(scope)).rejects.toMatchObject({ code: 'credential-missing' });
});

it('Vertex explicit Cloud API keys and bearer headers retain their distinct modes', async () => {
  expect((await owner({ providerFamily: 'google-vertex' }).resolve(scope)).headers['x-goog-api-key']).toBe('fake-test-key');
  const bearer = owner({ providerFamily: 'google-vertex', runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-unused', headers: { authorization: 'Bearer fake-vertex-value' } } }) } });
  expect((await bearer.resolve(scope)).headers.authorization).toBe('Bearer fake-vertex-value');
  const key = owner({ providerFamily: 'google-vertex', runtime: { getAuth: async () => ({ auth: { headers: { 'x-goog-api-key': 'fake-explicit-key' } } }) } });
  expect((await key.resolve(scope)).headers['x-goog-api-key']).toBe('fake-explicit-key');
});

it('Codex rejects empty bearer material while accepting a case-insensitive scheme', async () => {
  const empty = owner({ providerFamily: 'openai-codex-responses', currentProviderAccount: async () => 'fake-provider-account', runtime: { getAuth: async () => ({ auth: { headers: { authorization: 'Bearer   ' } } }) } });
  await expect(empty.resolve(scope)).rejects.toMatchObject({ code: 'codex-credential-binding-required' });
  const lower = owner({ providerFamily: 'openai-codex-responses', currentProviderAccount: async () => 'fake-provider-account', runtime: { getAuth: async () => ({ auth: { headers: { authorization: 'bearer fake-codex-token' } } }) } });
  expect((await lower.resolve(scope)).headers['chatgpt-account-id']).toBe('fake-provider-account');
});


it('private credential bridge ignores stale epochs and rejects mismatched registered scopes', async () => {
  let lookups = 0;
  const replies: PrivateCredentialResponse[] = [];
  const bridge = new NativeCredentialBridge(() => 'current-epoch', async response => { replies.push(response); }, () => { throw new Error('unexpected transport failure'); });
  await bridge.register('run', owner({ runtime: { getAuth: async () => { lookups++; return { auth: { apiKey: 'fake-bridge-key' } }; } } }));
  const request = { v: 1, kind: 'credential-request', id: 'request', kernelEpoch: 'current-epoch', runId: 'run', scope };
  expect(bridge.consume({ ...request, kernelEpoch: 'old-epoch' })).toBe(true);
  await Promise.resolve();
  expect(lookups).toBe(0);
  expect(replies).toHaveLength(0);
  bridge.consume({ ...request, scope: { ...scope, account: 'different-account' } });
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0]).toMatchObject({ ok: false, error: { code: 'credential-owner-unavailable' } });
  expect(lookups).toBe(0);
  bridge.close();
});

it('private bridge drops a late credential result after its Run registration is released', async () => {
  const refresh = deferred<{ auth: { apiKey: string } }>();
  const entered = deferred<void>();
  const persisted = deferred<void>();
  const replies: PrivateCredentialResponse[] = [];
  const bridge = new NativeCredentialBridge(() => 'epoch', async response => { replies.push(response); }, () => { throw new Error('unexpected transport failure'); });
  await bridge.register('run', owner({ runtime: { getAuth: async () => { entered.resolve(); const result = await refresh.promise; persisted.resolve(); return result; } } }));
  bridge.consume({ v: 1, kind: 'credential-request', id: 'request', kernelEpoch: 'epoch', runId: 'run', scope });
  await entered.promise;
  bridge.unregister('run');
  refresh.resolve({ auth: { apiKey: 'fake-late-bridge-key' } });
  await persisted.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toHaveLength(0);
});


it('trusted Bedrock model selection binds its ARN region and fake bearer through the existing owner', async () => {
  const model = { providerId: 'bedrock-fixture', modelId: 'arn:aws:bedrock:us-west-2:123456789012:inference-profile/fixture', name: 'Fixture model', api: 'bedrock-converse-stream', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', maxTokens: 128, input: ['text', 'image'] };
  const authority = createNativeModelAuthority({
    selectedModel: async (providerId, modelId) => { expect([providerId, modelId]).toEqual([model.providerId, model.modelId]); return model; },
    listModels: async () => [model], currentScope: async () => scope, currentProviderAccount: async () => undefined,
    routingEnvironment: async () => ({ AWS_REGION: 'eu-west-1' }),
    getAuth: async () => ({ auth: { apiKey: 'fake-bedrock-bearer' } }),
  });
  expect(await authority.listModels()).toContainEqual({ providerId: model.providerId, modelId: model.modelId, name: model.name, acceptsImages: true });
  const selected = await authority.resolveModel({ providerId: model.providerId, modelId: model.modelId });
  expect(selected.configuration.endpoint).toBe(`https://bedrock-runtime.us-west-2.amazonaws.com/model/${encodeURIComponent(model.modelId)}/converse-stream`);
  expect((await selected.credentialOwner.resolve(scope)).headers.authorization).toBe('Bearer fake-bedrock-bearer');
});


it.each([
  ['https://aiplatform.googleapis.com', 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-fixture:streamGenerateContent'],
  ['https://vertex.example.test/proxy/v1', 'https://vertex.example.test/proxy/v1/publishers/google/models/gemini-fixture:streamGenerateContent'],
])('Vertex Cloud API key uses the registered collection base %s', async (baseUrl, endpoint) => {
  const model = { providerId: 'vertex-fixture', modelId: 'gemini-fixture', name: 'Vertex fixture', api: 'google-vertex', baseUrl, maxTokens: 128 };
  const authority = createNativeModelAuthority({ selectedModel: async () => model, listModels: async () => [model],
    currentScope: async () => scope, currentProviderAccount: async () => undefined, routingEnvironment: async () => ({}),
    getAuth: async () => ({ auth: { apiKey: 'fake-cloud-api-key', baseUrl } }),
  });
  const selected = await authority.resolveModel({ providerId: model.providerId, modelId: model.modelId });
  expect(selected.configuration.endpoint).toBe(endpoint);
  expect((await selected.credentialOwner.resolve(scope)).headers['x-goog-api-key']).toBe('fake-cloud-api-key');
});

it('trusted header-only connection supports provider-specific authentication headers without ambient keys', async () => {
  const credential = owner({ runtime: { getAuth: async () => ({ auth: { headers: { 'x-custom-token': 'fake-custom-token' } }, source: 'configured headers' }) } });
  expect((await credential.resolve(scope)).headers).toEqual({ 'x-custom-token': 'fake-custom-token' });
  await expect(owner({ runtime: { getAuth: async () => ({ auth: { headers: {} }, source: 'configured headers' }) } }).resolve(scope)).rejects.toMatchObject({ code: 'credential-missing' });
});

it.each([
  ['', 'us-central1', 'https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/google/models/gemini-fixture:streamGenerateContent'],
  ['https://{location}-aiplatform.googleapis.com', 'global', 'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-fixture:streamGenerateContent'],
  ['https://vertex.example.test/custom/v1', 'us-central1', 'https://vertex.example.test/custom/v1/publishers/google/models/gemini-fixture:streamGenerateContent'],
])('Vertex ADC preserves its project/location routing and custom collection %s %s', async (baseUrl, location, endpoint) => {
  const model = { providerId: 'google-vertex', modelId: 'gemini-fixture', name: 'Vertex ADC fixture', api: 'google-vertex', baseUrl, maxTokens: 128 };
  const authority = createNativeModelAuthority({ selectedModel: async () => model, listModels: async () => [model],
    currentScope: async () => scope, currentProviderAccount: async () => undefined,
    routingEnvironment: async () => ({ GOOGLE_CLOUD_PROJECT: 'fixture-project', GOOGLE_CLOUD_LOCATION: location }), vertexAuthentication: async () => 'adc',
    getAuth: async () => ({ auth: { headers: { authorization: 'Bearer fake-adc-bearer' } }, source: 'Google ADC' }),
  });
  const selected = await authority.resolveModel({ providerId: model.providerId, modelId: model.modelId });
  expect(selected.configuration.endpoint).toBe(endpoint);
  expect((await selected.credentialOwner.resolve(scope)).headers.authorization).toBe('Bearer fake-adc-bearer');
});
