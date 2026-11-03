import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { createKernelClient } from '../kernel/kernel-client.js';
import { TransportFixture } from '../kernel/tests/transport-fixture.js';
import type { ContextObservationFact, ContextObservationReceipt, EnvironmentObservationCapture,
  EnvironmentObservationReceipt, ContextObservationOriginal, LaunchSourceParams } from '../kernel/protocol.generated.js';
import { openKnowledgeStoreEngine } from '../knowledge/store-engine.js';
import { createContextObservationPublication } from '../knowledge/context-publication.js';
import { createEnvironmentObservationCoordinator, createObservationPort, type ObservationPort } from './coordinator.js';
import { createEnvironmentObservationRuntime } from './runtime.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Real Catalog, ContentStore, framed IPC and registered temporary root; no document-trust bypass or model credentials. */
async function fixture(endpoint = 'http://127.0.0.1:9/responses') {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-observation-native-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const hostId = 'observations-native', workspaceId = 'observation-workspace';
  const probe = new TransportFixture(); let child!: ChildProcessWithoutNullStreams;
  const options = { hostId, storageRoot: path.join(root, 'kernel'), buildVersion, kernelPath, allowCargoDevRunner: false };
  let kernel = createKernelClient({ ...options, transportFactory: probe.create,
    spawnProcess: ((command, args, input) => { child = spawn(command, args ?? [], input ?? {}) as ChildProcessWithoutNullStreams; return child; }) as typeof spawn });
  const clients = [kernel];
  cleanups.push(async () => { for (const client of clients.toReversed()) await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const makeRuntime = () => new AgentRuntimeClient(kernel, undefined, undefined, undefined, async source => {
    if (source.workspaceId !== workspaceId || source.executionWorkspaceId !== workspaceId
      || source.liveRoot.hostId !== hostId || source.liveRoot.rootId !== registered.rootId
      || source.liveRoot.canonicalRoot !== registered.canonicalRoot) throw new Error('Fixture source changed');
    // Rust's Windows canonical path can retain the extended-length prefix that
    // Node realpath removes. Preserve the registered identity, then compare both
    // physical paths through the same filesystem API rather than their spelling.
    expect(await fs.realpath(source.liveRoot.canonicalRoot)).toBe(await fs.realpath(workspace));
  });
  let runtime = makeRuntime(); await kernel.start(); await runtime.createThread('thread', 'branch');
  const grant = await kernel.issueGrant({ grantId: 'observation-root', owningWorkspace: workspaceId, executionWorkspace: workspaceId,
    threadId: 'thread', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const registered = await kernel.scoped(grant).fileRootRegister({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: await fs.realpath(workspace) });
  await kernel.revokeGrant(grant.grantId);
  const liveRoot = { hostId, rootId: registered.rootId, canonicalRoot: registered.canonicalRoot };
  const source: LaunchSourceParams = { resourceOwner: { kind: 'local' }, workspaceId, executionWorkspaceId: workspaceId,
    mode: 'live_root', liveRoot, branchId: null, revision: null };
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint,
    allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 };
  const submit = async (key: string) => runtime.submit({ key, threadId: 'thread', branchId: 'branch',
    expectedHead: (await runtime.historyPage({ branchId: 'branch', limit: 1 })).head,
    input: { text: key }, configuration, launch: { source, enabledTools: [] } });
  const first = await submit('original');
  const port: ObservationPort = {
    sources: runId => createObservationPort(kernel).sources(runId),
    capture: (owner, captures) => createObservationPort(kernel).capture(owner, captures),
    receipt: (owner, ids) => createObservationPort(kernel).receipt(owner, ids),
    snapshot: runId => createObservationPort(kernel).snapshot(runId),
  };
  return { root, workspace, workspaceId, hostId, probe, source, liveRoot, first, submit, port,
    get kernel() { return kernel; }, get runtime() { return runtime; },
    async crashAndReopen() {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await kernel.close();
      probe.held.length = 0; delete probe.hold;
      kernel = createKernelClient(options); clients.push(kernel); runtime = makeRuntime(); await kernel.start();
    },
  };
}
async function localProvider() {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { endpoint: `http://127.0.0.1:${address.port}/responses`, requests };
}

const command = (captureId: string): EnvironmentObservationCapture => ({ captureId, event: { kind: 'command', at: 1234, source: 'user',
  body: { terminalId: '终端', commandId: 'generation:2:command:3', command: 'printf "雪🙂\\n"; '.repeat(7_000),
    exitCode: 3, cwd: '/目录 with spaces', integration: 'osc-633', startedAt: 1200, endedAt: 1234, changeId: captureId } } });

it('uses the actual TS/native bridge for canonical Unicode raw bytes, omitted model projection and immutable retry receipts', async () => {
  const provider = await localProvider();
  const f = await fixture(provider.endpoint), errors: unknown[] = [];
  const coordinator = createEnvironmentObservationCoordinator({ port: f.port, onError: error => errors.push(error) });
  const owner = (await coordinator.sources())[0]!; const capture = command('terminal:host:generation:command');
  coordinator.enqueue(owner, capture); expect(await coordinator.close()).toMatchObject([{ availability: 'ready', pending: [] }]);
  expect(errors).toEqual([]);
  const [receipt] = await f.port.receipt(owner, [capture.captureId]);
  expect(receipt).toMatchObject({ captureId: capture.captureId, representation: { version: 1, omitted: true } });
  expect(receipt!.rawDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
  expect(await f.port.capture(owner, [capture])).toEqual([receipt]);
  await expect(f.port.capture(owner, [{ ...capture, event: { ...capture.event, at: 999 } }])).rejects.toThrow(/different|conflict/i);
  await expect(f.kernel.agentRuntimeRequest('runtime.context.observations.read', { runId: f.first.run_id, id: receipt!.id })).rejects.toThrow(/not visible/i);
  f.kernel.setContextOwner({ close() {}, query: async (query, signal) => ({ status: 'ready',
    ...(query.action === 'execution_environment' ? { environment: await f.runtime.executionEnvironmentForSource((await f.runtime.launch(query.runId, signal))?.selection.source, signal) } : {}),
  }) });
  await f.runtime.rebindLaunch(f.first.run_id);
  await expect.poll(async () => (await f.runtime.run(f.first.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(1);
  let offset = 0, text = '';
  for (;;) {
    const page = await f.kernel.agentRuntimeRequest<ContextObservationOriginal, 'runtime.context.observations.read'>(
      'runtime.context.observations.read', { runId: f.first.run_id, id: receipt!.id, offset, limit: 16_384 });
    expect(page.rawDigest).toBe(receipt!.rawDigest); text += page.text; offset = page.nextOffset;
    if (offset === page.totalBytes) break;
  }
  expect(JSON.parse(text)).toEqual(capture.event);
  expect(JSON.parse(text)).not.toHaveProperty('text');
  expect((await f.runtime.historyPage({ branchId: 'branch', limit: 20 })).items.filter(item => item.id === receipt!.id)).toHaveLength(1);
}, 30_000);

it('reconciles a real lost acknowledgement after kernel termination using the original receipt across a new epoch', async () => {
  const f = await fixture(), errors: unknown[] = [];
  const coordinator = createEnvironmentObservationCoordinator({ port: f.port, onError: error => errors.push(error) });
  const owner = (await coordinator.sources())[0]!, capture = command('lost-original');
  const submissions = vi.spyOn(f.port, 'capture'), receiptReads = vi.spyOn(f.port, 'receipt');
  f.probe.hold = frame => f.probe.sent.find(request => request.id === frame.id)?.method === 'runtime.context.observations.capture';
  coordinator.enqueue(owner, capture);
  await expect.poll(() => f.probe.held.length).toBe(1);
  // The held response came from the real committed Catalog transaction. Killing
  // its process loses the Host acknowledgement, not the durable capture.
  expect(f.probe.held[0]!.ok).toBe(true);
  const committed = f.probe.held[0]!.result as EnvironmentObservationReceipt[];
  expect(committed).toMatchObject([{ captureId: capture.captureId, id: expect.any(String), cursor: expect.any(Number) }]);
  await f.crashAndReopen();
  await expect.poll(() => coordinator.inspect()[0]?.unknown).toEqual([capture.captureId]);
  const refreshed = (await coordinator.sources())[0]!; expect(refreshed.epoch).not.toBe(owner.epoch);
  coordinator.wake(); await expect.poll(() => coordinator.inspect()[0]?.pending).toEqual([]);
  expect(submissions).toHaveBeenCalledOnce(); expect(receiptReads).toHaveBeenCalledExactlyOnceWith(owner, [capture.captureId]);
  expect(await f.port.receipt(owner, [capture.captureId])).toEqual(committed);
  expect((await f.runtime.events(0, 1000)).filter(event => event.kind === 'context.observed' && event.subject === committed[0]!.id)).toHaveLength(1);
  expect(f.probe.sent.filter(request => request.method === 'runtime.context.observations.capture')).toHaveLength(1);
  expect(errors).toHaveLength(1); await coordinator.close();
}, 30_000);

it('imports the actual old Knowledge journal under Run A after Run B exists, preserving the old digest and durable prefix', async () => {
  const provider = await localProvider();
  const f = await fixture(provider.endpoint), original = (await f.port.sources())[0]!;
  const legacy = await openKnowledgeStoreEngine({ dataDir: path.join(f.root, 'legacy'), hostId: f.hostId, workspaceId: f.workspaceId, embedding: null });
  cleanups.push(() => legacy.close());
  const old = { kind: 'command' as const, at: 9, sessionId: original.runId, source: 'user' as const,
    text: 'exit 0 · original legacy command  (/old cwd)', refs: { handle: 'old-terminal' }, data: { command: 'original legacy command', cwd: '/old cwd', exitCode: 0 } };
  const saved = await legacy.putEvent(old);
  await f.runtime.cancelRun(f.first.run_id);
  await expect.poll(async () => (await f.runtime.run(f.first.run_id)).state).toBe('cancelled');
  const successor = await f.submit('successor'); expect((await f.port.sources()).map(source => source.runId)).toEqual([successor.run_id]);
  const errors: unknown[] = []; let importer = createContextObservationPublication(f.kernel, { getLegacyStore: async () => legacy, onError: error => errors.push(error) });
  // The real request source query already contains the eligible original
  // ancestry, including Runs which became eligible after startup discovery.
  const coordinator = createEnvironmentObservationCoordinator({ port: f.port });
  const preparation = await coordinator.prepare({ id: successor.run_id });
  expect(preparation.sources.map(status => status.owner.runId)).toEqual([successor.run_id, original.runId]);
  importer.wake(preparation.sources.map(status => status.owner));
  expect((await importer.close()).every(source => source.state === 'ready')).toBe(true); await coordinator.close();
  expect(errors).toEqual([]);
  const id = `observation:${original.runId}:${saved.id}`;
  const admissions = (await f.runtime.events(0, 1000)).filter(event => event.kind === 'context.observed' && event.subject === id);
  expect(admissions).toHaveLength(1);
  const fact: ContextObservationFact = { id: saved.id, kind: old.kind, at: old.at, text: old.text, source: old.source, refs: old.refs, data: old.data };
  const replay = await f.kernel.agentRuntimeRequest<ContextObservationReceipt[], 'runtime.context.observations.admit'>(
    'runtime.context.observations.admit', { owner: original, events: [fact] });
  expect(replay).toMatchObject([{ id, cursor: admissions[0]!.cursor }]);
  await expect(f.kernel.agentRuntimeRequest('runtime.context.observations.admit', { owner: original, events: [{ ...fact, text: 'new renderer must not replace old text' }] })).rejects.toThrow(/different|conflict/i);
  const importCalls = () => f.probe.sent.filter(request => request.method === 'runtime.context.observations.import').length;
  expect(importCalls()).toBe(1);
  const reads = vi.spyOn(legacy, 'listEvents');
  importer = createContextObservationPublication(f.kernel, { getLegacyStore: async () => legacy }); await importer.recover(); await importer.close();
  expect(reads.mock.calls.find(([filter]) => filter.sessionId === original.runId)?.[0].afterId).toBe(saved.id);
  expect(importCalls()).toBe(1);
  f.kernel.setContextOwner({ close() {}, query: async (query, signal) => ({ status: 'ready',
    ...(query.action === 'execution_environment' ? { environment: await f.runtime.executionEnvironmentForSource((await f.runtime.launch(query.runId, signal))?.selection.source, signal) } : {}),
  }) });
  await f.runtime.rebindLaunch(successor.run_id);
  await expect.poll(async () => (await f.runtime.run(successor.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(1);
  const history = (await f.runtime.historyPage({ branchId: 'branch', limit: 20 })).items.filter(item => item.id === id);
  expect(history).toHaveLength(1);
  expect(JSON.stringify(await f.runtime.historyItem(history[0]!))).toContain(old.text);
}, 30_000);

it('round-trips the actual Host preparation diagnostics, including retired/source/producer gaps, through native context preparation', async () => {
  const { endpoint, requests } = await localProvider();
  const f = await fixture(endpoint);
  const observations = createEnvironmentObservationRuntime({ port: f.port, budgets: { totalBytes: 1, sourceBytes: 1024 } });
  cleanups.push(async () => { await observations.dispose(); });
  const save = (id: string) => observations.observeDocumentMutation({ workspaceId: f.workspaceId, resourceId: 'file.md', kind: 'modified',
    owner: { kind: 'web-route', id: 'editor' }, changeId: id, observedAt: 10 });
  save('old-gap'); await expect.poll(() => observations.inspect()[0]?.gap?.count).toBe(1);
  await f.runtime.cancelRun(f.first.run_id); await expect.poll(async () => (await f.runtime.run(f.first.run_id)).state).toBe('cancelled');
  const successor = await f.submit('diagnostics'); save('current-gap');
  await expect.poll(() => observations.inspect().find(status => status.owner.runId === successor.run_id)?.gap?.count).toBe(1);
  await observations.observeTerminalCommand({ workspaceId: f.workspaceId, sessionId: 'terminal', commandId: 'oversize', command: 'x'.repeat(2_000), exitCode: 0, source: 'user', endedAt: 11 });
  f.kernel.setContextOwner({ close() {}, query: async (query, signal) => ({ status: 'ready',
    ...(query.action === 'prepare' ? { observations: await observations.prepare({ id: query.runId }, signal) } : {}),
    ...(query.action === 'execution_environment' ? { environment: await f.runtime.executionEnvironmentForSource((await f.runtime.launch(query.runId, signal))?.selection.source, signal) } : {}),
  }) });
  await f.runtime.rebindLaunch(successor.run_id);
  await expect.poll(async () => (await f.runtime.run(successor.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(requests).toHaveLength(1);
  const snapshot = (await f.runtime.events(0, 1000)).find(event => event.kind === 'context.observation_snapshot');
  expect(snapshot?.data).toMatchObject({ host: { acceptedCursor: 0, retiredGaps: [{ workspaceId: f.workspaceId, count: 1 }],
    producerGaps: [{ workspaceId: f.workspaceId, reason: 'queue_budget', count: 1 }] } });
}, 30_000);
