import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsService } from './service.js';
import { CredentialService, fileSecretStore, type AccountCredential } from './credentials.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelChannel } from '@varin/application-client';
import { createModelConnectionsHttpAPI, createMcpConnectionsHttpAPI, configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@varin/application-client';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { registerModelRoutes } from './routes.js';
import { McpAuthority } from '../mcp/authority.js';
import { createMcpSettings } from '../mcp/settings.js';

const fixtures: string[] = [];
afterEach(async () => { for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-model-services-')); fixtures.push(directory);
  return { directory, models: new ModelsService(directory, { projectTrusted: () => false }) };
}
const channel = (id = 'local-one'): ModelChannel => ({ id, name: id, type: 'local', enabled: true, baseUrl: 'http://localhost:1234/v1',
  authentication: { kind: 'none' }, parameters: {}, models: [{ id: 'chat', name: 'Chat', enabled: true, operations: ['chat'], maxOutputTokens: 4096, contextWindow: 32768 }] });

test('settings HTTP clients edit model channels and MCP sources through the production JSON boundary without a Pi worker', async () => {
  const { directory, models } = await fixture();
  const authority = new McpAuthority();
  const mcp = createMcpSettings({ authority, changed() {}, resolveScope: async () => ({ resourceOwner: { kind: 'local' }, agentDir: directory,
    configCwd: directory, executionCwd: directory, environmentId: 'fixture', executionScope: 'global', projectTrusted: false, sessionId: 'settings' }) });
  const app = express(); registerCommonRequestMiddleware(app, { express });
  const auth: express.RequestHandler = (_request, _response, next) => next();
  registerModelRoutes(app, models, auth, globalThis.fetch); mcp.register(app, auth);
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previous = getRuntimeUrlResolver();
  const address = server.address() as { port: number };
  configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const modelClient = createModelConnectionsHttpAPI(), mcpClient = createMcpConnectionsHttpAPI();
    const initial = await modelClient.read();
    expect((await modelClient.save(channel(), initial.revision)).channels).toHaveLength(1);
    const view = await mcpClient.open(), file = await mcpClient.readDocument(view.view, view.sources[0]!.path);
    const saved = await mcpClient.saveDocument(view.view, file.path, '{"mcpServers":{"local":{"command":"fixture","enabled":false}}}', file.revision);
    expect(saved.exists).toBe(true);
    expect((await mcpClient.read(view.view)).servers).toMatchObject([{ name: 'local', status: 'disabled', canSignIn: false }]);
    await mcpClient.close(view.view);
    expect(await readdir(directory)).not.toContain('model-auth.json');
    expect(await readdir(directory)).not.toContain('mcp-auth.json');
  } finally {
    setRuntimeUrlResolver(previous); mcp.close(); await authority.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('credential reads leave no files and the selected file serializes writes without rewriting unchanged values', async () => {
  const { directory } = await fixture();
  const store = fileSecretStore(join(directory, 'auth.json'));
  expect(await store.read('missing')).toBeNull();
  expect(await readdir(directory)).toEqual([]);
  await Promise.all([store.modify('one', () => '{"key":"one"}'), store.modify('two', () => '{"key":"two"}')]);
  const original = await stat(join(directory, 'auth.json'));
  await store.modify('one', value => value);
  expect((await stat(join(directory, 'auth.json'))).mtimeMs).toBe(original.mtimeMs);
  expect(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))).toEqual({ one: { key: 'one' }, two: { key: 'two' } });
  expect(await readdir(directory)).toEqual(['auth.json']);
});

test('Host channels bind independently to Rust model configuration and anonymous authentication', async () => {
  const { models } = await fixture();
  let snapshot = await models.save(channel(), (await models.read()).revision);
  const second = channel('local-two'); second.baseUrl = 'http://localhost:4321/v1';
  snapshot = await models.save(second, snapshot.revision);
  expect((await models.listModels()).map(model => model.providerId)).toEqual(['local-one', 'local-two']);
  const authority = createModelAuthority(models);
  const accepted = await authority.resolveModel({ providerId: 'local-one', modelId: 'chat' });
  expect(accepted.configuration.endpoint).toBe('http://localhost:1234/v1/chat/completions');
  const scope = await accepted.credentialOwner.scope();
  expect((await accepted.credentialOwner.resolve(scope)).headers).toEqual({});
  const edited = channel(); edited.baseUrl = 'http://localhost:9999/v1';
  await models.save(edited, snapshot.revision);
  expect(accepted.configuration.endpoint).toBe('http://localhost:1234/v1/chat/completions');
  const restored = await authority.rebindModel(accepted.configuration, scope);
  try {
    expect((await restored.resolve(scope)).headers).toEqual({});
    expect(accepted.configuration.endpoint).toBe('http://localhost:1234/v1/chat/completions');
  } finally { restored.release(); accepted.credentialOwner.release(); }
});

test('one invalid channel stays visible as an issue, leaves independent channels usable and never rewrites the source', async () => {
  const { models, directory } = await fixture();
  await models.save(channel(), (await models.read()).revision);
  const binding = await models.selectedModel('local-one', 'chat');
  const raw = JSON.stringify({ channels: [channel(), { ...channel('broken'), parameters: { unknown: true } }] });
  await writeFile(join(directory, 'models.json'), raw);
  const snapshot = await models.read();
  expect(snapshot.channels.map(channel => channel.id)).toEqual(['local-one']);
  expect(snapshot.issues?.[0]?.channelId).toBe('broken');
  expect(await models.selectedModel('local-one', 'chat')).toEqual(binding);
  expect(await readFile(join(directory, 'models.json'), 'utf8')).toBe(raw);
  await writeFile(join(directory, 'models.json'), '{broken');
  await expect(models.read()).rejects.toThrow();
  expect(await readFile(join(directory, 'models.json'), 'utf8')).toBe('{broken');
});

test('discovery returns candidates without changing configured models or their revision', async () => {
  const { models } = await fixture();
  const reference = await models.credentials.put('test-key');
  const configured = { ...channel(), type: 'openai-compatible', authentication: { kind: 'credential' as const, reference } };
  const saved = await models.save(configured, (await models.read()).revision);
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('http://localhost:1234/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    return Response.json({ data: [{ id: 'candidate' }] });
  };
  expect(await models.discover(configured.id, fetchImpl)).toEqual({ models: [{ id: 'candidate', name: 'candidate' }] });
  expect(await models.read()).toEqual(saved);
});

test('settings CAS keeps concurrent edits and validates before writing without a Pi worker', async () => {
  const { models } = await fixture();
  const original = await models.settings.snapshot();
  const saved = await models.settings.update({ scope: 'global', expectedRevision: original.globalRevision, set: { harness: { images: { generation: { providerId: 'one', modelId: 'image' } } } }, remove: [] });
  await expect(models.settings.update({ scope: 'global', expectedRevision: original.globalRevision, set: { harness: {} }, remove: [] })).rejects.toMatchObject({ code: 'config_conflict' });
  await expect(models.settings.update({ scope: 'global', expectedRevision: saved.globalRevision, set: { harness: { images: { generation: { modelId: 'missing-provider' } } } }, remove: [] })).rejects.toThrow();
  expect(await models.settings.snapshot()).toEqual(saved);
  await expect(readFile(models.credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('OAuth refresh belongs to the account, survives a cancelled waiter and cannot overwrite a relink', async () => {
  const { directory } = await fixture();
  const store = fileSecretStore(join(directory, 'auth.json'));
  const credentials = new CredentialService('test', store);
  let finish!: (value: Extract<AccountCredential['value'], { kind: 'oauth' }>) => void;
  let calls = 0;
  credentials.registerOAuth('test', { refresh: async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, headers: value => ({ authorization: `Bearer ${value.accessToken}` }) });
  const value = { kind: 'oauth' as const, provider: 'test', accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
  const reference = await credentials.linkOAuth(value);
  const source = { kind: 'credential' as const, reference };
  const cancel = new AbortController();
  const first = credentials.resolve(source, 'channel', cancel.signal);
  const second = credentials.resolve(source, 'channel');
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  cancel.abort(); await expect(first).rejects.toThrow();
  finish({ ...value, accessToken: 'fresh', expiresAt: Date.now() + 3600000 });
  expect((await second).auth.headers?.authorization).toBe('Bearer fresh');
  expect(calls).toBe(1);
  await credentials.linkOAuth(value, reference);
  finish = undefined as unknown as typeof finish;
  const refresh = credentials.resolve(source, 'channel');
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  await credentials.put('replacement', reference);
  finish({ ...value, accessToken: 'stale' });
  await expect(refresh).rejects.toMatchObject({ code: 'credential-scope-changed' });
  expect((await credentials.resolve(source, 'channel')).auth.apiKey).toBe('replacement');
});
