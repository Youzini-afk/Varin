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
  const launch: LaunchIntent = { policy_preparable: false, policy_generation: 0, policy_target: { kind: 'default' }, run_id: run.id, revision: 1, startable: false, requires_rebind: true, bound_epoch: null,
    pause: { action_id: 'pause:one', wait_id: 'wait:one', reason: 'Review before proceeding' }, preparation_failure: null,
    selection: { credential_scope: { reference: 'scope', authority: 'fixture', account: 'account', generation: 1 },
      child_dispatch: null, policy_models: [], mcp_binding: null, extension_bindings:[], connection_identity: 'fixture', provider_family: 'fixture', model: 'fixture',
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
    releaseMainModelCredentials: vi.fn(), failLaunch: vi.fn(async () => launch),
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
  expect(f.runtime.releaseMainModelCredentials).not.toHaveBeenCalled();
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
  expect(f.runtime.releaseMainModelCredentials).toHaveBeenCalledOnce();
  release(); await joined;
  // Start ack leaves assembly owned in the supervisor although its launch still requires rebind.
  f.launch.requires_rebind = true;
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  await f.adapter.recover(); await tick();
  expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce();
  expect(f.runtime.releaseMainModelCredentials).toHaveBeenCalledOnce();
  // A later Pause has a different Wait; an old receipt retry cannot clear or relaunch it.
  f.run.state = 'waiting'; f.run.waiting_on = 'wait:two';
  f.launch.pause = { action_id: 'pause:two', wait_id: 'wait:two', reason: 'Second review' };
  expect(await f.adapter.resume(f.run.id, 'wait:one')).toEqual(f.receipt);
  await tick();
  expect(f.run.waiting_on).toBe('wait:two');
  expect(f.runtime.releaseMainModelCredentials).toHaveBeenCalledOnce();
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
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never, storageAdapter: {} as never, resolveLiveSource: async () => { throw new Error("No source expected"); }, sourceCaptureOwners: {} as never, runtime: runtime as unknown as AgentRuntimeClient,
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

it.each(['followup.admitted', 'goal.run_ready'] as const)('%s uses the same cold launch owner, while unrelated and repeated durable events cannot relaunch it', async kind => {
  const f = fixture();
  const subject = kind === 'goal.run_ready' ? 'goal:one' : 'followup:process';
  const events: RuntimeEvent[] = [];
  let listener!: (event: AgentRuntimeStreamEvent) => void;
  const runtime = Object.assign(f.runtime, {
    onEvent: (handler: typeof listener) => { listener = handler; return () => {}; }, onExit: () => () => {}, onReady: () => () => {},
    reconcileChildren: async () => [], reconcileProcessWaits: async () => [], children: async () => [], unacceptedChildSources: async () => [],
    status: async () => ({ eventCursor: 0 }), events: async (cursor: number) => events.filter(event => event.cursor > cursor),
  });
  const continues = vi.fn((runId: string, signal: AbortSignal) => f.adapter.continueLaunch(runId, { signal }));
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never, storageAdapter: {} as never,
    resolveLiveSource: async () => { throw new Error('Unexpected source'); }, sourceCaptureOwners: {} as never,
    runtime: runtime as unknown as AgentRuntimeClient, workingStates: {} as never, prepareContext: {} as never,
    continueRun: continues, recoverLaunches: signal => f.adapter.recover(signal), onError: (_id, error) => { f.errors.push(error); } });
  const notify = () => listener({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'durable', cursor: events.at(-1)!.cursor });
  try {
    await collaboration.recover();
    // A prior manual Pause is still authoritative even if an old admitted notification replays.
    events.push({ cursor: 1, subject, revision: 2, kind, data: { run_id: f.run.id } });
    notify(); await vi.waitFor(() => expect(continues).toHaveBeenCalledOnce()); await tick();
    expect(f.run.waiting_on).toBe('wait:one'); expect(f.runtime.resumeRun).not.toHaveBeenCalled();
    expect(f.runtime.rebindLaunch).not.toHaveBeenCalled();
    // Only the exact continuation admission wakes cold preparation. Generic accepted Runs may be children.
    f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable'; f.run.waiting_on = null;
    events.push({ cursor: 2, subject: 'run:unprepared-child', revision: 1, kind: 'run.accepted', data: { run_id: 'run:unprepared-child' } });
    events.push({ cursor: 3, subject, revision: 1, kind: kind === 'goal.run_ready' ? 'goal.started' : 'followup.registered', data: { run_id: f.run.id } });
    notify(); await tick(); await tick(); expect(continues).toHaveBeenCalledOnce();
    events.push({ cursor: 4, subject, revision: 2, kind, data: {
      run_id: f.run.id, ...(kind === 'goal.run_ready' ? { goal_id: subject } : {
        followup_id: subject, occurrence_id: 'occurrence:process', source_run_id: 'run:source', operation_id: 'operation:process',
      }),
    } });
    notify(); await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce());
    expect(continues).toHaveBeenLastCalledWith(f.run.id, expect.any(AbortSignal));
    expect(f.runtime.rebindLaunch).toHaveBeenLastCalledWith(f.run.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.models.rebindModel).toHaveBeenCalledWith(f.run.configuration, f.launch.selection.credential_scope);
    notify(); await tick(); await tick();
    expect(continues).toHaveBeenCalledTimes(2); expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce();
    expect(f.runtime.resumeRun).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
  } finally { collaboration.stop(); }
});

it.each(['followup.admitted', 'goal.run_ready'] as const)('startup discovery retains %s during the saved-launch scan and discovers saved work after an epoch change', async kind => {
  const f = fixture(); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable'; f.run.waiting_on = null;
  let release!: () => void; const scanned = new Promise<void>(resolve => { release = resolve; });
  f.runtime.pendingLaunches.mockImplementationOnce(async () => { await scanned; return []; });
  let listener!: (event: AgentRuntimeStreamEvent) => void; let exit!: () => void; let ready!: () => void;
  const events: RuntimeEvent[] = [];
  const runtime = Object.assign(f.runtime, {
    onEvent: (handler: typeof listener) => { listener = handler; return () => {}; },
    onExit: (handler: () => void) => { exit = handler; return () => {}; }, onReady: (handler: () => void) => { ready = handler; return () => {}; },
    reconcileChildren: async () => [], reconcileProcessWaits: async () => [], children: async () => [], unacceptedChildSources: async () => [],
    status: async () => ({ eventCursor: events.at(-1)?.cursor ?? 0 }), events: async (cursor: number) => events.filter(event => event.cursor > cursor),
  });
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never, storageAdapter: {} as never,
    resolveLiveSource: async () => { throw new Error('Unexpected source'); }, sourceCaptureOwners: {} as never,
    runtime: runtime as unknown as AgentRuntimeClient, workingStates: {} as never, prepareContext: {} as never,
    continueRun: (runId, signal) => f.adapter.continueLaunch(runId, { signal }), recoverLaunches: signal => f.adapter.recover(signal),
    onError: (_id, error) => { f.errors.push(error); } });
  try {
    const discovery = collaboration.recover();
    await vi.waitFor(() => expect(f.runtime.pendingLaunches).toHaveBeenCalledOnce());
    events.push({ cursor: 1, subject: kind === 'goal.run_ready' ? 'goal:one' : 'followup:process', revision: 2, kind, data: { run_id: f.run.id } });
    listener({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'durable', cursor: 1 });
    release(); await discovery;
    await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledOnce());
    // A new Host epoch discovers the Catalog's saved launch even with no new event notification.
    exit(); f.launch.startable = true; ready();
    await vi.waitFor(() => expect(f.runtime.rebindLaunch).toHaveBeenCalledTimes(2));
    expect(f.runtime.pendingLaunches).toHaveBeenCalledTimes(2);
    expect(f.runtime.rebindLaunch).toHaveBeenLastCalledWith(f.run.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.runtime.resumeRun).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
  } finally { release(); collaboration.stop(); }
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
  expect(f.runtime.releaseMainModelCredentials).toHaveBeenCalledOnce();
  expect(f.runtime.failLaunch).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});


it('cancelled launch context refresh cannot publish its late proposal or bind the subsequent owner', async () => {
  let resolve!: (proposal: { effectiveSystemPrompt: string; instructionSources: string[]; memoryCheckpoint: null }) => void;
  const refresh = vi.fn(() => new Promise<{ effectiveSystemPrompt: string; instructionSources: string[]; memoryCheckpoint: null }>(done => { resolve = done; }));
  const prepare = Object.assign(async () => { throw new Error('Initial context is already present'); }, { refresh }) as unknown as ContextPreparer;
  const f = fixture(prepare); f.launch.startable = true; f.launch.pause = null; f.run.state = 'runnable';
  f.runtime.context.mockResolvedValue({ id: 'context:old', revision: 1, resource_activations: [], proposal: { key: 'context:old', branch_id: identity.branchId,
    through_id: null, expected_revision: 0, summary: '', effective_system_prompt: 'Original context', instruction_sources: [], memory_checkpoint: null } });
  const work = f.adapter.continueLaunch(f.run.id);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  f.cancelPreparation(); await rejected;
  resolve({ effectiveSystemPrompt: 'Late old-owner context', instructionSources: [], memoryCheckpoint: null });
  await tick();
  expect(f.runtime.refreshContext).not.toHaveBeenCalled();
  expect(f.runtime.releaseMainModelCredentials).not.toHaveBeenCalled();
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
  expect(f.runtime.releaseMainModelCredentials).toHaveBeenCalledTimes(2);
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

it('policy HTTP controls require the displayed selection and branch, reject private state and do not resume a Pause', async () => {
  const f = fixture();
  const desired = { selection_id: 'candidate-one', run_id: f.run.id, generation: 1, expected_generation: 0, expected_selection_id: null, target: { kind: 'default' as const },
    state_mode: 'preserve' as const, status: 'failed' as const, failure: 'policy_state_incompatible', activation_cursor: null };
  const inspection = { active: { generation: 0, target: { kind: 'default' as const }, identity: { name: 'old', version: '1' }, activation_cursor: null },
    desired, preparation: null };
  const controls = Object.assign(f.runtime, {
    inspectPolicy: vi.fn(async () => inspection),
    restartPolicy: vi.fn(async (_runId: string, selectionId: string) => {
      if (selectionId !== desired.selection_id) throw new Error('policy_selection_changed');
      return { ...desired, selection_id: 'restart-command', state_mode: 'restart_state' as const, status: 'ready' as const, failure: null };
    }),
    cancelPolicyUpdate: vi.fn(async (_runId: string, selectionId: string) => {
      if (selectionId !== desired.selection_id) throw new Error('policy_selection_changed');
      return { ...desired, status: 'cancelled' as const };
    }),
  });
  const handlers = new Map<string, RequestHandler>();
  const app = { post: (path: string, ...chain: RequestHandler[]) => handlers.set(path, chain.at(-1)!), get() {} } as unknown as Express;
  registerThreadRoutes(app, f.adapter, (_request, _response, next) => next());
  const request = async (path: string, body: unknown) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; }, json(value: unknown) { output = value; this.writableEnded = true; return this; } });
    await handlers.get(path)!({ body } as Request, response as unknown as ExpressResponse, () => {});
    return Response.json(output, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  const api = createThreadsHttpAPI();
  expect(await api.inspectPolicy(identity, f.run.id)).toEqual(inspection);
  expect((await api.restartPolicy(identity, f.run.id, desired.selection_id)).state_mode).toBe('restart_state');
  expect((await api.cancelPolicyUpdate(identity, f.run.id, desired.selection_id)).status).toBe('cancelled');
  for (const body of [
    { ...identity, runId: f.run.id },
    { ...identity, runId: f.run.id, selectionId: desired.selection_id, state: null },
    { ...identity, runId: f.run.id, selectionId: desired.selection_id, target: { kind: 'default' } },
    { ...identity, branchId: 'foreign-branch', runId: f.run.id, selectionId: desired.selection_id },
  ]) expect((await request('/api/threads/policy/restart', body)).status).toBe(400);
  expect(controls.restartPolicy).toHaveBeenCalledOnce();
  expect(f.run.waiting_on).toBe('wait:one'); expect(f.runtime.resumeRun).not.toHaveBeenCalled();
  expect(f.runtime.rebindLaunch).not.toHaveBeenCalled();
});

it.each(['child_revision', 'process_receipt'] as const)('%s observed during an active child task is rechecked once after it releases', async wake => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listener!: (event: AgentRuntimeStreamEvent) => void;
  const child = { operation_id: 'child-operation', parent_run_id: 'parent', parent_thread_id: 'parent-thread', parent_branch_id: 'parent-branch',
    child_thread_id: 'child-thread', child_branch_id: 'child-branch', origin: {}, call_id: 'dispatch', project_id: null,
    input: { task: 'Read source', workMode: 'read_only' }, selected_profile: {preset_id:null, catalog_identity:null, work_mode:'read_only', tools:[], instructions:''}, configuration: {}, launch: f.launch.selection,
    state: 'ready', revision: 1, cursor: 1, receipt: { key: 'child-input', run_id: f.run.id, input_id: 'child-input', branch_id: 'child-branch', thread_id: 'child-thread', cursor: 1 },
    report: null, resources_released: true, code_result: { kind: 'no_changes' },
    source: { kind: 'pending', handoff: { operation_id: 'handoff', source: { mode: 'fixed_branch', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'source', revision: 0, live_root: null }, root: { kind: 'fixed', pin: { pin_id: 'pin', root: 'root', source: { mode: 'fixed_branch', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'source', revision: 0, live_root: null } } } } },
  } as import('./protocol.generated.js').ChildTask;
  const children = vi.fn(async () => [structuredClone(child)]);
  const events: RuntimeEvent[] = [];
  const runtime = Object.assign(f.runtime, {
    onEvent: (handler: typeof listener) => { listener = handler; return () => {}; }, onExit: () => () => {}, onReady: () => () => {},
    reconcileChildren: async () => [], reconcileProcessWaits: async () => [], children, unacceptedChildSources: async () => [],
    child: async () => structuredClone(child), releaseSourceGrants: vi.fn(async () => {}),
    status: async () => ({ eventCursor: 0 }), events: async (cursor: number) => events.filter(event => event.cursor > cursor),
  });
  const continueRun = vi.fn(async () => { await gate; });
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never, storageAdapter: {} as never, resolveLiveSource: async () => { throw new Error('Unexpected source'); }, sourceCaptureOwners: {} as never,
    runtime: runtime as unknown as AgentRuntimeClient, workingStates: {} as never, prepareContext: {} as never,
    continueRun, recoverLaunches: async () => {}, onError: (_id, error) => { f.errors.push(error); } });
  try {
    await collaboration.recover(); expect(continueRun).toHaveBeenCalledOnce();
    if (wake === 'child_revision') {
      child.revision = 2; child.state = 'completed';
      child.report = { outcome: 'succeeded', sender_thread_id: child.child_thread_id, run_id: f.run.id, history_ids: [], detail: null };
    } else {
      // Original process stop is a distinct fact; it does not revise ChildTask.
      events.push({ cursor: 1, subject: 'original-child-process', revision: 2, kind: 'operation.executor_stopped', data: { operation_id: 'original-child-process', executor: 'process_spawn', receipt_identity: 'guardian', receipt_epoch: 1 } });
    }
    listener({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'durable', cursor: 2 });
    await vi.waitFor(() => expect(children).toHaveBeenCalledTimes(wake === 'child_revision' ? 2 : 3));
    const scans = children.mock.calls.length;
    release();
    await vi.waitFor(() => expect(children).toHaveBeenCalledTimes(scans + 1));
    await tick(); expect(children).toHaveBeenCalledTimes(scans + 1);
    expect(continueRun).toHaveBeenCalledTimes(wake === 'child_revision' ? 1 : 2); expect(f.errors).toEqual([]);
  } finally { release(); collaboration.stop(); }
});

it('domain receipt discovery keeps the new epoch wake while an aborted old discovery drains', async () => {
  const f = fixture();
  let exit!: () => void; let ready!: () => void; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = Object.assign(f.runtime, {
    onEvent: () => () => {}, onExit: (handler: () => void) => { exit = handler; return () => {}; }, onReady: (handler: () => void) => { ready = handler; return () => {}; },
    reconcileChildren: async () => [], reconcileProcessWaits: async () => [], children: async () => [], unacceptedChildSources: async () => [],
    status: async () => ({ eventCursor: 0 }), events: async () => [],
  });
  const reconcileDomainReceipts = vi.fn(async (_signal: AbortSignal) => {}).mockImplementationOnce(async () => { await gate; });
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never, storageAdapter: {} as never, resolveLiveSource: async () => { throw new Error('Unexpected source'); }, sourceCaptureOwners: {} as never,
    runtime: runtime as unknown as AgentRuntimeClient, workingStates: {} as never, prepareContext: {} as never,
    continueRun: async () => {}, recoverLaunches: async () => {}, reconcileDomainReceipts, onError: (_id, error) => { f.errors.push(error); } });
  try {
    await collaboration.recover(); expect(reconcileDomainReceipts).toHaveBeenCalledOnce();
    exit(); ready(); await tick(); expect(reconcileDomainReceipts).toHaveBeenCalledOnce();
    expect(reconcileDomainReceipts.mock.calls[0]![0].aborted).toBe(true);
    release(); await vi.waitFor(() => expect(reconcileDomainReceipts).toHaveBeenCalledTimes(2));
    expect(reconcileDomainReceipts.mock.calls[1]![0].aborted).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { release(); collaboration.stop(); }
});


it('subtree cancellation carries the original parent scope and never loads child or operation bodies', async () => {
  const f = fixture();
  const status = { id: 'dispatch-operation', run_id: f.run.id, epoch: 1, revision: 2, phase: 'running' as const,
    outcome: null, effect: 'dispatched' as const, cancel_requested: false, lifetime: 'thread' as const, handed_off: true,
    executor: 'dispatch', waiting_on: null, call_completion: null, execution_owner: { kind: 'kernel' as const } };
  const runtime = Object.assign(f.runtime, {
    child: vi.fn(async () => { throw new Error('Unavailable child instruction body'); }),
    operation: vi.fn(async () => { throw new Error('Unavailable result body'); }),
    operationStatus: vi.fn(async () => status),
    cancelTree: vi.fn(async (target: import('./protocol.generated.js').TreeCancelTarget) => ({ target, cursor: 8, run_count: 2, child_count: 3, process_count: 1 })),
  });
  expect(await f.adapter.cancelChild(identity, 'dispatch-operation')).toMatchObject({ target: { kind: 'child', operation_id: 'dispatch-operation' }, process_count: 1 });
  expect(runtime.cancelTree).toHaveBeenLastCalledWith({ kind: 'child', operation_id: 'dispatch-operation' }, undefined, identity.threadId);
  await f.adapter.cancelTree(identity);
  expect(runtime.cancelTree).toHaveBeenLastCalledWith({ kind: 'thread', thread_id: identity.threadId });
  expect(await f.adapter.cancelOperation('dispatch-operation')).toBe(status);
  expect(runtime.cancelTree).toHaveBeenLastCalledWith({ kind: 'child', operation_id: 'dispatch-operation' });
  expect(runtime.child).not.toHaveBeenCalled(); expect(runtime.operation).not.toHaveBeenCalled();
});
