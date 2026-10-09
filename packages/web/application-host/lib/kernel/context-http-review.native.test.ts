import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
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
async function fixture(existingRoot?: string, existingEndpoint?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-context-http-review-'));
  const kernel = createKernelClient({ hostId: 'http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'fake-http-provider-key-not-a-real-secret';
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (bytes: Buffer) => chunks.push(bytes));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `http-answer-${requests.length}`, type: 'message', content: [{ type: 'output_text', text: JSON.stringify(requests.at(-1)!.body).includes('Produce a faithful continuation summary') ? 'SUMMARY: fixed original goal.' : 'Original full answer.' }] }] } })}\n\n`);
    });
  });
  const endpoint = existingEndpoint ?? `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const rebound: unknown[] = [];
  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async (configuration, expectedScope) => { rebound.push({ configuration, expectedScope }); expect(expectedScope).toEqual(await owner.scope()); return owner; },
  }, async () => { throw new Error('this fixture has no admitted source'); }, (_runId, error) => { launchErrors.push(error); });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, endpoint, rebound, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };

it('HTTP compaction generates an authenticated fixed-range summary and the next Run uses its published checkpoint without rewriting history', async () => {
  const f = await fixture();
  const identity = await f.api.create('context-source');
  const first = await f.api.submit({ ...identity, key: 'source', expectedHead: null, text: 'ORIGINAL USER GOAL: preserve source evidence.', model });
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const original = await f.api.snapshot(identity);
  const throughId = original.historyPage.head!;
  const job = await f.api.compact({ ...identity, key: 'compact', throughId, expectedRevision: 0, model });
  await expect.poll(async () => (await f.api.snapshot(identity)).context.jobs.find(value => value.job.receipt.run_id === job.receipt.run_id)?.run.state).toBe('completed');
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1]!.body)).toContain('Produce a faithful continuation summary');
  expect(JSON.stringify(f.requests[1]!.body)).toContain('ORIGINAL USER GOAL');
  expect(f.requests[1]!.authorization).toBe(`Bearer ${f.secret}`);
  expect(f.requests[1]!.body.tools ?? []).toEqual([]);
  expect((await f.api.snapshot(identity)).context.checkpoint).toBeNull();
  const tail = await f.api.submit({ ...identity, key: 'tail-before-publication', expectedHead: throughId, text: 'APPENDED TAIL: retain this verbatim.', model });
  await expect.poll(async () => (await f.api.run(tail.run_id)).state).toBe('completed');
  const before = await f.api.snapshot(identity);
  const other = await f.api.create('wrong-context-owner');
  await expect(f.api.publishContext(other, job.receipt.run_id)).rejects.toThrow();
  const published = await f.api.publishContext(identity, job.receipt.run_id);
  expect(published.proposal.through_id).toBe(throughId);
  expect(published.proposal.summary).toBe('SUMMARY: fixed original goal.');
  expect((await f.api.snapshot(identity)).history).toEqual(before.history);
  expect(await f.api.publishContext(identity, job.receipt.run_id)).toEqual(published);
  const next = await f.api.submit({ ...identity, key: 'after-compaction', expectedHead: before.historyPage.head, text: 'CONTINUE AFTER SUMMARY', model });
  await expect.poll(async () => (await f.api.run(next.run_id)).state).toBe('completed');
  const request = JSON.stringify(f.requests.at(-1)!.body);
  expect(request).toContain('SUMMARY: fixed original goal.');
  expect(request).toContain('APPENDED TAIL: retain this verbatim.');
  expect(request).toContain('CONTINUE AFTER SUMMARY');
  expect(request).not.toContain('ORIGINAL USER GOAL');
  const final = await f.api.snapshot(identity);
  expect(final.history.slice(0, original.history.length)).toEqual(original.history);
  expect(JSON.stringify({ final, published, events: await f.api.events(0) })).not.toContain(f.secret);
  expect(f.launchErrors).toEqual([]);
}, 30_000);

it('accepted context job survives Host/kernel reopen and explicit resume rebinds its original credential scope', async () => {
  const f = await fixture();
  const identity = await f.api.create('context-recovery');
  const first = await f.api.submit({ ...identity, key: 'recovery-source', expectedHead: null, text: 'RECOVERY ORIGINAL GOAL', model });
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const source = await f.api.snapshot(identity);
  // Fault injection at the actual admission/launch gap: the durable job exists, dispatch never starts.
  const start = vi.spyOn(f.runtime, 'startRunWithCredentialOwner').mockRejectedValueOnce(new Error('simulated Host shutdown after admission'));
  const job = await f.api.compact({ ...identity, key: 'recovery-job', throughId: source.historyPage.head!, expectedRevision: 0, model });
  await expect.poll(() => f.launchErrors.length).toBe(1);
  start.mockRestore();
  expect(f.requests).toHaveLength(1);
  await f.closeKernel();
  const reopened = await fixture(f.root, f.endpoint);
  expect((await reopened.api.snapshot(identity)).context.jobs.map(value => value.job.receipt.run_id)).toContain(job.receipt.run_id);
  await reopened.api.resumeContext(identity, job.receipt.run_id);
  await expect.poll(async () => (await reopened.api.snapshot(identity)).context.jobs.find(value => value.job.receipt.run_id === job.receipt.run_id)?.run.state).toBe('completed');
  expect(reopened.rebound).toHaveLength(1);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.authorization).toBe(`Bearer ${f.secret}`);
  expect((await reopened.api.publishContext(identity, job.receipt.run_id)).proposal.summary).toBe('SUMMARY: fixed original goal.');
  expect((await reopened.api.snapshot(identity)).history).toEqual(source.history);
  expect(reopened.launchErrors).toEqual([]);
}, 30_000);
