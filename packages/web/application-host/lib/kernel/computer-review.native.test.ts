/** Full public/IPC acceptance fixture. Controlled driver and loopback provider only;
 * never operates the user's desktop or calls a paid model. */
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { configureRuntimeUrlResolver, createThreadsHttpAPI, setRuntimeExtraHeaders } from '@varin/application-client';
import { createComputerService } from '../computer/computer-service.js';
import type { ComputerDriverSession, DriverResponse } from '../computer/driver-host.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createComputerRuntime } from './computer-runtime.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { createExtensionTools } from './extension-tool-owner.js';
import { createKernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRuntimeExtraHeaders(null);
  configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Computer acceptance needs actual loopback HTTP');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
function respond(response: ServerResponse, name?: string, args: Record<string, unknown> = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: name
    ? [{ id: `item-${name}`, type: 'function_call', call_id: name, name, arguments: JSON.stringify(args) }]
    : [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'Computer receipt consumed' }] }] } })}\n\n`);
}

it('source-less public Native work executes the shipped Computer tool, drains exact Stop and natural completion, and retains original dispatched results after reopen', async () => {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-computer-review-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const kernelOptions = { hostId: 'computer-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false };
  const kernel = createKernelClient(kernelOptions);
  cleanups.push(() => kernel.close());
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  cleanups.push(() => extensions.stop());
  const runtime: AgentRuntimeClient = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, createExtensionTools({ runtime: extensions, kernel,
    currentPolicy: async () => ({ mode: 'normal', rules: COMPUTER_TOOL_DECLARATIONS.map(value => ({ tool: value.tool!.name, decision: 'allow' as const })) }),
    prepareConfiguration: (...args) => computer.prepareConfiguration(...args),
  }));
  const driverCalls: string[] = [];
  let physicalReleases = 0;
  const response = (extra: Partial<DriverResponse> = {}): DriverResponse => ({ id: 'controlled-driver', ok: true, ...extra });
  const driver: ComputerDriverSession = {
    capabilities: null, alive: () => true, cancel: () => true, dispose: () => {},
    interrupt: async () => { physicalReleases++; return { released: true }; },
    async request(operation, dispatch) {
      dispatch?.beforeDispatch?.();
      driverCalls.push(String(operation.tool));
      if (operation.tool === 'capabilities') return response({ capabilities: { platform: 'windows', driver: 'controlled', status: 'ready' } });
      if (operation.tool === 'get_app_state') return response({ snapshot: {
        app: { name: 'fixture-editor', pid: 42, windowTitle: 'Controlled Computer acceptance' },
        windowBounds: { x: 10, y: 20, width: 800, height: 600 }, treeLines: ['0 Edit Fixture text'],
        elements: [{ index: 0, name: 'Fixture text', controlType: 'Edit' }],
      } });
      return response({ text: 'controlled-driver-dispatch', receipt: { effect: 'dispatched' } });
    },
  };
  const computers = createComputerService({ client: kernel, hostId: kernelOptions.hostId, dataDir: path.join(root, 'computer'), platform: 'windows',
    createDriver: () => driver,
    onControlEvent: event => computer.acceptControlEvent(event).then(() => {}),
    onControlEventCancel: command => computer.cancelControlEvents(command),
    resolveActor: async work => work.runtime === 'agent' ? (await computer.resolve(work)).actor : null,
    resolveScope: async work => work.runtime === 'agent' ? (await computer.resolve(work)).scope : null,
  });
  cleanups.push(() => computers.dispose());
  const computer: ReturnType<typeof createComputerRuntime> = createComputerRuntime({ kernel, runtime, computers, enabled: async () => true });
  computer.start();
  cleanups.push(async () => { computer.stop(); });
  extensions.capabilities.register(COMPUTER_CAPABILITY, computer.capability);
  await extensions.start();
  await computers.ensureLocal();
  await computers.setDefaultDesktop('local-console');
  let finalResponse: ServerResponse | undefined;
  let naturalPhase = false, naturalSteps = 0;
  const requests: Record<string, unknown>[] = [];
  const provider = createServer((request, outgoing) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      if (naturalPhase) {
        if (++naturalSteps === 1) respond(outgoing, 'computer_control', {});
        else if (naturalSteps === 2) respond(outgoing, 'computer_observe', { app: 'fixture-editor' });
        else if (naturalSteps === 3) respond(outgoing, 'computer_act', { action: { kind: 'key', app: 'fixture-editor', key: 'tab' } });
        else respond(outgoing);
      } else if (requests.length === 1) respond(outgoing, 'computer_observe', { app: 'fixture-editor' });
      else if (requests.length === 2) respond(outgoing, 'computer_act', { action: { kind: 'key', app: 'fixture-editor', key: 'enter' } });
      else if (requests.length === 3) finalResponse = outgoing;
      else respond(outgoing);
    });
  });
  const endpoint = `${await listen(provider)}/responses`;
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: 'computer-fixture', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-owner', account: 'fixture-account', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-computer-review-key-not-a-secret' } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'computer-fixture', endpoint, credentialEnvironment: null,
    allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime, { resolveModel: async () => ({ configuration, credentialOwner }), rebindModel: async () => credentialOwner },
    async () => { throw new Error('This Computer acceptance has no file source'); }, (_run, error) => { launchErrors.push(error); });
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, outgoing, next) => {
    if (request.headers['x-fixture-auth'] !== 'computer-review') { outgoing.status(401).json({ code: 'authentication-required' }); return; }
    next();
  }, undefined, computer.user);
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'computer-review' });
  const api = createThreadsHttpAPI();
  const identity = await api.create('source-less-computer');
  const prepared = await extensions.prepareService({ serviceId: 'varin.computer.observe', version: 1,
    method: 'execute', args: [], routing: { threadId: identity.threadId, branchId: identity.branchId } });
  cleanups.push(async () => { prepared.release(); });
  expect((await api.computer.state(identity)).state).toMatchObject({ work: identity, currentExecution: null, currentRootExecution: null, active: false });
  expect(driverCalls.filter(call => !['release_input', 'ping', 'capabilities'].includes(call))).toEqual([]);
  const accepted = await api.submit({ ...identity, key: 'computer-input', expectedHead: null, text: 'Exercise the original Computer owner',
    model: { providerId: 'computer-fixture', modelId: 'computer-fixture' } });
  await expect.poll(() => finalResponse !== undefined, { timeout: 15_000 }).toBe(true);
  expect(launchErrors).toEqual([]);
  expect((await runtime.launch(accepted.run_id))?.selection.source).toBeNull();
  const active = await api.computer.state(identity);
  expect(active.state.currentExecution).toEqual({ work: identity, runId: accepted.run_id });
  expect(active.state.leases.some(lease => lease.access === 'control' && lease.actor.execution.work.threadId === identity.threadId
    && lease.actor.execution.work.branchId === identity.branchId && lease.actor.execution.runId === accepted.run_id)).toBe(true);
  const stopped = await api.computer.stop(identity, { runId: accepted.run_id, desktopId: 'local-console' });
  expect(stopped.state.status).toBe('enabled');
  expect(stopped.state.leases).toEqual([]);
  expect(stopped.state.cleanups).toEqual([]);
  expect(physicalReleases).toBeGreaterThan(0);
  expect(driverCalls.filter(call => call === 'press_key')).toHaveLength(1);
  expect(JSON.stringify(requests[2])).toContain('controlled-driver-dispatch');
  expect(JSON.stringify(requests[2])).toContain('dispatched');
  respond(finalResponse!);
  await expect.poll(async () => (await api.run(accepted.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect((await api.computer.state(identity)).state.currentExecution).toBeNull();
  await expect(api.computer.stop(identity, { runId: accepted.run_id })).rejects.toMatchObject({ code: 'computer-execution-stale' });
  naturalPhase = true;
  const natural = await api.submit({ ...identity, key: 'computer-natural-completion', expectedHead: (await api.snapshot(identity)).historyPage.head,
    text: 'Finish this work without a separate Computer Stop', model: { providerId: 'computer-fixture', modelId: 'computer-fixture' } });
  await expect.poll(async () => (await api.run(natural.run_id)).state, { timeout: 15_000 }).toBe('completed');
  // No user Stop or release tool precedes this terminal event. The original owner must drain it.
  await computer.reconcileExecutions();
  const finished = (await api.computer.state(identity)).state;
  expect(finished.currentExecution).toBeNull();
  expect(finished.leases).toEqual([]);
  expect(finished.cleanups).toEqual([]);
  expect(finished.status).toBe('enabled');
  expect(driverCalls.filter(call => call === 'press_key')).toHaveLength(2);
  expect(physicalReleases).toBeGreaterThanOrEqual(2);
  const history = await runtime.history(identity.branchId);
  expect((await runtime.collectContent()).status).toBe('completed');
  computer.stop();
  await computers.dispose();
  await kernel.close();
  const reopened = createKernelClient(kernelOptions);
  try { expect(await new AgentRuntimeClient(reopened).history(identity.branchId)).toEqual(history); }
  finally { await reopened.close(); }
}, 45_000);
