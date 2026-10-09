import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNativeThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';
import { createKernelComputeService } from './compute-service.js';
import { createNativeLiveSourceOwner } from './native-live-source.js';
import type { NativeInitialContext } from './protocol.generated.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeThreadAdapter } from './native-thread-adapter.js';
import { registerNativeThreadRoutes } from './native-thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

export function responseTool(response: ServerResponse, name: string, args: Record<string, unknown>, serial = 1) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `item-${serial}`, type: 'function_call', call_id: `call-${serial}`, name, arguments: JSON.stringify(args) }] } })}\n\n`);
}
export function responseDone(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'done', type: 'message', content: [{ type: 'output_text', text: 'retrieval checked' }] }] } })}\n\n`);
}
export function latestOutput(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
  return item ? JSON.parse(String(item.output)) as Record<string, unknown> : undefined;
}
export const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

/** Real Documents, Rust kernel/compute and public HTTP route; only the model is scripted loopback. */
export async function retrievalFixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void) {
  if (!process.env.VARIN_TEST_KERNEL_PATH) throw new Error('Independent retrieval acceptance requires explicit frozen VARIN_TEST_KERNEL_PATH');
  const documents = await createDocumentAuthorityHarness({ hostId: 'process-consumer' });
  const native = createNativeProcessTestHarness(documents.authority);
  const { client: kernel } = await native.get();
  const compute = createKernelComputeService({ client: kernel, resolveIdentity: async cwd => {
    const identity = await documents.authority.resolveWorkspace({ path: cwd });
    return { workspaceId: identity.workspaceId, executionWorkspaceId: identity.workspaceId, canonicalRoot: (await documents.authority.inspectWorkspace(identity.workspaceId)).root };
  } });
  const liveSources = createNativeLiveSourceOwner({ documents: documents.authority, kernel });
  const runtime = new NativeRuntimeClient(kernel, undefined, undefined, undefined, liveSources.validate);
  const servers: Server[] = [];
  const listen = async (server: Server) => {
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address');
    return `http://127.0.0.1:${address.port}`;
  };
  const requests: Array<Record<string, unknown>> = [];
  const endpoint = `${await listen(createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests.push(body); reply(body, response); });
  }))}/responses`;
  const configuration = { providerFamily: 'openai-responses', model: 'retrieval-loopback', endpoint, credentialEnvironment: null, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 64 };
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: 'fixture', providerFamily: 'openai-responses', endpoint, allowAnonymous: true,
    currentScope: async () => ({ reference: 'retrieval-fixture', authority: 'fixture', account: 'loopback', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: {} }) },
  });
  const launchErrors: unknown[] = [];
  const adapter = new NativeThreadAdapter(runtime, { resolveModel: async () => ({ configuration, credentialOwner }), rebindModel: async () => credentialOwner },
    async (source, identity) => { if (source.mode !== 'live_root') throw new Error('Fixture HTTP path admits live source only'); await liveSources.admit(source, identity.threadId); },
    (_runId, error) => launchErrors.push(error));
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerNativeThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-retrieval-review'] !== 'owner') { response.status(401).json({ error: 'unauthorized' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-retrieval-review': 'owner' });
  const api = createNativeThreadsHttpAPI();
  const workspaceId = documents.identity.workspaceId;
  async function admit(id: string, tools: string[], scopes = [''], capabilities = ['storage.read', 'storage.write'], initialContext?: NativeInitialContext) {
    const threadId = `${id}-thread`, branchId = `${id}-branch`;
    await runtime.createThread(threadId, branchId);
    const receipt = await runtime.submit({ key: `${id}-input`, threadId, branchId, expectedHead: null, input: { text: id }, configuration, ...(initialContext ? { initialContext } : {}) });
    const grant = await kernel.issueGrant({ grantId: `${id}-grant`, threadId, runId: receipt.run_id, owningWorkspace: workspaceId, executionWorkspace: workspaceId, capabilities, pathScopes: scopes });
    const root = await kernel.scoped(grant).fileRootRegister({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: documents.workspaceRoot });
    const liveRoot = { hostId: 'process-consumer', canonicalRoot: root.canonicalRoot, rootId: root.rootId };
    const binding = { grantId: grant.grantId, threadId, runId: receipt.run_id, workspaceId, executionWorkspaceId: workspaceId, rootId: root.rootId, sourceMode: 'live_root', liveRoot, enabledTools: tools };
    return { receipt, grant, binding, branchId, start: () => runtime.startRun(receipt.run_id, undefined, binding) };
  }
  return { configuration, documents, kernel, compute, liveSources, runtime, api, hostUrl, workspaceId, requests, launchErrors, admit,
    write: async (relative: string, text: string) => { const file = path.join(documents.workspaceRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); },
    async dispose() {
      setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' });
      for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      await compute.dispose(); await native.dispose(); await documents.cleanup();
    },
  };
}
