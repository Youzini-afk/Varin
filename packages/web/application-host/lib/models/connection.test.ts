import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChannel, ModelConnectionOptions } from '@varin/application-client';
import { appendModelPath, modelEgressOverride, validateModelConnection } from './connection.js';
import { ModelsService } from './service.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import { requestClassifier } from './classifier.js';
import type { ClassifierApi } from './classifier-protocol.js';
import type { EgressFetch } from '../harness/egress.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(connection?: ModelConnectionOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-model-network-')); roots.push(directory);
  const models = new ModelsService(directory, { projectTrusted: () => false, fetch: async () => { throw new Error("Unexpected model fixture network request"); } });
  const channel: ModelChannel = { id: 'connection', name: 'Connection', type: 'openai-compatible', enabled: true,
    baseUrl: 'https://models.example/gateway/v1', authentication: { kind: 'none' }, parameters: {},
    ...(connection === undefined ? {} : { connection }),
    models: [{ id: 'model', name: 'Model', enabled: true, operations: ['chat', 'embedding', 'rerank', 'image-generation', 'image-editing'] }] };
  await models.save(channel, (await models.read()).revision);
  return { models, channel, directory };
}

test('custom paths append to the existing endpoint path, with escaped traversal and origin changes rejected', () => {
  expect(appendModelPath('https://models.example/gateway/v1/', '/custom/embeddings')).toBe('https://models.example/gateway/v1/custom/embeddings');
  expect(appendModelPath('https://models.example/v1', '/models/model:run')).toBe('https://models.example/v1/models/model:run');
  for (const path of ['https://other.example/run', '//other.example/run', '/a/../run', '/./run', '/%2e%2e/run', '/%252e%252e/run', '/a%2fb', '/a%5cb', '/run?key=secret', '/run#fragment', '/run%3fkey=value', '/a\\b', '/run\n', 'run', '/bad%zz']) {
    expect(() => appendModelPath('https://models.example/v1', path), path).toThrow();
  }
  for (const base of ['https://models.example/v1?key=value', 'https://models.example/v1#fragment', 'https://user:secret@models.example/v1']) expect(() => appendModelPath(base, '/run')).toThrow();
});

test('connection validation rejects stored secrets, transport overrides and ambiguous headers without echoing values', () => {
  const headers = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'api-key', 'x-goog-api-key', 'X-Auth-Token', 'X-Amz-Security-Token', 'x-fixture-session', 'Ocp-Apim-Subscription-Key'];
  for (const header of headers) {
    expect(() => validateModelConnection({ headers: { [header]: 'sensitive-value' } })).toThrow('Sensitive model headers');
    try { validateModelConnection({ headers: { [header]: 'sensitive-value' } }); } catch (error) { expect(String(error)).not.toContain('sensitive-value'); }
  }
  expect(() => validateModelConnection({ headers: { 'x-custom-account': 'secret' } }, ['chat'], 'x-custom-account')).toThrow('Sensitive model headers');
  for (const headers of [{ Host: 'other.example' }, { 'content-length': '0' }, { x: 'one', X: 'two' }, { x: 1 }, { x: 'value\r\ninjected: header' }]) expect(() => validateModelConnection({ headers })).toThrow();
  for (const proxy of [{ mode: 'proxy', url: 'https://user:secret@proxy.example' }, { mode: 'proxy', url: 'socks5://proxy.example' }, { mode: 'proxy', url: 'https://proxy.example/path' }, { mode: 'proxy', url: 'https://proxy.example?password=secret' }, { mode: 'direct', url: 'https://proxy.example' }]) expect(() => validateModelConnection({ proxy })).toThrow();
  expect(() => validateModelConnection({ paths: { chat: '/run' } }, ['embedding'])).toThrow();
  expect(() => validateModelConnection({ headers: { 'X-Request-Source': '', 'OpenAI-Organization': 'org-123', 'anthropic-version': '2023-06-01' }, proxy: { mode: 'proxy', url: 'http://127.0.0.1:8888' } })).not.toThrow();
  expect(modelEgressOverride(undefined)).toBeUndefined();
  expect(modelEgressOverride({ proxy: { mode: 'direct' } })).toEqual({ mode: 'direct' });
  expect(modelEgressOverride({ proxy: { mode: 'proxy', url: 'http://localhost:8888' } })).toEqual({ mode: 'proxy', proxyUrl: 'http://localhost:8888' });
});

test('saved channels round-trip network options and each prepared purpose keeps its original connection snapshot', async () => {
  const connection: ModelConnectionOptions = { headers: { 'X-Request-Source': 'original' }, proxy: { mode: 'proxy', url: 'http://localhost:8888' },
    paths: { chat: '/dialogue', embedding: '/vectors', rerank: '/rank', 'image-generation': '/pictures', 'image-editing': '/edits' } };
  const { models, channel } = await fixture(connection);
  expect((await models.read()).channels[0]?.connection).toEqual(connection);
  const captured = await models.captureModel(channel.id, 'model');
  const embedding = await models.resolveEmbeddingBinding(channel.id, 'model');
  const rerank = await models.resolveRerankBinding(channel.id, 'model');
  const explicit = await models.resolveRerankBinding(channel.id, 'model', '/purpose-rank');
  const generation = await models.resolveImageBinding(channel.id, 'model', 'generation');
  const editing = await models.resolveImageBinding(channel.id, 'model', 'editing');
  try {
    expect(captured.model.connection).toEqual(connection);
    expect(embedding).toMatchObject({ endpoint: '/vectors', requestUrl: 'https://models.example/gateway/v1/vectors', headers: connection.headers, egressOverride: { mode: 'proxy', proxyUrl: 'http://localhost:8888' } });
    expect(rerank.requestUrl).toBe('https://models.example/gateway/v1/rank');
    expect(explicit.requestUrl).toBe('https://models.example/gateway/v1/purpose-rank');
    expect(generation.requestUrl).toBe('https://models.example/gateway/v1/pictures');
    expect(editing.requestUrl).toBe('https://models.example/gateway/v1/edits');
    await models.save({ ...channel, connection: { headers: { 'X-Request-Source': 'replacement' }, proxy: { mode: 'direct' }, paths: { embedding: '/replacement' } } }, (await models.read()).revision);
    await embedding.assertAvailable();
    expect(embedding.headers).toEqual(connection.headers);
    expect(embedding.requestUrl).toBe('https://models.example/gateway/v1/vectors');
    expect(captured.model.connection).toEqual(connection);
    const next = await models.resolveEmbeddingBinding(channel.id, 'model');
    try { expect(next.requestUrl).toBe('https://models.example/gateway/v1/replacement'); expect(next.configurationId).not.toBe(embedding.configurationId); expect(next.egressOverride).toEqual({ mode: 'direct' }); } finally { next.release?.(); }
  } finally { captured.release(); for (const binding of [embedding, rerank, explicit, generation, editing]) binding.release?.(); }
});

test('omitted connection preserves protocol URLs and inherited Host egress, including discovery', async () => {
  const { models, channel } = await fixture();
  const embedding = await models.resolveEmbeddingBinding(channel.id, 'model');
  try {
    expect(embedding.requestUrl).toBe('https://models.example/gateway/v1/embeddings');
    expect(embedding.endpoint).toBeUndefined(); expect(embedding.egressOverride).toBeUndefined(); expect(embedding.headers).toBeUndefined();
    const fetchImpl = vi.fn<EgressFetch>(async () => Response.json({ data: [] }));
    expect(await models.discover(channel.id, fetchImpl)).toEqual({ models: [] });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://models.example/gateway/v1/models');
    expect(fetchImpl.mock.calls[0]?.[2]).toBeUndefined();
  } finally { embedding.release?.(); }
});

test('discovery passes channel routing to Host egress and merges non-sensitive headers with live credentials', async () => {
  const { models, channel } = await fixture({ proxy: { mode: 'direct' }, headers: { 'X-Request-Source': 'settings' } });
  const reference = await models.storeCredential('credential-key');
  await models.save({ ...channel, authentication: { kind: 'credential', reference } }, (await models.read()).revision);
  const before = await models.read();
  const fetchImpl: EgressFetch = async (url, init, override) => {
    expect(url).toBe('https://models.example/gateway/v1/models');
    expect(override).toEqual({ mode: 'direct' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer credential-key');
    expect(headers.get('x-request-source')).toBe('settings');
    return Response.json({ data: [{ id: 'candidate' }] });
  };
  expect(await models.discover(channel.id, fetchImpl)).toEqual({ models: [{ id: 'candidate', name: 'candidate', catalog: { source: 'service', overrides: [] } }] });
  const after = await models.read();
  expect(after.channels).toEqual(before.channels);
  expect(after.revision).toBe(before.revision);
});

test('invalid persisted network options preserve the original file and the previous accepted binding', async () => {
  const { models, channel, directory } = await fixture({ headers: { 'X-Request-Source': 'valid' } });
  const binding = await models.resolveEmbeddingBinding(channel.id, 'model');
  const raw = JSON.stringify({ channels: [{ ...channel, connection: { headers: { Authorization: 'do-not-copy' } } }] });
  await writeFile(join(directory, 'models.json'), raw);
  try {
    expect((await models.read()).issues).toMatchObject([{ channelId: channel.id, code: 'model-connection-invalid' }]);
    await binding.assertAvailable();
    expect(binding.headers).toEqual({ 'X-Request-Source': 'valid' });
    expect(await readFile(join(directory, 'models.json'), 'utf8')).toBe(raw);
  } finally { binding.release?.(); }
});

test('image model protocols override the inherited service default independently and retain their accepted route', async () => {
  const { models, channel } = await fixture({ paths: { 'image-generation': '/service-generate', 'image-editing': '/service-edit' } });
  const mixed: ModelChannel = { ...channel, parameters: { imageApi: 'openai-images' }, models: [
    { id: 'router', name: 'Router image', enabled: true, operations: ['image-generation', 'image-editing'], image: { api: 'openrouter-images', paths: { generation: '/custom/generate', editing: '/custom/edit' } } },
    { id: 'images', name: 'OpenAI image', enabled: true, operations: ['image-generation'] },
  ] };
  await models.save(mixed, (await models.read()).revision);
  const router = await models.resolveImageBinding(channel.id, 'router', 'generation');
  const editing = await models.resolveImageBinding(channel.id, 'router', 'editing');
  const images = await models.resolveImageBinding(channel.id, 'images', 'generation');
  try {
    expect(router.api).toBe('openrouter-images');
    expect(router.requestUrl).toBe(`${channel.baseUrl}/custom/generate`);
    expect(editing.requestUrl).toBe(`${channel.baseUrl}/custom/edit`);
    expect(images.api).toBe('openai-images');
    expect(images.requestUrl).toBe(`${channel.baseUrl}/service-generate`);
    expect((await models.listImageModels()).map(model => model.api)).toEqual(['openrouter-images', 'openai-images']);
    await models.save({ ...mixed, models: [{ ...mixed.models[0]!, image: { api: 'openai-images' } }, mixed.models[1]!] }, (await models.read()).revision);
    expect(router.api).toBe('openrouter-images');
    expect(router.requestUrl).toBe(`${channel.baseUrl}/custom/generate`);
    expect(() => models.validate({ ...mixed, models: [{ ...mixed.models[0]!, image: { api: 'unknown' } }] })).toThrow('Image capabilities');
  } finally { router.release?.(); editing.release?.(); images.release?.(); }
});

test.each(['embedding', 'rerank', 'decision'] as const)('%s context capacity is saved and frozen in its original binding', async operation => {
  const { models, channel } = await fixture();
  const configured: ModelChannel = { ...channel, models: [{ id: 'model', name: 'Model', enabled: true, operations: [operation], contextWindow: 32768 }] };
  await models.save(configured, (await models.read()).revision);
  const resolve = () => operation === 'embedding' ? models.resolveEmbeddingBinding(channel.id, 'model')
    : operation === 'rerank' ? models.resolveRerankBinding(channel.id, 'model') : models.resolveDecisionBinding(channel.id, 'model');
  const binding = await resolve();
  try {
    expect(binding.contextWindow).toBe(32768);
    expect((await models.read()).channels[0]?.models[0]?.contextWindow).toBe(32768);
    await models.save({ ...configured, models: [{ ...configured.models[0]!, contextWindow: 65536 }] }, (await models.read()).revision);
    const next = await resolve();
    try { expect(next.contextWindow).toBe(65536); expect(next.configurationId).not.toBe(binding.configurationId); }
    finally { next.release?.(); }
    expect(binding.contextWindow).toBe(32768);
  } finally { binding.release?.(); }
});

test.each(['openai-compatible', 'local'])('%s services route each decision model through its selected protocol alongside chat models', async type => {
  const { models, channel } = await fixture();
  const mixed: ModelChannel = { ...channel, type, parameters: { decisionApi: 'cloudflare-workers-ai-system-one' }, models: [{ ...channel.models[0]!, operations: ['chat'] },
    { id: 'decision', requestModelId: 'jev-latest', name: 'Decision', enabled: true, operations: ['decision'], decision: { api: 'typesafe-system-one', paths: { classify: '/custom/systemone' } } },
    { id: 'inherited', name: 'Inherited', enabled: true, operations: ['decision'] }] };
  await models.save(mixed, (await models.read()).revision);
  const binding = await models.resolveDecisionBinding(channel.id, 'decision');
  const inherited = await models.resolveDecisionBinding(channel.id, 'inherited');
  const chat = await createModelAuthority(models).resolveModel({ providerId: channel.id, modelId: 'model' });
  try {
    expect(binding.api).toBe('typesafe-system-one');
    expect(binding.requestUrl).toBe(`${channel.baseUrl}/custom/systemone`);
    expect(inherited.api).toBe('cloudflare-workers-ai-system-one');
    expect(inherited.requestUrl).toBe(`${channel.baseUrl}/run`);
    expect(chat.configuration.endpoint).toBe(`${channel.baseUrl}/chat/completions`);
    await models.save({ ...mixed, models: mixed.models.map(model => model.id === 'decision' ? { ...model, decision: { api: 'cloudflare-workers-ai-system-one' } } : model) }, (await models.read()).revision);
    const replacement = await models.resolveDecisionBinding(channel.id, 'decision');
    try {
      expect(replacement.api).toBe('cloudflare-workers-ai-system-one');
      expect(replacement.requestUrl).toBe(`${channel.baseUrl}/run`);
      expect(replacement.configurationId).not.toBe(binding.configurationId);
    } finally { replacement.release?.(); }
    expect(binding.api).toBe('typesafe-system-one');
    expect(binding.requestUrl).toBe(`${channel.baseUrl}/custom/systemone`);
    const result = await requestClassifier({ baseUrl: binding.baseUrl, model: binding.requestModelId!, ...(binding.decisionPaths ? { paths: binding.decisionPaths } : {}),
      nativeModel: { api: binding.api as ClassifierApi, id: binding.requestModelId!, baseUrl: binding.baseUrl },
      state: { goal: 'Find relevant evidence' },
      questions: [{ id: 'relevant', kind: 'score', instructions: 'Evaluate relevance', levels: ['irrelevant', 'relevant'] }],
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(binding.requestUrl);
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-latest', questions: { relevant: { type: 'score' } } });
        return Response.json({ answers: { relevant: { type: 'score', score: 1 } } });
      } });
    expect(result).toMatchObject({ answers: [{ id: 'relevant', kind: 'score', score: 1 }], missing: [] });
  } finally { binding.release?.(); inherited.release?.(); chat.credentialOwner.release(); }
});

test.each(['llama-cpp-classify', 'openai-compatible'])('%s cannot misrepresent multi-route llama.cpp classification as a single endpoint', async type => {
  const { models, channel } = await fixture();
  const classifier: ModelChannel = { ...channel, type,
    models: [{ id: 'model', name: 'Model', enabled: true, operations: ['decision'], decision: {
      ...(type === 'openai-compatible' ? { api: 'llama-cpp-classify' as const } : {}),
      paths: { tokenize: '/custom/tokenize', applyTemplate: '/custom/template', completion: '/custom/complete' } } }] };
  await expect(models.save({ ...classifier, connection: { paths: { decision: '/run' } } }, (await models.read()).revision)).rejects.toMatchObject({ code: 'model-connection-invalid' });
  await models.save({ ...classifier, connection: { proxy: { mode: 'direct' } } }, (await models.read()).revision);
  const binding = await models.resolveDecisionBinding(channel.id, 'model');
  try {
    expect(binding.routes.map(route => route.requestUrl)).toEqual(['https://models.example/gateway/custom/tokenize', 'https://models.example/gateway/custom/template', 'https://models.example/gateway/custom/complete']);
    expect(binding.egressOverride).toEqual({ mode: 'direct' });
  } finally { binding.release?.(); }
  await expect(models.resolveDecisionBinding(channel.id, 'model', '/run')).rejects.toThrow('single endpoint override');
});

test.each(['image', 'decision'] as const)('%s model paths validate before saving and preserve saved models on malformed edits', async kind => {
  const { models, channel } = await fixture();
  const baseModel = { id: 'custom', name: 'Custom', enabled: true, operations: [kind === 'image' ? 'image-generation' as const : 'decision' as const] };
  for (const path of ['https://other.example/run', '/../run', '/%2e%2e/run', '/run?key=value', '', 1]) {
    const configuration = kind === 'image' ? { image: { paths: { generation: path } } } : { decision: { paths: { classify: path } } };
    await expect(models.save({ ...channel, models: [{ ...baseModel, ...configuration }] } as ModelChannel, (await models.read()).revision)).rejects.toMatchObject({ code: 'model-connection-invalid' });
  }
  expect((await models.read()).channels[0]?.models).toEqual(channel.models);
});

test('a System One model can override an inherited llama.cpp default and invalid model classifier settings are rejected', async () => {
  const { models, channel } = await fixture();
  const model: ModelChannel['models'][number] = { id: 'model', name: 'Model', enabled: true, operations: ['decision'], decision: { api: 'typesafe-system-one' } };
  const configured: ModelChannel = { ...channel, parameters: { decisionApi: 'llama-cpp-classify' }, connection: { paths: { decision: '/custom-systemone' } }, models: [model] };
  await models.save(configured, (await models.read()).revision);
  const binding = await models.resolveDecisionBinding(channel.id, 'model');
  try {
    expect(binding.api).toBe('typesafe-system-one');
    expect(binding.requestUrl).toBe(`${channel.baseUrl}/custom-systemone`);
    for (const decision of [{ api: 'unknown' }, { api: 1 }, { api: null }, { endpoint: '/custom' }, []]) {
      expect(() => models.validate({ ...configured, models: [{ ...model, decision }] })).toThrow('Decision capabilities');
    }
    expect(() => models.validate({ ...configured, models: [{ ...model, operations: ['chat'] }] })).toThrow('Decision capabilities');
  } finally { binding.release?.(); }
});


test('chat projects frozen non-sensitive HTTP options and a custom path into the native model configuration', async () => {
  const { models, channel } = await fixture({ headers: { 'X-Request-Source': 'original' }, paths: { chat: '/dialogue' }, proxy: { mode: 'direct' } });
  const authority = createModelAuthority(models);
  const original = await authority.resolveModel({ providerId: channel.id, modelId: 'model' });
  try {
    expect(original.configuration.endpoint).toBe('https://models.example/gateway/v1/dialogue');
    expect(original.configuration.connection).toEqual({ headers: { 'X-Request-Source': 'original' }, proxy: { mode: 'direct' } });
    await models.save({ ...channel, connection: { headers: { 'X-Request-Source': 'next' }, paths: { chat: '/next' } } }, (await models.read()).revision);
    expect(original.configuration.endpoint).toBe('https://models.example/gateway/v1/dialogue');
    expect(original.configuration.connection?.headers).toEqual({ 'X-Request-Source': 'original' });
    const next = await authority.resolveModel({ providerId: channel.id, modelId: 'model' });
    try { expect(next.configuration.endpoint).toBe('https://models.example/gateway/v1/next'); expect(next.configuration.configurationGeneration).not.toBe(original.configuration.configurationGeneration); } finally { next.credentialOwner.release(); }
  } finally { original.credentialOwner.release(); }
});

test('Azure custom paths keep deployment and API-version protocol parameters', async () => {
  const { models, channel } = await fixture();
  const reference = await models.storeCredential('azure-key');
  await models.save({ ...channel, type: 'azure', authentication: { kind: 'credential', reference },
    parameters: { deployment: 'original-deployment', apiVersion: '2026-01-01' }, connection: { paths: { chat: '/custom/responses' } },
    models: [{ id: 'model', name: 'Model', enabled: true, operations: ['chat'] }] }, (await models.read()).revision);
  const selected = await createModelAuthority(models).resolveModel({ providerId: channel.id, modelId: 'model' });
  try {
    expect(selected.configuration.endpoint).toBe('https://models.example/gateway/v1/custom/responses');
    expect(selected.configuration.azureDeployment).toBe('original-deployment');
    expect(selected.configuration.azureApiVersion).toBe('2026-01-01');
  } finally { selected.credentialOwner.release(); }
});
