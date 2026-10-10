import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { sourceToolSchemas } from './source-launch.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void) {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-http-review-'));
  const kernel = createKernelClient({ hostId: 'http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'fake-http-provider-key-not-a-real-secret';
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (bytes: Buffer) => chunks.push(bytes));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      reply(requests.at(-1)!.body, response);
    });
  });
  const endpoint = `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { if (source.workspaceId !== 'source-workspace' || source.executionWorkspaceId !== 'source-workspace') throw new Error('unknown fixture workspace'); }, (_runId, error) => { launchErrors.push(error); });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

async function publishSource(kernel: ReturnType<typeof createKernelClient>, branchId: string, text: string) {
  const actor = kernel.scoped(await kernel.issueGrant({ grantId: `source-owner-${branchId}`, owningWorkspace: 'source-workspace', executionWorkspace: 'source-workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
  const bytes = Buffer.from(text); const blob = await actor.putBlob(bytes, `blob-${branchId}`);
  await actor.createBranch({ operationId: `create-${branchId}`, branchId, workspaceId: 'source-workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'source.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const branch = await actor.readBranch({ branchId });
  return Number((await actor.publishBranch({ operationId: `publish-${branchId}`, branchId, expectedRoot: branch.root, expectedWriteRevision: branch.writeRevision })).revision);
}
it('public completed-turn continuation preserves edited disk while explicit source override and retries retain their identities', async () => {
  let step = 0;
  const outputs: string[] = [];
  const f = await fixture((body, response) => {
    const last = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    const output = last ? String(last.output) : '';
    outputs.push(output); step++;
    let call: { name: string; arguments: Record<string, unknown> } | undefined;
    if ([1, 4, 6].includes(step)) call = { name: 'file_read', arguments: { path: 'source.txt' } };
    else if (step === 2) call = { name: 'file_write', arguments: { path: 'source.txt', readVersion: (JSON.parse(output) as { content: { readVersion: string } }).content.readVersion, content: 'persisted working edit' } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [call ? { id: `tool-${step}`, type: 'function_call', call_id: `call-${step}`, name: call.name, arguments: JSON.stringify(call.arguments) } : { id: `answer-${step}`, type: 'message', content: [{ type: 'output_text', text: 'completed actual source turn' }] }] } })}\n\n`);
  });
  const revision = await publishSource(f.kernel, 'source-a', 'original source A');
  const overrideRevision = await publishSource(f.kernel, 'source-b', 'explicit source B');
  const identity = await f.api.create('inherited-source-thread');
  const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
  const initial = await f.api.submit({ ...identity, key: 'edit-source', expectedHead: null, text: 'edit source', model, source: { workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'source-a', revision, mode: 'materialized', tools: ['file_read', 'file_write'] } });
  await expect.poll(async () => (await f.api.run(initial.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const nextRequest = { ...identity, key: 'continue-source', expectedHead: (await f.api.snapshot(identity)).historyPage.head, text: 'read persisted working edits', model };
  const next = await f.api.submit(nextRequest);
  await expect.poll(async () => (await f.api.run(next.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(outputs[4]).toContain('persisted working edit');
  expect((await f.runtime.launch(next.run_id))?.selection.source).toMatchObject({ branch_id: 'source-a', environment_run_id: initial.run_id, mode: 'materialized', live_root: null });
  const changed = await f.api.submit({ ...identity, key: 'override-source', expectedHead: (await f.api.snapshot(identity)).historyPage.head, text: 'read explicitly selected other source', model, source: { workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'source-b', revision: overrideRevision, mode: 'materialized', tools: ['file_read'] } });
  await expect.poll(async () => (await f.api.run(changed.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(outputs[6]).toContain('explicit source B');
  expect((await f.runtime.launch(changed.run_id))?.selection.source).toMatchObject({ branch_id: 'source-b', environment_run_id: null });
  const calls = f.requests.length;
  expect(await f.api.submit(nextRequest)).toEqual(next);
  expect(f.requests).toHaveLength(calls);
  expect(f.launchErrors).toEqual([]);
}, 45_000);
it('first public submit without a source completes without resource capabilities', async () => {
  const f = await fixture((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'model-only-answer', type: 'message', content: [{ type: 'output_text', text: 'model only completed' }] }] } })}\n\n`);
  });
  const identity = await f.api.create('no-source-inheritance');
  const receipt = await f.api.submit({ ...identity, key: 'model-only-input', expectedHead: null, text: 'hello', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  const launch = (await f.runtime.launch(receipt.run_id))!;
  expect(launch.selection.source).toBeNull();
  expect(sourceToolSchemas(launch.selection)).toEqual([]);
  expect(launch.selection.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ask_user', 'question_status', 'memory']));
  expect(f.launchErrors).toEqual([]);
});
