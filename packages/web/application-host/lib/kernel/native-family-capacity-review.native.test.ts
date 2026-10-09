import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';

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
      child = spawn(command, args ?? [], { ...options, env: { ...process.env, ...options?.env, VARIN_NATIVE_COMPUTE_CONCURRENCY: String(capacity) } });
      return child;
    }) as typeof spawn });
  cleanup.push(() => kernel.close());
  const native = new NativeRuntimeClient(kernel);
  expect((await native.status()).admission.localComputeCapacity).toBe(capacity);
  let turns = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      const output = ++turns === 1
        ? [{ id: 'search-item', type: 'function_call', call_id: 'search-call', name: 'native_file_search', arguments: JSON.stringify({ query: 'needle', fixedStrings: true }) }]
        : [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'done' }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  await native.createThread('family-thread', 'family-branch');
  const receipt = await native.submit({ key: 'family-input', threadId: 'family-thread', branchId: 'family-branch', expectedHead: null,
    input: { text: 'Find needle' }, configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
  const grant = await kernel.issueGrant({ grantId: 'family-source', threadId: 'family-thread', runId: receipt.run_id,
    owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const actor = kernel.scoped(grant); const bytes = Buffer.from('a tiny needle fixture\n'); const blob = await actor.putBlob(bytes, 'family-fixture');
  await actor.createBranch({ operationId: 'create-source', branchId: 'source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [],
    entries: [{ path: 'tiny.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const source = await actor.readBranch({ branchId: 'source' });
  const published = await actor.publishBranch({ operationId: 'publish-source', branchId: 'source', expectedRoot: source.root, expectedWriteRevision: source.writeRevision });
  await native.startRun(receipt.run_id, undefined, { grantId: grant.grantId, runId: receipt.run_id, threadId: 'family-thread', workspaceId: 'workspace', executionWorkspaceId: 'workspace',
    fileSource: { branchId: 'source', revision: Number(published.revision) }, enabledTools: ['file_search'] });
  await expect.poll(async () => (await native.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(turns).toBe(2);
  const history = await native.history('family-branch');
  const result = history.find(item => item.source === 'tool'); expect(result).toBeDefined();
  expect(JSON.stringify(result?.content)).toContain('needle');
  const requestId = result!.id.slice(0, -':result:search-call'.length);
  expect(result!.id).toBe(`${requestId}:result:search-call`);
  const epoch = (await native.run(receipt.run_id)).epoch;
  const origin = { runId: receipt.run_id, ownerGeneration: epoch, requestId, callId: 'search-call' };
  expect((await native.admission(origin)).state).toBe('settled');
  await expect(native.admission({ ...origin, callId: 'unknown' })).rejects.toThrow(/not found.*tool call/i);
  await expect(native.admission({ ...origin, ownerGeneration: epoch + 1 })).rejects.toThrow(/generation expired/i);
  await native.createThread('foreign-thread', 'foreign-branch');
  const foreign = await native.submit({ key: 'foreign-input', threadId: 'foreign-thread', branchId: 'foreign-branch', expectedHead: null, input: 'other', configuration: {} });
  await expect(native.admission({ ...origin, runId: foreign.run_id })).rejects.toThrow(/origin is not owned/i);
  expect(await native.status()).toMatchObject({ admission: { localComputeCapacity: capacity, localComputeActive: 0, queued: 0 } });
  // Linux observes actual worker threads rather than trusting a second configured scalar.
  if (process.platform === 'linux') {
    const taskRoot = `/proc/${child.pid}/task`;
    const names = await Promise.all((await fs.readdir(taskRoot)).map(async tid => (await fs.readFile(path.join(taskRoot, tid, 'comm'), 'utf8')).trim()));
    expect(names.filter(name => name.startsWith('compute-read-'))).toHaveLength(capacity);
    expect(names.filter(name => name === 'compute-index')).toHaveLength(1);
  }
  await native.cancelRun(foreign.run_id);
  expect((await native.run(foreign.run_id)).cancel_requested).toBe(true);
}, 30_000);
