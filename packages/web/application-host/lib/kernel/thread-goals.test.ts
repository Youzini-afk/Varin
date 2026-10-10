import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { Goal, GoalControlReceipt, GoalMeasuredUsage, ModelSessionConfiguration, Run } from './protocol.generated.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:goal', branchId: 'branch:goal' };
const source: Run = { id: 'run:source', thread_id: identity.threadId, branch_id: identity.branchId,
  state: 'waiting', revision: 2, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: 'policy-pause:source' };
const measured = (output: number, unknown: number): GoalMeasuredUsage => ({ inferences: 1,
  input_tokens: { known: 30, unknown_receipts: 0 }, output_tokens: { known: output, unknown_receipts: unknown },
  cached_input_tokens: { known: 0, unknown_receipts: 1 }, cache_write_tokens: { known: 0, unknown_receipts: 1 },
  reasoning_tokens: { known: 0, unknown_receipts: 1 } });
const goal: Goal = { id: 'goal:one', revision: 1, generation: 1,
  thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: source.id,
  objective: 'Keep the requested work going', control: 'active', state: 'blocked', budget: { maxOutputTokens: 0 },
  usage: { actual: measured(0, 1), estimated: measured(1500, 0), missing_inferences: 1, pending_inferences: 2 },
  blocked_reason: 'waiting', reason: 'An external dependency is pending', dependency_operation_id: 'operation:dependency' };
const accepted: GoalControlReceipt = { id: goal.id, revision: goal.revision, generation: goal.generation,
  thread_id: identity.threadId, branch_id: identity.branchId, control: 'active' };

/** Same public transport boundary as thread-followups.test.ts: client, routes, thin adapter and runtime
 * client are real; RPC responses are controlled. Catalog authorization, durability, actual usage gates
 * and atomic continuation admission belong to the native suite, not this socket-free fixture. */
function fixture() {
  const facts = { reply: structuredClone(accepted), list: [structuredClone(goal)], source: structuredClone(source),
    showRun: false, listError: false, writeError: null as Error | null };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    switch (method) {
      case 'runtime.thread.inspect': return { thread_id: params.threadId, observer_project_ids: [], branches: [
        { branch_id: identity.branchId, active_run_id: facts.showRun ? source.id : null,
          head: null, latest_run: facts.showRun ? facts.source : null },
        { branch_id: 'branch:other', active_run_id: null, head: null, latest_run: null },
      ] };
      case 'runtime.run.inspect': return facts.source;
      case 'runtime.goal.start': case 'runtime.goal.update': case 'runtime.goal.control':
        if (facts.writeError) throw facts.writeError;
        return facts.reply;
      case 'runtime.goal.list':
        if (facts.listError) throw new Error('Goal objective body is damaged');
        return facts.list;
      case 'runtime.status': return { eventCursor: 5 };
      case 'runtime.history.page': return { head: null, previous: null, items: [] };
      case 'runtime.context.inspect': case 'runtime.launch.inspect': return null;
      case 'runtime.model.inspect': return { desired: null, active: null };
      case 'runtime.input.submit': case 'runtime.input.enqueue': return {
        input_id: 'input:ordinary', run_id: source.id, mode: 'boundary', cursor: 6,
      };
      case 'runtime.input.list': case 'runtime.thread.operations.active': case 'runtime.context_job.list':
      case 'runtime.followup.list': case 'runtime.child.list': return [];
      default: throw new Error(`Unexpected RPC: ${method}`);
    }
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests,
    beginRunPreparation: () => ({ signal: new AbortController().signal, release() {} }),
    cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {},
  } as unknown as KernelClient);
  const models = { resolveModel: vi.fn(async () => ({ configuration: {} as ModelSessionConfiguration, credentialOwner: {
    scope: async () => ({ reference: 'scope', authority: 'fixture', account: 'account', generation: 1 }),
  } as ExistingHostCredentialOwner })), rebindModel: vi.fn() };
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
  return { facts, requests, request, models, api: createThreadsHttpAPI() };
}
afterEach(() => vi.unstubAllGlobals());

it('forwards original retry keys, large objectives, nullable and zero budgets, and revision CAS without expanding short receipts', async () => {
  const f = fixture();
  const objective = `  用户的原始目标\n${'Preserve this paragraph and its spacing.\n'.repeat(4096)}  `;
  const input = { ...identity, key: 'same-goal-start-key', runId: source.id, objective, budget: null };
  expect(await f.api.goals.start(input)).toEqual(accepted);
  // A terminal source is still forwarded; the Catalog decides current/latest-source eligibility.
  f.facts.source.state = 'completed'; f.facts.source.waiting_on = null;
  expect(await f.api.goals.start(input)).toEqual(accepted);
  const starts = f.requests.mock.calls.filter(([method]) => method === 'runtime.goal.start');
  expect(starts).toHaveLength(2);
  for (const [, params, signal] of starts) {
    expect(params).toEqual({ threadId: identity.threadId, branchId: identity.branchId,
      key: input.key, runId: source.id, objective, budget: null });
    expect(signal).toBeInstanceOf(AbortSignal);
  }
  f.facts.reply = { ...accepted, revision: 10, generation: 3 };
  const changed = { ...identity, goalId: goal.id, expectedRevision: 9,
    objective: `\nUpdated constraint\n${objective}`, budget: { maxOutputTokens: 0 } };
  expect(await f.api.goals.update(changed)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.goal.update', {
    goalId: changed.goalId, threadId: identity.threadId, branchId: identity.branchId,
    expectedRevision: 9, objective: changed.objective, budget: { maxOutputTokens: 0 },
  }]);
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.goal.list')).toBe(false);
  expect(f.models.resolveModel).not.toHaveBeenCalled();
});

it('pause and resume reach scoped Catalog control even when full Goal bodies cannot be read, without resuming a policy Pause', async () => {
  const f = fixture(); f.facts.listError = true;
  await expect(f.api.goals.list(identity)).rejects.toMatchObject({ status: 400 });
  f.requests.mockClear();
  for (const [action, control] of [['pause', 'paused'], ['resume', 'active']] as const) {
    f.facts.reply = { ...f.facts.reply, revision: f.facts.reply.revision + 1, control };
    const expectedRevision = f.facts.reply.revision - 1;
    expect(await f.api.goals.control({ ...identity, goalId: goal.id, expectedRevision, action })).toEqual(f.facts.reply);
    expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.goal.control', {
      goalId: goal.id, threadId: identity.threadId, branchId: identity.branchId, expectedRevision, action,
    }]);
  }
  expect(f.requests.mock.calls.map(([method]) => method)).toEqual([
    'runtime.thread.inspect', 'runtime.goal.control', 'runtime.thread.inspect', 'runtime.goal.control',
  ]);
  expect(f.facts.source.waiting_on).toBe('policy-pause:source');
  expect(f.models.rebindModel).not.toHaveBeenCalled();
  // The selected scope reaches the atomic native check; no list/hydrate preflight may replace it.
  f.facts.writeError = new KernelClientError({ code: 'operation-error', message: 'operation error: Goal belongs to another branch' });
  await expect(f.api.goals.control({ ...identity, branchId: 'branch:other', goalId: goal.id, expectedRevision: 3, action: 'cancel' }))
    .rejects.toMatchObject({ status: 400, code: 'operation-error' });
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.goal.control', {
    goalId: goal.id, threadId: identity.threadId, branchId: 'branch:other', expectedRevision: 3, action: 'cancel',
  }]);
});

it('list and snapshot keep the selected branch current and preserve unknown, estimated and pending usage instead of recomputing a budget state', async () => {
  const f = fixture();
  const current = { ...goal, revision: 9, objective: 'A newer objective already committed by another client' };
  const second = { ...goal, id: 'goal:second', objective: 'An independent explicit goal', budget: null };
  const other = { ...goal, id: 'goal:other-branch', branch_id: 'branch:other' };
  f.facts.list = [current, second, other, { ...goal, id: 'goal:other-thread', thread_id: 'thread:other' }];
  expect(await f.api.goals.list(identity)).toEqual([current, second]);
  expect(await f.api.goals.list({ ...identity, branchId: 'branch:other' })).toEqual([other]);
  // An older command receipt is not a replacement for the latest full projection.
  expect(await f.api.goals.start({ ...identity, key: 'old-key', runId: source.id, objective: goal.objective, budget: goal.budget })).toEqual(accepted);
  expect((await f.api.snapshot(identity)).goals).toEqual([current, second]);
  expect((await f.api.snapshot({ ...identity, branchId: 'branch:other' })).goals).toEqual([other]);
});

it('all Goal routes authenticate first and reject unknown fields and invalid budgets or revisions before RPC admission', async () => {
  const f = fixture();
  for (const method of ['start', 'update', 'control', 'list']) {
    expect((await f.request(`/api/threads/goal/${method}`, identity, false)).status).toBe(401);
  }
  expect(f.requests).not.toHaveBeenCalled();
  const start = { ...identity, key: 'start', runId: source.id, objective: 'private objective', budget: null };
  for (const body of [
    { ...start, schedule: 'daily' }, { ...start, runtime: 'pi' },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'].map(maxOutputTokens => ({ ...start, budget: { maxOutputTokens } })),
    { ...start, budget: { maxOutputTokens: 0, remaining: 0 } }, { ...start, budget: {} },
  ]) expect((await f.request('/api/threads/goal/start', body)).status).toBe(400);
  const update = { ...identity, goalId: goal.id, expectedRevision: 1, objective: goal.objective, budget: null };
  expect((await f.request('/api/threads/goal/update', { ...update, generation: 2 })).status).toBe(400);
  expect((await f.request('/api/threads/goal/update', { ...update, budget: undefined })).status).toBe(400);
  const control = { ...identity, goalId: goal.id, expectedRevision: 1, action: 'pause' };
  for (const body of [{ ...control, expectedRevision: -1 }, { ...control, expectedRevision: 1.5 },
    { ...control, action: 'restart' }, { ...control, objective: 'new objective' }]) {
    expect((await f.request('/api/threads/goal/control', body)).status).toBe(400);
  }
  expect((await f.request('/api/threads/goal/list', { ...identity, includeAllBranches: true })).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled();
});

it('rejects a source Run from another Thread or branch before Goal admission', async () => {
  const f = fixture();
  const input = { ...identity, key: 'foreign-source', runId: source.id, objective: goal.objective, budget: null };
  f.facts.source.branch_id = 'branch:other';
  await expect(f.api.goals.start(input)).rejects.toMatchObject({ status: 400 });
  f.facts.source.branch_id = identity.branchId; f.facts.source.thread_id = 'thread:other';
  await expect(f.api.goals.start(input)).rejects.toMatchObject({ status: 400 });
  await expect(f.api.goals.list({ ...identity, branchId: 'branch:unknown' })).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.goal.start')).toBe(false);
});

it('returns safe 400 and revision-conflict 409 errors without exposing an upstream objective or prompt', async () => {
  const f = fixture();
  const control = { ...identity, goalId: goal.id, expectedRevision: 0, action: 'complete' as const };
  const privatePrompt = 'PRIVATE OBJECTIVE: never expose this provider prompt';
  for (const [prefix, status, code] of [
    ['operation error: damaged body: ', 400, 'operation-error'],
    ['operation error: conflict: Goal revision changed: ', 409, 'thread-conflict'],
  ] as const) {
    f.facts.writeError = new KernelClientError({ code: 'operation-error', message: `${prefix}${privatePrompt}` });
    const response = await f.request('/api/threads/goal/control', control);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, error: 'Thread request could not be completed' });
    await expect(f.api.goals.control(control)).rejects.toMatchObject({ status, code, message: `Thread request failed (${status})` });
  }
});

it('ordinary Send and queued input use their original input paths without implicitly starting a Goal', async () => {
  const f = fixture();
  expect(await f.api.submit({ ...identity, key: 'ordinary-send', text: 'Investigate this problem', expectedHead: null,
    model: { providerId: 'fixture', modelId: 'fixture' } })).toMatchObject({ input_id: 'input:ordinary' });
  f.facts.showRun = true;
  expect(await f.api.enqueue({ ...identity, key: 'ordinary-follow-on', text: 'Also check the result', mode: 'boundary' }))
    .toMatchObject({ input_id: 'input:ordinary' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const methods = f.requests.mock.calls.map(([method]) => method);
  expect(methods).toContain('runtime.input.submit'); expect(methods).toContain('runtime.input.enqueue');
  expect(methods.some(method => method.startsWith('runtime.goal.'))).toBe(false);
});
