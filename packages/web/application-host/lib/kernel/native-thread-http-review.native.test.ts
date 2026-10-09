import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
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
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

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
async function fixture(hold = false, acceptsImages?: boolean, existingRoot?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-http-review-'));
  const kernel = createKernelClient({ hostId: 'native-http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
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
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64, ...(acceptsImages === undefined ? {} : { acceptsImages }) };
  const launchErrors: unknown[] = [];
  const adapter = new NativeThreadAdapter(new NativeRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async () => { throw new Error('this fixture has no admitted source'); }, (_runId, error) => { launchErrors.push(error); });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
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
  const queued = await f.api.enqueue({ ...identity, key: 'http-queued-input', mode: 'boundary', text: 'queued user correction', images: [imageFixture] });
  const edited = await f.api.editInput(queued.input_id, 1, 'revised user correction');
  expect(edited.revision).toBe(2);
  expect(JSON.stringify(edited.content)).toContain(imageFixture.data);
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


const imageFixture = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=' };
it('production native HTTP image-only input reaches provider image content and survives a kernel reopen', async () => {
  const f = await fixture(false, true);
  const identity = await f.api.create('http-image-thread');
  const receipt = await f.api.submit({ ...identity, key: 'http-image-input', expectedHead: null, text: '', images: [imageFixture], model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const imageUrl = `data:${imageFixture.mimeType};base64,${imageFixture.data}`;
  expect(JSON.stringify(f.requests[0]?.body.input)).toContain('input_image');
  expect(JSON.stringify(f.requests[0]?.body.input)).toContain(imageUrl);
  expect(JSON.stringify((await f.api.snapshot(identity)).history)).toContain(imageUrl);
  await f.closeKernel();
  const reopened = await fixture(false, true, f.root);
  expect(JSON.stringify((await reopened.api.snapshot(identity)).history)).toContain(imageUrl);
  expect(reopened.requests).toHaveLength(0);
}, 30_000);

it('production native HTTP rejects image input for a text-only model before durable admission', async () => {
  const f = await fixture(false, false);
  const identity = await f.api.create('http-text-only-thread');
  await expect(f.api.submit({ ...identity, key: 'http-unsupported-image', expectedHead: null, text: '', images: [imageFixture], model: { providerId: 'fixture-provider', modelId: 'fixture-model' } })).rejects.toThrow();
  expect((await f.api.snapshot(identity)).history).toEqual([]);
  expect(f.requests).toHaveLength(0);
}, 30_000);

it('an image exceeding the existing kernel frame limit leaves unrelated execution alive and is not admitted', async () => {
  const f = await fixture(true, true);
  const active = await f.api.create('http-large-image-active');
  const activeRun = await f.api.submit({ ...active, key: 'active-before-large-image', expectedHead: null, text: 'keep running', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(() => f.requests.length).toBe(1);
  const before = await f.runtime.status();
  const target = await f.api.create('http-large-image-target');
  const image = { mimeType: 'image/png', data: 'A'.repeat(17 * 1024 * 1024) };
  await expect(f.api.submit({ ...target, key: 'too-large-image', expectedHead: null, text: '', images: [image], model: { providerId: 'fixture-provider', modelId: 'fixture-model' } })).rejects.toMatchObject({ code: 'kernel-frame-too-large' });
  expect((await f.runtime.status()).epoch).toBe(before.epoch);
  expect((await f.api.run(activeRun.run_id)).state).toBe('generating');
  expect((await f.api.snapshot(target)).history).toEqual([]);
  expect(f.requests).toHaveLength(1);
  await f.api.cancelRun(activeRun.run_id);
}, 30_000);


function largePngFixture() {
  const image = Buffer.from(imageFixture.data, 'base64');
  const payload = Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(4 * 1024 * 1024, 'p')]);
  const type = Buffer.from('tEXt');
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return { mimeType: 'image/png', data: Buffer.concat([image.subarray(0, -12), length, type, payload, checksum, image.subarray(-12)]).toString('base64') };
}
function inlineImages(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('data:image/') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(inlineImages);
  if (value && typeof value === 'object') return Object.values(value).flatMap(inlineImages);
  return [];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

it('public history hydrates accumulated images larger than one kernel frame without losing bytes or the kernel epoch', async () => {
  const f = await fixture(false, true);
  const identity = await f.api.create('http-large-history');
  const before = await f.runtime.status();
  const image = largePngFixture();
  const captions = Array.from({ length: 3 }, (_, index) => `图像第 ${index} 轮 🧪 café résumé`);
  let head: string | null = null;
  let snapshot: Awaited<ReturnType<typeof f.api.snapshot>> | undefined;
  for (let index = 0; index < 3; index++) {
    const receipt = await f.api.submit({ ...identity, key: `large-history-${index}`, expectedHead: head, text: captions[index]!, images: [image], model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
    await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
    snapshot = await f.api.snapshot(identity);
    head = snapshot.thread.branches.find(branch => branch.branch_id === identity.branchId)!.head;
  }
  expect(Buffer.byteLength(JSON.stringify(snapshot!.history))).toBeGreaterThan(16 * 1024 * 1024);
  const expected = digest(`data:${image.mimeType};base64,${image.data}`);
  expect(inlineImages(snapshot!.history).map(digest)).toEqual([expected, expected, expected]);
  expect(snapshot!.history.filter(item => item.source === 'user').map(item => (item.content as { text: string }).text)).toEqual(captions);
  expect(inlineImages(f.requests.at(-1)!.body.input).map(digest)).toEqual([expected, expected, expected]);
  expect((await f.runtime.status()).epoch).toBe(before.epoch);
}, 60_000);

it('load-earlier HTTP history keeps its pinned head while newer conversation turns arrive', async () => {
  const f = await fixture(false, true);
  const identity = await f.api.create('http-pinned-history');
  let head: string | null = null;
  for (let index = 0; index < 12; index++) {
    const receipt = await f.api.submit({ ...identity, key: `paged-history-${index}`, expectedHead: head, text: `paged turn ${index}`, ...(index === 0 ? { images: [imageFixture] } : {}), model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
    await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
    head = (await f.runtime.thread(identity.threadId)).branches.find(branch => branch.branch_id === identity.branchId)!.head;
  }
  const pinned = await f.api.snapshot(identity);
  expect(pinned.history).toHaveLength(20);
  expect(pinned.historyPage.head).toBe(head);
  expect(pinned.historyPage.previous).toBeTruthy();
  const newest = await f.api.submit({ ...identity, key: 'after-pinned-window', expectedHead: head, text: 'new turn after history was pinned', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.run(newest.run_id)).state).toBe('completed');
  const earlier = await f.api.historyPage(identity, { headId: pinned.historyPage.head!, beforeId: pinned.historyPage.previous! });
  expect(earlier.head).toBe(pinned.historyPage.head);
  expect(earlier.previous).toBeNull();
  const combined = [...earlier.items, ...pinned.history];
  expect(combined).toHaveLength(24);
  expect(new Set(combined.map(item => item.id)).size).toBe(24);
  expect(combined.at(-1)!.id).toBe(pinned.historyPage.head);
  expect(JSON.stringify(combined)).not.toContain('new turn after history was pinned');
  expect(inlineImages(earlier.items)).toContain(`data:${imageFixture.mimeType};base64,${imageFixture.data}`);
  const live = await f.api.snapshot(identity);
  expect(live.historyPage.head).not.toBe(pinned.historyPage.head);
  // A valid record can still be an invalid cursor for this immutable view.
  await expect(f.api.historyPage(identity, { headId: pinned.historyPage.head!, beforeId: live.historyPage.head! })).rejects.toMatchObject({ status: 409, code: 'native-thread-conflict' });
  const unrelated = await f.api.create('http-unrelated-history');
  await expect(f.api.historyPage(unrelated, { headId: pinned.historyPage.head!, beforeId: pinned.historyPage.previous! })).rejects.toMatchObject({ status: 409, code: 'native-thread-conflict' });
  await expect(f.api.historyPage({ ...identity, branchId: unrelated.branchId }, { headId: pinned.historyPage.head!, beforeId: pinned.historyPage.previous! })).rejects.toMatchObject({ status: 400 });
}, 45_000);

it('forks an immutable prefix, executes independently, and retries without rewinding the new branch', async () => {
  const f = await fixture();
  const original = await f.api.create('http-fork-source');
  const first = await f.api.submit({ ...original, key: 'fork-source-input', expectedHead: null, text: 'shared source question', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const source = await f.api.snapshot(original);
  const unrelated = await f.api.create('http-fork-unrelated');
  await expect(f.api.fork({ ...original, branchId: unrelated.branchId, key: 'mismatched-fork', headId: null })).rejects.toMatchObject({ status: 400 });
  expect((await f.api.list()).flatMap(thread => thread.branches)).toHaveLength(2);
  const cut = source.history[0]!.id;
  const request = { ...original, key: 'stable-fork-request', headId: cut };
  const branch = await f.api.fork(request);
  expect(branch.threadId).toBe(original.threadId);
  expect(branch.branchId).not.toBe(original.branchId);
  const forked = await f.api.snapshot(branch);
  expect(forked.history.map(item => item.id)).toEqual([cut]);
  expect(forked.activeRun).toBeNull();
  expect(forked.launch).toBeNull();
  const next = await f.api.submit({ ...branch, key: 'fork-only-input', expectedHead: cut, text: 'new branch question', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.run(next.run_id)).state).toBe('completed');
  const advanced = await f.api.snapshot(branch);
  expect(JSON.stringify(advanced.history)).toContain('new branch question');
  expect((await f.api.snapshot(original)).history).toEqual(source.history);
  expect(await f.api.fork(request)).toEqual(branch);
  expect((await f.api.snapshot(branch)).historyPage.head).toBe(advanced.historyPage.head);
  // A sibling-only message cannot become a cut on the original branch.
  await expect(f.api.fork({ ...original, key: 'invalid-sibling-cut', headId: advanced.historyPage.head })).rejects.toMatchObject({ status: 400 });
}, 30_000);
