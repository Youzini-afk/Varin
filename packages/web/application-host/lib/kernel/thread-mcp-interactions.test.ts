import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import type { McpElicitationResponse, McpInteractionItem, McpInteractionView } from '@varin/protocol';
import { createMcpInteractionRuntime } from './mcp-interaction-runtime.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const target = { ...identity, operationId: 'operation:original', interactionId: 'request:original' };
const original = (): McpInteractionView => ({ record: {
  id: target.interactionId, revision: 4, binding: { operationId: target.operationId,
    executionOwner: { kind: 'external', identity: 'original-owner', epoch: 'original-epoch' }, connectionId: 'original-connection',
    endpoint: { server: 'original-server', resourceKey: 'resource', configurationVersion: 'configuration', credentialVersion: 'grant' },
    source: { kind: 'server_request', requestId: 0, relation: { kind: 'task', taskId: 'remote-task' } } }, runId: 'run:finished', threadId: identity.threadId, branchId: identity.branchId,
  mode: 'form', availability: 'rpc_closed', choice: 'accept', delivery: 'sent', completionReported: false, problem: null },
  request: { message: 'Private original server request' }, presentation: { mode: 'form', message: 'Private original server request', fields: [] },
  response: { action: 'accept', content: { boolean: false, number: 0, empty: '', selected: [] } },
});

const item = ({ record, presentation, response }: McpInteractionItem): McpInteractionItem => ({ record, presentation, response });
const originalError = (): McpInteractionView => {
  const view = original();
  const presentation = { mode: 'url' as const, message: 'Review the original external step', url: 'https://accounts.example.test/finish?original=1', elicitationId: 'external:original' };
  return { ...view, record: { ...view.record, mode: 'url', choice: null, availability: 'owner_unavailable', delivery: null,
    binding: { ...view.record.binding, source: { kind: 'rpc_error', outgoingRequestId: 1.5, method: 'tools/call', elicitationId: presentation.elicitationId } } },
    presentation, response: null, request: { code: -32042, message: 'The original RPC failed',
      data: { elicitations: [presentation], originalErrorEvidence: 'private original evidence '.repeat(1000) } } };
};

/** Real client, authenticated routes, adapter, AgentRuntimeClient and local response owner. Only the private kernel
 * request port is controlled here; the separate owner integration suite proves remote delivery. */
function fixture() {
  const state = { view: original(), fail: false, block: false };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (method === 'runtime.thread.inspect') return { thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, active_run_id: null, latest_run: null }] };
    if (state.block) return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
    if (state.fail) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: secret upstream request and account details' });
    if (method === 'runtime.mcp.interaction.list') return { items: [item(state.view)], nextCursor: 'opaque:history' };
    if (method === 'runtime.mcp.interaction.read') {
      if (params.operationId !== target.operationId || params.interactionId !== target.interactionId) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: original interaction binding' });
      return state.view;
    }
    if (method === 'runtime.mcp.interaction.respond') {
      if (params.expectedRevision !== state.view.record.revision) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: stale revision' });
      const response = params.response as McpElicitationResponse;
      state.view = { ...state.view, response, record: { ...state.view.record, choice: response.action, revision: state.view.record.revision + 1 } };
      return state.view.record;
    }
    throw new Error(`Unexpected private RPC ${method}`);
  });
  const kernel = { subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient;
  const runtime = new AgentRuntimeClient(kernel);
  // No active receiver/connection is installed: this is an original persisted error after reopen.
  runtime.setMcpInteractionOwner(createMcpInteractionRuntime({ kernel, runtime }));
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  registerThreadRoutes({ post(path: string, ...chain: RequestHandler[]) { routes.set(path, chain); }, get() {} } as unknown as Express,
    adapter, (request, response, next) => { if (request.headers.authorization !== 'original-host-session') response.status(401).end(); else next(); });
  const request = async (path: string, body: unknown, authenticated = true, signal?: AbortSignal) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    const close = () => response.emit('close'); signal?.addEventListener('abort', close, { once: true });
    const input = { body, headers: authenticated ? { authorization: 'original-host-session' } : {} } as Request;
    try {
      await new Promise<void>((resolve, reject) => {
        let index = 0;
        const next = (failure?: unknown) => {
          if (failure) { reject(failure); return; }
          const handler = routes.get(path)![index++]; if (!handler) { resolve(); return; }
          Promise.resolve(handler(input, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
        }; next();
      });
      signal?.throwIfAborted();
      return Response.json(output ?? {}, { status });
    } finally { signal?.removeEventListener('abort', close); }
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'https://fixture.invalid').pathname, JSON.parse(String(init.body)), true, init.signal ?? undefined));
  return { state, requests, models, request, api: createThreadsHttpAPI() };
}
afterEach(() => vi.unstubAllGlobals());

it('reads a bounded page and original closed request after Run completion through the actual public chain', async () => {
  const f = fixture();
  expect(await f.api.listMcpInteractions({ ...identity, cursor: 'opaque:cursor', limit: 2 })).toEqual({ items: [item(f.state.view)], nextCursor: 'opaque:history' });
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.mcp.interaction.list', { threadId: identity.threadId, branchId: identity.branchId, cursor: 'opaque:cursor', limit: 2 }]);
  expect(await f.api.readMcpInteraction(target)).toEqual(f.state.view);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.mcp.interaction.read', { operationId: target.operationId, interactionId: target.interactionId }]);
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual(['runtime.thread.inspect', 'runtime.mcp.interaction.list', 'runtime.thread.inspect', 'runtime.mcp.interaction.read']);
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
});

it.each([original, originalError])('authenticates all three routes and rejects foreign exact Thread, branch, interaction and Operation identities before response delivery (%#)', async makeView => {
  const f = fixture(); f.state.view = makeView(); const body = { ...target, expectedRevision: 4, response: { action: 'accept' } };
  for (const action of ['list', 'read', 'respond']) expect((await f.request(`/api/threads/mcp/interactions/${action}`, body, false)).status).toBe(401);
  expect(f.requests).not.toHaveBeenCalled();
  await expect(f.api.readMcpInteraction({ ...target, branchId: 'branch:foreign' })).rejects.toMatchObject({ status: 400 });
  f.state.view.record.threadId = 'thread:other';
  await expect(f.api.readMcpInteraction(target)).rejects.toMatchObject({ status: 403 });
  await expect(f.api.respondMcpInteraction({ ...target, expectedRevision: 4, response: { action: 'decline' } })).rejects.toMatchObject({ status: 403 });
  f.state.view = makeView();
  await expect(f.api.readMcpInteraction({ ...target, operationId: 'operation:other' })).rejects.toMatchObject({ status: 409 });
  await expect(f.api.respondMcpInteraction({ ...target, interactionId: 'request:other', expectedRevision: 4, response: { action: 'cancel' } })).rejects.toMatchObject({ status: 409 });
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method === 'runtime.mcp.interaction.read')).toBe(true);
  expect((await f.request('/api/threads/mcp/interactions/respond', { ...body, authority: 'spoofed' })).status).toBe(400);
});

it('projects actionable conflicts without leaking original server or credential details', async () => {
  const f = fixture(); f.state.fail = true;
  const response = await f.request('/api/threads/mcp/interactions/read', target);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'thread-conflict', error: 'Thread request could not be completed' });
});

it.each(['list', 'read'] as const)('closing the %s response cancels only its reader, never the remote interaction, Operation or Run', async action => {
  const f = fixture(); f.state.block = true;
  const controller = new AbortController();
  const work = action === 'list' ? f.api.listMcpInteractions(identity, controller.signal) : f.api.readMcpInteraction(target, controller.signal);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.requests).toHaveBeenCalledTimes(2));
  controller.abort(); await rejected;
  expect(f.requests.mock.calls[1]![2]?.aborted).toBe(true);
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual(['runtime.thread.inspect', `runtime.mcp.interaction.${action}`]);
});


it.each(['accept', 'decline', 'cancel'] as const)('records error-source %s through the real public consumer and original local response owner without a send or Run command', async action => {
  const f = fixture(); f.state.view = originalError();
  const evidence = structuredClone(f.state.view.request);
  const page = await f.api.listMcpInteractions({ ...identity, limit: 1 });
  expect(page.items[0]?.record.binding.source).toEqual({ kind: 'rpc_error', outgoingRequestId: 1.5, method: 'tools/call', elicitationId: 'external:original' });
  expect(Object.hasOwn(page.items[0]!, 'request')).toBe(false);
  expect(JSON.stringify(page)).not.toContain('originalErrorEvidence');
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.interaction.read')).toBe(false);
  expect((await f.api.readMcpInteraction(target)).request).toEqual(evidence);
  f.requests.mockClear();
  const choice = { ...target, expectedRevision: 4, response: { action } };
  const accepted = await f.api.respondMcpInteraction(choice);
  expect(accepted.record).toMatchObject({ availability: 'owner_unavailable', choice: action, delivery: null, completionReported: false, runId: 'run:finished' });
  expect(accepted.request).toEqual(evidence);
  expect(accepted.response).toEqual({ action });
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual([
    'runtime.thread.inspect', 'runtime.mcp.interaction.read', 'runtime.mcp.interaction.read',
    'runtime.mcp.interaction.respond', 'runtime.mcp.interaction.read',
  ]);
  expect(await f.api.respondMcpInteraction(choice)).toEqual(accepted);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.interaction.respond')).toHaveLength(1);
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
});

it('leaves malformed local URL choices to the original validator without a second route schema', async () => {
  const f = fixture(); f.state.view = originalError();
  await expect(f.api.respondMcpInteraction({ ...target, expectedRevision: 4, response: { action: 'accept', content: { injected: 'value' } } }))
    .rejects.toMatchObject({ status: 400, code: 'mcp_interaction_response_invalid' });
  expect(f.state.view.record.choice).toBeNull();
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.interaction.respond')).toBe(false);
});
