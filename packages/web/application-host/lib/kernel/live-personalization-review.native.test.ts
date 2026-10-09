import { createMemoryOwner } from './memory-owner.js';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-http-review-'));
  const kernel = createKernelClient({ hostId: 'http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
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
  const endpoint = existingEndpoint ?? `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createThreadSourcePreparer({ documents, workingStates });
  let refresh = () => Promise.resolve();
  const refreshTasks: Promise<void>[] = [];
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }), onChanged: () => { const task = refresh(); void task.catch(() => undefined); refreshTasks.push(task); } });
  const prepareContext = createThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  refresh = () => adapter.refreshPersonalization();
  const flushRefreshes = async () => { while (refreshTasks.length) await Promise.all(refreshTasks.splice(0)); };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { flushRefreshes, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
const system = (body: Record<string, unknown>) => JSON.stringify((body.input as Array<{ role?: string }>).filter(item => item.role === 'system'));
function complete(response: ServerResponse, id: string, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id, type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
}
it('live profiles advance at the request boundary while note tails preserve the frozen memory prefix and compaction revisions', async () => {
  let held!: ServerResponse; let count = 0;
  const f = await fixture((body, response) => {
    count++;
    if (count === 1) { held = response; return; }
    complete(response, `live-output-${count}`, JSON.stringify(body).includes('Produce a faithful continuation summary') ? 'LIVE CONTINUATION SUMMARY' : 'ordinary completed response');
  });
  const identity = await f.api.create('live-personalization');
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { global_rule: 'PROFILE OLD' } }, (await f.personalization.catalog()).revision);
  const note = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'NOTE OLD' });
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'PINNED AGENT SOURCE');
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'actual pinned body');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live-source', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await f.api.submit({ ...identity, key: 'live-input', expectedHead: null, text: 'read source after a note edit', model, source: prepared.source });
  await expect.poll(() => f.requests.length).toBe(1);
  const initialWire = structuredClone(f.requests[0]!.body);
  expect(system(initialWire)).toContain('PROFILE OLD'); expect(system(initialWire)).toContain('NOTE OLD');
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'LATER DISK SOURCE');
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { global_rule: 'PROFILE NEW' } }, (await f.personalization.catalog()).revision);
  await f.personalization.saveNote({ id: note.result.id, scope: { kind: 'global' }, content: 'NOTE NEW' });
  await f.flushRefreshes();
  expect(f.requests[0]!.body).toEqual(initialWire);
  expect(f.requests).toHaveLength(1);
  held.writeHead(200, { 'content-type': 'text/event-stream' });
  held.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'live-read-item', type: 'function_call', call_id: 'live-read-call', name: 'file_read', arguments: JSON.stringify({ path: 'source.txt' }) }] } })}\n\n`);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  const refreshedWire = system(f.requests[1]!.body);
  expect(refreshedWire).toContain('PROFILE NEW'); expect(refreshedWire).not.toContain('NOTE NEW');
  expect(JSON.stringify((f.requests[1]!.body.input as Array<{ role?: string }>).filter(item => item.role !== 'system'))).toContain('NOTE NEW');
  expect(refreshedWire).toContain('PINNED AGENT SOURCE'); expect(refreshedWire).not.toContain('LATER DISK SOURCE');
  expect(refreshedWire).not.toContain('PROFILE OLD'); expect(refreshedWire).toContain('NOTE OLD');
  const before = await f.api.snapshot(identity);
  const stale = await f.api.compact({ ...identity, key: 'stale-live-summary', throughId: before.historyPage.head!, expectedRevision: before.context.checkpoint!.revision, model });
  await expect.poll(async () => (await f.api.snapshot(identity)).context.jobs.find(job => job.job.receipt.run_id === stale.receipt.run_id)?.run.state).toBe('completed');
  await f.personalization.saveNote({ id: note.result.id, scope: { kind: 'global' }, content: 'NOTE LATEST' });
  await f.flushRefreshes();
  const admitted = await f.api.publishContext(identity, stale.receipt.run_id);
  expect(admitted.proposal.effective_system_prompt).toContain('NOTE NEW');
  expect(admitted.proposal.effective_system_prompt).not.toContain('NOTE LATEST');
  const current = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(current.proposal.effective_system_prompt).toContain('NOTE NEW');
  expect(current.proposal.effective_system_prompt).not.toContain('NOTE LATEST');
  const fresh = await f.api.compact({ ...identity, key: 'fresh-live-summary', throughId: before.historyPage.head!, expectedRevision: current.revision, model });
  await expect.poll(async () => (await f.api.snapshot(identity)).context.jobs.find(job => job.job.receipt.run_id === fresh.receipt.run_id)?.run.state).toBe('completed');
  const published = await f.api.publishContext(identity, fresh.receipt.run_id);
  await f.personalization.removeNote(note.result.id, (await f.personalization.catalog()).revision);
  await f.personalization.savePrompt({ kind: 'global' }, null, (await f.personalization.catalog()).revision);
  await f.flushRefreshes();
  const reset = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(reset.proposal.summary).toBe(published.proposal.summary);
  expect(reset.proposal.through_id).toBe(published.proposal.through_id);
  expect(reset.proposal.effective_system_prompt).toContain('PINNED AGENT SOURCE');
  expect(reset.proposal.effective_system_prompt).not.toContain('PROFILE NEW');
  expect(reset.proposal.effective_system_prompt).toContain('NOTE LATEST');
  expect(reset.proposal.memory_checkpoint).toBe(published.proposal.memory_checkpoint);
  const next = await f.api.submit({ ...identity, key: 'after-live-reset', expectedHead: before.historyPage.head, text: 'continue after reset', model });
  await expect.poll(async () => (await f.api.run(next.run_id)).state).toBe('completed');
  const last = f.requests.at(-1)!.body;
  expect(system(last)).not.toContain('PROFILE NEW'); expect(system(last)).toContain('NOTE LATEST');
  expect(JSON.stringify(last)).toContain('LIVE CONTINUATION SUMMARY');
  expect((await f.api.snapshot(identity)).history.slice(0, before.history.length)).toEqual(before.history);
  expect(f.launchErrors).toEqual([]);
}, 45_000);
