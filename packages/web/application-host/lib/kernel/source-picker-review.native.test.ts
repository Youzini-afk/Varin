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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string) {
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
  const endpoint = `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createThreadSourcePreparer({ documents, workingStates });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
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
it('prepares saved disk through real Documents and capture; concurrent and reopened retries keep its read-only baseline', async () => {
  let read = '';
  const reply = (body: Record<string, unknown>, response: ServerResponse) => {
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    if (!output) tool(response, 'file_read', { path: 'source.txt' }, 1);
    else { read = String(output.output); done(response); }
  };
  const f = await fixture(reply);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'saved baseline');
  const identity = await f.api.create('prepared-source');
  const request = { ...identity, key: 'same-capture', path: f.workspace, mode: 'fixed_branch' as const };
  const [first, concurrent] = await Promise.all([f.api.prepareSource(request), f.api.prepareSource(request)]);
  expect(first).toEqual(concurrent);
  expect(first.source.workspaceId).toBe((await f.documents.resolveWorkspace({ path: f.workspace })).workspaceId);
  expect(first.source.tools).toContain('file_read');
  expect(first.source.tools.every(tool => ['file_read', 'file_list', 'file_search'].includes(tool))).toBe(true);
  expect(first.source.revision).toBe(0);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed disk after capture');
  expect(await f.api.prepareSource(request)).toEqual(first);
  const other = await f.api.create('other-prepared-thread');
  await expect(f.api.prepareSource({ ...request, threadId: other.threadId })).rejects.toMatchObject({ status: 400 });
  await expect(f.api.prepareSource({ ...request, key: 'missing-folder', path: path.join(f.root, 'absent') })).rejects.toMatchObject({ status: 400 });
  await f.close();
  const reopened = await fixture(reply, f.root);
  expect(await reopened.api.prepareSource(request)).toEqual(first);
  const receipt = await reopened.api.submit({ ...identity, key: 'read-snapshot', expectedHead: null, text: 'read saved snapshot', model, source: first.source });
  await expect.poll(async () => (await reopened.api.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(read).toContain('saved baseline');
  expect(read).not.toContain('changed disk after capture');
  expect(await fs.readFile(path.join(f.workspace, 'source.txt'), 'utf8')).toBe('changed disk after capture');
  expect(reopened.launchErrors).toEqual([]);
}, 45_000);

it('prepared editable copy runs a real process without modifying the source folder, and cannot accept invented workspace IDs', async () => {
  let serial = 0; let processId = ''; let read = ''; let discovered = ''; let matched = '';
  const f = await fixture((body, response) => {
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    const result = output ? JSON.parse(String(output.output)) as { operation_id?: string; content?: { writerActive?: boolean } } : undefined;
    if (!output) tool(response, 'process_spawn', { cwd: '', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("source.txt", "isolated process edit"); require("node:fs").writeFileSync("generated.txt", "new process file")'], mode: 'pipe' }, ++serial);
    else if (String(output.call_id).startsWith('process_spawn-')) { processId = result!.operation_id!; tool(response, 'process_inspect', { processId }, ++serial); }
    else if (String(output.call_id).startsWith('process_inspect-')) { if (result!.content!.writerActive) tool(response, 'process_inspect', { processId }, ++serial); else tool(response, 'file_list', {}, ++serial); }
    else if (String(output.call_id).startsWith('file_list-')) { discovered = String(output.output); tool(response, 'file_search', { query: 'isolated process edit' }, ++serial); }
    else if (String(output.call_id).startsWith('file_search-')) { matched = String(output.output); tool(response, 'file_read', { path: 'source.txt' }, ++serial); }
    else { read = String(output.output); done(response); }
  });
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'unmodified source folder');
  const identity = await f.api.create('editable-prepared-source');
  const prepared = await f.api.prepareSource({ ...identity, key: 'editable-capture', path: f.workspace, mode: 'materialized' });
  const input = { ...identity, key: 'execute-isolated-copy', expectedHead: null, text: 'edit only isolated working copy', model, source: prepared.source };
  await expect(f.api.submit({ ...input, source: { ...prepared.source, workspaceId: 'invented-workspace' } })).rejects.toMatchObject({ status: 400 });
  expect((await f.api.snapshot(identity)).history).toEqual([]);
  const receipt = await f.api.submit(input);
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(read).toContain('isolated process edit');
  expect(discovered).toContain('generated.txt');
  expect(matched).toContain('isolated process edit');
  expect(await fs.readFile(path.join(f.workspace, 'source.txt'), 'utf8')).toBe('unmodified source folder');
  expect(f.launchErrors).toEqual([]);
}, 45_000);

it('list and search discover the prepared fixed snapshot rather than later disk paths or contents', async () => {
  let turn = 0;
  const returned: string[] = [];
  const f = await fixture((body, response) => {
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    if (output) returned.push(String(output.output));
    turn++;
    if (turn === 1) tool(response, 'file_list', { paths: ['src'], recursive: true }, turn);
    else if (turn === 2) tool(response, 'file_search', { paths: ['src'], query: 'needle', fixedStrings: true }, turn);
    else done(response);
  });
  await fs.mkdir(path.join(f.workspace, 'src'));
  await fs.writeFile(path.join(f.workspace, 'src', 'original.ts'), 'needle snapshot content');
  const identity = await f.api.create('fixed-discovery-thread');
  const prepared = await f.api.prepareSource({ ...identity, key: 'fixed-discovery-source', path: f.workspace, mode: 'fixed_branch' });
  await fs.writeFile(path.join(f.workspace, 'src', 'original.ts'), 'needle changed live content');
  await fs.writeFile(path.join(f.workspace, 'src', 'live-only.ts'), 'needle not in snapshot');
  const receipt = await f.api.submit({ ...identity, key: 'fixed-discovery-input', expectedHead: null, text: 'list and search the saved workspace', model, source: prepared.source });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(returned).toHaveLength(2);
  expect(returned[0]).toContain('src/original.ts');
  expect(returned[0]).not.toContain('live-only.ts');
  expect(returned[1]).toContain('needle snapshot content');
  expect(returned[1]).not.toContain('changed live content');
  expect(returned[1]).not.toContain('not in snapshot');
  expect(f.launchErrors).toEqual([]);
}, 30_000);
