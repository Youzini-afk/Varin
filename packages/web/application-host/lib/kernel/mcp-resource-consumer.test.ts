import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { McpAuthorityLease, McpAuthorityService, McpResourceChange, McpResourceRelease } from '../mcp/authority.js';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { DelegatedExecution, HistoryItem, HostToolCall, McpResourceBinding, McpResourceListenerParams, McpResourcePending, Operation, Run } from './protocol.generated.js';
import { ThreadAdapter } from './thread-adapter.js';
import { ThreadCollaboration } from './thread-collaboration.js';
import { createMcpResourceRuntime } from './mcp-resource-runtime.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:resource-consumer', branchId: 'branch:resource-consumer' };
const run: Run = { id: 'run:original-subscribe', thread_id: identity.threadId, branch_id: identity.branchId,
  state: 'completed', revision: 4, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
function observation(): Operation {
  const id = 'operation:original-resource-subscribe';
  return { id, run_id: run.id, epoch: 1, revision: 3, phase: 'terminal', outcome: 'indeterminate', effect: 'unknown',
    lifetime: 'thread', cancel_requested: false, handed_off: true, executor: 'mcp', waiting_on: null, intent: {}, result: null,
    execution_owner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' }, external_receipt: null,
    call_completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
      content: { data: { original: 'subscribe-response' }, parts: [{ kind: 'text', text: 'Original finite subscribe response' }] } },
    mcp_resource_subscription: { binding: { operationId: id,
      executionOwner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' },
      endpoint: { server: 'original-resource-server', resourceKey: 'original-server-key', configurationVersion: 'frozen-configuration', credentialVersion: 'original-grant' },
      schemaVersion: 'frozen-resources-version', uri: 'file:///opaque/server-resource?original=1' },
      sourceScope: 'workspace', acceptanceRef: { content_object: 'original-acceptance' }, listenerId: 'original-listener',
      availability: 'active', localReleased: false, mcpHolderReleased: true, remoteCleanup: 'not_requested', lastEventCursor: 11, problem: null },
  };
}

/** Actual application client, registered authenticated routes, Adapter and Runtime. The kernel request
 * boundary is controlled: this does not prove Rust family authorization, persistence or source IO. */
function routeFixture() {
  const facts = { operation: observation(), denyCancel: false, active: true, operationMissing: false, operationReadError: false,
    run: structuredClone(run), history: [] as HistoryItem[] };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'runtime.operation.inspect': case 'runtime.operation.status':
        if (facts.operationReadError) throw new KernelClientError({ code: 'storage-error', message: 'Private original record diagnostics' });
        if (facts.operationMissing || params.operationId !== facts.operation.id) {
          if (method === 'runtime.operation.inspect' && params.allowMissing === true) return null;
          throw new KernelClientError({ code: 'not-found', message: 'Original operation not found' });
        }
        return structuredClone(facts.operation);
      case 'runtime.operation.cancel':
        if (params.operationId !== facts.operation.id) throw new Error('Wrong operation cancellation');
        if (facts.denyCancel) throw new KernelClientError({ code: 'forbidden', message: 'Remote credential detail that must not escape' });
        facts.operation.cancel_requested = true;
        Object.assign(facts.operation.mcp_resource_subscription!, { availability: 'closed', localReleased: true, remoteCleanup: 'unknown' });
        return structuredClone(facts.operation);
      case 'runtime.run.inspect': return facts.run;
      case 'runtime.thread.inspect': return { thread_id: identity.threadId, parent_thread_id: null, observer_project_ids: [],
        branches: [{ branch_id: identity.branchId, active_run_id: null, head: facts.history.at(-1)?.id ?? null, latest_run: null }] };
      case 'runtime.thread.operations.active': return facts.active ? [structuredClone(facts.operation)] : [];
      case 'runtime.status': return { eventCursor: 11 };
      case 'runtime.history.page': return { head: facts.history.at(-1)?.id ?? null, previous: null,
        items: facts.history.map(({ content: _content, provider: _provider, ...item }) => ({ ...item, content_ref: `content:${item.id}` })) };
      case 'runtime.history.body': {
        const item = facts.history.find(value => value.id === params.itemId);
        if (!item) throw new Error('Unexpected history item');
        const bytes = Buffer.from(JSON.stringify({ content: item.content, provider: item.provider }));
        return { itemId: item.id, contentRef: `content:${item.id}`, chunkIndex: 0, chunkCount: 1,
          totalBytes: bytes.length, bytesBase64: bytes.toString('base64') };
      }
      case 'runtime.events.read': return [{ cursor: 11, kind: 'mcp.resource_listener_changed', subject: facts.operation.id,
        revision: facts.operation.revision, data: { subscription: structuredClone(facts.operation.mcp_resource_subscription) } }];
      case 'runtime.context.inspect': case 'runtime.child.for_thread': return null;
      case 'runtime.family.list': return { rootThreadId: identity.threadId, members: [], nextCursor: null };
      case 'runtime.input.list': case 'runtime.context_job.list': case 'runtime.child.list': case 'runtime.child.execution.list':
      case 'runtime.followup.list': case 'runtime.goal.list': return [];
      default: throw new Error(`Unexpected kernel request: ${method}`);
    }
  });
  const runtime = new AgentRuntimeClient({ subscribeExit: () => () => {}, onToolReleased: () => () => {},
    cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {},
    agentRuntimeRequest: requests } as unknown as KernelClient);
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers), get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'host-session') { response.status(401).end(); return; }
    next();
  });
  const request = async (path: string, body: unknown, authenticated = true) => {
    let status = 200;
    let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; } });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    const handlers = routes.get(path);
    if (!handlers) throw new Error(`Unknown route: ${path}`);
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++];
        if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  };
  const fetch = vi.fn((url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  vi.stubGlobal('fetch', fetch);
  return { facts, requests, models, request, fetch, api: createThreadsHttpAPI() };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps the resource facet through real client/route/snapshot reads and cancels the exact terminal Operation', async () => {
  const f = routeFixture();
  const original = structuredClone(f.facts.operation);
  expect(await f.api.operation(original.id)).toEqual(original);
  const snapshot = await f.api.snapshot(identity);
  expect(snapshot.operations).toEqual([original]);
  expect(snapshot.activeRun).toBeNull();
  expect((await f.api.events(0))[0]!.data).toEqual({ subscription: original.mcp_resource_subscription });
  const cancelled = await f.api.cancelOperation(original.id);
  expect(cancelled).toMatchObject({ id: original.id, phase: 'terminal', outcome: 'indeterminate', effect: 'unknown' });
  expect(await f.api.operation(original.id)).toMatchObject({
    call_completion: original.call_completion,
    mcp_resource_subscription: { binding: original.mcp_resource_subscription!.binding,
      availability: 'closed', localReleased: true, remoteCleanup: 'unknown' },
  });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.cancel')).toEqual([
    ['runtime.operation.cancel', { operationId: original.id }, undefined],
  ]);
  const [, init] = f.fetch.mock.calls.at(-2)!;
  expect(JSON.parse(String(init.body))).toEqual({ operationId: original.id });
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
});

it('requires authenticated resource reads/Stop and preserves the owning kernel denial without disclosing remote errors', async () => {
  const f = routeFixture();
  for (const method of ['operation', 'operation/cancel']) {
    expect((await f.request(`/api/threads/${method}`, { operationId: f.facts.operation.id }, false)).status).toBe(401);
  }
  expect(f.requests).not.toHaveBeenCalled();
  const invalid = await f.request('/api/threads/operation/cancel', { operationId: f.facts.operation.id, uri: 'file:///substitute' });
  expect(invalid.status).toBe(400); expect(f.requests).not.toHaveBeenCalled();
  f.facts.denyCancel = true;
  await expect(f.api.cancelOperation(f.facts.operation.id)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  const rejected = await f.request('/api/threads/operation/cancel', { operationId: f.facts.operation.id });
  expect(await rejected.json()).toEqual({ code: 'forbidden', error: 'Thread request could not be completed' });
  expect(f.facts.operation.mcp_resource_subscription!.localReleased).toBe(false);
  f.facts.denyCancel = false;
  await f.api.cancelOperation(f.facts.operation.id);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.cancel').map(([, params]) => params))
    .toEqual(Array(3).fill({ operationId: f.facts.operation.id }));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** Uses the actual Collaboration -> Runtime -> MCP resource owner path. Only the Catalog RPC,
 * original connection handle, and scoped storage ports are controlled fault-injection seams. */
async function sourceReleaseFixture() {
  const trace: string[] = [];
  const faults = { fence: false, listener: false };
  const fence = deferred<void>();
  const body = deferred<unknown>();
  const cleanup = deferred<McpResourceRelease>();
  let waitForFence = false;
  let change!: (value: McpResourceChange) => void;
  let pending!: McpResourcePending;
  const operation = observation();
  const source = { mode: 'fixed_branch' as const, resource_owner: { kind: 'local' as const }, workspace_id: 'workspace:original', execution_workspace_id: 'workspace:original',
    branch_id: 'branch:original-source', revision: 1, live_root: null };
  const pin = { pin_id: 'pin:original-source', root: 'root:original-source', source };
  const child: DelegatedExecution = {
    execution_id: 'execution:original-child', child_operation_id: 'operation:dispatch', parent_run_id: 'run:parent',
    parent_thread_id: 'thread:parent', parent_branch_id: 'branch:parent', origin: { kind: 'model_step', request_id: 'request:dispatch' },
    call_id: 'call:dispatch', child_thread_id: identity.threadId, child_branch_id: identity.branchId, project_id: null,
    trigger: { kind: 'dispatch' }, input: { task: 'Read the original source' }, configuration: {},
    selected_profile: { preset_id: null, catalog_identity: null, work_mode: 'read_only', tools: [], instructions: '' },
    launch: { credential_scope: null, child_dispatch: null, policy_models: [], mcp_binding: null, extension_bindings: [],
      connection_identity: 'original', provider_family: 'original', model: 'original', configuration_generation: 1,
      tool_schema_generation: 1, tools: [], policy: { name: 'default', version: '1' }, source },
    policy_target: { kind: 'default' }, source_basis: null,
    source: { kind: 'ready', handoff: { resource_authority: null, operation_id: 'handoff:original', source, root: { kind: 'fixed', pin } },
      pin, selection: source, provenance: { consistency: 'fixed-root', root: pin.root } },
    code_result: { kind: 'no_changes' }, state: 'completed', revision: 4, cursor: 1,
    receipt: { run_id: run.id, input_id: 'input:child', thread_id: identity.threadId, branch_id: identity.branchId, cursor: 1 },
    report: { outcome: 'succeeded', sender_thread_id: identity.threadId, run_id: run.id, history_ids: [], detail: null },
    terminal_head: null, resources_released: false, cancel_requested: false,
  };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'runtime.mcp.resource.begin': {
        pending = { revision: 1, operationId: operation.id, runId: run.id, threadId: identity.threadId, branchId: identity.branchId,
          cancelRequested: false, subscription: { ...structuredClone(operation.mcp_resource_subscription!),
            binding: params.binding as McpResourceBinding, acceptanceRef: null, listenerId: null, availability: 'pending' } };
        return structuredClone(pending);
      }
      case 'runtime.mcp.resource.accept':
        pending.revision += 1;
        Object.assign(pending.subscription, { acceptanceRef: { content_object: 'original-acceptance' }, listenerId: params.listenerId, availability: 'active' });
        return structuredClone(pending);
      case 'runtime.mcp.resource.notify': trace.push('notification-body-started'); return body.promise;
      case 'runtime.mcp.resource.release_source':
        expect(params).toEqual({ runId: run.id });
        trace.push('source-fence-request');
        if (faults.fence) { faults.fence = false; throw new Error('Catalog source fence unavailable'); }
        if (waitForFence) await fence.promise;
        pending.cancelRequested = true; pending.revision += 1;
        trace.push('source-fenced');
        return [structuredClone(pending)];
      case 'runtime.mcp.resource.listener': {
        const update = params as unknown as McpResourceListenerParams;
        expect(update.binding).toEqual(pending.subscription.binding);
        trace.push('listener-release-request');
        if (faults.listener) { faults.listener = false; throw new Error('Catalog listener release unavailable'); }
        expect(update.expectedListenerId).toBe(pending.subscription.listenerId);
        Object.assign(pending.subscription, { listenerId: update.listenerId, availability: update.availability,
          localReleased: update.localReleased, remoteCleanup: update.remoteCleanup, problem: update.problem });
        pending.revision += 1;
        trace.push('listener-release-stored');
        return structuredClone(pending);
      }
      case 'runtime.observations.reconcile': case 'runtime.child.dependencies.pending': case 'runtime.child.list': case 'runtime.events.read': return [];
      case 'runtime.child.execution.list': return [structuredClone(child)];
      case 'runtime.child.execution.inspect': return structuredClone(child);
      case 'runtime.child.release':
        expect(params).toEqual({ executionId: child.execution_id });
        expect(pending.cancelRequested && pending.subscription.localReleased).toBe(true);
        trace.push('child-resource-release'); child.resources_released = true; return structuredClone(child);
      case 'runtime.status': return { eventCursor: 0 };
      case 'runtime.run.inspect': return structuredClone(run);
      case 'runtime.launch.inspect': return { selection: structuredClone(child.launch) };
      default: throw new Error(`Unexpected source consumer request: ${method}`);
    }
  });
  const unpin = vi.fn(async (input: unknown) => {
    expect(pending.cancelRequested && pending.subscription.localReleased).toBe(true);
    expect(input).toEqual({ operationId: `child-handoff-release:${child.execution_id}`, branchId: source.branch_id, pinId: pin.pin_id });
    trace.push('source-unpinned');
  });
  const retire = vi.fn(async (runId: string) => {
    expect(runId).toBe(run.id);
    expect(pending.cancelRequested && pending.subscription.localReleased).toBe(true);
    trace.push('grants-retired');
  });
  const kernel = { subscribeExit: () => () => {}, subscribeReady: () => () => {}, onAgentRuntimeEvent: () => () => {}, onToolReleased: () => () => {},
    agentRuntimeRequest: requests, reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {},
    claimChildSource: vi.fn(async (input: { handoffOperationId: string }) => {
      expect(input.handoffOperationId).toBe('handoff:original'); return { grantId: 'grant:release-original' };
    }),
    scoped: () => ({ unpinBranch: unpin }), revokeGrant: vi.fn(async () => {}), retireRunGrants: retire,
    releaseLanguageSource: vi.fn(async () => {}), cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {},
  } as unknown as KernelClient;
  const runtime = new AgentRuntimeClient(kernel);
  const errors: unknown[] = [];
  const resources = createMcpResourceRuntime({ kernel, runtime,
    recover: async () => { throw new Error('Original live observation must not be recreated'); }, onError: error => errors.push(error) });
  runtime.setMcpResourceOwner(resources);
  const detach = vi.fn(() => { trace.push('listener-detached'); return cleanup.promise; });
  const lease = { resourceEndpoint: () => operation.mcp_resource_subscription!.binding.endpoint,
    observeResource: async (_service: McpAuthorityService, _uri: string, options: { onChange: typeof change }) => {
      change = options.onChange;
      return { endpoint: operation.mcp_resource_subscription!.binding.endpoint, listenerId: 'original-listener', acknowledgement: {}, detach };
    },
  } as unknown as McpAuthorityLease;
  const service: McpAuthorityService = { kind: 'resources', server: 'original-resource-server', schemaVersion: 'frozen-resources-version', resourceKey: 'original-server-key', subscribe: true };
  const call: HostToolCall = { operationId: operation.id, runId: run.id, origin: { kind: 'model_step', request_id: 'request:subscribe' },
    callId: 'call:subscribe', name: 'mcp_subscribe_resource', schemaVersion: service.schemaVersion, arguments: {} };
  await resources.subscribe({ call, owner: operation.execution_owner!, lease, service, uri: operation.mcp_resource_subscription!.binding.uri,
    signal: new AbortController().signal, checkObservation: async () => {} });
  const collaboration = new ThreadCollaboration({ kernel, runtime,
    storageAdapter: {} as never, resolveLiveSource: async () => { throw new Error('Must not reacquire source'); },
    sourceCaptureOwners: {} as never,  prepareContext: {} as never,
    continueRun: async () => { throw new Error('Must not restart the child'); }, recoverLaunches: async () => {},
    onError: (_id, error) => errors.push(error) });
  return { trace, faults, fence, body, cleanup, errors, requests, resources, runtime, collaboration, unpin, retire, detach,
    pauseFence: () => { waitForFence = true; },
    notify: () => change({ kind: 'updated', notification: { uri: operation.mcp_resource_subscription!.binding.uri } }),
    async close() { collaboration.stop(); fence.resolve(); body.resolve({}); cleanup.resolve({ status: 'unknown' }); await resources.dispose(); },
  };
}

it('fences and detaches the original child observer before unpin/retire without awaiting notification body or remote cleanup', async () => {
  const f = await sourceReleaseFixture();
  try {
    f.notify();
    await vi.waitFor(() => expect(f.trace).toContain('notification-body-started'));
    f.pauseFence();
    await f.collaboration.recover();
    await vi.waitFor(() => expect(f.trace).toContain('source-fence-request'));
    expect(f.detach).not.toHaveBeenCalled(); expect(f.unpin).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
    f.fence.resolve();
    await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce());
    expect(f.detach).toHaveBeenCalledOnce(); expect(f.unpin).toHaveBeenCalledOnce();
    for (const [earlier, later] of [['source-fenced', 'listener-detached'], ['listener-detached', 'listener-release-stored'],
      ['listener-release-stored', 'source-unpinned'], ['source-unpinned', 'grants-retired']]) {
      expect(f.trace.indexOf(earlier!)).toBeLessThan(f.trace.indexOf(later!));
    }
    const bodyRequests = f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.resource.notify').length;
    f.notify(); await new Promise(resolve => setImmediate(resolve));
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.resource.notify')).toHaveLength(bodyRequests);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it.each(['fence', 'listener'] as const)('keeps source pins/grants on %s rejection and retries the same original child release', async failure => {
  const f = await sourceReleaseFixture();
  try {
    f.faults[failure] = true;
    await f.collaboration.recover();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.unpin).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
    expect(f.detach).toHaveBeenCalledTimes(failure === 'fence' ? 0 : 1);
    await new Promise(resolve => setImmediate(resolve));
    await f.collaboration.recover();
    await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce());
    expect(f.unpin).toHaveBeenCalledOnce(); expect(f.detach).toHaveBeenCalledOnce();
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.mcp.resource.release_source').every(([, params]) => params.runId === run.id)).toBe(true);
  } finally { await f.close(); }
});

function closedFiniteHistory(f: ReturnType<typeof routeFixture>, origin: 'model' | 'policy' = 'model') {
  const operationId = origin === 'model' ? 'request:original:tool:subscribe' : 'action:original:node:subscribe';
  f.facts.active = false;
  Object.assign(f.facts.operation, { id: operationId, outcome: 'succeeded', effect: 'confirmed', cancel_requested: true });
  const subscription = f.facts.operation.mcp_resource_subscription!;
  subscription.binding.operationId = operationId;
  Object.assign(subscription, { availability: 'closed', localReleased: true, remoteCleanup: 'unknown' });
  const completion = { kind: 'result' as const, outcome: 'succeeded' as const, effect: 'confirmed' as const,
    content: { data: { operationId, server: subscription.binding.endpoint.server, uri: subscription.binding.uri, acknowledgement: {} }, parts: [] } };
  f.facts.operation.call_completion = structuredClone(completion);
  const result = { request_id: 'request:original', call_id: 'subscribe', completion };
  // policy_actions::policy_evidence_item publishes Content::Output, while the model batch
  // producer in catalog_execution publishes Content::ToolResult with request/call identity.
  f.facts.history = [{ id: 'history:subscribe-result', thread_id: identity.threadId, run_id: run.id, parent: null, source: 'tool', provider: null,
    content: origin === 'model'
      ? { provenance: { kind: 'tool_data', call_id: result.call_id }, content: { kind: 'tool_result', result } }
      : { provenance: { kind: 'policy_tool_data', reference: { action_id: 'action:original', node_id: 'subscribe' } },
        content: { kind: 'output', output: completion.content } } }];
  return { operationId, result };
}

it.each(['model', 'policy'] as const)('reconstructs the closed observer from the original finite %s result when it is absent from active Operations', async origin => {
  const f = routeFixture();
  const { operationId } = closedFiniteHistory(f, origin);
  const originalCompletion = structuredClone(f.facts.operation.call_completion);
  const snapshot = await f.api.snapshot(identity);
  expect(snapshot.activeRun).toBeNull();
  expect(snapshot.operations).toEqual([f.facts.operation]);
  expect(snapshot.operations[0]!.call_completion).toEqual(originalCompletion);
  expect(snapshot.operations[0]!.mcp_resource_subscription).toMatchObject({ availability: 'closed', localReleased: true, remoteCleanup: 'unknown' });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect').map(([, params]) => params))
    .toEqual([{ operationId, allowMissing: true }]);
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
});

it.each(['ordinary-result', 'other-branch', 'none-effect'] as const)('does not promote %s into a resource observer through finite history', async variant => {
  const f = routeFixture();
  const { operationId } = closedFiniteHistory(f);
  if (variant === 'ordinary-result') delete f.facts.operation.mcp_resource_subscription;
  if (variant === 'other-branch') f.facts.run.branch_id = 'branch:original-history-fork';
  if (variant === 'none-effect') f.facts.operation.effect = 'none';
  expect((await f.api.snapshot(identity)).operations).toEqual([]);
  const reads = f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect').map(([, params]) => params);
  expect(reads).toEqual([{ operationId, allowMissing: true }]);
});

it.each(['model', 'policy'] as const)('does not substitute external data identity for the original %s producer identity', async origin => {
  const f = routeFixture();
  const { operationId, result } = closedFiniteHistory(f, origin);
  result.completion.content.data.operationId = 'operation:unrelated';
  expect((await f.api.snapshot(identity)).operations).toEqual(origin === 'model' ? [f.facts.operation] : []);
  const reads = f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect').map(([, params]) => params);
  expect(reads).toEqual(origin === 'model' ? [{ operationId, allowMissing: true }] : []);
});

it('keeps ordinary read-only ToolResults without durable Operations readable and does not inspect a fabricated row', async () => {
  const f = routeFixture();
  const { result } = closedFiniteHistory(f);
  Object.assign(result.completion, { effect: 'none' });
  f.facts.operationMissing = true;
  const snapshot = await f.api.snapshot(identity);
  expect(snapshot.history).toHaveLength(1);
  expect(snapshot.operations).toEqual([]);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect')).toEqual([]);
});

it('allows an actually missing optional history Operation without weakening required Operation reads', async () => {
  const f = routeFixture();
  const { operationId } = closedFiniteHistory(f, 'policy');
  f.facts.operationMissing = true;
  expect((await f.api.snapshot(identity)).operations).toEqual([]);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect').map(([, params]) => params))
    .toEqual([{ operationId, allowMissing: true }]);
  await expect(f.api.operation(operationId)).rejects.toMatchObject({ status: 404, code: 'not-found' });
});

it('propagates real storage errors from optional Operation lookup instead of inventing an empty successful snapshot', async () => {
  const f = routeFixture();
  const { operationId } = closedFiniteHistory(f, 'policy');
  f.facts.operationReadError = true;
  await expect(f.api.snapshot(identity)).rejects.toMatchObject({ status: 400, code: 'storage-error' });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.operation.inspect').map(([, params]) => params))
    .toEqual([{ operationId, allowMissing: true }]);
  const response = await f.request('/api/threads/snapshot', identity);
  expect(await response.json()).toEqual({ code: 'storage-error', error: 'Thread request could not be completed' });
});
