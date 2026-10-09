import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createNativeThreadContext } from './native-thread-context.js';
import { createNativeMemoryOwner, type NativeMemoryQuery } from './native-memory-owner.js';
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
import { NativeThreadCollaboration } from './native-thread-collaboration.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeThreadAdapter } from './native-thread-adapter.js';
import { registerNativeThreadRoutes } from './native-thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
function contextOwner(kernel: ReturnType<typeof createKernelClient>, workingStates: ReturnType<typeof createKernelWorkspaceWorkingStateAccess>) {
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'process-wait-project' }) });
  const prepareContext = createNativeThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'process-wait-project' });
  const memory = createNativeMemoryOwner({ personalization, prepareContext });
  const queries: NativeMemoryQuery[] = [];
  kernel.setNativeMemoryOwner(async (query, signal) => { queries.push(structuredClone(query)); return memory(query, signal); });
  return { prepareContext, queries };
}
afterEach(async () => { setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture needs a TCP listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-http-review-'));
  const kernel = createKernelClient({ hostId: 'native-http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
  const grants: Awaited<ReturnType<typeof kernel.issueGrant>>[] = [];
  const issueGrant = kernel.issueGrant.bind(kernel);
  kernel.issueGrant = async (input, signal) => { const grant = await issueGrant(input, signal); grants.push(grant); return grant; };
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
  const endpoint = `${await listen(provider)}/responses`;
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
  const context = contextOwner(kernel, workingStates);
  let closed = false; let kernelClosed = false;
  const closeKernel = async () => { kernelClosed = true; await kernel.close(); };
  const close = async () => { if (closed) return; closed = true;
    try { if (!kernelClosed) await storage.dispose(); } finally { await documents.dispose(); await closeKernel(); } };
  cleanups.push(close);

  const adapter = new NativeThreadAdapter(new NativeRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, context.prepareContext);
  const collaboration = new NativeThreadCollaboration({ runtime: adapter.runtime, workingStates,
    models: { resolveModel: async () => ({ configuration, credentialOwner: owner }), rebindModel: async () => owner },
    prepareContext: context.prepareContext,
    admitSource: async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); },
    onError: (_operation, error) => { launchErrors.push(error); } });
  cleanups.push(async () => { collaboration.stop(); });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { workspace, documents, workingStates, close, kernel, grants, collaboration, owner, configuration, context, api: createNativeThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel };
}

function tool(response: ServerResponse, name: string, args: Record<string, unknown>, serial: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `item-${serial}`, type: 'function_call', call_id: `${name}-${serial}`, name, arguments: JSON.stringify(args) }] } })}\n\n`);
}
function done(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'source check completed' }] }] } })}\n\n`);
}
const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
function batch(response: ServerResponse, calls: Array<{ name: string; args: Record<string, unknown>; id: string }>) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: calls.map(call => ({
    id: `item-${call.id}`, type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args),
  })) } })}\n\n`);
}

it.each(['none', 'original', 'current'] as const)('durable wait resumes with exact readonly observation; revoked grant: %s', async revoked => {
  let serial = 0; let processId = ''; let readResult = ''; let foreign = false; let foreignResult = '';
  const failures: unknown[] = [];
  const f = await fixture((body, response) => { void (async () => {
    const outputs = (body.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
    const output = outputs.at(-1);
    if (foreign) {
      if (!output) tool(response, 'native_wait_process', { processId }, 90);
      else { foreignResult = String(output.output); done(response); }
      return;
    }
    serial++;
    if (serial === 1) {
      tool(response, 'native_process_spawn', { cwd: '', command: process.execPath,
        args: ['-e', `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(f.root, 'release-process'))})){clearInterval(timer);process.stdout.write('process-wait-real-output');}},10);`], mode: 'pipe' }, 1);
    } else if (serial === 2) {
      processId = (JSON.parse(String(output?.output)) as { operation_id: string }).operation_id;
      batch(response, [{ name: 'native_wait_process', args: { processId }, id: 'wait-2' },
        { name: 'native_file_read', args: { path: 'source.txt' }, id: 'read-peer-2' }]);
    } else if (serial === 3) {
      expect(String(outputs.find(item => item.call_id === 'read-peer-2')?.output)).toContain('parallel read completed');
      expect(JSON.stringify(body.input)).toContain('Native process lifecycle data');
      expect(f.context.queries.filter(query => query.action === 'synchronize').length).toBeGreaterThanOrEqual(3);
      const processGrants = f.grants.filter(grant => grant.grantId.startsWith('native-source:'));
      expect(processGrants).toHaveLength(2);
      expect(processGrants[0]!.grantId).not.toBe(processGrants[1]!.grantId);
      const launch = await f.runtime.launch((await f.runtime.operation(processId)).run_id);
      const identity = { workspaceId: launch!.selection.source!.workspace_id, processId };
      const current = f.kernel.scoped(processGrants[1]!);
      // A legal observation rebind does not convey process control or direct actor ownership.
      await expect(current.processKill({ ...identity, force: true })).rejects.toThrow(/another workspace or actor/);
      await expect(current.processWrite({ ...identity, sequence: 1, bytesBase64: '', eof: true })).rejects.toThrow(/another workspace or actor/);
      if (revoked === 'none') {
        const originalRead = await f.kernel.scoped(processGrants[0]!).processRead({ ...identity, cursor: 0 });
        expect(JSON.stringify(originalRead)).toContain(Buffer.from('process-wait-real-output').toString('base64'));
      } else await f.kernel.revokeGrant(processGrants[revoked === 'original' ? 0 : 1]!.grantId);
      tool(response, 'native_process_read', { processId, cursor: 0 }, 3);
    } else if (serial === 4) {
      readResult = String(output?.output);
      // New observation registration must obey the same explicit revoke as reads.
      if (revoked !== 'none') tool(response, 'native_wait_process', { processId }, 4);
      else done(response);
    } else {
      expect(String(output?.output)).toContain('failed');
      expect(String(output?.output)).toMatch(/revoked|authority/);
      done(response);
    }
  })().catch(error => { failures.push(error); response.writeHead(500); response.end('fixture assertion failed'); }); });
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'parallel read completed');
  const identity = await f.api.create(`process-wait-${revoked}`);
  const prepared = await f.api.prepareSource({ ...identity, key: 'capture', path: f.workspace, mode: 'materialized' });
  const receipt = await f.api.submit({ ...identity, key: 'spawn-and-observe', expectedHead: null, text: 'wait for the process', model, source: prepared.source });
  try {
    await expect.poll(async () => (await f.runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('waiting');
    expect((await f.runtime.run(receipt.run_id)).waiting_on).toMatch(/^process-wait:/);
    expect(serial).toBe(2);
    expect((await f.runtime.operation(processId)).phase).not.toBe('terminal');
    // Same Run cannot use observation delegation to swap its admitted immutable source.
    await expect(f.runtime.startFromSource({ mode: 'materialized', runId: receipt.run_id,
      workspaceId: prepared.source.workspaceId, executionWorkspaceId: prepared.source.executionWorkspaceId, tools: prepared.source.tools,
      branchId: 'invented-different-source', revision: 0 })).rejects.toThrow(/durable source selection/);
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    await expect.poll(async () => (await f.runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
    expect(failures).toEqual([]); expect(f.launchErrors).toEqual([]);
    if (revoked === 'none') {
      expect(readResult).toContain('succeeded');
      expect(readResult).toContain(Buffer.from('process-wait-real-output').toString('base64'));
      const history = await f.runtime.history(identity.branchId);
      expect(history.filter(item => JSON.stringify(item.content).includes('Native process lifecycle data'))).toHaveLength(1);
      foreign = true;
      const other = await f.api.create('foreign-process-observer');
      const foreignRun = await f.api.submit({ ...other, key: 'foreign', expectedHead: null, text: 'observe foreign process', model, source: prepared.source });
      await expect.poll(async () => (await f.runtime.run(foreignRun.run_id)).state, { timeout: 10_000 }).toBe('completed');
      expect(foreignResult).toContain('failed'); expect(foreignResult).toContain('not owned by this native Run');
      expect((await f.runtime.operation(processId)).outcome).toBe('succeeded');
    } else { expect(readResult).toContain('failed'); expect(readResult).toMatch(/revoked|authority/); }
  } finally {
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    if (processId) await f.runtime.cancelOperation(processId).catch(() => undefined);
  }
}, 60_000);

it('reopens a parked wait after kernel shutdown and delivers the original stopped process fact without respawn', async () => {
  let turn = 0; let processId = ''; let output = '';
  const f = await fixture((_body, response) => {
    turn++;
    if (turn === 1) tool(response, 'native_process_spawn', { cwd: '', command: process.execPath,
      args: ['-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(f.root, 'spawn-count'))},'1');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(f.root, 'release-process'))})){clearInterval(timer);process.stdout.write('reopened-process-output');}},10);`], mode: 'pipe' }, 1);
    else if (turn === 2) {
      const last = (_body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
      processId = (JSON.parse(String(last?.output)) as { operation_id: string }).operation_id;
      tool(response, 'native_wait_process', { processId }, 2);
    } else if (turn === 3) tool(response, 'native_process_read', { processId, cursor: 0 }, 3);
    else {
      output = JSON.stringify(_body.input); done(response);
    }
  });
  const identity = await f.api.create('reopen-process-wait');
  const prepared = await f.api.prepareSource({ ...identity, key: 'capture', path: f.workspace, mode: 'materialized' });
  const receipt = await f.api.submit({ ...identity, key: 'observe', expectedHead: null, text: 'wait across restart', model, source: prepared.source });
  let reopened: ReturnType<typeof createKernelClient> | undefined;
  let collaboration: NativeThreadCollaboration | undefined;
  let reopenedStorage: KernelStorageAdapter | undefined;
  let runtime = f.runtime;
  try {
    await expect.poll(async () => (await runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('waiting');
    const waitId = (await runtime.run(receipt.run_id)).waiting_on;
    expect(waitId).toMatch(/^process-wait:/); expect(turn).toBe(2);
    await expect.poll(() => fs.readFile(path.join(f.root, 'spawn-count'), 'utf8').catch(() => ''), { timeout: 5_000 }).toBe('1');
    f.collaboration.stop();
    // Close only this fixture's kernel client. Do not revoke the original process grant.
    await f.closeKernel();
    reopened = createKernelClient({ hostId: 'native-http-review', storageRoot: f.root, buildVersion, kernelPath, allowCargoDevRunner: false });
    runtime = new NativeRuntimeClient(reopened);
    const errors: unknown[] = [];
    reopenedStorage = new KernelStorageAdapter({ client: reopened, hostId: 'native-http-review', storageRoot: f.root, resolveWorkspaceRoot: async id => (await f.documents.inspectWorkspace(id)).root });
    const workingStates = createKernelWorkspaceWorkingStateAccess(reopenedStorage);
    const context = contextOwner(reopened, workingStates);
    collaboration = new NativeThreadCollaboration({ runtime, workingStates,
      models: { resolveModel: async () => ({ configuration: f.configuration, credentialOwner: f.owner }), rebindModel: async () => f.owner },
      prepareContext: context.prepareContext,
      admitSource: async source => { await f.documents.inspectWorkspace(source.workspaceId); await f.documents.inspectWorkspace(source.executionWorkspaceId); },
      onError: (_operation, error) => { errors.push(error); } });
    await reopened.start(); await collaboration.recover();
    // Shutdown may already have supplied the terminal receipt. Its original Wait identity
    // survives even if startup reconciliation has delivered it before this assertion.
    expect((await runtime.operation(waitId!.slice('process-wait:'.length))).waiting_on).toBe(waitId);
    expect(await fs.readFile(path.join(f.root, 'spawn-count'), 'utf8')).toBe('1');
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    await expect.poll(async () => (await runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
    expect(errors).toEqual([]); expect(turn).toBe(4);
    expect(context.queries.some(query => query.action === 'synchronize' && query.runId === receipt.run_id)).toBe(true);
    const items = JSON.parse(output) as Array<Record<string, unknown>>;
    const factText = String(items.find(item => typeof item.content === 'string' && item.content.startsWith('Native process lifecycle data'))?.content);
    const fact = JSON.parse(factText.split('\n').at(-1)!) as { outcome: string; signal: string; treeConfirmed: boolean };
    expect(fact).toMatchObject({ outcome: 'failed', signal: 'Killed', treeConfirmed: true });
    const read = JSON.parse(String(items.find(item => item.call_id === 'native_process_read-3' && item.type === 'function_call_output')?.output)) as { content: { outputComplete: boolean; outputError: string; process: { signal: string; writerActive: boolean } } };
    expect(read.content.outputComplete).toBe(false);
    expect(read.content.outputError).toContain('without a durable completion marker');
    expect(read.content.process).toMatchObject({ signal: 'Killed', writerActive: false });
    expect(await fs.readFile(path.join(f.root, 'spawn-count'), 'utf8')).toBe('1');
    expect((await runtime.operation(processId)).outcome).toBe('failed');
    expect((await runtime.history(identity.branchId)).filter(item => JSON.stringify(item.content).includes('Native process lifecycle data'))).toHaveLength(1);
  } finally {
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    if (processId) {
      // Cleanup is scoped to the exact fixture Operation even if an assertion failed.
      await runtime.cancelOperation(processId).catch(() => undefined);
    }
    collaboration?.stop(); await reopenedStorage?.dispose(); await reopened?.close();
  }
}, 60_000);

it('rebuilds only Host continuation service while its kernel keeps the original process alive', async () => {
  let turn = 0; let processId = ''; let readResult = '';
  const f = await fixture((body, response) => {
    turn++;
    const last = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    if (turn === 1) tool(response, 'native_process_spawn', { cwd: '', command: process.execPath,
      args: ['-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(f.root, 'spawn-count'))},'1');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(f.root, 'release-process'))})){clearInterval(timer);process.stdout.write('host-service-recovered-output');}},10);`], mode: 'pipe' }, 1);
    else if (turn === 2) { processId = (JSON.parse(String(last?.output)) as { operation_id: string }).operation_id; tool(response, 'native_wait_process', { processId }, 2); }
    else if (turn === 3) tool(response, 'native_process_read', { processId, cursor: 0 }, 3);
    else { readResult = String(last?.output); done(response); }
  });
  const identity = await f.api.create('host-service-process-wait');
  const prepared = await f.api.prepareSource({ ...identity, key: 'capture', path: f.workspace, mode: 'materialized' });
  const receipt = await f.api.submit({ ...identity, key: 'observe', expectedHead: null, text: 'wait through Host service reopen', model, source: prepared.source });
  let replacement: NativeThreadCollaboration | undefined;
  try {
    await expect.poll(async () => (await f.runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('waiting');
    const waitId = (await f.runtime.run(receipt.run_id)).waiting_on;
    f.collaboration.stop();
    const errors: unknown[] = [];
    replacement = new NativeThreadCollaboration({ runtime: f.runtime, workingStates: f.workingStates,
      models: { resolveModel: async () => ({ configuration: f.configuration, credentialOwner: f.owner }), rebindModel: async () => f.owner },
      prepareContext: f.context.prepareContext,
      admitSource: async source => { await f.documents.inspectWorkspace(source.workspaceId); await f.documents.inspectWorkspace(source.executionWorkspaceId); },
      onError: (_operation, error) => { errors.push(error); } });
    await replacement.recover();
    expect((await f.runtime.run(receipt.run_id)).waiting_on).toBe(waitId); expect(turn).toBe(2);
    const actor = f.kernel.scoped(f.grants.find(grant => grant.grantId.startsWith('native-source:'))!);
    expect((await actor.processInspect({ workspaceId: prepared.source.workspaceId, processId })).writerActive).toBe(true);
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    await expect.poll(async () => (await f.runtime.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
    expect(errors).toEqual([]); expect(turn).toBe(4);
    expect(readResult).toContain(Buffer.from('host-service-recovered-output').toString('base64'));
    expect(readResult).toContain('succeeded'); expect((await f.runtime.operation(processId)).outcome).toBe('succeeded');
    expect(await fs.readFile(path.join(f.root, 'spawn-count'), 'utf8')).toBe('1');
    expect((await f.runtime.history(identity.branchId)).filter(item => JSON.stringify(item.content).includes('Native process lifecycle data'))).toHaveLength(1);
  } finally {
    await fs.writeFile(path.join(f.root, 'release-process'), 'release');
    if (processId) await f.runtime.cancelOperation(processId).catch(() => undefined);
    replacement?.stop();
  }
}, 60_000);
