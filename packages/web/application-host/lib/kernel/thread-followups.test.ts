import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { FollowupPendingRegistration, Followup, Run } from './protocol.generated.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:followup', branchId: 'branch:followup' };
const run: Run = { id: 'run:source', thread_id: identity.threadId, branch_id: identity.branchId,
  state: 'waiting', revision: 2, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: 'policy-pause:source' };
const operationId = 'operation:process';
const trigger = { kind: 'process_stopped' as const, operationId };
const instruction = '  Read the original process output.\nDo not start it again.  ';
const definition: Followup = { id: 'followup:process', revision: 1, generation: 1,
  thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: run.id,
  actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1_700_000_000_000, observation: null,
  goal_id: null, trigger: { kind: 'process_stopped', operation_id: operationId }, sources: [{ source_index: 0, after_cursor: 4, observed: null, file: null }], state: 'active',
  wait: { id: 'wait:process', kind: 'process_stopped', after_cursor: 4, trigger_cursor: null, state: 'waiting' }, occurrence: null };

/** These are transport contract tests: real HTTP/client/admission functions, with a controlled RPC boundary.
 * Catalog durability, process-stop proof and atomic occurrence consumption are native suite obligations. */
function fixture() {
  const facts = { reply: structuredClone(definition), list: [structuredClone(definition)], conflict: false,
    source: structuredClone(run), registerError: false, pendingError: false, pending: [] as FollowupPendingRegistration[],
    liveInvalid: false, launch: { selection: { source: { mode: 'materialized', workspace_id: 'workspace:original',
      execution_workspace_id: 'execution:original', branch_id: 'files:original', revision: 3, live_root: null } } } };
  const issueGrant = vi.fn(async (input: { grantId: string }) => ({ ...input }));
  const retireGrant = vi.fn(async (_grantId: string) => ({}));
  const revokeGrant = vi.fn();
  const validateLive = vi.fn(async () => { if (facts.liveInvalid) throw new Error('Original live root changed'); });
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    switch (method) {
      case 'runtime.thread.inspect': return { thread_id: params.threadId, observer_project_ids: [], branches: [
        { branch_id: identity.branchId, active_run_id: null, head: null, latest_run: null },
        { branch_id: 'branch:other', active_run_id: null, head: null, latest_run: null },
      ] };
      case 'runtime.run.inspect': return facts.source;
      case 'runtime.launch.inspect': return facts.launch;
      case 'runtime.followup.register': {
        if (facts.registerError) throw new KernelClientError({ code: 'operation-error', message: 'operation error: operation belongs to another Run' });
        return facts.reply;
      }
      case 'runtime.followup.list': return facts.list;
      case 'runtime.followup.registrations.pending': {
        if (facts.pendingError) throw new KernelClientError({ code: 'storage-error', message: 'original acceptance metadata cannot be read' });
        return { registrations: facts.pending, nextCursor: null };
      }
      case 'runtime.followup.registration.cancel': return { followup: null };
      case 'runtime.followup.get': return { followup: facts.list.find(value => value.id === params.followupId), instruction };
      case 'runtime.followup.control': {
        if (facts.conflict) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: follow-up revision changed' });
        return facts.reply;
      }
      case 'runtime.status': return { eventCursor: 5 };
      case 'runtime.history.page': return { head: null, previous: null, items: [] };
      case 'runtime.context.inspect': case 'runtime.child.for_thread': return null;
      case 'runtime.input.list': case 'runtime.thread.operations.active': case 'runtime.context_job.list': case 'runtime.child.list': case 'runtime.child.execution.list': case 'runtime.goal.list': return [];
      default: throw new Error(`Unexpected RPC: ${method}`);
    }
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {}, agentRuntimeRequest: requests, issueGrant, retireGrant, revokeGrant } as unknown as KernelClient, undefined, undefined, undefined, validateLive);
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...chain: RequestHandler[]) => routes.set(path, chain), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'host-session') { response.status(401).end(); return; }
    next();
  };
  registerThreadRoutes(app, adapter, requireAuth);
  const request = async (path: string, body: unknown, authenticated = true) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; } });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    const handlers = routes.get(path); if (!handlers) throw new Error(`Unknown route: ${path}`);
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  return { facts, requests, request, models, issueGrant, retireGrant, revokeGrant, validateLive, api: createThreadsHttpAPI() };
}
afterEach(() => vi.unstubAllGlobals());

it('the public management client preserves registration keys, revisions and original consumed receipts', async () => {
  const f = fixture();
  const input = { ...identity, key: 'register-once', runId: run.id, trigger, instruction };
  const accepted = await f.api.followups.register(input);
  expect(await f.api.followups.register(input)).toEqual(accepted);
  const registrations = f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register');
  expect(registrations).toHaveLength(2);
  for (const [, params, signal] of registrations) {
    expect(params).toEqual({ key: input.key, runId: run.id, trigger, instruction });
    expect(signal).toBeInstanceOf(AbortSignal);
  }
  for (const [action, state] of [['pause', 'paused'], ['resume', 'active'], ['cancel', 'cancelled']] as const) {
    f.facts.reply = { ...accepted, state, revision: f.facts.reply.revision + 1 };
    const controlled = await f.api.followups.control({ ...identity, followupId: accepted.id,
      expectedRevision: f.facts.reply.revision - 1, action });
    expect(controlled).toEqual(f.facts.reply);
    expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.followup.control', {
      followupId: accepted.id, expectedRevision: f.facts.reply.revision - 1, action,
    }]);
  }
  f.facts.reply = { ...accepted, revision: 7, wait: { ...accepted.wait, trigger_cursor: 9, state: 'consumed' }, occurrence: {
    id: 'occurrence:process', generation: 1, trigger_cursor: 9,
    evidence: { kind: 'process_stopped', receipt_identity: 'process:receipt', receipt_epoch: 'process-epoch:one' },
    state: 'admitted', hold_reason: null, delivery: { state: 'delivered', activation_state: 'bound',
      run_id: 'run:continued', input_id: 'environment:process', delivered_cursor: 10, execution_id: null, failure_code: null },
  } };
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    expect(await f.api.followups.control({ ...identity, followupId: accepted.id, expectedRevision: 1, action })).toEqual(f.facts.reply);
  }
  expect(f.requests.mock.calls.some(([method]) => ['runtime.run.resume', 'runtime.run.cancel', 'runtime.input.submit', 'runtime.run.start', 'runtime.operation.inspect'].includes(method))).toBe(false);
  expect(f.models.rebindModel).not.toHaveBeenCalled();
  expect(f.facts.source.waiting_on).toBe('policy-pause:source');
});

it('list and snapshot expose only the selected branch and controls reject another branch or source Run', async () => {
  const f = fixture();
  const other = { ...definition, id: 'followup:other', branch_id: 'branch:other' };
  f.facts.list.push(other);
  expect(await f.api.followups.list(identity)).toEqual([definition]);
  expect(await f.api.followups.get(identity, definition.id)).toEqual({ followup: definition, instruction });
  await expect(f.api.followups.get(identity, other.id)).rejects.toMatchObject({ status: 400 });
  expect((await f.api.snapshot(identity)).followups).toEqual([definition]);
  expect(await f.api.followups.list({ ...identity, branchId: 'branch:other' })).toEqual([other]);
  await expect(f.api.followups.control({ ...identity, followupId: other.id, expectedRevision: 1, action: 'cancel' })).rejects.toMatchObject({ status: 400 });
  f.facts.source.branch_id = 'branch:other';
  await expect(f.api.followups.register({ ...identity, key: 'foreign', runId: run.id, trigger, instruction })).rejects.toMatchObject({ status: 400 });
  await expect(f.api.followups.list({ ...identity, branchId: 'branch:unknown' })).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.some(([method]) => ['runtime.followup.register', 'runtime.followup.control'].includes(method))).toBe(false);
  f.facts.source.branch_id = identity.branchId; f.facts.registerError = true;
  await expect(f.api.followups.register({ ...identity, key: 'foreign-operation', runId: run.id, trigger: { kind: 'process_stopped', operationId: 'operation:other' }, instruction }))
    .rejects.toMatchObject({ status: 400, code: 'operation-error' });
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.followup.register', {
    key: 'foreign-operation', runId: run.id, trigger: { kind: 'process_stopped', operationId: 'operation:other' }, instruction,
  }]);
});

it('management routes enforce authentication, exact fields and revision conflict without exposing private errors', async () => {
  const f = fixture();
  const register = { ...identity, key: 'register', runId: run.id, trigger, instruction };
  for (const method of ['register', 'list', 'get', 'control', 'registrations/pending', 'registration/cancel']) {
    expect((await f.request(`/api/threads/followup/${method}`, identity, false)).status).toBe(401);
  }
  expect(f.requests).not.toHaveBeenCalled();
  for (const body of [
    { ...register, text: 'different work' }, { ...register, schedule: 'daily' }, { ...register, trigger: { kind: 'process_stopped', operationId: '' } },
    { ...register, fileAuthority: { grantId: 'borrowed' } },
    { ...register, trigger: { kind: 'file', path: 'out.txt', condition: 'exists', rootId: 'other' } },
    { ...register, runtime: 'pi' }, { ...register, actor: { kind: 'user' } }, { ...register, wait: {} },
    { ...register, trigger: { kind: 'at', atMs: -1 } }, { ...register, trigger: { kind: 'at', atMs: 1.5 } },
    { ...register, trigger: { kind: 'at', atMs: 123, timeZone: 'UTC' } },
    { ...register, trigger: { kind: 'any', sources: [] } },
    { ...register, trigger: { kind: 'all', sources: [{ kind: 'any', sources: [{ kind: 'at', atMs: 0 }] }] } },
    { ...register, trigger: { kind: 'all', sources: [{ kind: 'process_stopped', operationId: 'one', actor: 'user' }] } },
    { ...register, trigger: { kind: 'any', sources: [{ kind: 'at', atMs: 0 }], repeat: true } },
  ]) expect((await f.request('/api/threads/followup/register', body)).status).toBe(400);
  const control = { ...identity, followupId: definition.id, expectedRevision: 1, action: 'cancel' };
  for (const body of [
    { ...control, expectedRevision: -1 }, { ...control, expectedRevision: 1.5 },
    { ...control, action: 'restart' }, { ...control, runId: 'run:continued' },
  ]) expect((await f.request('/api/threads/followup/control', body)).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled();
  f.facts.conflict = true;
  await expect(f.api.followups.control({ ...identity, followupId: definition.id, expectedRevision: 0, action: 'pause' }))
    .rejects.toMatchObject({ status: 409, code: 'thread-conflict' });
  const response = await f.request('/api/threads/followup/control', control);
  expect(await response.json()).toEqual({ code: 'thread-conflict', error: 'Thread request could not be completed' });
});


it('time and composite registration preserve exact leaf identities, original text and User source without Host launches', async () => {
  const f = fixture(); f.facts.source.state = 'cancelled'; f.facts.source.cancel_requested = true;
  const inputs = [
    { ...identity, key: 'at-once', runId: run.id, trigger: { kind: 'at' as const, atMs: 0 }, instruction },
    ...(['any', 'all'] as const).map(kind => ({ ...identity, key: `${kind}-once`, runId: run.id,
      trigger: { kind, sources: [{ kind: 'at' as const, atMs: 0 }, { kind: 'process_stopped' as const, operationId }] }, instruction })),
  ];
  for (const original of inputs) { await f.api.followups.register(original); await f.api.followups.register(original); }
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').map(([, params]) => params))
    .toEqual(inputs.flatMap(original => [original, original]).map(({ runtime: _runtime, threadId: _thread, branchId: _branch, ...params }) => params));
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
  expect(f.requests.mock.calls.some(([method]) => method.startsWith('runtime.run.') && method !== 'runtime.run.inspect')).toBe(false);
});


it('normal source retirement uses the original grants while failed preparation still explicitly revokes its grant', async () => {
  const retireRunGrants = vi.fn(async (_grantId: string) => ({})); const revokeGrant = vi.fn(async (_grantId: string) => ({}));
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, retireRunGrants, revokeGrant } as unknown as KernelClient);
  runtime.retainSourceGrant('old-child-run', 'original-creating-grant');
  runtime.retainSourceGrant('old-child-run', 'rebound-child-grant');
  runtime.retainSourceGrant('failed-preparation', 'unaccepted-grant');
  await runtime.retireSourceGrants('old-child-run'); await runtime.retireSourceGrants('old-child-run');
  expect(retireRunGrants.mock.calls.map(args => args[0])).toEqual(['old-child-run', 'old-child-run']);
  const restarted = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, retireRunGrants, revokeGrant } as unknown as KernelClient);
  await restarted.retireSourceGrants('previous-host-child-run');
  expect(retireRunGrants).toHaveBeenLastCalledWith('previous-host-child-run');
  expect(revokeGrant).not.toHaveBeenCalled();
  await runtime.releaseSourceGrant('failed-preparation', 'unaccepted-grant');
  expect(revokeGrant).toHaveBeenCalledWith('unaccepted-grant');
});


it('User file follow-ups admit only original-source exact reads and retire fresh caller grants even after a lost reply', async () => {
  const f = fixture(); f.facts.source.state = 'completed';
  const input = { ...identity, key: 'files-one', runId: run.id, instruction,
    trigger: { kind: 'all' as const, sources: [
      { kind: 'file' as const, path: 'results\\output.txt', condition: 'changed' as const },
      { kind: 'file' as const, path: 'results/output.txt', condition: 'ready' as const },
      { kind: 'at' as const, atMs: 0 },
    ] } };
  await f.api.followups.register(input);
  f.facts.registerError = true;
  await expect(f.api.followups.register(input)).rejects.toThrow();
  const grants = f.issueGrant.mock.calls.map(([grant]) => grant);
  expect(grants).toHaveLength(2);
  for (const grant of grants) expect(grant).toEqual({ grantId: expect.any(String), threadId: identity.threadId,
    owningWorkspace: 'workspace:original', executionWorkspace: 'execution:original',
    capabilities: ['storage.read'], pathScopes: ['results/output.txt'] });
  expect(grants[0]!.grantId).not.toBe(grants[1]!.grantId);
  expect(f.retireGrant.mock.calls.map(([id]) => id)).toEqual(grants.map(grant => grant.grantId));
  expect(f.revokeGrant).not.toHaveBeenCalled();
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').map(([, params]) => params))
    .toEqual(grants.map(grant => ({ key: input.key, runId: run.id, instruction, trigger: input.trigger, fileAuthority: { grantId: grant.grantId } })));
  expect(f.requests.mock.calls.some(([method]) => method.includes('start') || method.startsWith('file.'))).toBe(false);
});


it('discovers and explicitly cancels an original unconfirmed file registration without acquiring fresh source authority', async () => {
  const f = fixture();
  f.facts.pending = [{ id: 'unconfirmed-original-key', sourceRunId: run.id,
    threadId: identity.threadId, branchId: identity.branchId, paths: ['results/exact.txt'] }];
  expect(await f.api.followups.pendingRegistrations(identity)).toEqual(f.facts.pending);
  expect(await f.api.followups.cancelRegistration({ ...identity, key: f.facts.pending[0]!.id, runId: run.id })).toEqual({ followup: null });
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.followup.registration.cancel', { key: 'unconfirmed-original-key', runId: run.id }]);
  expect(f.issueGrant).not.toHaveBeenCalled(); expect(f.revokeGrant).not.toHaveBeenCalled();
  f.facts.pendingError = true;
  await expect(f.api.followups.pendingRegistrations(identity)).rejects.toMatchObject({ code: 'storage-error' });
  f.facts.source.branch_id = 'branch:other';
  await expect(f.api.followups.cancelRegistration({ ...identity, key: 'unconfirmed-original-key', runId: run.id })).rejects.toMatchObject({ status: 400 });
  expect((await f.request('/api/threads/followup/registration/cancel', { ...identity, key: 'one', runId: run.id, actor: 'user' })).status).toBe(400);
});
