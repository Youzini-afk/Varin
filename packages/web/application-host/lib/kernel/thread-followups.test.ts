import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { HostJobSource, FollowupPendingRegistration, Followup, FollowupOccurrenceView, FollowupOccurrencesResult, FollowupRegistrationTrigger, Run } from './protocol.generated.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:followup', branchId: 'branch:followup' };
const run: Run = { id: 'run:source', thread_id: identity.threadId, branch_id: identity.branchId,
  state: 'waiting', revision: 2, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: 'policy-pause:source' };
const operationId = 'operation:process';
const trigger = { kind: 'process_stopped' as const, operationId };
const instruction = '  Read the original process output.\nDo not start it again.  ';
const definition: Followup = { repeat: 'once', pending_occurrences: 0, exhausted: false, id: 'followup:process', revision: 1, generation: 1,
  thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: run.id,
  actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1_700_000_000_000, observation: null,
  goal_id: null, trigger: { kind: 'process_stopped', operation_id: operationId }, sources: [{ consumed_cursor: 0, source_index: 0, after_cursor: 4, observed: null, file: null, log: null, metric: null }], state: 'active',
  wait: { id: 'wait:process', kind: 'process_stopped', after_cursor: 4, trigger_cursor: null, state: 'waiting' }, occurrence: null };

/** These are transport contract tests: real HTTP/client/admission functions, with a controlled RPC boundary.
 * Catalog durability, process-stop proof and atomic occurrence consumption are native suite obligations. */
function fixture() {
  const facts = { reply: structuredClone(definition), list: [structuredClone(definition)], conflict: false,
    occurrenceViews: new Map<string, FollowupOccurrenceView>(), occurrenceDetailError: false,
    occurrencePages: new Map<number | undefined, FollowupOccurrencesResult>(), occurrenceError: false,
    source: structuredClone(run), jobs: [] as HostJobSource[], registerError: false, pendingError: false, pending: [] as FollowupPendingRegistration[],
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
      case 'runtime.host_job.sources': return facts.jobs;
      case 'runtime.followup.list': return facts.list;
      case 'runtime.followup.occurrence': {
        if (facts.occurrenceDetailError) throw new KernelClientError({ code: 'storage-error', message: 'original accepted metadata unavailable' });
        const view = facts.occurrenceViews.get(String(params.occurrenceId));
        if (!view) throw new KernelClientError({ code: 'operation-error', message: 'occurrence belongs to another follow-up' });
        return view;
      }
      case 'runtime.followup.occurrences': {
        if (facts.occurrenceError) throw new KernelClientError({ code: 'storage-error', message: 'original occurrence rows cannot be read' });
        return facts.occurrencePages.get(params.after as number | undefined) ?? { occurrences: [], nextCursor: null };
      }
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
    accepted_cursor: 9, id: 'occurrence:process', generation: 1, trigger_cursor: 9,
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
  for (const method of ['register', 'list', 'get', 'occurrence', 'occurrences', 'control', 'registrations/pending', 'registration/cancel']) {
    expect((await f.request(`/api/threads/followup/${method}`, identity, false)).status).toBe(401);
  }
  expect(f.requests).not.toHaveBeenCalled();
  for (const body of [
    { ...register, text: 'different work' }, { ...register, schedule: 'daily' },
    { ...register, fileAuthority: { grantId: 'borrowed' } }, { ...register, grantId: 'borrowed' },
    { ...register, runtime: 'pi' }, { ...register, actor: { kind: 'user' } }, { ...register, wait: {} },
    { ...register, trigger: null }, { ...register, trigger: [] },
    { ...register, trigger: { kind: 'any', sources: {} } },
    { ...register, trigger: { kind: 'all', sources: [null] } },
    { ...register, repeat: true }, { ...register, repeat: 'daily' }, { ...register, repeat: null },
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

it('public log registration preserves literal bytes, stream, offset and the original key after a lost HTTP reply', async () => {
  const f = fixture();
  const literal = { kind: 'log_literal' as const, operationId: 'accepted:job', stream: 'stdout' as const,
    literal: ' \n准备 🧪\t ', fromOffset: 13 };
  const end = { kind: 'log_end' as const, operationId: literal.operationId, stream: 'stderr' as const };
  const triggers: FollowupRegistrationTrigger[] = [literal, { ...literal, literal: ' \t\n ' }, end,
    { kind: 'any', sources: [literal, end] }, { kind: 'all', sources: [literal, end] }];
  let loseReply = true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await f.request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body)));
    if (loseReply) { loseReply = false; throw new Error('acceptance reply lost'); }
    return response;
  });
  const inputs = triggers.map((trigger, index) => ({ ...identity, key: `log-original-${index}`, runId: run.id, trigger, instruction }));
  await expect(f.api.followups.register(inputs[0]!)).rejects.toThrow('acceptance reply lost');
  for (const input of inputs) expect(await f.api.followups.register(input)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').map(([, params]) => params))
    .toEqual([inputs[0]!, ...inputs].map(({ key, runId, trigger, instruction }) => ({ key, runId, trigger, instruction })));
  expect(f.issueGrant).not.toHaveBeenCalled();
  expect(f.models.resolveModel).not.toHaveBeenCalled();
});

it('forwards nested condition decoding to the original owner while retaining safe file-path admission', async () => {
  const f = fixture();
  const input = { ...identity, key: 'owner-decodes', runId: run.id, instruction };
  f.facts.registerError = true;
  // This controlled RPC only returns an owner error; Rust's real invalid-input
  // tests own rejection semantics. The HTTP layer must not strip unknown fields.
  for (const trigger of [
    { kind: 'unknown', extra: 'preserved' },
    { kind: 'log_literal', operationId: 'accepted:job', stream: 'stdout', literal: '', fromOffset: -1 },
    { kind: 'any', sources: [], repeat: true },
    { kind: 'all', sources: [{ kind: 'any', sources: [] }] },
  ]) {
    const response = await f.request('/api/threads/followup/register', { ...input, trigger });
    expect(response.status).toBe(400);
    expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.followup.register', { key: input.key, runId: run.id, instruction, trigger }]);
  }
  f.requests.mockClear();
  for (const path of [null, 7, '', '../outside', '/absolute', '.']) {
    expect((await f.request('/api/threads/followup/register', { ...input,
      trigger: { kind: 'file', path, condition: 'changed' } })).status).toBe(400);
  }
  expect(f.issueGrant).not.toHaveBeenCalled();
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.followup.register')).toBe(false);
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
      { kind: 'log_literal' as const, operationId: 'accepted:job', stream: 'stdout' as const, literal: 'ready' },
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


it('accepted-job discovery and explicit job conditions use the observer work identity through the original public route', async () => {
  const f = fixture();
  f.facts.jobs = [{ observationKinds: ['job_stopped', 'artifact', 'collection'], binding: { operationId: 'user-job:accepted', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'ws', subjectId: 'attempt:original' } }, sourceRunId: 'historical-completed-run', threadId: 'thread:child', branchId: 'branch:child', phase: 'running', executorStopped: false, cancelRequested: false, origin: { kind: 'user', key: 'accepted-key' } }];
  expect(await f.api.followups.jobSources(identity, run.id)).toEqual(f.facts.jobs);
  expect(f.requests.mock.calls.find(([method]) => method === 'runtime.host_job.sources')?.[1]).toEqual({ runId: run.id });
  for (const trigger of [{ kind: 'job_stopped', operationId: f.facts.jobs[0]!.binding.operationId }, { kind: 'all', sources: [{ kind: 'at', atMs: 0 }, { kind: 'job_stopped', operationId: f.facts.jobs[0]!.binding.operationId }] }] as const) {
    const response = await f.request('/api/threads/followup/register', { ...identity, key: 'explicit-job', runId: run.id, trigger, instruction: 'Read actual stopped job' });
    expect(response.status).toBe(200);
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').at(-1)?.[1]).toEqual({ key: 'explicit-job', runId: run.id, trigger, instruction: 'Read actual stopped job' });
  }
  expect((await f.request('/api/threads/followup/jobs', { ...identity, runId: run.id }, false)).status).toBe(401);
  expect((await f.request('/api/threads/followup/jobs', { ...identity, runId: run.id, workspaceId: 'forged' })).status).toBe(400);
  f.facts.source = { ...run, thread_id: 'foreign' };
  const before = f.requests.mock.calls.filter(([method]) => method === 'runtime.host_job.sources').length;
  await expect(f.api.followups.jobSources(identity, run.id)).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.host_job.sources')).toHaveLength(before);
  expect(f.models.resolveModel).not.toHaveBeenCalled();
});

it('preserves repeating authorization through original file admission and an uncertain HTTP retry', async () => {
  const f = fixture();
  const original = { ...identity, key: 'standing-user-key', runId: run.id, repeat: 'each' as const,
    trigger: { kind: 'any' as const, sources: [{ kind: 'file' as const, path: 'results/out.txt', condition: 'changed' as const }, { kind: 'job_stopped' as const, operationId: 'job:original' }] }, instruction };
  f.facts.reply = { ...definition, repeat: 'each' };
  let loseReply = true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await f.request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body)));
    if (loseReply) { loseReply = false; throw new Error('acceptance reply lost'); }
    return response;
  });
  await expect(f.api.followups.register(original)).rejects.toThrow('acceptance reply lost');
  expect(await f.api.followups.register(original)).toEqual(f.facts.reply);
  const calls = f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register');
  expect(calls).toHaveLength(2);
  for (const [, params] of calls) expect(params).toMatchObject({ key: original.key, runId: run.id, repeat: 'each', trigger: original.trigger, instruction });
  expect(f.retireGrant).toHaveBeenCalledTimes(2); expect(f.revokeGrant).not.toHaveBeenCalled();
  expect(f.models.resolveModel).not.toHaveBeenCalled();
});

it('pages original occurrence rows by accepted cursor without hydrating instructions, draining all history or widening branch access', async () => {
  const f = fixture();
  const rows = Array.from({ length: 130 }, (_, index) => ({ accepted_cursor: index + 10, id: `occurrence:${index}`, generation: 1,
    trigger_cursor: 1_000 - index, state: 'completed' as const, hold_reason: null,
    evidence: { kind: 'process_stopped' as const, receipt_identity: `receipt:${index}`, receipt_epoch: 'original' },
    delivery: { input_id: `input:${index}`, state: 'delivered' as const, activation_state: 'bound' as const,
      run_id: `run:${index}`, execution_id: index % 2 ? `execution:${index}` : null, delivered_cursor: index + 200, failure_code: null } }));
  f.facts.occurrencePages.set(undefined, { occurrences: rows.slice(0, 64), nextCursor: 73 });
  f.facts.occurrencePages.set(73, { occurrences: rows.slice(64, 128), nextCursor: 137 });
  f.facts.occurrencePages.set(137, { occurrences: rows.slice(128), nextCursor: null });
  const first = await f.api.followups.occurrences(identity, definition.id);
  expect(first.occurrences).toEqual(rows.slice(0, 64));
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.occurrences')).toHaveLength(1);
  const second = await f.api.followups.occurrences(identity, definition.id, first.nextCursor!);
  const third = await f.api.followups.occurrences(identity, definition.id, second.nextCursor!);
  expect([...first.occurrences, ...second.occurrences, ...third.occurrences]).toEqual(rows); expect(third.nextCursor).toBeNull();
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.occurrences').map(([, params]) => params))
    .toEqual([{ followupId: definition.id }, { followupId: definition.id, after: 73 }, { followupId: definition.id, after: 137 }]);
  expect(f.requests.mock.calls.some(([method]) => ['runtime.followup.get', 'runtime.input.submit', 'runtime.run.start'].includes(method))).toBe(false);
  const count = f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.occurrences').length;
  await expect(f.api.followups.occurrences({ ...identity, branchId: 'branch:other' }, definition.id)).rejects.toMatchObject({ status: 400 });
  await expect(f.api.followups.occurrences(identity, 'unknown-definition')).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.occurrences')).toHaveLength(count);
  for (const body of [{ after: -1 }, { after: 0.5 }, { after: '73' }, { after: null }, { after: Number.MAX_SAFE_INTEGER + 1 }, { limit: 999 }, { runId: run.id }]) {
    expect((await f.request('/api/threads/followup/occurrences', { ...identity, followupId: definition.id, ...body })).status).toBe(400);
  }
  f.facts.occurrenceError = true;
  await expect(f.api.followups.occurrences(identity, definition.id, 137)).rejects.toMatchObject({ code: 'storage-error' });
  f.facts.occurrenceError = false;
  expect((await f.api.followups.occurrences(identity, definition.id, 137)).occurrences).toEqual(rows.slice(128));
});

it('routes artifact selectors and independent collection conditions without changing the selected continuation Run', async () => {
  const f = fixture();
  for (const trigger of [
    { kind: 'artifact', operationId: 'original-user-job' },
    { kind: 'artifact', operationId: 'original-user-job', artifactId: 'artifact:exact' },
    { kind: 'artifact', operationId: 'original-user-job', name: 'metrics.json' },
    { kind: 'collection', operationId: 'original-user-job' },
    { kind: 'any', sources: [{ kind: 'artifact', operationId: 'original-user-job' }, { kind: 'collection', operationId: 'original-user-job' }] },
    { kind: 'all', sources: [{ kind: 'artifact', operationId: 'original-user-job', name: 'metrics.json' }, { kind: 'collection', operationId: 'original-user-job' }] },
  ]) {
    const body = { ...identity, key: 'explicit-research', runId: run.id, trigger, repeat: 'each', instruction };
    expect((await f.request('/api/threads/followup/register', body)).status).toBe(200);
    expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').at(-1)?.[1])
      .toEqual({ key: body.key, runId: run.id, trigger, repeat: 'each', instruction });
  }
  expect(f.issueGrant).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
});

it('reads only the exact original occurrence metadata through the public API and short branch authorization', async () => {
  const f = fixture();
  const binding = { operationId: 'job:research', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'ws:original', subjectId: 'attempt:original' } } satisfies HostJobSource['binding'];
  const first: FollowupOccurrenceView = {
    occurrence: { id: 'occurrence:original', generation: 1, accepted_cursor: 25, trigger_cursor: 100, state: 'completed', hold_reason: null, delivery: null,
      evidence: { kind: 'all', sources: [
        { source_index: 0, accepted_cursor: 12, trigger_cursor: 100, evidence: { kind: 'artifact', binding, fact: { kind: 'artifact_available', artifact_id: 'artifact:zero', record_revision: 2 }, gap: false } },
        { source_index: 1, accepted_cursor: 25, trigger_cursor: 90, evidence: { kind: 'collection', binding, completion_revision: 7, outcome: 'done', counts: { available: 1, failed: 0, expired: 0, pending: 0 }, gap: false } },
      ] } },
    facts: [{ source_index: 0, accepted_cursor: 12, content: { artifactId: 'artifact:zero', byteLength: 0 } },
      { source_index: 1, accepted_cursor: 25, content: { attemptId: binding.subject.subjectId, completionRevision: 7 } }],
  };
  f.facts.occurrenceViews.set(first.occurrence.id, first);
  f.facts.list[0]!.occurrence = { ...first.occurrence, id: 'occurrence:latest', accepted_cursor: 50 };
  expect(await f.api.followups.occurrence(identity, definition.id, first.occurrence.id)).toEqual(first);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.occurrence')).toHaveLength(1);
  expect(f.requests.mock.calls.at(-1)).toEqual(['runtime.followup.occurrence', { followupId: definition.id, occurrenceId: first.occurrence.id }, expect.any(AbortSignal)]);
  expect(f.requests.mock.calls.some(([method]) => ['runtime.followup.get', 'runtime.followup.occurrences', 'runtime.operation.inspect', 'runtime.input.submit', 'runtime.run.start'].includes(method))).toBe(false);
  f.requests.mockClear();
  for (const [selected, id] of [[{ ...identity, branchId: 'branch:other' }, definition.id], [identity, 'foreign-followup']] as const) {
    await expect(f.api.followups.occurrence(selected, id, first.occurrence.id)).rejects.toMatchObject({ status: 400 });
  }
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.followup.occurrence')).toBe(false);
  for (const body of [{ occurrenceId: '' }, { occurrenceId: null }, { occurrenceId: first.occurrence.id, after: 25 }, { occurrenceId: first.occurrence.id, sourceRunId: 'forged' }]) {
    expect((await f.request('/api/threads/followup/occurrence', { ...identity, followupId: definition.id, ...body })).status).toBe(400);
  }
  await expect(f.api.followups.occurrence(identity, definition.id, 'occurrence:foreign')).rejects.toMatchObject({ code: 'operation-error' });
  f.facts.occurrenceDetailError = true;
  await expect(f.api.followups.occurrence(identity, definition.id, first.occurrence.id)).rejects.toMatchObject({ code: 'storage-error' });
  f.facts.occurrenceDetailError = false;
  expect(await f.api.followups.occurrence(identity, definition.id, first.occurrence.id)).toEqual(first);
});

it('public metric and composite registrations reach the original decoder with exact UUID, decimals and retry identity', async () => {
  const f = fixture();
  const cpu = { kind: 'metric' as const, machineId: 'local', metric: 'cpu_percent' as const, predicate: 'above' as const, threshold: 90.125 };
  const gpu = { kind: 'metric' as const, machineId: 'local', metric: 'gpu_memory_mb' as const, gpuUuid: 'GPU-original', predicate: 'below' as const, threshold: -0.25 };
  const triggers: FollowupRegistrationTrigger[] = [cpu, gpu, { kind: 'any', sources: [cpu, gpu] }, { kind: 'all', sources: [cpu, gpu] }];
  let loseReply = true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await f.request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body)));
    if (loseReply) { loseReply = false; throw new Error('metric acceptance reply lost'); } return response;
  });
  const inputs = triggers.map((trigger, index) => ({ ...identity, key: `metric-${index}`, runId: run.id, trigger, instruction, repeat: 'each' as const }));
  await expect(f.api.followups.register(inputs[0]!)).rejects.toThrow('metric acceptance reply lost');
  for (const input of inputs) await f.api.followups.register(input);
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.followup.register').map(([, params]) => params))
    .toEqual([inputs[0]!, ...inputs].map(({ key, runId, trigger, instruction, repeat }) => ({ key, runId, trigger, instruction, repeat })));
  expect(f.issueGrant).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
});
