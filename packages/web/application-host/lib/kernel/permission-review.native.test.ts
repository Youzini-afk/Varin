import { resourceScopeFixture } from './resource-scope.test-helper.js';
import { createMcpLease } from './mcp-owner.js';
import { createMemoryOwner } from './memory-owner.js';
import type { McpAuthorityLease } from '@varin/pi-host/mcp-authority';
import type { PermissionPolicy } from '@varin/protocol';
import { createThreadContext } from './thread-context.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string) {
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
  const resources = resourceScopeFixture(root, workingStates, documents);
  const prepare = createThreadSourcePreparer({ documents, workingStates, prepareResources: resources.prepareSourceCapture });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createThreadContext({ personalization, resources, projectForWorkspace: async () => 'selected-project' });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const effects: Array<Record<string, unknown>> = [];
  let currentPolicy: PermissionPolicy = { mode: 'normal', rules: [] };
  let callable = true;
  const revocation = new AbortController();
  const runtime = new AgentRuntimeClient(kernel, async () => {
    let released = false;
    const lease: McpAuthorityLease = {
      implementationIdentity:'fixture-implementation',
      binding: { reference: 'fixture-mcp-owner', generation: 1,
        serverSelections: [{ name: 'fixture-server', configurationVersion: 'fixture-config', hiddenTools: [] }],
        readiness: { configErrorCount: 0, configuredServerCount: 1, connectedServerCount: 1, cachedToolCount: 0, servers: [] },
        servers: [{ name: 'fixture-server', description: 'Fixture', resourceKey: 'fixture-server:effect', hasDirectTools: true, exposure: 'direct', configurationScope: 'global', executionScope: 'global', status: 'connected', cachedToolCount: 0, connectedToolCount: 1, selected: true }], tools: [{ name: 'fixture_send', server: 'fixture-server', tool: 'send', schemaVersion: 'schema-1', resourceKey: 'fixture-server:effect', configurationScope: 'global', executionScope: 'global', exposure: 'direct', description: 'Send exact text to the fixture sink', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] },
      inspect: () => ({ configErrorCount: 0, configuredServerCount: 1, connectedServerCount: 1, cachedToolCount: 0, servers: [] }),
      async discover() { throw new Error('unexpected fixture discovery'); },
      async prepareTool() { throw new Error('unexpected deferred fixture tool'); },
      assertCallable() { if (released || !callable) throw new Error('fixture_owner_changed'); },
      revocationSignal: () => revocation.signal,
      validateArguments(_name, _version, args) { if (!args || typeof args !== 'object' || typeof (args as { text?: unknown }).text !== 'string' || Object.keys(args).some(key => key !== 'text')) throw new Error('fixture_schema_invalid'); },
      async callTool(_name, args, options) { options.signal.throwIfAborted(); await options.beforeDispatch?.(); effects.push(structuredClone(args)); return { content: [{ type: 'text', text: 'fixture accepted' }] }; },
      release() { released = true; },
    };
    return createMcpLease({ lease, kernel, currentPolicy: async () => currentPolicy });
  });
  const adapter = new ThreadAdapter(runtime, {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { effects, setPolicy: (value: PermissionPolicy) => { currentPolicy = value; }, revokeOwner: () => { callable = false; revocation.abort(); }, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
function tool(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `send-${crypto.randomUUID()}`, type: 'function_call', call_id: `call-${crypto.randomUUID()}`, name: 'fixture_send', arguments: JSON.stringify({ text: 'only this approved text' }) }] } })}\n\n`);
}
function done(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `done-${crypto.randomUUID()}`, type: 'message', content: [{ type: 'output_text', text: 'permission result received' }] }] } })}\n\n`);
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  const identity = await f.api.create(key);
  const receipt = await f.api.submit({ ...identity, key: `${key}-input`, expectedHead: null, text: 'invoke exact fixture action', model });
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:')), { timeout: 10_000 }).toBe(true);
  const operation = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
  const permission = (operation.result as { permission: { id: string; call: Record<string, unknown>; scope: Record<string, unknown>; actor: Record<string, unknown>; decision: unknown; consumed: boolean } }).permission;
  return { identity, receipt, operation, permission };
}
it('real permission flow remains undispatched until exact allow-once and never turns an ordinary answer into consent', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls <= 2) tool(response); else done(response); });
  const { identity, receipt, operation, permission } = await pending(f, 'allow-exact-action');
  expect(f.effects).toEqual([]); expect(operation.effect).toBe('none');
  expect(permission.call).toMatchObject({ operationId: operation.id, runId: receipt.run_id, name: 'fixture_send', schemaVersion: 'schema-1', arguments: { text: 'only this approved text' } });
  expect(permission.actor.account).toBe('fixture-local-handle');
  await expect(f.api.answerQuestion({ ...identity, operationId: operation.id, answer: 'yes, allow it' })).rejects.toMatchObject({ status: 400 });
  const fork = await f.api.fork({ ...identity, key: 'foreign-permission-branch', headId: receipt.input_id });
  await expect(f.api.decidePermission({ ...fork, operationId: operation.id, permissionId: permission.id, decision: 'allow_once' })).rejects.toMatchObject({ status: 400 });
  await expect(f.api.decidePermission({ ...identity, operationId: operation.id, permissionId: 'different-permission', decision: 'allow_once' })).rejects.toMatchObject({ status: 400 });
  expect(f.effects).toEqual([]);
  await f.api.decidePermission({ ...identity, operationId: operation.id, permissionId: permission.id, decision: 'allow_once' });
  await expect.poll(() => f.effects.length).toBe(1);
  // An identical second tool call still requires a distinct user decision.
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.id !== operation.id && op.waiting_on?.startsWith('permission:'))).toBe(true);
  expect(f.effects).toEqual([{ text: 'only this approved text' }]);
  await expect(f.api.decidePermission({ ...identity, operationId: operation.id, permissionId: permission.id, decision: 'allow_once' })).rejects.toMatchObject({ status: 400 });
  const second = (await f.api.snapshot(identity)).operations.find(op => op.id !== operation.id && op.waiting_on?.startsWith('permission:'))!;
  const secondId = (second.result as { permission: { id: string } }).permission.id;
  await f.api.decidePermission({ ...identity, operationId: second.id, permissionId: secondId, decision: 'deny' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
  expect(f.effects).toHaveLength(1);
  expect((await f.api.operation(second.id)).effect).toBe('none');
}, 30_000);

it('changed policy, revoked owner and cancelled or reopened permissions never dispatch the approved call', async () => {
  for (const reason of ['policy', 'owner', 'cancel', 'restart'] as const) {
    let calls = 0;
    const reply = (_body: Record<string, unknown>, response: ServerResponse) => { if (++calls === 1) tool(response); else done(response); };
    const f = await fixture(reply);
    const state = await pending(f, `stale-permission-${reason}`);
    const decision = { ...state.identity, operationId: state.operation.id, permissionId: state.permission.id, decision: 'allow_once' as const };
    if (reason === 'policy') f.setPolicy({ mode: 'smart', rules: [] });
    if (reason === 'owner') f.revokeOwner();
    if (reason === 'cancel') { await f.api.cancelRun(state.receipt.run_id); await expect.poll(async () => (await f.api.run(state.receipt.run_id)).state).toBe('cancelled'); }
    if (reason === 'restart') {
      await f.close(); const reopened = await fixture(reply, f.root, f.endpoint);
      await expect(reopened.api.decidePermission(decision)).rejects.toMatchObject({ status: 400 });
      expect(reopened.effects).toEqual([]);
    } else if (reason === 'cancel' || reason === 'owner') {
      if (reason === 'owner') await expect.poll(async () => (await f.api.run(state.receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
      await expect(f.api.decidePermission(decision)).rejects.toMatchObject({ status: 400 });
    }
    else {
      await f.api.decidePermission(decision);
      await expect.poll(async () => (await f.api.run(state.receipt.run_id)).state).toBe('completed');
    }
    expect(f.effects).toEqual([]);
  }
}, 45_000);

it('explicit permission rules win, while Smart never infers approval for an unknown MCP effect', async () => {
  for (const selected of ['allow', 'deny', 'smart'] as const) {
    let calls = 0;
    const f = await fixture((_body, response) => { if (++calls === 1) tool(response); else done(response); });
    f.setPolicy(selected === 'smart' ? { mode: 'smart', rules: [] } : { mode: 'normal', rules: [{ tool: 'fixture_send', decision: selected }] });
    const identity = await f.api.create(`rule-${selected}`);
    const receipt = await f.api.submit({ ...identity, key: `rule-${selected}-input`, expectedHead: null, text: 'apply the current exact policy', model });
    if (selected === 'smart') {
      await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:'))).toBe(true);
      expect(f.effects).toEqual([]);
      const op = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
      await f.api.decidePermission({ ...identity, operationId: op.id, permissionId: (op.result as { permission: { id: string } }).permission.id, decision: 'deny' });
    }
    await expect.poll(async () => (await f.api.run(receipt.run_id)).state).toBe('completed');
    expect(f.effects).toHaveLength(selected === 'allow' ? 1 : 0);
    const opened = (await f.runtime.events(0, 256)).filter(event => event.kind === 'permission.opened');
    expect(opened).toHaveLength(selected === 'smart' ? 1 : 0);
  }
}, 45_000);
