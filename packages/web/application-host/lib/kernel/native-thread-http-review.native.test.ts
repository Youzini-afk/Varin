import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createNativeThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeThreadAdapter } from './native-thread-adapter.js';
import { registerNativeThreadRoutes } from './native-thread-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture needs a TCP listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(hold = false) {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-http-review-'));
  const kernel = createKernelClient({ hostId: 'native-http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'fake-native-http-provider-key-not-a-real-secret';
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (bytes: Buffer) => chunks.push(bytes));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (hold && requests.length === 1) response.write(': waiting for legitimate cancellation\n\n');
      else response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `http-answer-${requests.length}`, type: 'message', content: [{ type: 'output_text', text: 'actual native HTTP answer' }] }] } })}\n\n`);
    });
  });
  const endpoint = `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const adapter = new NativeThreadAdapter(new NativeRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async () => { throw new Error('this fixture has no admitted source'); }, (_runId, error) => { launchErrors.push(error); });
  const app = express();
  app.use(express.json());
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors };
}

it('public nativeThreads HTTP client reaches the native kernel, enforces selected thread identity, and streams no credential material', async () => {
  const f = await fixture();
  expect((await fetch(`${f.hostUrl}/api/native-threads/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'unauthenticated' }) })).status).toBe(401);
  const identity = await f.api.create('http-owned-thread');
  const controller = new AbortController();
  const events: unknown[] = [];
  const observation = f.api.observe(0, event => events.push(event), { signal: controller.signal }).catch(error => { if (!controller.signal.aborted) throw error; });
  try {
    const receipt = await f.api.submit({ ...identity, key: 'http-submission', expectedHead: null, text: 'real public caller prompt', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
    expect((await f.runtime.launch(receipt.run_id))?.selection.credential_scope).toMatchObject({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 });
    await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    const snapshot = await f.api.snapshot(identity);
    expect(JSON.stringify(snapshot.history)).toContain('actual native HTTP answer');
    const other = await f.api.create('http-other-thread');
    await expect(f.api.snapshot({ ...other, branchId: identity.branchId })).rejects.toThrow();
    const durable = await f.api.events(0);
    expect(durable.some(event => event.subject === receipt.run_id)).toBe(true);
    await expect.poll(() => JSON.stringify(events).includes(receipt.run_id)).toBe(true);
    expect(JSON.stringify({ receipt, snapshot, durable, events, run: await f.api.run(receipt.run_id) })).not.toContain(f.secret);
    expect(await f.api.submit({ ...identity, key: 'http-submission', expectedHead: null, text: 'real public caller prompt', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } })).toEqual(receipt);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.authorization).toBe(`Bearer ${f.secret}`);
    expect(f.launchErrors).toEqual([]);
    expect(await f.api.create('http-owned-thread')).toEqual(identity);
  } finally { controller.abort(); await observation; }
}, 30_000);

it('public nativeThreads HTTP input editing/cancellation and Run cancellation affect the real durable execution', async () => {
  const f = await fixture(true);
  const identity = await f.api.create('http-cancel-thread');
  const receipt = await f.api.submit({ ...identity, key: 'http-held-input', expectedHead: null, text: 'hold while I decide', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(() => f.requests.length).toBe(1);
  const queued = await f.api.enqueue({ ...identity, key: 'http-queued-input', mode: 'boundary', text: 'queued user correction' });
  const edited = await f.api.editInput(queued.input_id, 1, 'revised user correction');
  expect(edited.revision).toBe(2);
  expect((await f.api.cancelInput(queued.input_id, edited.revision)).state).toBe('cancelled');
  const next = await f.api.enqueue({ ...identity, key: 'http-next-input', mode: 'next_run', text: 'continue after stopping the current Run' });
  await f.api.cancelRun(receipt.run_id);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('cancelled');
  await expect.poll(async () => (await f.api.run(next.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const snapshot = await f.api.snapshot(identity);
  expect(snapshot.inputs.find(input => input.id === queued.input_id)?.state).toBe('cancelled');
  expect(JSON.stringify(snapshot.history)).not.toContain('revised user correction');
  expect(JSON.stringify(await f.api.events(0))).not.toContain(f.secret);
  expect(f.requests).toHaveLength(2);
  expect(f.launchErrors).toEqual([]);
}, 30_000);
