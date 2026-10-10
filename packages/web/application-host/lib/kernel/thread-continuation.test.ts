import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { AgentRuntimeStreamEvent, LaunchIntent, Run, RuntimeEvent } from './protocol.generated.js';
import { waitWithSignal } from '../cancellation.js';
import { ThreadAdapter } from './thread-adapter.js';
import { ThreadCollaboration } from './thread-collaboration.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:pause', branchId: 'branch:pause' };
function fixture(prepareContext?: ContextPreparer) {
  const run: Run = { id: 'run:pause', thread_id: identity.threadId, branch_id: identity.branchId, state: 'waiting',
    revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: 'wait:one' };
  const launch: LaunchIntent = { run_id: run.id, revision: 1, startable: false, requires_rebind: true, bound_epoch: null,
    pause: { action_id: 'pause:one', wait_id: 'wait:one', reason: 'Review before proceeding' }, preparation_failure: null,
    selection: { credential_scope: { reference: 'scope', authority: 'fixture', account: 'account', generation: 1 },
      policy_models: [], mcp_binding: null, connection_identity: 'fixture', provider_family: 'fixture', model: 'fixture',
      configuration_generation: 1, tool_schema_generation: 1, tools: [], policy: { name: 'fixture', version: '1' }, source: null } };
  const receipt = { run_id: run.id, action_id: 'pause:one', wait_id: 'wait:one', cursor: 7 };
  let preparation = new AbortController();
  const runtime = {
    withRunPreparation: <T>(_runId: string, callerSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) => {
      const signal = callerSignal ? AbortSignal.any([callerSignal, preparation.signal]) : preparation.signal;
      return waitWithSignal(work(signal), signal);
    },
    run: vi.fn(async () => structuredClone(run)), launch: vi.fn(async () => structuredClone(launch)),
    pendingLaunches: vi.fn(async () => [structuredClone(launch)]), childForThread: vi.fn(async () => null),
    threads: vi.fn(async () => [{ thread_id: identity.threadId, observer_project_ids: [], branches: [{ branch_id: identity.branchId, active_run_id: run.id, head: null, latest_run: run }] }]),
    thread: vi.fn(async () => ({ thread_id: identity.threadId, observer_project_ids: [], branches: [{ branch_id: identity.branchId, active_run_id: run.id, head: null, latest_run: run }] })),
    modelSelections: vi.fn(async () => ({ desired: null, active: null })),
    resumeRun: vi.fn(async (runId: string, waitId: string) => {
      if (runId !== run.id || waitId !== receipt.wait_id) throw new Error('Not the recorded pause command');
      if (run.waiting_on === receipt.wait_id) { run.state = 'runnable'; run.waiting_on = null; launch.startable = true; launch.pause = null; }
      return structuredClone(receipt);
    }),
    enqueue: vi.fn(async () => ({ input_id: 'queued', run_id: run.id, mode: 'boundary' as const, cursor: 6 })),
    rebindLaunch: vi.fn<AgentRuntimeClient['rebindLaunch']>(async () => { launch.startable = false; return { runId: run.id, epoch: 1 }; }),
    context: vi.fn<AgentRuntimeClient['context']>(async () => null), refreshContext: vi.fn<AgentRuntimeClient['refreshContext']>(),
    releaseRunCredentialOwner: vi.fn(), failLaunch: vi.fn(async () => launch),
  };
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn(async () => ({}) as ExistingHostCredentialOwner) };
  const errors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, async () => {}, (_runId, error) => { errors.push(error); }, undefined, prepareContext);
  return { run, launch, receipt, runtime, models, adapter, errors, cancelPreparation: () => { preparation.abort(); preparation = new AbortController(); } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => vi.unstubAllGlobals());

it('queued input, startup discovery and generic continuation leave an explicit Pause untouched', async () => {
  const f = fixture();
  expect(await f.adapter.enqueue({ ...identity, key: 'queued', text: 'another input', mode: 'boundary' })).toMatchObject({ input_id: 'queued' });
  await f.adapter.recover(); await f.adapter.continueLaunch(f.run.id); await tick();
  expect(f.run.waiting_on).toBe('wait:one');
  expect(f.runtime.resumeRun).not.toHaveBeenCalled();
  expect(f.runtime.rebindLaunch).not.toHaveBeenCalled();
  expect(f.models.rebindModel).not.toHaveBeenCalled();
  expect(f.runtime.releaseRunCredentialOwner).not.toHaveBeenCalled();
  await expect(f.adapter.retryPreparation(f.run.id)).rejects.toThrow('not eligible');
});

it('resume returns its durable receipt before cold assembly and all callers share the existing launch owner', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.rebindLaunch.mockImplementation(async () => { await gate; f.launch.startable = false; return { runId: f.run.id, epoch: 1 }; });
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce());
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  const joined = f.adapter.continueLaunch(f.run.id);
  await f.adapter.recover();
  expect(f.runtime.releaseRunCredentialOwner).toHaveBeenCalledOnce();
  release(); await joined;
  // Start ack leaves assembly owned in the supervisor although its launch still requires rebind.
  f.launch.requires_rebind = true;
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  await f.adapter.recover(); await tick();
  expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce();
  expect(f.runtime.releaseRunCredentialOwner).toHaveBeenCalledOnce();
  // A later Pause has a different Wait; an old receipt retry cannot clear or relaunch it.
  f.run.state = 'waiting'; f.run.waiting_on = 'wait:two';
  f.launch.pause = { action_id: 'pause:two', wait_id: 'wait:two', reason: 'Second review' };
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  await tick();
  expect(f.run.waiting_on).toBe('wait:two');
  expect(f.runtime.releaseRunCredentialOwner).toHaveBeenCalledOnce();
  expect(f.errors).toEqual([]);
});

it('the public HTTP client and registered routes require waitId and keep preparation retry separate', async () => {
  const f = fixture();
  const handlers = new Map<string, RequestHandler>();
  const app = { post: (path: string, ...chain: RequestHandler[]) => { handlers.set(path, chain.at(-1)!); }, get: () => {} } as unknown as Express;
  registerThreadRoutes(app, f.adapter, (_request, _response, next) => next());
  const calls: Array<{ path: string; body: unknown }> = [];
  const request = async (path: string, body: unknown) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; }, json(value: unknown) { output = value; this.writableEnded = true; return this; } });
    const handler = handlers.get(path); if (!handler) throw new Error(`No registered route: ${path}`);
    await handler({ body } as Request, response as unknown as ExpressResponse, () => {});
    return Response.json(output, { status });
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url, 'http://fixture.invalid').pathname;
    const body = JSON.parse(String(init.body)); calls.push({ path, body }); return request(path, body);
  });
  const api = createThreadsHttpAPI();
  expect((await request('/api/threads/run/resume', { runId: f.run.id })).status).toBe(400);
  expect((await request('/api/threads/run/resume', { runId: f.run.id, waitId: 'wait:one', resumeAll: true })).status).toBe(400);
  expect(f.runtime.resumeRun).not.toHaveBeenCalled();
  expect(await api.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  expect(calls.at(-1)).toEqual({ path: '/api/threads/run/resume', body: { runId: f.run.id, waitId: 'wait:one' } });
  await tick();
  f.launch.startable = true; f.launch.requires_rebind = true; f.launch.preparation_failure = 'preparation_failed';
  await api.retryPreparation(f.run.id);
  expect(calls.at(-1)).toEqual({ path: '/api/threads/run/retry-preparation', body: { runId: f.run.id } });
  expect(f.runtime.resumeRun).toHaveBeenCalledOnce();
});

it('slow startup launch cannot block the existing child/process pump or a later exact policy resume event', async () => {
  const f = fixture(); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable'; f.run.waiting_on = null;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.rebindLaunch.mockImplementation(async () => { await gate; f.launch.startable = false; return { runId: f.run.id, epoch: 1 }; });
  let listener!: (event: AgentRuntimeStreamEvent) => void;
  const events: RuntimeEvent[] = [];
  const reconcileChildren = vi.fn(async () => [] as string[]);
  const runtime = Object.assign(f.runtime, {
    onEvent: (handler: typeof listener) => { listener = handler; return () => {}; }, onExit: () => () => {}, onReady: () => () => {},
    reconcileChildren, reconcileProcessWaits: async () => [], children: async () => [], unacceptedChildSources: async () => [],
    status: async () => ({ eventCursor: 0 }), events: async (cursor: number) => events.filter(event => event.cursor > cursor),
  });
  const continues = vi.fn(async (runId: string, signal: AbortSignal) => { if (runId === f.run.id) await f.adapter.continueLaunch(runId, { signal }); });
  const collaboration = new ThreadCollaboration({ runtime: runtime as unknown as AgentRuntimeClient,
    workingStates: {} as never, prepareContext: (async () => { throw new Error('No child preparation expected'); }) as never,
    continueRun: continues, recoverLaunches: signal => f.adapter.recover(signal), onError: (_id, error) => { f.errors.push(error); } });
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce());
    const previous = reconcileChildren.mock.calls.length;
    events.push({ cursor: 1, subject: 'pause:other', revision: 2, kind: 'policy.resumed', data: { run_id: 'run:other', action_id: 'pause:other', wait_id: 'wait:other' } });
    listener({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'durable', cursor: 1 });
    await vi.waitFor(() => expect(continues).toHaveBeenCalledWith('run:other', expect.any(AbortSignal)));
    expect(reconcileChildren.mock.calls.length).toBeGreaterThan(previous);
    expect(f.runtime.pendingLaunches).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
  } finally { release(); collaboration.stop(); await tick(); }
});


it('Run or epoch cancellation detaches cold credential preparation before it can release or rebind an owner', async () => {
  const f = fixture(); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable';
  let resolve!: (owner: ExistingHostCredentialOwner) => void;
  f.models.rebindModel.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const old = f.adapter.continueLaunch(f.run.id);
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.models.rebindModel).toHaveBeenCalledOnce());
  f.cancelPreparation(); await rejected;
  await f.adapter.continueLaunch(f.run.id);
  resolve({} as ExistingHostCredentialOwner); await tick();
  expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce();
  expect(f.runtime.releaseRunCredentialOwner).toHaveBeenCalledOnce();
  expect(f.runtime.failLaunch).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});


it('cancelled launch context refresh cannot publish its late proposal or bind the subsequent owner', async () => {
  let resolve!: (proposal: { effectiveSystemPrompt: string; instructionSources: string[]; memoryCheckpoint: null }) => void;
  const refresh = vi.fn(() => new Promise<{ effectiveSystemPrompt: string; instructionSources: string[]; memoryCheckpoint: null }>(done => { resolve = done; }));
  const prepare = Object.assign(async () => { throw new Error('Initial context is already present'); }, { refresh }) as unknown as ContextPreparer;
  const f = fixture(prepare); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable';
  f.runtime.context.mockResolvedValue({ id: 'context:old', revision: 1, proposal: { key: 'context:old', branch_id: identity.branchId,
    through_id: null, expected_revision: 0, summary: '', effective_system_prompt: 'Original context', instruction_sources: [], memory_checkpoint: null } });
  const work = f.adapter.continueLaunch(f.run.id);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  f.cancelPreparation(); await rejected;
  resolve({ effectiveSystemPrompt: 'Late old-owner context', instructionSources: [], memoryCheckpoint: null });
  await tick();
  expect(f.runtime.refreshContext).not.toHaveBeenCalled();
  expect(f.runtime.releaseRunCredentialOwner).not.toHaveBeenCalled();
  expect(f.runtime.rebindLaunch).not.toHaveBeenCalled();
  expect(f.runtime.failLaunch).not.toHaveBeenCalled();
});


it('resume during a delayed previous start acknowledgement schedules one fresh continuation before joined callers settle', async () => {
  const f = fixture(); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable'; f.run.waiting_on = null;
  let releaseFirst!: () => void; const firstAck = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseSecond!: () => void; const secondAck = new Promise<void>(resolve => { releaseSecond = resolve; });
  let starts = 0;
  let releaseCancelledOwner!: (owner: ExistingHostCredentialOwner) => void;
  f.models.rebindModel.mockImplementationOnce(async () => ({}) as ExistingHostCredentialOwner)
    .mockImplementationOnce(() => new Promise(resolve => { releaseCancelledOwner = resolve; }));
  f.runtime.rebindLaunch.mockImplementation(async () => {
    if (++starts === 1) await firstAck;
    else { await secondAck; f.launch.startable = false; f.launch.requires_rebind = false; }
    return { runId: f.run.id, epoch: 1 };
  });
  const first = f.adapter.continueLaunch(f.run.id);
  await vi.waitFor(() => expect(starts).toBe(1));
  // The worker has committed Pause and quiesced, but its original start reply is delayed.
  f.run.state = 'waiting'; f.run.waiting_on = 'wait:one'; f.launch.startable = false;
  f.launch.pause = { action_id: 'pause:one', wait_id: 'wait:one', reason: 'Review' };
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  let notificationSettled = false;
  const notification = f.adapter.continueLaunch(f.run.id).then(() => { notificationSettled = true; });
  const cancelled = new AbortController();
  const cancelledWake = expect(f.adapter.continueLaunch(f.run.id, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
  releaseFirst();
  await vi.waitFor(() => expect(f.models.rebindModel).toHaveBeenCalledTimes(2));
  // The newest coalesced wake cancels while preparing; the earlier durable resume remains live.
  cancelled.abort(); await cancelledWake;
  await vi.waitFor(() => expect(starts).toBe(2));
  releaseCancelledOwner({} as ExistingHostCredentialOwner);
  expect(f.models.rebindModel).toHaveBeenCalledTimes(3);
  expect(notificationSettled).toBe(false);
  expect(f.runtime.releaseRunCredentialOwner).toHaveBeenCalledTimes(2);
  releaseSecond(); await Promise.all([first, notification]);
  expect(notificationSettled).toBe(true);
  expect(starts).toBe(2);
  expect(f.errors).toEqual([]);
});

it('a new epoch wake keeps its exact credential owner when the previous launch is cancelled and late old wakes arrive', async () => {
  const f = fixture(); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable';
  const oldEpoch = new AbortController(); const newEpoch = new AbortController();
  const oldOwner = { identity: 'old-owner' } as unknown as ExistingHostCredentialOwner;
  const newOwner = { identity: 'new-owner' } as unknown as ExistingHostCredentialOwner;
  let releaseOld!: () => void; const oldAck = new Promise<void>(resolve => { releaseOld = resolve; });
  let releaseNew!: () => void; const newAck = new Promise<void>(resolve => { releaseNew = resolve; });
  f.runtime.rebindLaunch.mockImplementationOnce(async () => { await oldAck; return { runId: f.run.id, epoch: 1 }; })
    .mockImplementationOnce(async () => { await newAck; f.launch.startable = false; return { runId: f.run.id, epoch: 2 }; });
  const old = f.adapter.continueLaunch(f.run.id, { signal: oldEpoch.signal, credentialOwner: oldOwner });
  const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce());
  let nextSettled = false;
  const next = f.adapter.continueLaunch(f.run.id, { signal: newEpoch.signal, credentialOwner: newOwner }).then(() => { nextSettled = true; });
  oldEpoch.abort(); f.cancelPreparation();
  await expect(f.adapter.continueLaunch(f.run.id, { signal: oldEpoch.signal, credentialOwner: oldOwner })).rejects.toMatchObject({ name: 'AbortError' });
  await oldRejected;
  await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledTimes(2));
  expect(f.runtime.rebindLaunch.mock.calls[1]![1]?.credentialOwner).toBe(newOwner);
  expect(nextSettled).toBe(false);
  releaseOld(); releaseNew(); await next;
  expect(f.runtime.rebindLaunch).toHaveBeenCalledTimes(2);
  expect(f.runtime.failLaunch).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});
