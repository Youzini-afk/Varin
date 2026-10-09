import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createMemoryOwner, type MemoryQuery } from './memory-owner.js';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? '';
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each([1, 3])('real FileSearch uses configured %i-worker budget and scoped admission receipts', async capacity => {
  if (!kernelPath) throw new Error('Requires an explicit source-bound VARIN_TEST_KERNEL_PATH');
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-family-capacity-review-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  let child!: ChildProcess;
  const kernel = createKernelClient({ hostId: 'family-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false,
    spawnProcess: ((command, args, options) => {
      child = spawn(command, args ?? [], { ...options, env: { ...process.env, ...options?.env, VARIN_COMPUTE_CONCURRENCY: String(capacity) } });
      return child;
    }) as typeof spawn });
  cleanup.push(() => kernel.close());
  const runtimeClient = new AgentRuntimeClient(kernel);
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'family-review', storageRoot: root,
    resolveWorkspaceRoot: async () => root });
  cleanup.push(() => storage.dispose());
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'family-project' }) });
  const prepareContext = createThreadContext({ personalization, workingStates: createKernelWorkspaceWorkingStateAccess(storage),
    projectForWorkspace: async () => 'family-project' });
  const memoryQueries: MemoryQuery[] = [];
  const memoryOwner = createMemoryOwner({ personalization, prepareContext });
  kernel.setMemoryOwner(async (query, signal) => { memoryQueries.push(structuredClone(query)); return memoryOwner(query, signal); });
  const requestBodies: Array<Record<string, unknown>> = [];
  expect((await runtimeClient.status()).admission.localComputeCapacity).toBe(capacity);
  let turns = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk)); request.on('end', () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      const output = ++turns === 1
        ? [{ id: 'search-item', type: 'function_call', call_id: 'search-call', name: 'file_search', arguments: JSON.stringify({ query: 'needle', fixedStrings: true }) }]
        : [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'done' }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  await runtimeClient.createThread('family-thread', 'family-branch');
  const receipt = await runtimeClient.submit({ key: 'family-input', threadId: 'family-thread', branchId: 'family-branch', expectedHead: null,
    input: { text: 'Find needle' }, initialContext: await prepareContext.main({ runtime: 'agent', threadId: 'family-thread', branchId: 'family-branch' }, null), configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
  const grant = await kernel.issueGrant({ grantId: 'family-source', threadId: 'family-thread', runId: receipt.run_id,
    owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const actor = kernel.scoped(grant); const bytes = Buffer.from('a tiny needle fixture\n'); const blob = await actor.putBlob(bytes, 'family-fixture');
  await actor.createBranch({ operationId: 'create-source', branchId: 'source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [],
    entries: [{ path: 'tiny.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const source = await actor.readBranch({ branchId: 'source' });
  const published = await actor.publishBranch({ operationId: 'publish-source', branchId: 'source', expectedRoot: source.root, expectedWriteRevision: source.writeRevision });
  await runtimeClient.startRun(receipt.run_id, undefined, { grantId: grant.grantId, runId: receipt.run_id, threadId: 'family-thread', workspaceId: 'workspace', executionWorkspaceId: 'workspace',
    fileSource: { branchId: 'source', revision: Number(published.revision) }, enabledTools: ['file_search'] });
  await expect.poll(async () => (await runtimeClient.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(turns).toBe(2);
  // Main launch actually installs B's MemoryTools and calls its production context owner.
  expect(memoryQueries.filter(query => query.action === 'synchronize' && query.runId === receipt.run_id)).toHaveLength(2);
  expect(memoryQueries[0]?.scope).toEqual({ mode: 'agent', sessionId: 'family-thread', projectId: null });
  for (const body of requestBodies) expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'memory' })]));
  const history = await runtimeClient.history('family-branch');
  const result = history.find(item => item.source === 'tool'); expect(result).toBeDefined();
  expect(JSON.stringify(result?.content)).toContain('needle');
  const requestId = result!.id.slice(0, -':result:search-call'.length);
  expect(result!.id).toBe(`${requestId}:result:search-call`);
  const epoch = (await runtimeClient.run(receipt.run_id)).epoch;
  const origin = { runId: receipt.run_id, ownerGeneration: epoch, requestId, callId: 'search-call' };
  expect((await runtimeClient.admission(origin)).state).toBe('settled');
  await expect(runtimeClient.admission({ ...origin, callId: 'unknown' })).rejects.toThrow(/not found.*tool call/i);
  await expect(runtimeClient.admission({ ...origin, ownerGeneration: epoch + 1 })).rejects.toThrow(/generation expired/i);
  await runtimeClient.createThread('foreign-thread', 'foreign-branch');
  const foreign = await runtimeClient.submit({ key: 'foreign-input', threadId: 'foreign-thread', branchId: 'foreign-branch', expectedHead: null, input: 'other', configuration: {} });
  await expect(runtimeClient.admission({ ...origin, runId: foreign.run_id })).rejects.toThrow(/origin is not owned/i);
  expect(await runtimeClient.status()).toMatchObject({ admission: { localComputeCapacity: capacity, localComputeActive: 0, queued: 0 } });
  // Linux observes actual worker threads rather than trusting a second configured scalar.
  if (process.platform === 'linux') {
    const taskRoot = `/proc/${child.pid}/task`;
    const names = await Promise.all((await fs.readdir(taskRoot)).map(async tid => (await fs.readFile(path.join(taskRoot, tid, 'comm'), 'utf8')).trim()));
    expect(names.filter(name => name.startsWith('compute-read-'))).toHaveLength(capacity);
    expect(names.filter(name => name === 'compute-index')).toHaveLength(1);
  }
  await runtimeClient.cancelRun(foreign.run_id);
  expect((await runtimeClient.run(foreign.run_id)).cancel_requested).toBe(true);
}, 30_000);
