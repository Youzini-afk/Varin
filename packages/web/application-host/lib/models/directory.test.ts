import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsService } from './service.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelChannel } from '@varin/application-client';
import { CHANNEL_DIRECTORY_URL } from './channel-directory.js';

const directories: string[] = [];
const unexpected: typeof fetch = async () => { throw new Error('Unexpected network'); };
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-directory-')); directories.push(directory);
  return new ModelsService(directory, { projectTrusted: () => false, fetch: unexpected });
}

test('offline catalogs populate mixed protocol services while initial settings remain lightweight', async () => {
  const models = await fixture();
  const snapshot = await models.read();
  expect(snapshot.types.every(type => type.catalog === undefined)).toBe(true);
  const openai = await models.directorySnapshot('openai');
  expect(openai.models.filter(model => model.operations.includes('chat')).map(model => model.id)).not.toContain('text-embedding-3-small');
  const catalog = await models.directorySnapshot('opencode-go');
  const claude = catalog.models.find(model => model.protocol === 'anthropic-messages')!;
  const google = catalog.models.find(model => model.protocol === 'google-generative-ai')!;
  expect(claude.maxOutputTokens).toBeGreaterThan(0);
  for (const model of [claude, google]) {
    const channel: ModelChannel = { id: 'go', type: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/inference/go', enabled: true,
      authentication: { kind: 'none' }, parameters: {}, models: [{ ...model, enabled: true }] };
    const resolved = await createModelAuthority(models).resolveCaptured(await models.captureDraftModel({ channel }, model.id), { providerId: 'go', modelId: model.id });
    try {
      expect(resolved.configuration.modelOptions).toMatchObject({ requestProfile: 'opencode' });
      expect(resolved.configuration.endpoint).toContain(model === claude ? '/go/anthropic/v1/messages' : '/go/google/v1beta/models/');
      expect(resolved.configuration.connection?.headers).toBeUndefined();
    } finally { resolved.credentialOwner.release(); }
  }
  const command = await models.directorySnapshot('commandcode');
  expect(command.models.find(model => model.id === 'claude-sonnet-5-5')?.protocol).toBe('anthropic-messages');
});

test('refresh never blocks model capture, preserves explicit fields and accepted bindings, and reloads cached data with ETag', async () => {
  const models = await fixture();
  const preset = (await models.directorySnapshot('deepseek')).models.find(model => model.id === 'deepseek-flash')!;
  const channel: ModelChannel = { id: 'deepseek', type: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', enabled: true, authentication: { kind: 'none' }, parameters: {},
    models: [{ ...preset, enabled: true, maxOutputTokens: 7777, catalog: { overrides: ['maxOutputTokens'] } }] };
  await models.save(channel, (await models.read()).revision);
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const stop = models.modelDirectory.start(async url => String(url) === CHANNEL_DIRECTORY_URL ? Response.json({ version: 1, channels: [{ id: 'example-vendor', name: 'Example Vendor', kind: 'model-vendor', protocol: 'openai-completions', baseUrl: 'https://example.test/v1' }] }, { headers: { etag: '"channels-v1"' } }) : pending);
  const refresh = models.modelDirectory.refresh();
  const captured = await models.captureModel(channel.id, preset.id);
  expect(captured.model.contextWindow).toBe(preset.contextWindow);
  const oldContext = captured.model.contextWindow;
  finish(Response.json({ deepseek: { npm: '@ai-sdk/openai-compatible', models: {
    'deepseek-flash': { name: 'Updated model', modalities: { input: ['text'], output: ['text'] }, limit: { context: 222222, output: 4444 }, reasoning: false },
  } } }, { headers: { etag: '"directory-v2"' } }));
  try { await refresh; } finally { stop(); captured.release(); }
  const next = (await models.read()).channels[0]!.models[0]!;
  expect(next).toMatchObject({ name: 'Updated model', contextWindow: 222222, maxOutputTokens: 7777, input: ['text'] });
  expect(next.thinking).toBeUndefined();
  expect((await models.read()).types.some(type => type.id === 'example-vendor')).toBe(true);
  expect(captured.model.contextWindow).toBe(oldContext);
  const stored = JSON.parse(await readFile(join(models.directory, 'models.json'), 'utf8'));
  expect(stored.channels[0].models[0].contextWindow).toBe(preset.contextWindow);
  const restarted = new ModelsService(models.directory, { projectTrusted: () => false, fetch: unexpected });
  expect((await restarted.read()).channels[0]?.models[0]?.contextWindow).toBe(222222);
  let checks = 0;
  const stopAgain = restarted.modelDirectory.start(async (_url, init) => {
    checks += 1;
    expect(new Headers(init?.headers).get('if-none-match')).toBe(String(_url) === CHANNEL_DIRECTORY_URL ? '"channels-v1"' : '"directory-v2"');
    return new Response(null, { status: 304 });
  });
  try { await restarted.modelDirectory.refresh(); await restarted.modelDirectory.refresh(true); } finally { stopAgain(); }
  expect(checks).toBe(2);
  expect((await restarted.read()).channels[0]?.models[0]?.maxOutputTokens).toBe(7777);
});

test('account discovery stays scoped to its actual connection and account without rewriting user models', async () => {
  const models = await fixture();
  const reference = await models.storeCredential('account-one');
  const channel: ModelChannel = { id: 'account', name: 'Account', type: 'openai-compatible', enabled: true, baseUrl: 'https://account.example/v1', authentication: { kind: 'credential', reference }, parameters: {}, models: [] };
  const saved = await models.save(channel, (await models.read()).revision);
  await models.discover(channel.id, async () => Response.json({ data: [{ id: 'account-model' }] }));
  expect((await models.directorySnapshot(channel.type, channel.id)).models.map(model => model.id)).toEqual(['account-model']);
  expect((await models.read()).revision).toBe(saved.revision);
  await models.storeCredential('account-two', reference);
  expect((await models.directorySnapshot(channel.type, channel.id)).models).toEqual([]);
});

test('custom channels fill metadata for decorated upstream IDs without changing user fields or the request route', async () => {
  const models = await fixture();
  const preset = (await models.directorySnapshot('deepseek')).models.find(model => model.id === 'deepseek-flash')!;
  const model = { id: 'local-alias', requestModelId: 'team/DEEPSEEK-FLASH-fast', name: 'My model', enabled: true, operations: ['chat' as const], contextWindow: 22222 };
  const channel: ModelChannel = { id: 'custom', name: 'Custom', type: 'openai-compatible', enabled: true, baseUrl: 'https://relay.example/v1',
    authentication: { kind: 'none' }, parameters: {}, models: [model] };
  await models.save(channel, (await models.read()).revision);
  const captured = await models.captureModel(channel.id, model.id);
  try {
    expect(captured.model).toMatchObject({ requestModelId: model.requestModelId, contextWindow: 22222, maxTokens: preset.maxOutputTokens,
      api: 'openai-completions', baseUrl: channel.baseUrl, thinking: preset.thinking });
  } finally { captured.release(); }
  const lookup = await models.directorySnapshot(channel.type, channel.id, [model]);
  expect(lookup.models.find(value => value.id === model.id)).toMatchObject({ id: model.id, requestModelId: model.requestModelId, contextWindow: preset.contextWindow });
  const stored = JSON.parse(await readFile(join(models.directory, 'models.json'), 'utf8'));
  expect(stored.channels[0].models[0]).toEqual(model);
});

test('discovered IDs inherit refreshed metadata while the account cache retains only facts the service actually supplied', async () => {
  const models = await fixture();
  const id = 'relay/DEEPSEEK-FLASH-fast';
  const channel: ModelChannel = { id: 'custom', name: 'Custom', type: 'openai-compatible', enabled: true, baseUrl: 'https://relay.example/v1',
    authentication: { kind: 'none' }, parameters: {}, models: [] };
  await models.save(channel, (await models.read()).revision);
  const discovered = await models.discover(channel.id, async () => Response.json({ data: [{ id }] }));
  expect(discovered.models[0]?.contextWindow).toBeGreaterThan(0);
  channel.models = [{ ...discovered.models[0]!, enabled: true, operations: ['chat'] }];
  await models.save(channel, (await models.read()).revision);
  const stop = models.modelDirectory.start(async url => String(url) === CHANNEL_DIRECTORY_URL ? new Response(null, { status: 503 }) : Response.json({ deepseek: { npm: '@ai-sdk/openai-compatible', models: {
    'deepseek-flash': { modalities: { input: ['text'], output: ['text'] }, limit: { context: 345678, output: 45678 }, reasoning: false },
  } } }));
  try { await models.modelDirectory.refresh(); } finally { stop(); }
  const updated = (await models.read()).channels[0]!.models[0]!;
  expect(updated).toMatchObject({ id, contextWindow: 345678, maxOutputTokens: 45678, reasoning: false });
  expect(updated.thinking).toBeUndefined();
  const cache = JSON.parse(await readFile(join(models.directory, 'model-directory.json'), 'utf8'));
  expect(cache.connections.custom.models[0].contextWindow).toBeUndefined();
});
