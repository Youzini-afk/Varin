import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import type { McpElicitationResponse, McpInteractionItem, McpInteractionView, McpInteractionRecord, ModelSessionConfiguration, McpSamplingResult } from '@varin/protocol';
import type { McpInteractionRequest } from '../mcp/authority.js';
import { createMcpInteractionRuntime } from './mcp-interaction-runtime.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const target = { ...identity, operationId: 'operation:original', interactionId: 'request:original' };
const original = (): McpInteractionView => ({ record: {
  id: target.interactionId, revision: 4, binding: { operationId: target.operationId,
    executionOwner: { kind: 'external', identity: 'original-owner', epoch: 'original-epoch' }, connectionId: 'original-connection',
    endpoint: { server: 'original-server', resourceKey: 'resource', configurationVersion: 'configuration', credentialVersion: 'grant' },
    source: { kind: 'server_request', requestId: 0, relation: { kind: 'task', taskId: 'remote-task' } } }, runId: 'run:finished', threadId: identity.threadId, branchId: identity.branchId,
  mode: 'form', availability: 'rpc_closed', choice: 'accept', delivery: 'sent', completionReported: false, deliveryReleased: true, problem: null },
  request: { message: 'Private original server request' }, presentation: { mode: 'form', message: 'Private original server request', fields: [] },
  response: { action: 'accept', content: { boolean: false, number: 0, empty: '', selected: [] } },
});

const item = ({ record, presentation, response, generation }: McpInteractionItem): McpInteractionItem => ({ record, presentation, response, ...(generation ? { generation } : {}) });
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
  const credentialScope = { reference: 'original-model-grant', authority: 'registered-model-owner', account: 'original-account', generation: 3 };
  const configuration: ModelSessionConfiguration = { providerId: 'registered-provider', providerFamily: 'openai-completions', model: 'registered-model',
    endpoint: 'https://model.example.test/v1/chat/completions', credentialEnvironment: null, allowAnonymous: false,
    configurationGeneration: 6, maxOutputTokens: 2048, acceptsImages: true };
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: configuration.providerId!, providerFamily: configuration.providerFamily,
    endpoint: configuration.endpoint, currentScope: async () => credentialScope,
    runtime: { getAuth: vi.fn(async () => ({ auth: { apiKey: 'PRIVATE_PROVIDER_SECRET' } })) } });
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (method === 'runtime.thread.inspect') return { thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, active_run_id: null, latest_run: null }] };
    if (state.block) return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
    if (state.fail) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: secret upstream request and account details' });
    if (method === 'runtime.mcp.interaction.list') return { items: [item(state.view)], nextCursor: 'opaque:history' };
    if (method === 'runtime.mcp.interaction.pending') return state.view.record.availability === 'live'
      ? [{ ...state.view.record, ...(state.view.generation ? { generation: state.view.generation } : {}) }] : [];
    if (method === 'runtime.mcp.interaction.read' || method === 'runtime.mcp.interaction.inspect') {
      if (Object.keys(params).some(key => key !== 'operationId' && key !== 'interactionId')) {
        throw new KernelClientError({ code: 'protocol-error', message: 'Unexpected interaction read field' });
      }
      if (params.operationId !== state.view.record.binding.operationId || params.interactionId !== state.view.record.id) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: original interaction binding' });
      return method === 'runtime.mcp.interaction.read' ? state.view : { ...state.view.record, ...(state.view.generation ? { generation: state.view.generation } : {}) };
    }
    if (method === 'runtime.mcp.interaction.open') {
      const record: McpInteractionRecord = { ...original().record, id: String(params.id), binding: params.binding as McpInteractionRecord['binding'],
        revision: 1, mode: 'sampling', availability: 'live', choice: null, delivery: 'not_started',
        sampling: { generationOperationId: null, review: 'request' } };
      state.view = { record, request: params.request as Record<string, unknown>, presentation: params.presentation as McpInteractionItem['presentation'], response: null,
        sampling: { editedRequest: null, output: null, providerOutput: null, receipt: null, snapshot: null } };
      return record;
    }
    // This controlled native request port establishes consumer wiring only. The native composition
    // suite supplies real validation, model dispatch and durable generation behavior.
    if (method === 'runtime.mcp.sampling.generate') {
      if (params.expectedRevision !== state.view.record.revision) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: stale revision' });
      const generationOperationId = `${String(params.interactionId)}:generation:${String(params.expectedRevision)}`;
      const output: McpSamplingResult = { role: 'assistant', model: configuration.model, content: { type: 'text', text: 'Original isolated model output' }, stopReason: 'endTurn' };
      state.view = { ...state.view, record: { ...state.view.record, revision: state.view.record.revision + 1,
        sampling: { generationOperationId, review: 'output' } },
        generation: { operationId: generationOperationId, phase: 'terminal', outcome: 'succeeded', cancelRequested: false,
          dispatch: 'completed', model: { providerId: configuration.providerId!, providerFamily: configuration.providerFamily, model: configuration.model, maxTokens: 64 },
          usage: { measurement: 'actual', inputTokens: 12, outputTokens: 7, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null }, problem: null },
        sampling: { editedRequest: params.editedRequest as Record<string, unknown>, output, providerOutput: { privateProviderField: 'retained' },
          receipt: { original: true }, snapshot: { request: 'original isolated snapshot' } } };
      return state.view.record;
    }
    if (method === 'runtime.mcp.sampling.review_request' || method === 'runtime.mcp.sampling.review_output') {
      if (params.expectedRevision !== state.view.record.revision) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: stale revision' });
      state.view = { ...state.view, record: { ...state.view.record, revision: state.view.record.revision + 1,
        choice: params.action as 'accept' | 'decline' | 'cancel', sampling: { ...state.view.record.sampling!, review: 'closed' } } };
      return state.view.record;
    }
    if (method === 'runtime.mcp.interaction.response.begin' || method === 'runtime.mcp.interaction.response.settle' || method === 'runtime.mcp.interaction.close') {
      state.view = { ...state.view, record: { ...state.view.record, revision: state.view.record.revision + 1,
        ...(method === 'runtime.mcp.interaction.close' ? { availability: params.availability as McpInteractionRecord['availability'] }
          : { delivery: method === 'runtime.mcp.interaction.response.begin' ? 'sending' : params.delivery as McpInteractionRecord['delivery'] }) } };
      return state.view.record;
    }
    if (method === 'runtime.mcp.interaction.respond') {
      if (params.expectedRevision !== state.view.record.revision) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: stale revision' });
      const response = params.response as McpElicitationResponse;
      state.view = { ...state.view, response, record: { ...state.view.record, choice: response.action, revision: state.view.record.revision + 1 } };
      return state.view.record;
    }
    throw new Error(`Unexpected private RPC ${method}`);
  });
  const registerCredentialOwner = vi.fn(async (_runId: string, owner: ExistingHostCredentialOwner) => owner.scope());
  const unregisterCredentialOwner = vi.fn();
  const kernel = { subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests, registerCredentialOwner, unregisterCredentialOwner, kernelEpoch: 'kernel:fixture' } as unknown as KernelClient;
  const runtime = new AgentRuntimeClient(kernel);
  // No active receiver/connection is installed: this is an original persisted error after reopen.
  const owner = createMcpInteractionRuntime({ kernel, runtime });
  runtime.setMcpInteractionOwner(owner);
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })), rebindModel: vi.fn() };
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
  const receiveSampling = (body: Record<string, unknown>) => {
    const controller = new AbortController();
    const before: Array<() => void | Promise<void>> = [];
    const settled: Array<(status: 'sent' | 'not_sent' | 'unknown') => void> = [];
    const input: McpInteractionRequest = { binding: original().record.binding, request: body, signal: controller.signal,
      assertLive: async () => controller.signal.throwIfAborted(), beforeResponse: callback => { before.push(callback); },
      onResponseSettled: callback => { settled.push(callback); }, onComplete: () => () => {} };
    const answer = owner.samplingReceiver(input); void answer.catch(() => {});
    return { controller, before, settled, answer };
  };
  return { state, requests, models, request, api: createThreadsHttpAPI(), owner, runtime, receiveSampling, configuration, credentialScope, credentialOwner, registerCredentialOwner, unregisterCredentialOwner };
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

const samplingRequest = () => ({ messages: [
  { role: 'user', content: [{ type: 'text', text: 'Review this literal <script>request</script>' },
    { type: 'image', mimeType: 'image/png', data: 'original-image-bytes' }] },
], maxTokens: 64, modelPreferences: { hints: [{ name: 'server-suggested-model' }] },
unmappedServerField: { retained: true, large: '完整原始请求'.repeat(1000) } });
const samplingTarget = (f: ReturnType<typeof fixture>) => ({ ...identity,
  operationId: f.state.view.record.binding.operationId, interactionId: f.state.view.record.id });
const selectedModel = { providerId: 'registered-provider', modelId: 'registered-model', thinkingLevel: 'off' as const };

it('requires both explicit reviews through the actual public chain, preserving full bodies and using only the registered model authority', async () => {
  const f = fixture(); const originalRequest = samplingRequest(); const peer = f.receiveSampling(originalRequest);
  const reviewed = structuredClone(originalRequest); reviewed.messages[0]!.content[0]!.text = 'User reviewed this exact request';
  const runtimeRequest = vi.spyOn(f.runtime, 'reviewMcpSamplingRequest');
  const runtimeOutput = vi.spyOn(f.runtime, 'reviewMcpSamplingOutput');
  const received = vi.fn(); void peer.answer.then(received, () => {});
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const target = samplingTarget(f);
    const page = await f.api.listMcpInteractions(identity);
    expect(JSON.stringify(page)).not.toContain('unmappedServerField');
    expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
    const expanded = await f.api.readMcpInteraction(target);
    expect(expanded.request).toEqual(originalRequest);
    const generated = await f.api.reviewMcpSamplingRequest({ ...target, expectedRevision: expanded.record.revision,
      action: 'generate', model: selectedModel, editedRequest: reviewed });
    expect(f.models.resolveModel).toHaveBeenCalledExactlyOnceWith(selectedModel);
    expect(runtimeRequest.mock.calls[0]![0]).toEqual({ operationId: target.operationId, interactionId: target.interactionId,
      expectedRevision: expanded.record.revision, action: 'generate', editedRequest: reviewed });
    expect(runtimeRequest.mock.calls[0]![1]).toEqual({ configuration: f.configuration, credentialOwner: f.credentialOwner });
    expect(f.registerCredentialOwner).toHaveBeenCalledWith('run:finished', f.credentialOwner, expect.any(AbortSignal),
      `${target.interactionId}:generation:1`, { kind: 'operation', operationId: `${target.interactionId}:generation:1`, assertLive: expect.any(Function) });
    expect(f.requests.mock.calls.find(([method]) => method === 'runtime.mcp.sampling.generate')?.[1]).toEqual({
      operationId: target.operationId, interactionId: target.interactionId, expectedRevision: expanded.record.revision,
      editedRequest: reviewed, configuration: f.configuration, credentialScope: f.credentialScope,
    });
    expect(generated.request).toEqual(originalRequest); expect(generated.sampling?.editedRequest).toEqual(reviewed);
    expect(generated.record).toMatchObject({ choice: null, delivery: 'not_started', sampling: { review: 'output' } });
    await vi.waitFor(() => expect(f.unregisterCredentialOwner).toHaveBeenCalledExactlyOnceWith('run:finished', `${target.interactionId}:generation:1`));
    expect(received).not.toHaveBeenCalled(); expect(runtimeOutput).not.toHaveBeenCalled();
    const generatedPage = await f.api.listMcpInteractions(identity);
    expect(generatedPage.items[0]?.generation).toEqual(generated.generation);
    expect(JSON.stringify(generatedPage)).not.toContain('privateProviderField');
    const accepted = await f.api.reviewMcpSamplingOutput({ ...target, expectedRevision: generated.record.revision, action: 'accept' });
    expect(accepted.record.choice).toBe('accept');
    expect(await peer.answer).toEqual(generated.sampling!.output);
    expect(accepted.record.delivery).toBe('not_started');
    for (const callback of peer.before) await callback();
    for (const callback of peer.settled) callback('sent');
    await vi.waitFor(() => expect(f.state.view.record.delivery).toBe('sent'));
    expect((await f.api.readMcpInteraction(target)).record).toMatchObject({ choice: 'accept', delivery: 'sent' });
    expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(f.models.rebindModel).not.toHaveBeenCalled();
    expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method.startsWith('runtime.mcp.'))).toBe(true);
    expect(JSON.stringify([generated, accepted])).not.toContain('PRIVATE_PROVIDER_SECRET');
  } finally { await f.owner.dispose(); }
});

it('authenticates sampling routes and denies foreign branch identities before resolving a model or changing the original request', async () => {
  const f = fixture(); const peer = f.receiveSampling(samplingRequest());
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const target = samplingTarget(f);
    const input = { ...target, expectedRevision: 1, action: 'generate' as const, model: selectedModel, editedRequest: samplingRequest() };
    f.requests.mockClear();
    for (const route of ['request', 'output']) expect((await f.request(`/api/threads/mcp/interactions/sampling/${route}`, input, false)).status).toBe(401);
    expect(f.requests).not.toHaveBeenCalled();
    f.state.view = { ...f.state.view, record: { ...f.state.view.record, branchId: 'branch:foreign' } };
    await expect(f.api.reviewMcpSamplingRequest(input)).rejects.toMatchObject({ status: 403 });
    await expect(f.api.reviewMcpSamplingOutput({ ...target, expectedRevision: 1, action: 'accept' })).rejects.toMatchObject({ status: 403 });
    expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method === 'runtime.mcp.interaction.read')).toBe(true);
  } finally { peer.controller.abort(); await f.owner.dispose(); }
});

it('rejects renderer-supplied private model authority while forwarding an unmodified reviewed request to its original validator', async () => {
  const f = fixture(); const peer = f.receiveSampling({ ...samplingRequest(), message: 'This remains sampling', requestedSchema: { type: 'object', properties: {} } });
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const input = { ...samplingTarget(f), expectedRevision: 1, action: 'generate', model: selectedModel, editedRequest: samplingRequest() };
    for (const extra of [{ configuration: f.configuration }, { credentialScope: f.credentialScope }, { endpoint: 'https://untrusted.invalid' }, { credentials: 'injected' }]) {
      expect((await f.request('/api/threads/mcp/interactions/sampling/request', { ...input, ...extra })).status).toBe(400);
    }
    expect((await f.request('/api/threads/mcp/interactions/sampling/request', { ...input, model: { ...selectedModel, endpoint: 'https://untrusted.invalid' } })).status).toBe(400);
    expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.sampling.generate')).toBe(false);
    await expect(f.api.respondMcpInteraction({ ...samplingTarget(f), expectedRevision: 1, response: { action: 'accept' } })).rejects.toMatchObject({ status: 400 });
    expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.interaction.respond')).toBe(false);
  } finally { peer.controller.abort(); await f.owner.dispose(); }
});

it.each(['decline', 'cancel'] as const)('reviews sampling request %s without selecting a model, generating or submitting Run input', async action => {
  const f = fixture(); const peer = f.receiveSampling(samplingRequest());
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const target = samplingTarget(f); f.requests.mockClear();
    const reviewed = await f.api.reviewMcpSamplingRequest({ ...target, expectedRevision: 1, action });
    expect(reviewed.record).toMatchObject({ choice: action, sampling: { review: 'closed' } });
    expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.sampling.review_request')).toHaveLength(1);
    expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method.startsWith('runtime.mcp.'))).toBe(true);
    expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.sampling.generate')).toBe(false);
  } finally { peer.controller.abort(); await f.owner.dispose(); }
});

it('reports original model selection failures as unadmitted and permits explicit correction', async () => {
  const f = fixture(); const peer = f.receiveSampling(samplingRequest());
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const target = samplingTarget(f);
    const input = { ...target, expectedRevision: 1, action: 'generate' as const, model: selectedModel, editedRequest: samplingRequest() };
    f.models.resolveModel.mockRejectedValueOnce(Object.assign(new Error('private provider diagnostics'), { code: 'registered-model-not-found' }));
    await expect(f.api.reviewMcpSamplingRequest(input)).rejects.toMatchObject({ code: 'registered-model-not-found', admission: 'not_started' });
    expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.sampling.generate')).toBe(false);
    expect((await f.api.readMcpInteraction(target)).record.revision).toBe(1);
    await f.api.reviewMcpSamplingRequest(input);
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.sampling.generate')).toHaveLength(1);
  } finally { peer.controller.abort(); await f.owner.dispose(); }
});

it('an aborted reader during model resolution cannot begin a generation or cancel the original server request', async () => {
  const f = fixture(); const peer = f.receiveSampling(samplingRequest());
  let resolveModel!: (value: { configuration: ModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }) => void;
  f.models.resolveModel.mockImplementationOnce(() => new Promise(resolve => { resolveModel = resolve; }));
  try {
    await vi.waitFor(() => expect(f.state.view.record.mode).toBe('sampling'));
    const controller = new AbortController();
    const pending = f.api.reviewMcpSamplingRequest({ ...samplingTarget(f), expectedRevision: 1, action: 'generate', model: selectedModel,
      editedRequest: samplingRequest() }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.models.resolveModel).toHaveBeenCalledOnce());
    controller.abort(); resolveModel({ configuration: f.configuration, credentialOwner: f.credentialOwner }); await rejected;
    expect(peer.controller.signal.aborted).toBe(false);
    expect(f.state.view.record).toMatchObject({ choice: null, sampling: { review: 'request' } });
    expect(f.requests.mock.calls.some(([method]) => method === 'runtime.mcp.sampling.generate' || method === 'runtime.mcp.sampling.review_request')).toBe(false);
  } finally { peer.controller.abort(); await f.owner.dispose(); }
});
