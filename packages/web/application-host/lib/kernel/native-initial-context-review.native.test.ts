import { createNativeThreadContext } from './native-thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createNativeThreadSourcePreparer } from './native-thread-sources.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string) {
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
  const documents = createDocumentAuthority({ hostId: 'native-http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'native-http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createNativeThreadSourcePreparer({ documents, workingStates });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createNativeThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new NativeThreadAdapter(new NativeRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
const messages = (body: Record<string, unknown>) => body.input as Array<{ role?: string; content?: unknown }>;
const system = (body: Record<string, unknown>) => messages(body).filter(value => value.role === 'system');
it('initial native context uses frozen personalization and pinned AGENTS in system roles across retry, restart, compaction and an earlier fork', async () => {
  let serial = 0;
  const reply = (body: Record<string, unknown>, response: ServerResponse) => {
    const text = JSON.stringify(body).includes('Produce a faithful continuation summary') ? 'GENERATED CONTINUATION SUMMARY' : 'ordinary answer';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `answer-${++serial}`, type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
  };
  const f = await fixture(reply);
  const identity = await f.api.create('initial-context-main');
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { global_rule: 'GLOBAL PROFILE RULE' } }, (await f.personalization.catalog()).revision);
  await f.personalization.savePrompt({ kind: 'project', id: 'selected-project' }, { sections: { project_rule: 'SELECTED PROJECT RULE' } }, (await f.personalization.catalog()).revision);
  await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'GLOBAL NOTE FROZEN' });
  await f.personalization.saveNote({ scope: { kind: 'project', id: 'selected-project' }, content: 'SELECTED PROJECT NOTE' });
  await f.personalization.saveNote({ scope: { kind: 'session', id: identity.threadId }, content: 'THIS SESSION NOTE' });
  await f.personalization.saveNote({ scope: { kind: 'project', id: 'unrelated-project' }, content: 'MUST NOT LEAK OTHER PROJECT' });
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'PINNED WORKSPACE INSTRUCTIONS');
  const prepared = await f.api.prepareSource({ ...identity, key: 'initial-context-source', path: f.workspace, mode: 'fixed_branch' });
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'LATER DISK INSTRUCTIONS');
  const request = { ...identity, key: 'initial-context-input', expectedHead: null, text: 'USER TEXT MUST STAY USER', model, source: prepared.source };
  await expect(f.api.submit({ ...request, expectedHead: 'wrong-head' })).rejects.toMatchObject({ status: 409 });
  expect((await f.api.snapshot(identity)).context.checkpoint).toBeNull();
  expect(f.requests).toHaveLength(0);
  const receipt = await f.api.submit(request);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  const before = await f.api.snapshot(identity);
  const frozen = before.context.checkpoint!;
  expect(frozen.revision).toBe(1);
  const prompt = JSON.stringify(system(f.requests[0]!.body));
  for (const text of ['GLOBAL PROFILE RULE', 'SELECTED PROJECT RULE', 'GLOBAL NOTE FROZEN', 'SELECTED PROJECT NOTE', 'THIS SESSION NOTE', 'PINNED WORKSPACE INSTRUCTIONS']) expect(prompt).toContain(text);
  for (const text of ['LATER DISK INSTRUCTIONS', 'MUST NOT LEAK OTHER PROJECT', 'USER TEXT MUST STAY USER']) expect(prompt).not.toContain(text);
  expect(JSON.stringify(messages(f.requests[0]!.body).filter(value => value.role === 'user'))).toContain('USER TEXT MUST STAY USER');
  expect(frozen.proposal.instruction_sources.some(value => value.includes('AGENTS.md:sha256-'))).toBe(true);
  expect(frozen.proposal.memory_checkpoint).toContain('agent.personalization:');
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { global_rule: 'CHANGED GLOBAL PROFILE' } }, (await f.personalization.catalog()).revision);
  await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'NEW NOTE AFTER ACCEPTANCE' });
  expect(await f.api.submit(request)).toEqual(receipt);
  expect(f.requests).toHaveLength(1);
  await f.close();
  const reopened = await fixture(reply, f.root, f.endpoint);
  expect(await reopened.api.submit(request)).toEqual(receipt);
  expect((await reopened.api.snapshot(identity)).context.checkpoint).toEqual(frozen);
  const next = await reopened.api.submit({ ...identity, key: 'next-context-turn', expectedHead: before.historyPage.head, text: 'NEXT USER MESSAGE', model });
  await expect.poll(async () => (await reopened.api.run(next.run_id)).state).toBe('completed');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).toBe(prompt);
  const job = await reopened.api.compact({ ...identity, key: 'initial-context-summary', throughId: before.historyPage.head!, expectedRevision: 1, model });
  await expect.poll(async () => (await reopened.api.snapshot(identity)).context.jobs.find(value => value.job.receipt.run_id === job.receipt.run_id)?.run.state).toBe('completed');
  const checkpoint = await reopened.api.publishContext(identity, job.receipt.run_id);
  expect(checkpoint.revision).toBe(2);
  expect(checkpoint.proposal.effective_system_prompt).toBe(frozen.proposal.effective_system_prompt);
  expect(checkpoint.proposal.memory_checkpoint).toBe(frozen.proposal.memory_checkpoint);
  const fork = await reopened.api.fork({ ...identity, key: 'earlier-context-fork', headId: receipt.input_id });
  const forkView = await reopened.api.snapshot(fork);
  expect(forkView.context.checkpoint?.proposal).toMatchObject({ through_id: null, summary: '', effective_system_prompt: frozen.proposal.effective_system_prompt, memory_checkpoint: frozen.proposal.memory_checkpoint });
  const forkRun = await reopened.api.submit({ ...fork, key: 'earlier-fork-input', expectedHead: receipt.input_id, text: 'FORK USER MESSAGE', model });
  await expect.poll(async () => (await reopened.api.run(forkRun.run_id)).state).toBe('completed');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).toBe(prompt);
  expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain('GENERATED CONTINUATION SUMMARY');
  const latest = await reopened.api.snapshot(identity);
  const finalRun = await reopened.api.submit({ ...identity, key: 'after-summary-input', expectedHead: latest.historyPage.head, text: 'AFTER SUMMARY USER MESSAGE', model });
  await expect.poll(async () => (await reopened.api.run(finalRun.run_id)).state).toBe('completed');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).toBe(prompt);
  expect(JSON.stringify(messages(f.requests.at(-1)!.body).filter(value => value.role !== 'system'))).toContain('GENERATED CONTINUATION SUMMARY');
  expect((await reopened.api.snapshot(identity)).history.slice(0, before.history.length)).toEqual(before.history);
  expect(reopened.launchErrors).toEqual([]);
}, 45_000);
