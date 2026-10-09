import { createNativeLiveSourceOwner } from './native-live-source.js';
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
import { afterEach, expect, it, vi } from 'vitest';
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
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-live-source-review-'));
  const kernel = createKernelClient({ hostId: 'native-live-source-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
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
  const documents = createDocumentAuthority({ hostId: 'native-live-source-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'native-live-source-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const liveSources = createNativeLiveSourceOwner({ documents, kernel });
  const prepare = createNativeThreadSourcePreparer({ documents, workingStates, liveSources });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createNativeThreadContext({ personalization, workingStates, liveSource: { documents, validate: liveSources.validate }, projectForWorkspace: async () => 'selected-project' });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new NativeThreadAdapter(new NativeRuntimeClient(kernel, undefined, undefined, undefined, liveSources.validate), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async (source, identity) => { if (source.mode === 'live_root') await liveSources.admit(source, identity.threadId); else { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); } }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
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
  return { liveSources, adapter, storage, prepare, prepareContext, submissionErrors, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
const messages = (body: Record<string, unknown>) => body.input as Array<{ role?: string; content?: unknown }>;
const system = (body: Record<string, unknown>) => messages(body).filter(value => value.role === 'system');
function tool(response: ServerResponse, name: string, args: Record<string, unknown>, serial: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `item-${serial}`, type: 'function_call', call_id: `${name}-${serial}`, name, arguments: JSON.stringify(args) }] } })}\n\n`);
}
let answerSerial = 0;
function done(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `answer-${++answerSerial}`, type: 'message', content: [{ type: 'output_text', text: 'live source completed' }] }] } })}\n\n`);
}
const lastOutput = (body: Record<string, unknown>) => (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');

it('explicit live source reads current disk and shares actual root with list, search, conditional edits and processes', async () => {
  const outputs: string[] = []; let serial = 0; let processId = '';
  const f = await fixture((body, response) => {
    const output = lastOutput(body);
    if (output) outputs.push(String(output.output));
    const result = output ? JSON.parse(String(output.output)) : undefined;
    if (!output) tool(response, 'native_file_read', { path: 'source.txt' }, ++serial);
    else if (String(output.call_id).startsWith('native_file_read-')) tool(response, 'native_file_write', { path: 'source.txt', readVersion: result.content.readVersion, content: 'conditional live edit' }, ++serial);
    else if (String(output.call_id).startsWith('native_file_write-')) tool(response, 'native_process_spawn', { cwd: '', command: process.execPath, args: ['-e', 'const fs=require("node:fs");fs.writeFileSync("process.txt",fs.readFileSync("source.txt","utf8")+" process same root")'], mode: 'pipe' }, ++serial);
    else if (String(output.call_id).startsWith('native_process_spawn-')) { processId = result.operation_id; tool(response, 'native_process_inspect', { processId }, ++serial); }
    else if (String(output.call_id).startsWith('native_process_inspect-')) {
      if (result.content.writerActive) tool(response, 'native_process_inspect', { processId }, ++serial);
      else tool(response, 'native_file_list', {}, ++serial);
    } else if (String(output.call_id).startsWith('native_file_list-')) tool(response, 'native_file_search', { query: 'process same root', fixedStrings: true }, ++serial);
    else done(response);
  });
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'at preparation');
  const identity = await f.api.create('live-all-consumers');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live-root', path: f.workspace, mode: 'live_root' });
  expect(prepared.source).toMatchObject({ mode: 'live_root', liveRoot: { hostId: 'native-live-source-review', canonicalRoot: await fs.realpath(f.workspace) } });
  expect(prepared.source).not.toHaveProperty('branchId');
  expect(prepared.source).not.toHaveProperty('revision');
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed after preparation');
  const receipt = await f.api.submit({ ...identity, key: 'live-all-input', expectedHead: null, text: 'use the explicitly selected live source', model, source: prepared.source });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(outputs[0]).toContain('changed after preparation');
  expect(outputs.at(-2)).toContain('process.txt');
  expect(outputs.at(-1)).toContain('conditional live edit process same root');
  for (const output of [outputs[0], outputs.at(-2), outputs.at(-1)]) expect(JSON.parse(output!).content.source).toMatchObject({ mode: 'live_root', rootId: prepared.source.mode === 'live_root' ? prepared.source.liveRoot.rootId : '', liveRoot: prepared.source.mode === 'live_root' ? prepared.source.liveRoot : null });
  expect(await fs.readFile(path.join(f.workspace, 'source.txt'), 'utf8')).toBe('conditional live edit');
  expect(await fs.readFile(path.join(f.workspace, 'process.txt'), 'utf8')).toBe('conditional live edit process same root');
  expect((await f.runtime.launch(receipt.run_id))?.selection.source).toMatchObject({ mode: 'live_root', live_root: prepared.source.mode === 'live_root' ? prepared.source.liveRoot : null, branch_id: null, revision: null, environment_run_id: null });
  await expect(fs.access(path.join(f.root, 'managed/native-runs'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.launchErrors).toEqual([]);
}, 45_000);

it('rejects forged host, root, path and execution owner before durable input or context admission', async () => {
  const f = await fixture((_body, response) => done(response));
  const identity = await f.api.create('live-forgery');
  const prepared = await f.api.prepareSource({ ...identity, key: 'source-a', path: f.workspace, mode: 'live_root' });
  if (prepared.source.mode !== 'live_root') throw new Error('expected live source');
  const otherRoot = path.join(f.root, 'other-workspace'); await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(otherRoot, 'AGENTS.md'), 'UNAUTHORIZED WRONG ROOT INSTRUCTIONS');
  const other = await f.api.prepareSource({ ...identity, key: 'source-b', path: otherRoot, mode: 'live_root' });
  if (other.source.mode !== 'live_root') throw new Error('expected second live source');
  const source = prepared.source;
  const cases = [
    { ...source, liveRoot: { ...source.liveRoot, hostId: 'other-host-same-path' } },
    { ...source, liveRoot: { ...source.liveRoot, canonicalRoot: otherRoot } },
    { ...source, liveRoot: { ...source.liveRoot, rootId: other.source.liveRoot.rootId } },
    { ...source, executionWorkspaceId: other.source.workspaceId },
    { ...source, liveRoot: other.source.liveRoot },
    { ...source, branchId: 'pretend-live-is-fixed', revision: 0 },
  ];
  for (const [index, forged] of cases.entries()) {
    const response = await fetch(`${f.hostUrl}/api/native-threads/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-auth': 'fixture-client' }, body: JSON.stringify({ ...identity, key: `forged-${index}`, expectedHead: null, text: 'must not be admitted', model, source: forged }) });
    expect(response.status).toBe(400);
    expect((await f.api.snapshot(identity)).history).toEqual([]);
    expect((await f.api.snapshot(identity)).context.checkpoint).toBeNull();
  }
  expect(f.requests).toHaveLength(0);
}, 30_000);

it('freezes actual Documents AGENTS revision at first context while live reads and later turns remain current', async () => {
  let serial = 0; const outputs: string[] = [];
  const f = await fixture((body, response) => {
    if ((body.input as Array<Record<string, unknown>>).at(-1)?.type !== 'function_call_output') tool(response, 'native_file_read', { path: 'AGENTS.md' }, ++serial);
    else { outputs.push(String(lastOutput(body)!.output)); done(response); }
  });
  const identity = await f.api.create('live-context');
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'BEFORE LIVE PREPARATION');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live-context-source', path: f.workspace, mode: 'live_root' });
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'AT FIRST ADMISSION');
  const document = await f.documents.readSnapshot({ workspaceId: prepared.source.workspaceId, resourceId: 'AGENTS.md' });
  if (document.status !== 'ready') throw new Error('expected real document snapshot');
  const first = await f.api.submit({ ...identity, key: 'first', expectedHead: null, text: 'read instructions as file data', model, source: prepared.source });
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const snapshot = await f.api.snapshot(identity);
  const frozen = snapshot.context.checkpoint!;
  expect(JSON.stringify(system(f.requests[0]!.body))).toContain('AT FIRST ADMISSION');
  expect(frozen.proposal.instruction_sources.some(value => value.endsWith(`AGENTS.md:${document.revision}`))).toBe(true);
  expect(outputs[0]).toContain('AT FIRST ADMISSION');
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'LATER LIVE FILE CONTENT');
  const second = await f.api.submit({ ...identity, key: 'second', expectedHead: snapshot.historyPage.head, text: 'read again', model });
  await expect.poll(async () => (await f.api.run(second.run_id)).state).toMatch(/completed|failed/);
  expect((await f.api.run(second.run_id)).state, JSON.stringify({ errors: f.launchErrors.map(String), outputs })).toBe('completed');
  expect(outputs[1]).toContain('LATER LIVE FILE CONTENT');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).toContain('AT FIRST ADMISSION');
  expect(JSON.stringify(system(f.requests.at(-1)!.body))).not.toContain('LATER LIVE FILE CONTENT');
  expect((await f.api.snapshot(identity)).context.checkpoint?.proposal.instruction_sources).toEqual(frozen.proposal.instruction_sources);
  expect((await f.runtime.launch(second.run_id))?.selection.source).toEqual((await f.runtime.launch(first.run_id))?.selection.source);
  expect(f.launchErrors).toEqual([]);
}, 30_000);

it('live preparation does not capture a branch and failed fixed preparation never downgrades to live', async () => {
  const f = await fixture((_body, response) => done(response));
  const identity = await f.api.create('no-live-fallback');
  const capture = vi.spyOn(f.workingStates, 'withBranchStore').mockRejectedValue(new Error('fixture immutable capture unavailable'));
  const live = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  expect(live.source.mode).toBe('live_root');
  expect(capture).not.toHaveBeenCalled();
  await expect(f.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' })).rejects.toMatchObject({ status: 400 });
  expect(capture).toHaveBeenCalledTimes(1);
  expect((await f.api.snapshot(identity)).history).toEqual([]);
  expect(f.requests).toHaveLength(0);
  capture.mockRestore();
});

it('queued live selection reopens with fresh authority and reads changed disk without acquiring immutable lineage', async () => {
  let serial = 0; let output = '';
  const reply = (body: Record<string, unknown>, response: ServerResponse) => {
    if (!JSON.stringify(body.input).includes('queued live request')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting for test cancellation\n\n'); return;
    }
    const last = lastOutput(body);
    if (!last) tool(response, 'native_file_read', { path: 'source.txt' }, ++serial);
    else { output = String(last.output); done(response); }
  };
  const f = await fixture(reply);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'before queue');
  const identity = await f.api.create('live-queued-restart');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  const first = await f.api.submit({ ...identity, key: 'held', expectedHead: null, text: 'hold first model request', model, source: prepared.source });
  await expect.poll(() => f.requests.length).toBe(1);
  // Leave the admitted successor unprepared, as if its first Host callback was interrupted.
  const next = await f.runtime.enqueue({ threadId: identity.threadId, branchId: identity.branchId, key: 'queued', mode: 'next_run', input: { text: 'queued live request' } });
  const selection = (await f.runtime.launch(next.run_id))!.selection.source;
  const epoch = f.kernel.kernelEpoch;
  await f.close();
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed while Host was closed');
  const reopened = await fixture(reply, f.root, f.endpoint);
  const grants = vi.spyOn(reopened.kernel, 'issueGrant');
  await reopened.adapter.resume(next.run_id);
  expect(reopened.kernel.kernelEpoch).not.toBe(epoch);
  await reopened.runtime.cancelRun(first.run_id);
  await expect.poll(async () => (await reopened.api.run(next.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(output).toContain('changed while Host was closed');
  expect((await reopened.runtime.launch(next.run_id))!.selection.source).toEqual(selection);
  expect(selection).toMatchObject({ mode: 'live_root', branch_id: null, revision: null, environment_run_id: null });
  expect(grants.mock.calls.some(([grant]) => grant.runId === next.run_id && grant.grantId.startsWith('native-source:'))).toBe(true);
  expect(reopened.launchErrors).toEqual([]);
}, 45_000);

it('registered canonical-root retarget is rejected on rebind and cannot read a same-name replacement environment', async () => {
  const f = await fixture((_body, response) => done(response));
  const identity = await f.api.create('live-root-retarget');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  if (prepared.source.mode !== 'live_root') throw new Error('expected live source');
  const selected = prepared.source;
  const run = await f.runtime.submit({ key: 'retarget-input', threadId: identity.threadId, branchId: identity.branchId, expectedHead: null, input: { text: 'do not read a redirected root' },
    configuration: { providerFamily: 'openai-responses', model: 'fixture-model', endpoint: f.endpoint, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 },
    launch: { source: { mode: 'live_root', workspaceId: selected.workspaceId, executionWorkspaceId: selected.executionWorkspaceId, branchId: null, revision: null, liveRoot: selected.liveRoot }, enabledTools: ['file_read'] } });
  const preserved = path.join(f.root, 'preserved-original');
  const other = path.join(f.root, 'replacement');
  await fs.mkdir(other); await fs.writeFile(path.join(other, 'source.txt'), 'WRONG ROOT MUST NOT BE READ');
  await fs.rename(f.workspace, preserved);
  await fs.symlink(other, f.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const before = (await f.runtime.launch(run.run_id))!.selection.source;
  await expect(f.runtime.rebindLaunch(run.run_id)).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
  expect((await f.runtime.launch(run.run_id))!.selection.source).toEqual(before);
  expect(await fs.readFile(path.join(other, 'source.txt'), 'utf8')).toBe('WRONG ROOT MUST NOT BE READ');
  await f.runtime.cancelRun(run.run_id);
}, 30_000);

it('cancelling during live owner validation never issues executable authority or publishes a model request', async () => {
  const f = await fixture((_body, response) => done(response));
  const identity = await f.api.create('live-cancel-validation');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new NativeRuntimeClient(f.kernel, undefined, undefined, undefined, async (source, signal) => {
    entered = true; await gate; await f.liveSources.validate(source, signal);
  });
  const pending = await runtime.submit({ key: 'cancel-validation', threadId: identity.threadId, branchId: identity.branchId, expectedHead: null, input: { text: 'cancel before authority' },
    configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: f.endpoint, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
  const grants = vi.spyOn(f.kernel, 'issueGrant');
  const launch = runtime.startFromSource({ ...prepared.source, runId: pending.run_id });
  const rejected = expect(launch).rejects.toThrow();
  await expect.poll(() => entered).toBe(true);
  await runtime.cancelRun(pending.run_id);
  release();
  await rejected;
  expect(grants.mock.calls.filter(([grant]) => grant.grantId.startsWith('native-source:'))).toHaveLength(0);
  expect(await runtime.launch(pending.run_id)).toBeNull();
  expect((await runtime.run(pending.run_id)).state).toBe('cancelled');
  expect(f.requests).toHaveLength(0);
}, 30_000);

it('cancelling after actual live-root registration revokes the fresh grant before a late registration reply can start work', async () => {
  const f = await fixture((_body, response) => done(response));
  const identity = await f.api.create('live-cancel-registration');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  const pending = await f.runtime.submit({ key: 'cancel-registration', threadId: identity.threadId, branchId: identity.branchId, expectedHead: null, input: { text: 'cancel registered root launch' },
    configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: f.endpoint, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.kernel.fileRootRegister.bind(f.kernel);
  const registration = vi.spyOn(f.kernel, 'fileRootRegister').mockImplementation(async (...args) => {
    const result = await original(...args); entered = true; await gate; return result;
  });
  const grants = vi.spyOn(f.kernel, 'issueGrant');
  const revocations = vi.spyOn(f.kernel, 'revokeGrant');
  const launch = f.runtime.startFromSource({ ...prepared.source, runId: pending.run_id });
  const rejected = expect(launch).rejects.toThrow();
  await expect.poll(() => entered).toBe(true);
  await f.runtime.cancelRun(pending.run_id);
  release();
  await rejected;
  const issued = grants.mock.calls.find(([grant]) => grant.grantId.startsWith('native-source:'))![0].grantId;
  await expect.poll(() => revocations.mock.calls.some(([grantId]) => grantId === issued)).toBe(true);
  await revocations.mock.results[revocations.mock.calls.findIndex(([grantId]) => grantId === issued)]!.value;
  const grant = await grants.mock.results[grants.mock.calls.findIndex(([value]) => value.grantId === issued)]!.value;
  await expect(f.kernel.scoped(grant).fileRootRegister({ workspaceId: prepared.source.workspaceId, executionWorkspaceId: prepared.source.executionWorkspaceId, canonicalRoot: f.workspace })).rejects.toThrow(/revoked/i);
  expect((await f.runtime.run(pending.run_id)).state).toBe('cancelled');
  expect(f.requests).toHaveLength(0);
  registration.mockRestore();
}, 30_000);

it('live read and discovery do not authorize a returned path that escapes its registered root', async () => {
  const returned: Array<Record<string, unknown>> = []; let serial = 0;
  const f = await fixture((body, response) => {
    const output = lastOutput(body); if (output) returned.push(JSON.parse(String(output.output)) as Record<string, unknown>);
    serial++;
    if (serial === 1) tool(response, 'native_file_read', { path: 'outside/private.txt' }, serial);
    else if (serial === 2) tool(response, 'native_file_search', { query: 'UNAUTHORIZED OUTSIDE CONTENT', fixedStrings: true }, serial);
    else done(response);
  });
  const outside = path.join(f.root, 'not-selected'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'UNAUTHORIZED OUTSIDE CONTENT');
  await fs.symlink(outside, path.join(f.workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const identity = await f.api.create('live-containment');
  const prepared = await f.api.prepareSource({ ...identity, key: 'live', path: f.workspace, mode: 'live_root' });
  const receipt = await f.api.submit({ ...identity, key: 'containment', expectedHead: null, text: 'verify selected root access', model, source: prepared.source });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(returned).toHaveLength(2);
  expect(returned[0]).not.toMatchObject({ outcome: 'succeeded' });
  expect(JSON.stringify(returned)).not.toContain('UNAUTHORIZED OUTSIDE CONTENT');
  expect(await fs.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('UNAUTHORIZED OUTSIDE CONTENT');
}, 30_000);

it('the kernel refuses process effects attached to a fixed branch even with a valid live root grant', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) tool(response, 'native_process_spawn', { cwd: '', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("forbidden.txt","wrong fixed-source effect")'], mode: 'pipe' }, 1); else done(response); });
  const identity = await f.api.create('fixed-process-refusal');
  const prepared = await f.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  if (prepared.source.mode === 'live_root') throw new Error('expected fixed branch');
  const source = prepared.source;
  const pending = await f.runtime.submit({ key: 'fixed-process', threadId: identity.threadId, branchId: identity.branchId, expectedHead: null, input: { text: 'fixed source must not execute process' },
    configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: f.endpoint, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
  const grant = await f.kernel.issueGrant({ grantId: 'fixed-process-attempt', owningWorkspace: source.workspaceId, executionWorkspace: source.executionWorkspaceId, threadId: identity.threadId, runId: pending.run_id,
    capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const registered = await f.kernel.scoped(grant).fileRootRegister({ workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, canonicalRoot: f.workspace });
  await expect(f.runtime.startRun(pending.run_id, undefined, { grantId: grant.grantId, runId: pending.run_id, threadId: identity.threadId,
    workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, sourceMode: 'fixed_branch', rootId: registered.rootId,
    fileSource: { branchId: source.branchId, revision: source.revision }, enabledTools: ['process_spawn'] })).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
  await expect(fs.access(path.join(f.workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.runtime.cancelRun(pending.run_id);
  await f.kernel.revokeGrant(grant.grantId);
}, 30_000);
