import express from 'express';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { configureRuntimeUrlResolver, createNativeThreadsHttpAPI, setRuntimeExtraHeaders } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { createKernelClient } from './kernel-client.js';
import { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { NativeThreadCollaboration } from './native-thread-collaboration.js';
import { NativeThreadAdapter } from './native-thread-adapter.js';
import { createNativeThreadContext, type NativeContextPreparer } from './native-thread-context.js';
import { registerNativeThreadRoutes } from './native-thread-routes.js';
import { createNativeThreadSourcePreparer } from './native-thread-sources.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? '';
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRuntimeExtraHeaders(null);
  configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' });
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function listen(server: Server): Promise<{ url: string; close(): Promise<void> }> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP listener');
  let closed = false;
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    if (closed) return; closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type RecordedRequest = { body: Record<string, unknown>; response: ServerResponse };
const model = { providerId: 'child-review-provider', modelId: 'child-review-model' };
function complete(response: ServerResponse, output: unknown[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
}
function tool(name: string, args: unknown, id: string) {
  return { id: `item-${id}`, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) };
}
function answer(text: string, id: string) {
  return { id, type: 'message', content: [{ type: 'output_text', text }] };
}
function result(body: Record<string, unknown>, name?: string) {
  const items = body.input as Array<Record<string, unknown>>;
  const call = name ? items.findLast(item => item.type === 'function_call' && item.name === name) : undefined;
  const output = items.findLast(item => item.type === 'function_call_output' && (!call || item.call_id === call.call_id));
  return output ? JSON.parse(String(output.output)) as Record<string, unknown> : undefined;
}
function assertPairing(body: Record<string, unknown>) {
  const pending = new Set<string>();
  for (const item of body.input as Array<Record<string, unknown>>) {
    if (item.type === 'function_call') { expect(pending.has(String(item.call_id))).toBe(false); pending.add(String(item.call_id)); }
    else if (item.type === 'function_call_output') expect(pending.delete(String(item.call_id)), 'output owns an earlier call').toBe(true);
    else if (item.role === 'user') expect([...pending], 'new data must follow closed tool exchanges').toEqual([]);
  }
  expect([...pending], 'request cannot contain unresolved tool calls').toEqual([]);
}

/** Real Host routing, Rust kernel, Documents/WorkingState and personalization. Only the paid
 * provider is replaced with loopback protocol fixtures. The caller controls precise barriers. */
async function fixture(reply: (request: RecordedRequest, index: number) => void) {
  if (!kernelPath) throw new Error('Review requires an explicit frozen VARIN_TEST_KERNEL_PATH');
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-child-review-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'source.txt'), 'fixed child source before parent changes');
  const requests: RecordedRequest[] = [];
  const provider = await listen(createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const value = { body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, response };
      requests.push(value); reply(value, requests.length);
    });
  }));
  cleanup.push(provider.close);
  const endpoint = `${provider.url}/responses`;
  const configuration = { providerFamily: 'openai-responses', model: model.modelId, endpoint,
    credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 128 };
  let projectId = 'child-review-project'; let trusted = true;
  async function openHost(options: { context?: (original: NativeContextPreparer) => NativeContextPreparer; collaboration?: boolean; sourceGrantScopes?: string[] } = {}) {
    let kernelProcess: ChildProcess | undefined;
    const kernel = createKernelClient({ hostId: 'child-review-host', storageRoot: root, buildVersion,
      kernelPath, allowCargoDevRunner: false, spawnProcess: ((command, args, options) => { kernelProcess = spawn(command, args ?? [], options ?? {}); return kernelProcess; }) as typeof spawn });
    const grants: Array<{ runId: string; grantId: string; pathScopes: string[] }> = [];
    const issueGrant = kernel.issueGrant.bind(kernel);
    kernel.issueGrant = async (input, signal) => {
      const selected = input.grantId.startsWith('native-source:') && options.sourceGrantScopes ? { ...input, pathScopes: options.sourceGrantScopes } : input;
      const grant = await issueGrant(selected, signal);
      if (selected.grantId.startsWith('native-source:') && selected.runId) grants.push({ runId: selected.runId, grantId: grant.grantId, pathScopes: selected.pathScopes });
      return grant;
    };
    const documents = createDocumentAuthority({ hostId: 'child-review-host', dataDir: path.join(root, 'documents'),
      isAllowedRoot: async () => true, isTrusted: async () => trusted });
    const storage = new KernelStorageAdapter({ client: kernel, hostId: 'child-review-host', storageRoot: root,
      resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
    const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
    const personalization = createAgentPersonalization({ client: kernel,
      context: async () => ({ bot: false, projectId }) });
    const originalContext = createNativeThreadContext({ personalization, workingStates,
      projectForWorkspace: async () => projectId });
    const prepareContext = options.context?.(originalContext) ?? originalContext;
    const credentialOwner = new ExistingHostCredentialOwner({ providerId: model.providerId,
      providerFamily: configuration.providerFamily, endpoint,
      currentScope: async () => ({ reference: 'child-review-reference', authority: 'child-review-authority',
        account: 'child-review-account', generation: 1 }),
      runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-child-review-key-not-a-real-secret' } }) } });
    const runtime = new NativeRuntimeClient(kernel);
    const errors: unknown[] = [];
    const models = { resolveModel: async (selection: typeof model) => {
      if (selection.providerId !== model.providerId || selection.modelId !== model.modelId) throw new Error('Unknown fixture model');
      return { configuration, credentialOwner };
    }, rebindModel: async () => credentialOwner };
    const adapter = new NativeThreadAdapter(runtime, models, async source => {
      await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId);
    }, (_runId, error) => { errors.push(error); }, createNativeThreadSourcePreparer({ documents, workingStates }), prepareContext);
    const collaboration = options.collaboration === false ? undefined : new NativeThreadCollaboration({ runtime, models, workingStates, prepareContext, admitSource: async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, onError: (_operation, error) => { errors.push(error); } });
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerNativeThreadRoutes(app, adapter, (request, response, next) => {
      if (request.headers['x-review-auth'] !== 'child-review') { response.sendStatus(401); return; }
      next();
    });
    const host = await listen(createServer(app));
    configureRuntimeUrlResolver({ apiBaseUrl: host.url, realtimeBaseUrl: host.url });
    setRuntimeExtraHeaders({ 'x-review-auth': 'child-review' });
    let closed = false; let crashed = false;
    const close = async () => {
      if (closed) return; closed = true;
      collaboration?.stop(); await host.close();
      try { await storage.dispose(); } catch (error) { if (!crashed || !String(error).includes('Kernel client is closed')) throw error; }
      finally { await documents.dispose(); await kernel.close(); }
    };
    cleanup.push(close);
    const crash = async () => {
      collaboration?.stop();
      if (!kernelProcess || kernelProcess.exitCode !== null || kernelProcess.signalCode !== null) throw new Error('Fixture kernel is not running');
      crashed = true;
      const exited = once(kernelProcess, 'exit');
      if (!kernelProcess.kill('SIGKILL')) throw new Error('Could not kill this fixture kernel');
      await exited; await kernel.close();
    };
    return { kernel, grants, crash, runtime, adapter, collaboration, models, prepareContext, workingStates, personalization, documents,
      errors, close, api: createNativeThreadsHttpAPI(), hostUrl: host.url };
  }
  return { root, workspace, requests, openHost, setProject(value: string) { projectId = value; }, setTrusted(value: boolean) { trusted = value; } };
}


const dispatch = { task: 'CHILD_TASK: inspect source.txt and send a report', model: 'parent', profile: 'read_only' };
const isParent = (body: Record<string, unknown>) => (body.tools as Array<{ name: string }>).some(item => item.name === 'native_dispatch');
const job = (body: Record<string, unknown>) => {
  const receipt = result(body, 'native_dispatch');
  expect(receipt?.kind).toBe('job_accepted');
  expect(typeof receipt?.operation_id).toBe('string');
  return String(receipt!.operation_id);
};
function blockChild(original: NativeContextPreparer, entered: ReturnType<typeof gate>, release: ReturnType<typeof gate>): NativeContextPreparer {
  const prepare: NativeContextPreparer = Object.assign(async (...args: Parameters<NativeContextPreparer>) => {
    if (args[2].threadRole === 'worker') { entered.release(); await release.promise; }
    return original(...args);
  }, { main: original.main, ...(original.refresh ? { refresh: original.refresh } : {}) });
  return prepare;
}

it('real dispatch returns before child preparation; parent reads, waits, and receives fixed-source scoped report exactly once', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    assertPairing(body);
    if (isParent(body)) {
      parentSteps++;
      if (parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch'), tool('native_file_read', { path: 'source.txt' }, 'parent-read')]);
      else if (parentSteps === 2) {
        operationId = job(body);
        expect(JSON.stringify(result(body, 'native_file_read'))).toContain('fixed child source before parent changes');
        complete(response, [tool('native_wait_child', { operationId }, 'wait-child')]);
      } else complete(response, [answer('Parent received the true child report', 'parent-final')]);
    } else {
      childSteps++;
      if (childSteps === 1) complete(response, [tool('native_file_read', { path: 'source.txt' }, 'child-read')]);
      else {
        expect(JSON.stringify(result(body, 'native_file_read'))).toContain('fixed child source before parent changes');
        complete(response, [answer('CHILD_REPORT: fixed source verified; no changes', 'child-final')]);
      }
    }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-scope');
  await h.personalization.saveNote({ scope: { kind: 'session', id: identity.threadId }, content: 'PARENT_SESSION_SECRET' });
  await h.personalization.saveNote({ scope: { kind: 'project', id: 'child-review-project' }, content: 'SHARED_ADMITTED_PROJECT_NOTE' });
  await h.personalization.saveNote({ scope: { kind: 'project', id: 'other-project' }, content: 'UNRELATED_CHANGED_PROJECT_NOTE' });
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  prepared.source.tools = ['file_read'];
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'PARENT_TASK: delegate then read and wait', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('waiting');
  expect(parentSteps).toBe(2); expect(childSteps).toBe(0);
  expect(operationId).not.toBe('');
  const accepted = await h.runtime.child(operationId);
  expect(accepted).toMatchObject({ parent_run_id: receipt.run_id, parent_thread_id: identity.threadId, parent_branch_id: identity.branchId,
    project_id: 'child-review-project', state: 'preparing', receipt: null });
  expect((await h.runtime.status()).eventCursor).toBeGreaterThan(accepted.cursor);
  f.setProject('other-project');
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed live parent disk must never leak into child');
  release.release();
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const child = await h.runtime.child(operationId);
  expect(child.report).toMatchObject({ outcome: 'succeeded', sender_thread_id: child.child_thread_id, code_result: 'no_changes' });
  expect((await h.runtime.readChildReport(operationId, child.report!.history_ids.at(-1)!)).text).toContain('CHILD_REPORT');
  expect(child.launch.tools.map(item => item.name)).toEqual(['native_file_read']);
  const childBodies = f.requests.filter(request => !isParent(request.body));
  expect(childBodies).toHaveLength(2);
  expect(JSON.stringify(childBodies[0]!.body)).toContain('SHARED_ADMITTED_PROJECT_NOTE');
  expect(JSON.stringify(childBodies.map(request => request.body))).not.toContain('PARENT_SESSION_SECRET');
  expect(JSON.stringify(childBodies.map(request => request.body))).not.toContain('UNRELATED_CHANGED_PROJECT_NOTE');
  const context = await h.runtime.context(child.child_branch_id);
  expect(context?.personalization).toMatchObject({ mode: 'agent', threadRole: 'worker', projectId: 'child-review-project', sessionId: child.child_thread_id });
  const history = (await h.api.snapshot(identity)).history;
  const reports = history.filter(item => item.source === 'agent');
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports[0]!.content)).toContain('CHILD_REPORT');
  expect(JSON.stringify(reports[0]!.content)).toContain(child.child_thread_id);
  expect(JSON.stringify(f.requests.filter(request => isParent(request.body)).at(-1)!.body)).toContain('other-agent data');
  expect(parentSteps).toBe(3); expect(childSteps).toBe(2); expect(h.errors.map(String)).toEqual([]);
  await h.close();
  const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  expect((await reopened.runtime.child(operationId)).report).toEqual(child.report);
  expect((await reopened.api.snapshot(identity)).history).toEqual(history);
  expect(parentSteps).toBe(3); expect(childSteps).toBe(2);
}, 30_000);

it('parent final survives independently; cancelling preparing child fences late context and releases its real pin', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (!isParent(body)) { childSteps++; complete(response, [answer('unexpected child launch', 'unexpected')]); return; }
    if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
    else { operationId = job(body); complete(response, [answer('Parent is final while child is preparing', 'parent-final')]); }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-cancel');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch and finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect((await h.runtime.child(operationId)).state).toBe('preparing');
  await h.runtime.cancelChild(operationId);
  release.release();
  await expect.poll(async () => (await h.runtime.child(operationId)).resources_released).toBe(true);
  const child = await h.runtime.child(operationId);
  expect(child.receipt).toBeNull(); expect(child.report?.outcome).toBe('cancelled'); expect(childSteps).toBe(0);
  await h.workingStates.withBranchStore(prepared.source.workspaceId, 'review-cleanup-evidence', async store => {
    expect(await store.getBranchRoot(`native-child-source:${operationId}`)).toBeNull();
    await expect(store.openBranchHandoffPin!(child.source_pin.source.branch_id!, child.source_pin.pin_id,
      { root: child.source_pin.root, revision: child.source_pin.source.revision!, writeRevision: child.source_pin.source.revision! })).rejects.toThrow();
  }, 'shared', { threadId: child.child_thread_id });
  expect((await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect(parentSteps).toBe(2);
}, 20_000);

it('accepted child preparation resumes after Host/kernel reopen without replaying the parent model request', async () => {
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    assertPairing(body);
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent done', 'parent-final')]); }
    } else {
      if (++childSteps === 1) complete(response, [tool('native_file_read', { path: 'source.txt' }, 'child-read')]);
      else { expect(JSON.stringify(result(body))).toContain('fixed child source before parent changes'); complete(response, [answer('REOPENED_CHILD_REPORT', 'child-final')]); }
    }
  });
  const h = await f.openHost({ collaboration: false });
  const identity = await h.api.create('child-review-reopen-prepare');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch and finish', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  const child = await h.runtime.child(operationId);
  expect(child.state).toBe('preparing'); expect(child.receipt).toBeNull(); expect(childSteps).toBe(0);
  await h.close();
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'new live data after restart');
  const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  await expect.poll(async () => (await reopened.runtime.child(operationId)).report?.outcome, { timeout: 10_000 }).toBe('succeeded');
  const finished = await reopened.runtime.child(operationId);
  expect(finished.child_thread_id).toBe(child.child_thread_id);
  expect((await reopened.runtime.readChildReport(operationId, finished.report!.history_ids.at(-1)!)).text).toBe('REOPENED_CHILD_REPORT');
  expect(await reopened.runtime.children()).toHaveLength(1);
  expect(parentSteps).toBe(2); expect(childSteps).toBe(2);
}, 25_000);

it('a later Run of the same parent Thread can observe and wait for an independently handed-off child', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    assertPairing(body);
    if (isParent(body)) {
      parentSteps++;
      if (parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else if (parentSteps === 2) { operationId = job(body); complete(response, [answer('Parent first Run is complete', 'first-parent-final')]); }
      else if (parentSteps === 3) complete(response, [tool('native_child_status', { operationId }, 'status-from-later-run'), tool('native_wait_child', { operationId }, 'wait-from-later-run')]);
      else complete(response, [answer('Later parent Run has the handed-off report', 'second-parent-final')]);
    } else {
      childSteps++;
      complete(response, [answer('REPORT_FOR_LATER_PARENT_RUN', 'child-final')]);
    }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-parent-continuation');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const first = await h.api.submit({ ...identity, key: 'first-input', expectedHead: null, text: 'dispatch and finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(first.run_id)).state).toBe('completed');
  const accepted = await h.runtime.child(operationId);
  f.setProject('changed-sidebar-project');
  const second = await h.api.submit({ ...identity, key: 'second-input', expectedHead: (await h.api.snapshot(identity)).historyPage.head,
    text: 'Now inspect and wait for the previous child', model });
  expect(second.run_id).not.toBe(first.run_id);
  await expect.poll(async () => (await h.runtime.run(second.run_id)).state).toBe('waiting');
  expect(childSteps).toBe(0);
  release.release();
  await expect.poll(async () => (await h.runtime.run(second.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const final = await h.runtime.child(operationId);
  expect(final.parent_run_id).toBe(first.run_id);
  expect(final.child_thread_id).toBe(accepted.child_thread_id);
  expect(final.project_id).toBe('child-review-project');
  const status = result(f.requests.filter(request => isParent(request.body)).at(-1)!.body, 'native_child_status');
  expect(status?.outcome).toBe('succeeded');
  expect(JSON.stringify(status)).toContain(accepted.child_thread_id);
  const reports = (await h.api.snapshot(identity)).history.filter(item => item.source === 'agent');
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports)).toContain('REPORT_FOR_LATER_PARENT_RUN');
  expect(parentSteps).toBe(4); expect(childSteps).toBe(1); expect(h.errors.map(String)).toEqual([]);
}, 25_000);

it('a dispatched child model request is not replayed after Host/kernel loss', async () => {
  const childRequested = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent handed off', 'parent-final')]); }
    } else { childSteps++; childRequested.release(); /* The loopback provider has received a billable-equivalent request; do not reply. */ }
  });
  const h = await f.openHost();
  const identity = await h.api.create('child-review-no-paid-replay');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch and finish', model, source: prepared.source });
  await childRequested.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  const child = await h.runtime.child(operationId);
  expect(child.receipt).not.toBeNull(); expect(childSteps).toBe(1);
  await h.crash(); await h.close();
  const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  const recovered = await reopened.runtime.run(child.receipt!.run_id);
  expect(recovered.state).not.toBe('generating');
  expect(childSteps).toBe(1); expect(parentSteps).toBe(2);
  expect((await reopened.runtime.child(operationId)).child_thread_id).toBe(child.child_thread_id);
  const events = await reopened.runtime.events(0, 1000);
  expect(events.some(event => event.kind === 'model.interrupted')).toBe(true);
}, 20_000);

it('committed child output survives a lost report delivery and resumes the original parent Wait once', async () => {
  const childRequested = gate(); let childResponse: ServerResponse | undefined;
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    assertPairing(body);
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else if (parentSteps === 2) { operationId = job(body); complete(response, [tool('native_wait_child', { operationId }, 'wait-child')]); }
      else { expect(JSON.stringify(body)).toContain('REPORT_COMMITTED_BEFORE_HOST_LOSS'); complete(response, [answer('Recovered report received', 'parent-final')]); }
    } else { childSteps++; childResponse = response; childRequested.release(); }
  });
  const h = await f.openHost();
  const identity = await h.api.create('child-review-report-recovery');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch then wait', model, source: prepared.source });
  await childRequested.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('waiting');
  const child = await h.runtime.child(operationId);
  await expect.poll(async () => (await h.runtime.launch(child.receipt!.run_id))?.requires_rebind).toBe(false);
  h.collaboration!.stop();
  complete(childResponse!, [answer('REPORT_COMMITTED_BEFORE_HOST_LOSS', 'child-final')]);
  await expect.poll(async () => (await h.runtime.run(child.receipt!.run_id)).state).toBe('completed');
  expect(parentSteps).toBe(2);
  await h.close();
  const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  await expect.poll(async () => (await reopened.runtime.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const reports = (await reopened.api.snapshot(identity)).history.filter(item => item.source === 'agent');
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports[0])).toContain('REPORT_COMMITTED_BEFORE_HOST_LOSS');
  expect((await reopened.runtime.child(operationId)).report?.sender_thread_id).toBe(child.child_thread_id);
  expect(parentSteps).toBe(3); expect(childSteps).toBe(1);
}, 25_000);

it('model-supplied parent, source, project and grant fields cannot manufacture child authority', async () => {
  let steps = 0;
  const f = await fixture(({ body, response }) => {
    if (++steps === 1) complete(response, [
      tool('native_dispatch', { ...dispatch, parentRunId: 'forged-parent' }, 'forge-parent'),
      tool('native_dispatch', { ...dispatch, source: { branchId: 'foreign-source' } }, 'forge-source'),
      tool('native_dispatch', { ...dispatch, projectId: 'foreign-project' }, 'forge-project'),
      tool('native_dispatch', { ...dispatch, grantId: 'foreign-grant' }, 'forge-grant'),
    ]);
    else {
      const outputs = (body.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
      expect(outputs).toHaveLength(4);
      for (const output of outputs) {
        const failure = JSON.parse(String(output.output)) as { kind: string; outcome?: string };
        expect(failure.kind === 'not_dispatched' || failure.outcome === 'failed').toBe(true);
      }
      complete(response, [answer('Invalid dispatch rejected', 'rejection-final')]);
    }
  });
  const h = await f.openHost(); const identity = await h.api.create('child-review-model-forgery');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'exercise rejected model parameters', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect(await h.runtime.children()).toEqual([]); expect(steps).toBe(2);
}, 15_000);

it('another native Thread cannot read or wait on a child merely by knowing its operation ID', async () => {
  const entered = gate(); const release = gate();
  let ownerSteps = 0; let foreignSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    const foreign = JSON.stringify(body.input).includes('FOREIGN_THREAD_SENTINEL');
    if (foreign) {
      if (++foreignSteps === 1) complete(response, [tool('native_child_status', { operationId }, 'foreign-status'), tool('native_wait_child', { operationId }, 'foreign-wait'), tool('native_child_report', { operationId, itemId: 'private-report-item' }, 'foreign-report')]);
      else {
        for (const output of (body.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output')) {
          const failure = JSON.parse(String(output.output)) as { kind: string; outcome?: string };
          expect(failure.kind === 'not_dispatched' || failure.outcome === 'failed').toBe(true);
          expect(String(output.output)).not.toContain('CHILD_TASK');
        }
        complete(response, [answer('Foreign access rejected', 'foreign-final')]);
      }
    } else if (isParent(body)) {
      if (++ownerSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Owner done', 'owner-final')]); }
    } else complete(response, [answer('Child completed only for owner', 'child-final')]);
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const owner = await h.api.create('child-review-private-owner');
  const prepared = await h.api.prepareSource({ ...owner, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const first = await h.api.submit({ ...owner, key: 'owner-input', expectedHead: null, text: 'dispatch then finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(first.run_id)).state).toBe('completed');
  const other = await h.api.create('child-review-foreign');
  const second = await h.api.submit({ ...other, key: 'foreign-input', expectedHead: null, text: 'FOREIGN_THREAD_SENTINEL', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(second.run_id)).state).toBe('completed');
  expect(foreignSteps).toBe(2);
  expect((await h.api.snapshot(other)).history.some(item => item.source === 'agent')).toBe(false);
  expect((await h.runtime.child(operationId)).parent_thread_id).toBe(owner.threadId);
  await h.runtime.cancelChild(operationId); release.release();
  await expect.poll(async () => (await h.runtime.child(operationId)).resources_released).toBe(true);
}, 20_000);

it('revoking only the old parent grant after durable handoff does not cancel the child authority', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent final after handoff', 'parent-final')]); }
    } else {
      if (++childSteps === 1) complete(response, [tool('native_file_read', { path: 'source.txt' }, 'child-read')]);
      else { expect(JSON.stringify(result(body))).toContain('fixed child source before parent changes'); complete(response, [answer('INDEPENDENT_CHILD_AUTHORITY', 'child-final')]); }
    }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-retired-parent-grant');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch then finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  const grant = h.grants.find(entry => entry.runId === receipt.run_id)!;
  expect(grant).toBeDefined();
  await h.kernel.revokeGrant(grant.grantId);
  release.release();
  await expect.poll(async () => (await h.runtime.child(operationId)).report?.outcome, { timeout: 10_000 }).toBe('succeeded');
  const child = await h.runtime.child(operationId);
  expect((await h.runtime.readChildReport(operationId, child.report!.history_ids.at(-1)!)).text).toBe('INDEPENDENT_CHILD_AUTHORITY');
  const childGrant = h.grants.find(entry => entry.runId === child.receipt?.run_id)!;
  expect(childGrant.grantId).not.toBe(grant.grantId);
  expect(childSteps).toBe(2); expect(parentSteps).toBe(2);
}, 20_000);

it('a parent grant revoked before dispatch cannot create a child or retain a handed-off source', async () => {
  const parentRequested = gate(); let parentResponse: ServerResponse | undefined;
  let steps = 0;
  const f = await fixture(({ body, response }) => {
    if (++steps === 1) { parentResponse = response; parentRequested.release(); }
    else {
      const failure = result(body, 'native_dispatch');
      expect(failure?.kind === 'not_dispatched' || failure?.outcome === 'failed').toBe(true);
      complete(response, [answer('No authority was transferred', 'parent-final')]);
    }
  });
  const h = await f.openHost(); const identity = await h.api.create('child-review-pre-handoff-revoke');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch only with current grant', model, source: prepared.source });
  await parentRequested.promise;
  const grant = h.grants.find(entry => entry.runId === receipt.run_id)!;
  expect(grant).toBeDefined(); await h.kernel.revokeGrant(grant.grantId);
  complete(parentResponse!, [tool('native_dispatch', dispatch, 'dispatch')]);
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect(await h.runtime.children()).toEqual([]); expect(steps).toBe(2);
}, 15_000);

it('a narrow parent read scope cannot turn a whole fixed root into wider child access', async () => {
  let steps = 0; let dispatchResult: Record<string, unknown> | undefined;
  const f = await fixture(({ body, response }) => {
    if (!isParent(body)) { complete(response, [answer('Child should never have been admitted', 'unexpected-child')]); return; }
    if (++steps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
    else {
      dispatchResult = result(body, 'native_dispatch');
      complete(response, [answer('Whole-root handoff is not authorized', 'parent-final')]);
    }
  });
  await fs.mkdir(path.join(f.workspace, 'allowed'));
  await fs.writeFile(path.join(f.workspace, 'allowed', 'read.txt'), 'allowed narrow content');
  const h = await f.openHost({ sourceGrantScopes: ['allowed'] }); const identity = await h.api.create('child-review-narrow-scope');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  prepared.source.tools = ['file_read'];
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch must honor narrow read scopes', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect(dispatchResult?.kind === 'not_dispatched' || dispatchResult?.outcome === 'failed', JSON.stringify(dispatchResult)).toBe(true);
  expect(await h.runtime.children()).toEqual([]); expect(steps).toBe(2);
}, 15_000);

it('a revoked child grant blocks its own reads even though the parent handoff was valid', async () => {
  const childRequested = gate(); let childResponse: ServerResponse | undefined;
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent handed off', 'parent-final')]); }
    } else if (++childSteps === 1) { childResponse = response; childRequested.release(); }
    else {
      const failure = result(body, 'native_file_read');
      expect(failure?.kind === 'not_dispatched' || failure?.outcome === 'failed').toBe(true);
      expect(JSON.stringify(failure)).not.toContain('fixed child source before parent changes');
      complete(response, [answer('The source grant was revoked; reading failed', 'child-final')]);
    }
  });
  const h = await f.openHost(); const identity = await h.api.create('child-review-child-grant-revoke');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch then finish', model, source: prepared.source });
  await childRequested.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  const child = await h.runtime.child(operationId);
  const grant = h.grants.find(entry => entry.runId === child.receipt!.run_id)!;
  expect(grant).toBeDefined(); await h.kernel.revokeGrant(grant.grantId);
  complete(childResponse!, [tool('native_file_read', { path: 'source.txt' }, 'child-read')]);
  await expect.poll(async () => (await h.runtime.child(operationId)).report?.outcome).toBe('failed');
  expect(childSteps).toBe(2); expect(parentSteps).toBe(2);
}, 20_000);

it('credential-owner failure after child Run admission is durable and prevents any child model request', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent done', 'parent-final')]); }
    } else { childSteps++; complete(response, [answer('Unexpected unauthorized generation', 'child-final')]); }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-rebind-failure');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch then finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  h.models.rebindModel = async () => { throw new Error('fixture credential owner was explicitly disabled'); };
  release.release();
  await expect.poll(async () => (await h.runtime.child(operationId)).report?.outcome).toBe('failed');
  const child = await h.runtime.child(operationId);
  expect(child.receipt).not.toBeNull();
  expect((await h.runtime.launch(child.receipt!.run_id))?.preparation_failure).toBe('preparation_failed');
  expect((await h.runtime.run(child.receipt!.run_id)).state).toBe('failed');
  expect(childSteps).toBe(0); expect(parentSteps).toBe(2);
  await h.close(); const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  expect((await reopened.runtime.child(operationId)).report).toEqual(child.report);
  expect(childSteps).toBe(0);
}, 20_000);

it('failure between the durable source pin and child Catalog admission compensates the exact pin and never reports accepted work', async () => {
  let steps = 0;
  const f = await fixture(({ body, response }) => {
    if (++steps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
    else {
      const failure = result(body, 'native_dispatch');
      expect(failure?.kind === 'not_dispatched' || failure?.outcome === 'failed').toBe(true);
      complete(response, [answer('Child was not admitted', 'parent-final')]);
    }
  });
  const h = await f.openHost(); const identity = await h.api.create('child-review-pin-admission-gap');
  const catalog = path.join(f.root, 'agent-runtime', 'conversation.sqlite');
  const sql = (query: string) => execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()', catalog, query]);
  sql("CREATE TRIGGER review_reject_child_admission BEFORE INSERT ON child_tasks BEGIN SELECT RAISE(ABORT,'review failed child admission after source receipt'); END;");
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'dispatch with an injected local admission failure', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect(await h.runtime.children()).toEqual([]);
  const evidence = JSON.parse(execFileSync('python3', ['-c',
    'import sqlite3,sys,json; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps({"receipts":c.execute("SELECT kind,state FROM operations WHERE operation_id LIKE ?",("native-child-pin:%",)).fetchall(),"pins":c.execute("SELECT count(*) FROM pins WHERE pin_id LIKE ?",("native-child-pin:%",)).fetchone()[0]}))',
    path.join(f.root, 'catalog.sqlite')], { encoding: 'utf8' })) as { receipts: Array<[string, string]>; pins: number };
  expect(evidence.receipts).toEqual([['branch.pin', 'committed']]);
  expect(evidence.pins).toBe(0);
  sql('DROP TRIGGER review_reject_child_admission;');
  await h.close(); const reopened = await f.openHost();
  await reopened.collaboration!.recover(); await reopened.adapter.recover();
  expect(await reopened.runtime.children()).toEqual([]); expect(steps).toBe(2);
}, 15_000);

it('keeps large UTF-8 reports as references with bounded Wait preview and exact continuation pages', async () => {
  const report = '报告🙂'.repeat(10_000);
  let parentSteps = 0; let operationId = ''; let waitPayload = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else if (parentSteps === 2) { operationId = job(body); complete(response, [tool('native_wait_child', { operationId }, 'wait')]); }
      else { waitPayload = JSON.stringify((body.input as Array<Record<string, unknown>>).filter(item => JSON.stringify(item).includes('Report from native child'))); complete(response, [answer('Read report by reference', 'parent-final')]); }
    } else complete(response, [answer(report, 'child-final')]);
  });
  const h = await f.openHost();
  const identity = await h.api.create('child-review-report-pages');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'Dispatch then wait', model, source: prepared.source });
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const child = await h.runtime.child(operationId);
  expect(child.report).not.toHaveProperty('text');
  expect(JSON.stringify(await h.runtime.children()).length).toBeLessThan(20_000);
  expect(waitPayload.length).toBeLessThan(70_000);
  expect(waitPayload).toContain('partial');
  const itemId = child.report!.history_ids.at(-1)!;
  let offset = 0; let combined = ''; let pages = 0;
  for (;;) {
    const page = await h.runtime.readChildReport(operationId, itemId, offset, 8191);
    expect(page.offset).toBe(offset);
    expect(page.total_bytes).toBe(Buffer.byteLength(report));
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(8191);
    expect(page.text).not.toContain('\uFFFD');
    combined += page.text; pages++;
    if (page.next_offset === null) break;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
  }
  expect(pages).toBeGreaterThan(1); expect(combined).toBe(report);
  expect((await h.api.collaboration!.readReport(identity, operationId, itemId, 0, 8191)).text).toBe((await h.runtime.readChildReport(operationId, itemId, 0, 8191)).text);
  const foreign = await h.api.create('child-review-foreign-report');
  await expect(h.api.collaboration!.readReport(foreign, operationId, itemId)).rejects.toThrow();
  await expect(h.runtime.readChildReport(operationId, 'unrelated-history-item')).rejects.toThrow();
  await expect(h.runtime.readChildReport(operationId, itemId, 1, 8191)).rejects.toThrow();
}, 20_000);


it('revoking actual Documents workspace trust after child handoff prevents child launch', async () => {
  const entered = gate(); const release = gate();
  let parentSteps = 0; let childSteps = 0; let operationId = '';
  const f = await fixture(({ body, response }) => {
    if (isParent(body)) {
      if (++parentSteps === 1) complete(response, [tool('native_dispatch', dispatch, 'dispatch')]);
      else { operationId = job(body); complete(response, [answer('Parent final', 'parent-final')]); }
    } else { childSteps++; complete(response, [answer('SHOULD_NOT_LAUNCH', 'child-final')]); }
  });
  const h = await f.openHost({ context: original => blockChild(original, entered, release) });
  const identity = await h.api.create('child-review-workspace-revoked');
  const prepared = await h.api.prepareSource({ ...identity, key: 'fixed', path: f.workspace, mode: 'fixed_branch' });
  const receipt = await h.api.submit({ ...identity, key: 'parent-input', expectedHead: null, text: 'Dispatch and finish', model, source: prepared.source });
  await entered.promise;
  await expect.poll(async () => (await h.runtime.run(receipt.run_id)).state).toBe('completed');
  expect((await h.runtime.child(operationId)).state).toBe('preparing');
  f.setTrusted(false); release.release();
  await expect.poll(async () => (await h.runtime.child(operationId)).report?.outcome).toBe('failed');
  expect(childSteps).toBe(0);
  f.setTrusted(true);
}, 20_000);
