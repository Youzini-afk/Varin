import { DatabaseSync } from 'node:sqlite';
import { createNativeMemoryOwner, type NativeMemoryQuery } from './native-memory-owner.js';
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
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-memory-review-'));
  const kernel = createKernelClient({ hostId: 'native-memory-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
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
  const documents = createDocumentAuthority({ hostId: 'native-memory-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'native-memory-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createNativeThreadSourcePreparer({ documents, workingStates });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createNativeThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  const memoryQueries: NativeMemoryQuery[] = [];
  const memoryControl = { synchronizeFailure: undefined as 'reject' | 'throw' | undefined, beforeSynchronize: undefined as (() => Promise<void>) | undefined, dropMutationReply: false, afterMutation: undefined as (() => Promise<void>) | undefined };
  const memoryOwner = createNativeMemoryOwner({ personalization, prepareContext });
  kernel.setNativeMemoryOwner(async (query, signal) => {
    memoryQueries.push(structuredClone(query));
    if (query.action === 'synchronize') {
      await memoryControl.beforeSynchronize?.();
      if (memoryControl.synchronizeFailure === 'reject') return { status: 'rejected', message: 'REVIEW_CONTEXT_OWNER_REJECTED' };
      if (memoryControl.synchronizeFailure === 'throw') throw new Error('REVIEW_CONTEXT_OWNER_THROWN');
    }
    const result = await memoryOwner(query, signal);
    if (query.action === 'tool' && ['save', 'delete'].includes(query.arguments?.action ?? '') && result.status === 'ready') await memoryControl.afterMutation?.();
    if (memoryControl.dropMutationReply && query.action === 'tool' && ['save', 'delete'].includes(query.arguments?.action ?? '') && result.status === 'ready') {
      memoryControl.dropMutationReply = false; throw new Error('fixture lost Host mutation receipt after commit');
    }
    return result;
  });
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
  const submissionErrors: string[] = [];
  const submit = adapter.submit.bind(adapter);
  adapter.submit = async input => { try { return await submit(input); } catch (error) { submissionErrors.push(String(error)); throw error; } };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { memoryControl, memoryQueries, adapter, owner, prepareContext, submissionErrors, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
const messages = (body: Record<string, unknown>) => body.input as Array<{ role?: string; content?: unknown }>;
const system = (body: Record<string, unknown>) => messages(body).filter(value => value.role === 'system');
function complete(response: ServerResponse, text = 'DONE') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'same-provider-id', type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
}
const summaryRequest = (body: Record<string, unknown>) => JSON.stringify(body).includes('Produce a faithful continuation summary');
const tail = (body: Record<string, unknown>) => JSON.stringify(messages(body).filter(item => item.role !== 'system'));
async function turn(f: Awaited<ReturnType<typeof fixture>>, identity: Awaited<ReturnType<typeof f.api.create>>, key: string) {
  const before = await f.api.snapshot(identity);
  const receipt = await f.api.submit({ ...identity, key, expectedHead: before.historyPage.head, text: key, model });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  return receipt;
}

it('UI note commits preserve the frozen system; explicit profiles advance independently and the tail survives reopen', async () => {
  const f = await fixture((_body, response) => complete(response));
  const identity = await f.api.create('memory-ui-freeze');
  const original = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'MEMORY_INITIAL' });
  await turn(f, identity, 'first');
  const frozen = (await f.api.snapshot(identity)).context.checkpoint!;
  const originalRequest = structuredClone(f.requests[0]!.body);
  expect(JSON.stringify(system(originalRequest))).toContain('MEMORY_INITIAL');

  const changed = await f.personalization.saveNote({ id: original.result.id, scope: original.result.scope,
    content: 'MEMORY_CHANGED', revision: original.revision });
  expect((await f.personalization.catalog()).revision).toBe(changed.revision);
  await f.adapter.refreshPersonalization();
  const afterNote = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(afterNote.proposal.effective_system_prompt).toBe(frozen.proposal.effective_system_prompt);
  expect(afterNote.proposal.memory_checkpoint).toBe(frozen.proposal.memory_checkpoint);
  expect(f.requests[0]!.body).toEqual(originalRequest);

  await f.personalization.savePrompt({ kind: 'global' }, { sections: { explicit_rule: 'EXPLICIT_NEW_PROFILE' } }, changed.revision);
  await f.adapter.refreshPersonalization();
  const afterProfile = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(afterProfile.proposal.effective_system_prompt).toContain('EXPLICIT_NEW_PROFILE');
  expect(afterProfile.proposal.effective_system_prompt).toContain('MEMORY_INITIAL');
  expect(afterProfile.proposal.effective_system_prompt).not.toContain('MEMORY_CHANGED');
  expect(afterProfile.proposal.memory_checkpoint).toBe(frozen.proposal.memory_checkpoint);

  await f.close();
  const reopened = await fixture((_body, response) => complete(response), f.root, f.endpoint);
  await turn(reopened, identity, 'after-reopen');
  const delivered = f.requests.at(-1)!.body;
  expect(JSON.stringify(system(delivered))).toContain('EXPLICIT_NEW_PROFILE');
  expect(JSON.stringify(system(delivered))).toContain('MEMORY_INITIAL');
  expect(JSON.stringify(system(delivered))).not.toContain('MEMORY_CHANGED');
  expect(tail(delivered)).toContain('MEMORY_CHANGED');
  const history = (await reopened.api.snapshot(identity)).history;
  await turn(reopened, identity, 'after-delivery');
  expect((await reopened.api.snapshot(identity)).history.filter(item => JSON.stringify(item).includes('MEMORY_CHANGED')))
    .toHaveLength(history.filter(item => JSON.stringify(item).includes('MEMORY_CHANGED')).length);
  expect(reopened.launchErrors).toEqual([]);
});

it('successful compaction atomically checkpoints its admitted notes while retaining later notes and appended history', async () => {
  let summaryResponse: ServerResponse | undefined;
  const f = await fixture((body, response) => {
    if (summaryRequest(body)) summaryResponse = response;
    else complete(response);
  });
  const identity = await f.api.create('memory-compaction-tail');
  const initial = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'CHECKPOINT_ORIGINAL' });
  await turn(f, identity, 'before-compaction');
  await f.personalization.saveNote({ id: initial.result.id, scope: initial.result.scope, content: 'CHECKPOINT_CANDIDATE', revision: initial.revision });
  await f.adapter.refreshPersonalization();
  const before = await f.api.snapshot(identity);
  const job = await f.api.compact({ ...identity, key: 'compact-with-tail', throughId: before.historyPage.head!,
    expectedRevision: before.context.checkpoint!.revision, model });
  await expect.poll(() => Boolean(summaryResponse)).toBe(true);
  expect((await f.api.snapshot(identity)).context.checkpoint!.proposal).toEqual(before.context.checkpoint!.proposal);
  await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'NOTE_AFTER_CANDIDATE' });
  await f.adapter.refreshPersonalization();
  await turn(f, identity, 'USER_TAIL_DURING_SUMMARY');
  const historyBeforePublish = (await f.api.snapshot(identity)).history;
  complete(summaryResponse!, 'SUMMARY_FIXED_ANCESTOR');
  await expect.poll(async () => (await f.runtime.run(job.receipt.run_id)).state).toBe('completed');
  const published = await f.api.publishContext(identity, job.receipt.run_id);
  expect(published.proposal.summary).toBe('SUMMARY_FIXED_ANCESTOR');
  expect(published.proposal.effective_system_prompt).toContain('CHECKPOINT_CANDIDATE');
  expect(published.proposal.effective_system_prompt).not.toContain('CHECKPOINT_ORIGINAL');
  expect(published.proposal.effective_system_prompt).not.toContain('NOTE_AFTER_CANDIDATE');
  expect((await f.api.snapshot(identity)).history).toEqual(historyBeforePublish);
  await turn(f, identity, 'after-compaction');
  const request = f.requests.at(-1)!.body;
  expect(JSON.stringify(system(request))).toContain('CHECKPOINT_CANDIDATE');
  expect(tail(request)).toContain('SUMMARY_FIXED_ANCESTOR');
  expect(tail(request)).toContain('USER_TAIL_DURING_SUMMARY');
  expect(tail(request)).toContain('NOTE_AFTER_CANDIDATE');
  expect(await f.api.publishContext(identity, job.receipt.run_id)).toEqual(published);
});

it('profile changes fence an older summary candidate and deleting the last note only clears memory on a successful checkpoint', async () => {
  let held: ServerResponse | undefined;
  let holdSummary = true;
  const f = await fixture((body, response) => {
    if (summaryRequest(body) && holdSummary) held = response;
    else complete(response, summaryRequest(body) ? 'EMPTY_MEMORY_SUMMARY' : 'DONE');
  });
  const identity = await f.api.create('memory-profile-cas-delete');
  const note = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'LAST_MEMORY_NOTE' });
  await turn(f, identity, 'initial');
  const initial = await f.api.snapshot(identity);
  const obsolete = await f.api.compact({ ...identity, key: 'old-profile-candidate', throughId: initial.historyPage.head!,
    expectedRevision: initial.context.checkpoint!.revision, model });
  await expect.poll(() => Boolean(held)).toBe(true);
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { current_rule: 'NEW_PROFILE_MUST_SURVIVE' } }, note.revision);
  await f.adapter.refreshPersonalization();
  const changedProfile = (await f.api.snapshot(identity)).context.checkpoint!;
  complete(held!, 'OBSOLETE_SUMMARY');
  await expect.poll(async () => (await f.runtime.run(obsolete.receipt.run_id)).state).toBe('completed');
  await expect(f.api.publishContext(identity, obsolete.receipt.run_id)).rejects.toMatchObject({ status: 409 });
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(changedProfile);

  const deleted = await f.personalization.removeNote(note.result.id, (await f.personalization.catalog()).revision);
  expect(deleted.result).toEqual({ removed: true });
  expect((await f.personalization.catalog()).memories).toEqual([]);
  await f.adapter.refreshPersonalization();
  expect((await f.api.snapshot(identity)).context.checkpoint!.proposal.effective_system_prompt).toContain('LAST_MEMORY_NOTE');
  holdSummary = false;
  const before = await f.api.snapshot(identity);
  const empty = await f.api.compact({ ...identity, key: 'empty-memory-candidate', throughId: before.historyPage.head!,
    expectedRevision: before.context.checkpoint!.revision, model });
  await expect.poll(async () => (await f.runtime.run(empty.receipt.run_id)).state).toBe('completed');
  const published = await f.api.publishContext(identity, empty.receipt.run_id);
  expect(published.proposal.effective_system_prompt).not.toContain('LAST_MEMORY_NOTE');
  expect(published.proposal.effective_system_prompt).toContain('NEW_PROFILE_MUST_SURVIVE');
  expect(published.proposal.effective_system_prompt).not.toContain('agent_memory_');
  expect(published.proposal.memory_checkpoint).not.toBe(changedProfile.proposal.memory_checkpoint);
});

it('trusted child admission shares only global/project notes and Bot admission receives no ordinary personalization', async () => {
  const f = await fixture((_body, response) => complete(response));
  const parent = await f.api.create('scope-parent');
  const child = await f.api.create('scope-child');
  const bot = await f.api.create('scope-bot');
  for (const [scope, content] of [
    [{ kind: 'global' }, 'SCOPE_GLOBAL'],
    [{ kind: 'project', id: 'admitted-project' }, 'SCOPE_ADMITTED_PROJECT'],
    [{ kind: 'project', id: 'selected-project' }, 'SCOPE_SIDEBAR_PROJECT_DO_NOT_USE'],
    [{ kind: 'session', id: parent.threadId }, 'SCOPE_PARENT_PRIVATE'],
    [{ kind: 'session', id: child.threadId }, 'SCOPE_CHILD_PRIVATE'],
  ] as const) await f.personalization.saveNote({ scope, content });
  await f.personalization.savePrompt({ kind: 'global' }, { sections: { ordinary_rule: 'ORDINARY_PROFILE_ONLY' } }, (await f.personalization.catalog()).revision);
  const prepared = await f.prepareContext(child, null, { mode: 'agent', threadRole: 'worker', projectId: 'admitted-project' });
  expect(prepared.personalization).toMatchObject({ mode: 'agent', threadRole: 'worker', sessionId: child.threadId, projectId: 'admitted-project' });
  for (const value of ['SCOPE_GLOBAL', 'SCOPE_ADMITTED_PROJECT', 'SCOPE_CHILD_PRIVATE', 'ORDINARY_PROFILE_ONLY']) expect(prepared.effectiveSystemPrompt).toContain(value);
  for (const value of ['SCOPE_PARENT_PRIVATE', 'SCOPE_SIDEBAR_PROJECT_DO_NOT_USE']) expect(prepared.effectiveSystemPrompt).not.toContain(value);
  const noProject = await f.prepareContext(child, null, { mode: 'agent', threadRole: 'read-only', projectId: null });
  expect(noProject.personalization).toMatchObject({ threadRole: 'read-only', projectId: null });
  expect(noProject.effectiveSystemPrompt).not.toContain('SCOPE_ADMITTED_PROJECT');
  const botContext = await f.prepareContext(bot, null, { mode: 'bot', threadRole: 'main', projectId: 'admitted-project' });
  for (const value of ['SCOPE_GLOBAL', 'SCOPE_ADMITTED_PROJECT', 'SCOPE_PARENT_PRIVATE', 'SCOPE_CHILD_PRIVATE', 'ORDINARY_PROFILE_ONLY']) expect(botContext.effectiveSystemPrompt).not.toContain(value);
});

it('failed and cancelled compaction candidates preserve the original checkpoint and raw conversation', async () => {
  let held: ServerResponse | undefined;
  let fail = true;
  const f = await fixture((body, response) => {
    if (!summaryRequest(body)) return complete(response);
    if (fail) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'deliberate fixture failure' } })); }
    else held = response;
  });
  const identity = await f.api.create('memory-compaction-failure');
  const note = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'BEFORE_FAILED_SUMMARY' });
  await turn(f, identity, 'original');
  await f.personalization.saveNote({ id: note.result.id, scope: note.result.scope, content: 'AFTER_FAILED_SUMMARY', revision: note.revision });
  await f.adapter.refreshPersonalization();
  const before = await f.api.snapshot(identity);
  const failed = await f.api.compact({ ...identity, key: 'failed-summary', throughId: before.historyPage.head!, expectedRevision: before.context.checkpoint!.revision, model });
  await expect.poll(async () => (await f.runtime.run(failed.receipt.run_id)).state).toBe('failed');
  await expect(f.api.publishContext(identity, failed.receipt.run_id)).rejects.toMatchObject({ status: 409 });
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(before.context.checkpoint);
  expect((await f.api.snapshot(identity)).history).toEqual(before.history);
  fail = false;
  const cancelled = await f.api.compact({ ...identity, key: 'cancelled-summary', throughId: before.historyPage.head!, expectedRevision: before.context.checkpoint!.revision, model });
  await expect.poll(() => Boolean(held)).toBe(true);
  await f.api.cancelContext(identity, cancelled.receipt.run_id);
  await expect.poll(async () => (await f.runtime.run(cancelled.receipt.run_id)).state).toBe('cancelled');
  complete(held!, 'LATE_CANCELLED_SUMMARY');
  await expect(f.api.publishContext(identity, cancelled.receipt.run_id)).rejects.toMatchObject({ status: 409 });
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(before.context.checkpoint);
  expect((await f.api.snapshot(identity)).history).toEqual(before.history);
});

it('the existing personalization document retains note identity and prompt sections through its first new write', async () => {
  const f = await fixture((_body, response) => complete(response));
  const workspaceId = '__varin_agent_personalization__';
  const grant = await f.kernel.issueGrant({ grantId: 'seed-existing-personalization', owningWorkspace: workspaceId,
    executionWorkspace: workspaceId, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const scoped = f.kernel.scoped(grant);
  const oldNote = { id: 41, scope: { kind: 'global' as const }, content: 'PREEXISTING_USER_NOTE', updatedAt: '2026-10-01T00:00:00.000Z' };
  const oldDocument = { memories: [oldNote], prompts: { global: { sections: { preserved_rule: 'PREEXISTING_USER_PROFILE' } } }, nextId: 42 };
  await scoped.putRecord({ operationId: 'seed-existing-document', workspaceId, recordId: 'agent.personalization',
    recordType: 'agent.personalization', state: 'active', payloadJson: JSON.stringify(oldDocument), ownerIds: [], references: [] });
  const before = await f.personalization.catalog();
  expect(before.memories).toEqual([oldNote]);
  expect(before.prompts).toEqual(oldDocument.prompts);
  const saved = await f.personalization.nativeMutation({ origin: 'review:preexisting:first-native-write', action: 'save', scope: { kind: 'global' }, content: 'NEW_USER_NOTE', revision: before.revision },
    { mode: 'agent', sessionId: 'existing-asset-thread', projectId: null });
  expect(saved.changes[0]!.id).toBe(42);
  expect(saved.revision).toBe(before.revision + 1);
  const after = await f.personalization.catalog();
  expect(after.memories).toEqual([oldNote, saved.changes[0]!.note]);
  expect(after.prompts).toEqual(oldDocument.prompts);
  await expect(f.personalization.saveNote({ id: 41, scope: oldNote.scope, content: 'STALE_OVERWRITE', revision: before.revision })).rejects.toMatchObject({ status: 409 });
  expect(await f.personalization.catalog()).toEqual(after);
});

it('a committed native mutation with a lost Host receipt reconciles after reopen and an intervening UI write without replay', async () => {
  const f = await fixture((_body, response) => complete(response));
  const identity = await f.api.create('lost-memory-receipt');
  await turn(f, identity, 'initialize-frozen-memory');
  const admitted = { mode: 'agent' as const, sessionId: identity.threadId, projectId: null };
  const input = { origin: 'review:model-step:lost-receipt:call-1', action: 'save' as const,
    scope: { kind: 'session' as const, id: identity.threadId }, content: 'COMMITTED_WITHOUT_HOST_RECEIPT', revision: 0 };
  const put = f.kernel.putRecord.bind(f.kernel);
  const getOperation = f.kernel.getOperation.bind(f.kernel);
  let committed = false;
  let writes = 0;
  f.kernel.putRecord = async (...args) => {
    const receipt = await put(...args);
    if (args[0].recordId === 'agent.personalization') { writes++; committed = true; throw new Error('fixture dropped committed put reply'); }
    return receipt;
  };
  f.kernel.getOperation = async (...args) => {
    if (committed) throw new Error('fixture Host transport unavailable before reconciliation');
    return getOperation(...args);
  };
  await expect(f.personalization.nativeMutation(input, admitted)).rejects.toThrow('fixture Host transport unavailable');
  expect(writes).toBe(1);
  f.kernel.putRecord = put;
  f.kernel.getOperation = getOperation;
  const afterCommit = await f.personalization.catalog();
  expect(afterCommit.revision).toBe(1);
  expect(afterCommit.memories.map(note => note.content)).toEqual(['COMMITTED_WITHOUT_HOST_RECEIPT']);
  const ui = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'INTERVENING_UI_WRITE', revision: 1 });
  expect(ui.revision).toBe(2);
  await f.close();

  const reopened = await fixture((_body, response) => complete(response), f.root, f.endpoint);
  const originalPut = reopened.kernel.putRecord.bind(reopened.kernel);
  let retryWrites = 0;
  reopened.kernel.putRecord = async (...args) => { retryWrites++; return originalPut(...args); };
  const receipt = await reopened.personalization.nativeMutation(input, admitted);
  expect(receipt).toMatchObject({ origin: input.origin, revision: 1,
    changes: [{ id: afterCommit.memories[0]!.id, scope: input.scope, note: afterCommit.memories[0] }] });
  expect(await reopened.personalization.mutationReceipt(input.origin)).toEqual(receipt);
  expect(retryWrites).toBe(0);
  expect((await reopened.personalization.catalog()).revision).toBe(2);
  expect((await reopened.personalization.catalog()).memories).toHaveLength(2);
  await expect(reopened.personalization.nativeMutation({ ...input, content: 'DIFFERENT_INTENT_SAME_ORIGIN' }, admitted)).rejects.toMatchObject({ status: 409 });
  expect(retryWrites).toBe(0);
  await turn(reopened, identity, 'recover-undelivered-facts');
  expect(tail(f.requests.at(-1)!.body)).toContain('COMMITTED_WITHOUT_HOST_RECEIPT');
  expect(tail(f.requests.at(-1)!.body)).toContain('INTERVENING_UI_WRITE');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).not.toContain('COMMITTED_WITHOUT_HOST_RECEIPT');
});

it('native and UI mutations use one exact revision CAS and scope moves retain old-scope deletion evidence', async () => {
  const f = await fixture((_body, response) => complete(response));
  const actor = { mode: 'agent' as const, sessionId: 'native-actor', projectId: 'project-a' };
  const nativeInput = { origin: 'review:cas:call-1', action: 'save' as const, scope: { kind: 'session' as const, id: actor.sessionId }, content: 'NATIVE_CAS', revision: 0 };
  const [native, ui] = await Promise.allSettled([
    f.personalization.nativeMutation(nativeInput, actor),
    f.personalization.saveNote({ scope: { kind: 'global' }, content: 'UI_CAS', revision: 0 }),
  ]);
  expect([native, ui].filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect([native, ui].find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  const catalog = await f.personalization.catalog();
  expect(catalog.revision).toBe(1); expect(catalog.memories).toHaveLength(1);
  const note = catalog.memories[0]!;
  const moved = await f.personalization.saveNote({ id: note.id, scope: { kind: 'project', id: 'project-b' }, content: note.content, revision: catalog.revision });
  expect(moved.receipt.changes).toEqual([
    { id: note.id, scope: note.scope, note: null },
    { id: note.id, scope: moved.result.scope, note: moved.result },
  ]);
  await expect(f.personalization.nativeMutation({ ...nativeInput, origin: 'review:cas:forbidden-scope', scope: { kind: 'session', id: 'another-thread' }, revision: moved.revision }, actor)).rejects.toMatchObject({ status: 403 });
  await expect(f.personalization.nativeMutation({ ...nativeInput, origin: 'review:cas:forbidden-id', id: note.id, revision: moved.revision }, actor)).rejects.toMatchObject({ status: 404 });
  await expect(f.personalization.nativeMutation({ ...nativeInput, origin: 'review:cas:bot', revision: moved.revision }, { ...actor, mode: 'bot' })).rejects.toThrow();
  expect((await f.personalization.catalog()).revision).toBe(moved.revision);
});

function toolCall(response: ServerResponse, callId: string, args: Record<string, unknown>) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [
    { id: `item-${callId}`, type: 'function_call', call_id: callId, name: 'native_memory', arguments: JSON.stringify(args) },
  ] } })}\n\n`);
}
it('actual native model tools share UI notes, keep reads cheap, enforce revision CAS and deliver each committed mutation once', async () => {
  let step = 0;
  const f = await fixture((_body, response) => {
    switch (++step) {
      case 1: return toolCall(response, 'memory-read-empty', { action: 'read' });
      case 2: return toolCall(response, 'memory-save', { action: 'save', content: 'REAL_NATIVE_MEMORY', scope: 'currentThread', revision: 0 });
      case 3: return toolCall(response, 'memory-read-saved', { action: 'read', scope: 'currentThread' });
      case 4: return toolCall(response, 'memory-stale-write', { action: 'save', id: 1, content: 'FORBIDDEN_STALE_MEMORY', revision: 0 });
      case 5: return toolCall(response, 'memory-delete', { action: 'delete', id: 1, scope: 'currentThread', revision: 1 });
      default: return complete(response);
    }
  });
  const identity = await f.api.create('real-native-memory-tools');
  const run = await turn(f, identity, 'exercise-native-memory');
  expect(f.requests).toHaveLength(6);
  const catalog = await f.personalization.catalog();
  expect(catalog.revision).toBe(2); expect(catalog.memories).toEqual([]);
  const history = (await f.api.snapshot(identity)).history;
  type ToolResult = { call_id: string; completion: { kind: string; outcome?: string; effect?: string; content?: Record<string, unknown> } };
  const results = history.filter(item => item.source === 'tool').map(item => (item.content as { content: { result: ToolResult } }).content.result);
  expect(results.map(result => result.call_id)).toEqual(['memory-read-empty', 'memory-save', 'memory-read-saved', 'memory-stale-write', 'memory-delete']);
  expect(results[0]!.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', effect: 'none', content: { revision: 0, notes: [] } });
  expect(results[1]!.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: {
    memoryReceipt: { revision: 1, changes: [{ id: 1, scope: { kind: 'session', id: identity.threadId }, note: { content: 'REAL_NATIVE_MEMORY' } }] },
  } });
  expect(results[2]!.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', effect: 'none', content: { revision: 1,
    notes: [{ id: 1, content: 'REAL_NATIVE_MEMORY', scope: { kind: 'session', id: identity.threadId } }] } });
  expect(results[3]!.completion).toMatchObject({ kind: 'not_dispatched' });
  expect(results[4]!.completion).toMatchObject({ kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: {
    memoryReceipt: { revision: 2, changes: [{ id: 1, scope: { kind: 'session', id: identity.threadId }, note: null }] },
  } });
  for (const request of f.requests) expect(JSON.stringify(system(request.body))).not.toContain('REAL_NATIVE_MEMORY');
  expect(history.filter(item => item.source === 'environment' && JSON.stringify(item).includes('REAL_NATIVE_MEMORY'))).toEqual([]);
  const toolQueries = f.memoryQueries.filter(query => query.action === 'tool');
  expect(toolQueries.map(query => query.arguments!.action)).toEqual(['read', 'save', 'read', 'save', 'delete']);
  expect(toolQueries.every(query => query.scope.sessionId === identity.threadId && query.runId === run.run_id)).toBe(true);
  const origin = toolQueries.find(query => query.arguments!.action === 'save')!.origin!;
  expect(await f.personalization.mutationReceipt(origin)).toMatchObject({ revision: 1 });
  const events = await f.runtime.events(0, 512);
  expect(events.filter(event => event.subject === run.run_id && event.kind === 'execution.committed'
    && (event.data as { kind?: string }).kind === 'tool_dispatched')).toHaveLength(3);
  await turn(f, identity, 'after-tool-delivery');
  expect((await f.api.snapshot(identity)).history.filter(item => item.source === 'environment' && JSON.stringify(item).includes('REAL_NATIVE_MEMORY'))).toEqual([]);
});

it('moving a note into another thread delivers a deletion to the old scope without leaking the new private text', async () => {
  const f = await fixture((_body, response) => complete(response));
  const parent = await f.api.create('memory-scope-move-parent');
  const child = await f.api.create('memory-scope-move-child');
  const original = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'PREVIOUSLY_GLOBAL_NOTE' });
  await turn(f, parent, 'parent-initial'); await turn(f, child, 'child-initial');
  await f.personalization.saveNote({ id: original.result.id, scope: { kind: 'session', id: child.threadId }, content: 'CHILD_PRIVATE_AFTER_MOVE', revision: original.revision });
  await turn(f, parent, 'parent-after-move');
  const parentRequest = f.requests.at(-1)!.body;
  expect(JSON.stringify(system(parentRequest))).toContain('PREVIOUSLY_GLOBAL_NOTE');
  expect(tail(parentRequest)).toContain(JSON.stringify('"note":null').slice(1, -1));
  expect(JSON.stringify(parentRequest)).not.toContain('CHILD_PRIVATE_AFTER_MOVE');
  await turn(f, child, 'child-after-move');
  const childRequest = f.requests.at(-1)!.body;
  expect(tail(childRequest).match(/CHILD_PRIVATE_AFTER_MOVE/g)).toHaveLength(1);
  expect(tail(childRequest)).toContain(JSON.stringify('"note":null').slice(1, -1));
});

it('reopening reconciles a real native tool whose domain commit outlived its lost Host bridge receipt', async () => {
  let calls = 0;
  const reply = (_body: Record<string, unknown>, response: ServerResponse) => {
    if (++calls === 1) return toolCall(response, 'lost-bridge-save', { action: 'save', content: 'NATIVE_BRIDGE_COMMITTED_NOTE', revision: 0 });
    complete(response);
  };
  const f = await fixture(reply);
  const identity = await f.api.create('lost-native-bridge-receipt');
  f.memoryControl.dropMutationReply = true;
  const run = await f.api.submit({ ...identity, key: 'lost-native-receipt-input', expectedHead: null, text: 'save note', model });
  await expect.poll(async () => ['completed', 'failed'].includes((await f.api.run(run.run_id)).state)).toBe(true);
  const catalog = await f.personalization.catalog();
  expect(catalog.revision).toBe(1); expect(catalog.memories).toHaveLength(1);
  const query = f.memoryQueries.find(item => item.action === 'tool' && item.arguments?.action === 'save')!;
  expect(query.origin).toBeTruthy();
  const operationId = query.origin!.slice(`native:${run.run_id}:`.length);
  expect(await f.runtime.operation(operationId)).toMatchObject({ outcome: 'indeterminate', effect: 'unknown' });
  await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'UI_WRITE_AFTER_LOST_BRIDGE', revision: 1 });
  await f.close();
  const reopened = await fixture(reply, f.root, f.endpoint);
  const put = reopened.kernel.putRecord.bind(reopened.kernel);
  let writes = 0;
  reopened.kernel.putRecord = async (...args) => { writes++; return put(...args); };
  const reconciled = await reopened.runtime.reconcileMemory(run.run_id);
  expect(reconciled).toMatchObject({ reconciled: [operationId], unresolved: [] });
  expect(reopened.memoryQueries.filter(item => item.action === 'receipt')).toMatchObject([{ origin: query.origin, arguments: query.arguments }]);
  expect(reopened.memoryQueries.some(item => item.action === 'tool')).toBe(false);
  expect(writes).toBe(0);
  expect(await reopened.runtime.operation(operationId)).toMatchObject({ outcome: 'succeeded', effect: 'confirmed' });
  expect((await reopened.personalization.catalog()).revision).toBe(2);
  expect(await reopened.personalization.mutationReceipt(query.origin!)).toMatchObject({ revision: 1,
    changes: [{ id: catalog.memories[0]!.id, note: catalog.memories[0] }] });
  const wireCount = f.requests.length;
  await reopened.runtime.reconcileMemory(run.run_id);
  expect(f.requests).toHaveLength(wireCount);
  expect(writes).toBe(0);
  const continuation = await turn(reopened, identity, 'continue-after-reconciliation');
  expect((await storedRequests(f.root, continuation.run_id))[0]!.view.history.filter(item => item.provenance.kind === 'environment_fact' && item.content.text?.includes('NATIVE_BRIDGE_COMMITTED_NOTE'))).toHaveLength(1);
  expect(tail(f.requests.at(-1)!.body)).toContain('UI_WRITE_AFTER_LOST_BRIDGE');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).not.toContain('NATIVE_BRIDGE_COMMITTED_NOTE');
});

type StoredRequest = { view: { request_id: string; history: Array<{ id: string; provenance: { kind: string; event_id?: string }; content: { kind: string; text?: string } }> }; serialized: unknown };
async function storedRequests(root: string, runId: string): Promise<StoredRequest[]> {
  const database = new DatabaseSync(path.join(root, 'agent-runtime', 'conversation.sqlite'), { readOnly: true });
  let rows: Array<{ body: string }>;
  try { rows = database.prepare('SELECT body FROM model_steps WHERE run_id=? ORDER BY rowid').all(runId) as Array<{ body: string }>; }
  finally { database.close(); }
  const read = async (hash: string) => {
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
    const hex = hash.slice('sha256-'.length);
    return fs.readFile(path.join(root, 'agent-runtime', 'content', 'objects', hex.slice(0, 2), hex.slice(2)));
  };
  return Promise.all(rows.map(async row => {
    const step = JSON.parse(row.body) as { request: { content_object: string } };
    const manifest = JSON.parse((await read(step.request.content_object)).toString()) as { chunks: string[]; bytes: number };
    const body = Buffer.concat(await Promise.all(manifest.chunks.map(read)));
    expect(body.length).toBe(manifest.bytes);
    return JSON.parse(body.toString()) as StoredRequest;
  }));
}
function memoryDeliveries(root: string, requestId: string) {
  const database = new DatabaseSync(path.join(root, 'agent-runtime', 'conversation.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT observer, fact_cursor, request, state FROM deliveries WHERE request=? AND observer LIKE ? ORDER BY observer').all(requestId, 'memory-delivery:%') as Array<{ observer: string; fact_cursor: number; request: string; state: string }>; }
  finally { database.close(); }
}
it('request-local memory facts have durable original bytes, stable IDs and per-request delivery evidence across reopen and fork', async () => {
  const f = await fixture((_body, response) => complete(response));
  const identity = await f.api.create('durable-memory-evidence');
  await turn(f, identity, 'initial-empty-snapshot');
  const note = await f.personalization.saveNote({ scope: { kind: 'global' }, content: 'DURABLE_MEMORY_FACT' });
  const first = await turn(f, identity, 'first-fact-request');
  const firstRequest = (await storedRequests(f.root, first.run_id))[0]!;
  const facts = firstRequest.view.history.filter(item => item.provenance.kind === 'environment_fact');
  expect(facts).toHaveLength(1); expect(facts[0]!.content.text).toContain('DURABLE_MEMORY_FACT');
  expect(facts[0]!.id).toBe(facts[0]!.provenance.event_id);
  const firstDelivery = memoryDeliveries(f.root, firstRequest.view.request_id);
  expect(firstDelivery).toHaveLength(1); expect(firstDelivery[0]!.state).toBe('"committed"');
  const head = (await f.api.snapshot(identity)).historyPage.head;
  const fork = await f.api.fork({ ...identity, key: 'fact-fork', headId: head });
  await f.close();
  const reopened = await fixture((_body, response) => complete(response), f.root, f.endpoint);
  const next = await turn(reopened, identity, 'repeat-fact-request');
  const nextRequest = (await storedRequests(f.root, next.run_id))[0]!;
  expect(nextRequest.view.history.filter(item => item.provenance.kind === 'environment_fact')).toEqual(facts);
  const nextDelivery = memoryDeliveries(f.root, nextRequest.view.request_id);
  expect(nextDelivery).toHaveLength(1); expect(nextDelivery[0]!.state).toBe('"committed"');
  expect(nextDelivery[0]!.fact_cursor).toBe(firstDelivery[0]!.fact_cursor);
  expect(nextDelivery[0]!.request).not.toBe(firstDelivery[0]!.request);
  expect((await storedRequests(f.root, first.run_id))[0]).toEqual(firstRequest);
  await reopened.personalization.removeNote(note.result.id, note.revision);
  const forkRun = await turn(reopened, fork, 'fork-sees-deletion');
  const forkRequest = (await storedRequests(f.root, forkRun.run_id))[0]!;
  const deleted = forkRequest.view.history.filter(item => item.provenance.kind === 'environment_fact');
  expect(deleted).toHaveLength(1); expect(deleted[0]!.content.text).toContain('"note":null');
  expect(deleted[0]!.id).not.toBe(facts[0]!.id);
  expect(memoryDeliveries(f.root, forkRequest.view.request_id)[0]!.observer).toContain(fork.branchId);
});

it('cancelling after a native note commit preserves the effect and a late Host result cannot revive the Run', async () => {
  let requests = 0;
  const f = await fixture((_body, response) => {
    if (++requests === 1) toolCall(response, 'cancel-after-memory-commit', { action: 'save', content: 'SAVED_BEFORE_CANCEL', revision: 0 });
    else complete(response);
  });
  let committed = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.memoryControl.afterMutation = async () => { committed = true; await gate; };
  const identity = await f.api.create('cancel-committed-memory');
  const run = await f.api.submit({ ...identity, key: 'cancel-commit-input', expectedHead: null, text: 'save note then wait', model });
  try {
    await expect.poll(() => committed).toBe(true);
    expect((await f.personalization.catalog()).memories[0]!.content).toBe('SAVED_BEFORE_CANCEL');
    await f.runtime.cancelRun(run.run_id);
    await expect.poll(async () => (await f.runtime.run(run.run_id)).state).toBe('cancelled');
    const before = f.requests.length;
    release(); f.memoryControl.afterMutation = undefined;
    await f.runtime.reconcileMemory(run.run_id);
    expect((await f.runtime.run(run.run_id)).state).toBe('cancelled');
    expect(f.requests).toHaveLength(before);
    expect((await f.personalization.catalog()).revision).toBe(1);
    const next = await turn(f, identity, 'continue-after-cancelled-commit');
    expect((await storedRequests(f.root, next.run_id))[0]!.view.history.some(item => item.provenance.kind === 'environment_fact' && item.content.text?.includes('SAVED_BEFORE_CANCEL'))).toBe(true);
    expect((await f.personalization.catalog()).revision).toBe(1);
  } finally { release(); }
});


it('a held Host context synchronization does not block cheap control or cancellation and its late reply cannot revive the Run', async () => {
  const f = await fixture((_body, response) => complete(response));
  const identity = await f.api.create('cancel-held-context');
  let entered!: () => void; let release!: () => void; let returned!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  const returnedGate = new Promise<void>(resolve => { returned = resolve; });
  f.memoryControl.beforeSynchronize = async () => { entered(); await releaseGate; returned(); };
  const run = await f.api.submit({ ...identity, key: 'held-context', expectedHead: null, text: 'await context safely', model });
  try {
    await enteredGate;
    const before = await f.runtime.context(identity.branchId);
    const start = performance.now();
    expect((await f.runtime.status()).epoch).toBeGreaterThan(0);
    await f.runtime.cancelRun(run.run_id);
    await expect.poll(async () => (await f.runtime.run(run.run_id)).state).toBe('cancelled');
    console.info('held-context-control-ms', performance.now() - start);
    expect(performance.now() - start, 'cheap status and cancellation must not await the unreleased Host gate').toBeLessThan(1_000);
    expect(f.requests).toHaveLength(0);
    release(); await returnedGate; f.memoryControl.beforeSynchronize = undefined;
    expect((await f.runtime.run(run.run_id)).state).toBe('cancelled');
    expect(await f.runtime.context(identity.branchId)).toEqual(before);
    await turn(f, identity, 'after-held-context-cancellation');
    expect(f.requests).toHaveLength(1);
  } finally { release(); }
});


it.each(['reject', 'throw'] as const)('main context owner %s becomes a durable failed Run without dispatch or checkpoint mutation', async failure => {
  const f = await fixture((_body, response) => complete(response));
  const identity = await f.api.create(`context-failure-${failure}`);
  await turn(f, identity, 'initial-checkpoint');
  const before = await f.api.snapshot(identity);
  f.memoryControl.synchronizeFailure = failure;
  const run = await f.api.submit({ ...identity, key: 'failed-context', expectedHead: before.historyPage.head, text: 'fail preparation honestly', model });
  await expect.poll(async () => (await f.runtime.run(run.run_id)).state).toBe('failed');
  expect(f.requests).toHaveLength(1);
  expect(await storedRequests(f.root, run.run_id)).toEqual([]);
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(before.context.checkpoint);
  const failures = (await f.runtime.events(0, 256)).filter(event => event.subject === run.run_id && event.kind === 'context.preparation_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]!.data).toMatchObject({ code: 'context_preparation_failed', message: expect.any(String) });
  expect(JSON.stringify(failures)).not.toContain('REVIEW_');
  await f.close();
  const reopened = await fixture((_body, response) => complete(response), f.root, f.endpoint);
  expect((await reopened.runtime.run(run.run_id)).state).toBe('failed');
  expect((await reopened.runtime.events(0, 256)).filter(event => event.subject === run.run_id && event.kind === 'context.preparation_failed')).toEqual(failures);
  expect((await reopened.api.snapshot(identity)).context.checkpoint).toEqual(before.context.checkpoint);
});
