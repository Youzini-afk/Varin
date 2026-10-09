import { createThreadContext } from './thread-context.js';
import { createMemoryOwner } from './memory-owner.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string, providerFamily = 'openai-responses') {
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
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily, endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily, model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createThreadSourcePreparer({ documents, workingStates });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  kernel.setMemoryOwner(createMemoryOwner({personalization,prepareContext}));
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
  const questionErrors: string[] = [];
  const answerQuestion = adapter.answerQuestion.bind(adapter);
  adapter.answerQuestion = async input => { try { return await answerQuestion(input); } catch (error) { questionErrors.push(String(error)); throw error; } };
  const cancelOperation = adapter.cancelOperation.bind(adapter);
  adapter.cancelOperation = async input => { try { return await cancelOperation(input); } catch (error) { questionErrors.push(String(error)); throw error; } };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { questionErrors, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
function assertResponsesPairing(body: Record<string, unknown>) {
  const pending = new Set<string>();
  for (const item of body.input as Array<Record<string, unknown>>) {
    if (item.type === 'function_call') { expect(pending.has(String(item.call_id))).toBe(false); pending.add(String(item.call_id)); }
    else if (item.type === 'function_call_output') { expect(pending.delete(String(item.call_id)), 'tool output must resolve a preceding call').toBe(true); }
    else if (item.role === 'user') expect([...pending], 'user answer must follow all tool outputs').toEqual([]);
  }
  expect([...pending], 'provider request must not contain unresolved tool calls').toEqual([]);
}

function ask(response: ServerResponse, text = 'Which plan should I use?') {
  const suffix = crypto.randomUUID();
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `ask-item-${suffix}`, type: 'function_call', call_id: `ask-call-${suffix}`, name: 'ask_user', arguments: JSON.stringify({ question: text, options: ['Option A', 'Option B'] }) }, { id: `pre-answer-text-${suffix}`, type: 'message', content: [{ type: 'output_text', text: 'I can finish after you choose.' }] }] } })}\n\n`);
}
function done(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `answer-item-${crypto.randomUUID()}`, type: 'message', content: [{ type: 'output_text', text: 'finished with actual user input' }] }] } })}\n\n`);
}
async function openQuestion(f: Awaited<ReturnType<typeof fixture>>, key: string, source?: import('@varin/application-client').ThreadSource) {
  const identity = await f.api.create(key);
  const receipt = await f.api.submit({ ...identity, key: `${key}-input`, expectedHead: null, text: 'ask me before choosing a plan', model, ...(source ? { source } : {}) });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('waiting');
  const view = await f.api.snapshot(identity);
  const operation = view.operations.find(operation => operation.executor === 'ask_user')!;
  expect(operation, JSON.stringify({ run: view.activeRun, launchErrors: f.launchErrors.map(String), calls: f.requests.length, events: operation ? [] : (await f.runtime.events(0, 256)).slice(-8) })).toBeDefined();
  expect(view.activeRun?.waiting_on).toBe(operation.waiting_on);
  return { identity, receipt, operation };
}
it('ordinary user answers pause the real Run, append once, resume once and cannot expand its tools', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) ask(response); else done(response); });
  const { identity, receipt, operation } = await openQuestion(f, 'question-once');
  expect(calls).toBe(1);
  const selected = await f.runtime.launch(receipt.run_id);
  const fork = await f.api.fork({ ...identity, key: 'question-earlier-fork', headId: receipt.input_id });
  const forkView = await f.api.snapshot(fork);
  expect(forkView.activeRun).toBeNull();
  expect(forkView.operations.some(op => op.id === operation.id)).toBe(false);
  await expect(f.api.answerQuestion({ ...fork, operationId: operation.id, answer: 'wrong branch answer' })).rejects.toMatchObject({ status: 400 });
  const other = await f.api.create('question-foreign');
  await expect(f.api.answerQuestion({ ...other, operationId: operation.id, answer: 'foreign answer' })).rejects.toMatchObject({ status: 400 });
  const bad = await fetch(`${f.hostUrl}/api/threads/question/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-auth': 'fixture-client' }, body: JSON.stringify({ ...identity, operationId: operation.id, answer: 'Yes', allowTools: ['process_spawn'] }) });
  expect(bad.status).toBe(400);
  expect((await f.api.run(receipt.run_id)).state).toBe('waiting');
  const desired = await f.api.selectModel({...identity,runId:receipt.run_id,key:'question-model-choice',model});
  expect(desired.status).toBe('preparing');
  const answer = { ...identity, operationId: operation.id, answer: 'Option B, with my specific free-text constraint' };
  const [first, duplicate] = await Promise.all([f.api.answerQuestion(answer), f.api.answerQuestion(answer)]).catch(error => { throw new Error(`${String(error)}: ${f.questionErrors.join('; ')}`); });
  expect(duplicate).toEqual(first);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  expect(calls).toBe(2);
  expect((await f.api.snapshot(identity)).modelSelection.active?.id).toBe(desired.id);
  assertResponsesPairing(f.requests[1]!.body);
  expect((await f.runtime.launch(receipt.run_id))?.selection).toEqual(selected?.selection);
  expect(((f.requests[1]!.body.tools ?? []) as Array<{ name: string }>).map(tool => tool.name)).toEqual(selected!.selection.tools.map(tool=>tool.name));
  const body = f.requests[1]!.body.input as Array<{ role?: string; content?: unknown }>;
  expect(JSON.stringify(body.filter(item => item.role === 'user'))).toContain(answer.answer);
  expect(JSON.stringify(body.filter(item => item.role === 'system'))).not.toContain(answer.answer);
  const history = (await f.api.snapshot(identity)).history;
  expect(history.filter(item => item.id === `question-answer:${operation.id}`)).toHaveLength(1);
  expect(history.find(item => item.id === `question-answer:${operation.id}`)!.content).toEqual({ text: answer.answer });
  expect(await f.api.answerQuestion(answer)).toEqual(first);
  await expect(f.api.answerQuestion({ ...answer, answer: 'different late answer' })).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(2);
}, 30_000);
it('pending question survives Host/kernel reopen and answer resumes its original source without reasking', async () => {
  let calls = 0; let read = '';
  const reply = (body: Record<string, unknown>, response: ServerResponse) => {
    calls++;
    if (calls === 1) { ask(response, 'Choose the file to inspect'); return; }
    if (calls === 2) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'read-item', type: 'function_call', call_id: 'read-call', name: 'file_read', arguments: JSON.stringify({ path: 'source.txt' }) }] } })}\n\n`); return;
    }
    read = String((body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output')?.output);
    done(response);
  };
  const f = await fixture(reply);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'pinned before asking');
  const identity = await f.api.create('restart-question');
  const prepared = await f.api.prepareSource({ ...identity, key: 'question-source', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await f.api.submit({ ...identity, key: 'restart-question-input', expectedHead: null, text: 'ask before reading', model, source: prepared.source });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('waiting');
  const operation = (await f.api.snapshot(identity)).operations.find(op => op.executor === 'ask_user')!;
  const selected = (await f.runtime.launch(receipt.run_id))!.selection;
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'later disk must not replace source');
  await f.close();
  const reopened = await fixture(reply, f.root, f.endpoint);
  expect((await reopened.api.run(receipt.run_id)).state).toBe('waiting');
  expect(calls).toBe(1);
  await reopened.api.answerQuestion({ ...identity, operationId: operation.id, answer: 'source.txt' });
  await expect.poll(async () => (await reopened.api.run(receipt.run_id)).state).toBe('completed');
  expect(calls).toBe(3);
  expect(read).toContain('pinned before asking');
  expect(read).not.toContain('later disk');
  expect((await reopened.runtime.launch(receipt.run_id))?.selection).toEqual(selected);
  expect(reopened.launchErrors).toEqual([]);
}, 30_000);

it('run cancellation fences late answers and question cancellation resumes with cancellation data exactly once', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { calls++; if (calls <= 2) ask(response); else done(response); });
  const cancelledRun = await openQuestion(f, 'cancel-question-run');
  await f.api.cancelRun(cancelledRun.receipt.run_id);
  await expect.poll(async () => (await f.api.run(cancelledRun.receipt.run_id)).state).toBe('cancelled');
  await expect(f.api.answerQuestion({ ...cancelledRun.identity, operationId: cancelledRun.operation.id, answer: 'too late' })).rejects.toMatchObject({ status: 409 });
  expect((await f.api.snapshot(cancelledRun.identity)).history.some(item => item.id === `question-answer:${cancelledRun.operation.id}`)).toBe(false);
  const cancelledQuestion = await openQuestion(f, 'cancel-question-only');
  const result = await f.api.cancelOperation(cancelledQuestion.operation.id);
  expect(result.outcome).toBe('cancelled');
  await expect.poll(async () => (await f.api.run(cancelledQuestion.receipt.run_id)).state).toBe('completed');
  expect(await f.api.cancelOperation(cancelledQuestion.operation.id)).toEqual(result);
  await expect(f.api.answerQuestion({ ...cancelledQuestion.identity, operationId: cancelledQuestion.operation.id, answer: 'late choice' })).rejects.toMatchObject({ status: 409 });
  const history = (await f.api.snapshot(cancelledQuestion.identity)).history;
  expect(history.filter(item => item.id === `question-answer:${cancelledQuestion.operation.id}`)).toHaveLength(1);
  expect(JSON.stringify(f.requests.at(-1)!.body)).toContain('cancelled this question');
  expect(calls).toBe(3);
}, 30_000);

it('simultaneous answer and cancel have one durable winner and one continuation', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) ask(response); else done(response); });
  const { identity, receipt, operation } = await openQuestion(f, 'question-race');
  const results = await Promise.allSettled([
    f.api.answerQuestion({ ...identity, operationId: operation.id, answer: 'race answer' }),
    f.api.cancelOperation(operation.id),
  ]);
  expect(results.filter(result => result.status === 'fulfilled'), f.questionErrors.join('; ')).toHaveLength(1);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  const view = await f.api.snapshot(identity);
  expect(view.history.filter(item => item.id === `question-answer:${operation.id}`)).toHaveLength(1);
  expect(calls).toBe(2);
  expect(['succeeded', 'cancelled']).toContain((await f.api.operation(operation.id)).outcome);
}, 30_000);
it('multiple outstanding questions park independently and do not generate until both are answered', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    if (++calls !== 1) { done(response); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: ['first', 'second'].map(id => ({ id: `${id}-item`, type: 'function_call', call_id: `${id}-call`, name: 'ask_user', arguments: JSON.stringify({ question: `${id} question` }) })) } })}\n\n`);
  });
  const { identity, receipt } = await openQuestion(f, 'question-batch');
  const before = await f.api.snapshot(identity);
  const questions = before.operations.filter(op => op.executor === 'ask_user');
  expect(questions).toHaveLength(2);
  const current = questions.find(op => op.waiting_on === before.activeRun!.waiting_on)!;
  const later = questions.find(op => op.id !== current.id)!;
  await expect(f.api.answerQuestion({ ...identity, operationId: later.id, answer: 'out of order' })).rejects.toMatchObject({ status: 409 });
  await f.api.answerQuestion({ ...identity, operationId: current.id, answer: 'first actual answer' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).waiting_on).toBe(later.waiting_on);
  expect(calls).toBe(1);
  await f.api.answerQuestion({ ...identity, operationId: later.id, answer: 'second actual answer' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  expect(calls).toBe(2);
  assertResponsesPairing(f.requests[1]!.body);
  expect(JSON.stringify(f.requests[1]!.body)).toContain('first actual answer');
  expect(JSON.stringify(f.requests[1]!.body)).toContain('second actual answer');
}, 30_000);
it('Anthropic continuation keeps tool-result blocks ahead of authenticated answer text', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    const asking = ++calls === 1;
    const events = [
      { type: 'message_start', message: { id: `anthropic-${calls}`, type: 'message', role: 'assistant', content: [], model: 'fixture-model', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: asking ? { type: 'tool_use', id: 'anthropic-ask', name: 'ask_user', input: { question: 'Choose a destination', options: ['North', 'South'] } } : { type: 'text', text: 'Completed after the real answer' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: asking ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }, undefined, undefined, 'anthropic-messages');
  const { identity, receipt, operation } = await openQuestion(f, 'anthropic-question');
  await f.api.answerQuestion({ ...identity, operationId: operation.id, answer: 'South by the safe route' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  expect(calls).toBe(2);
  const pending = new Set<string>();
  let sawAnswer = false;
  for (const message of f.requests[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') pending.add(String(block.id));
      else if (block.type === 'tool_result') { expect(message.role).toBe('user'); expect(pending.delete(String(block.tool_use_id))).toBe(true); }
      else if (message.role === 'user') {
        expect([...pending], 'Anthropic requires tool_results before any ordinary user text').toEqual([]);
        if (block.text === 'South by the safe route') sawAnswer = true;
      }
    }
    if (message.role === 'user') expect([...pending]).toEqual([]);
  }
  expect([...pending]).toEqual([]);
  expect(sawAnswer).toBe(true);
  expect(JSON.stringify(f.requests[1]!.body.system)).not.toContain('South by the safe route');
}, 30_000);
