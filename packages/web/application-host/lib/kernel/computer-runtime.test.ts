import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVarinToolJson } from '@varin/extension-contract';
import { COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { createComputerService } from '../computer/computer-service.js';
import type { ComputerDriverSession, DriverResponse } from '../computer/driver-host.js';
import { parseComputerAutomationInvalidation, type ComputerWorkRef, type ComputerAutomationInvalidation } from '@varin/protocol';
import { createComputerRuntime } from './computer-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { KernelRecordResult, ToolOrigin, ComputerRequestRecord, ComputerEventCommand, ComputerEventCancellation } from './protocol.generated.js';

const work = (threadId = 'root'): ComputerWorkRef => ({ runtime: 'agent', threadId, branchId: `${threadId}-branch` });
const owner = { extensionId: 'varin.builtin.computer', extensionVersion: '1.0.0', entrypointId: 'host', generation: 1 };
const response = (extra: Partial<DriverResponse> = {}): DriverResponse => ({ id: 'controlled', ok: true, ...extra });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(records = new Map<string, KernelRecordResult>()) {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-computer-domain-'));
  let enabled = true, releases = 0, failClear = false, blockInput = false, idle = false, deliveries = 0, terminal = false, releaseSucceeds = true, failList = false;
  const failedRuns = new Set<string>();
  const requestFacts: ComputerRequestRecord[] = [], invalidations: ComputerAutomationInvalidation[] = [];
  let requestBodyFailure = false, requestBodyReads = 0;
  let transferFailure = false, ackLoss = false, cancelFailure = false;
  const controlFacts = new Map<string, ComputerEventCommand>(), controlCancels: ComputerEventCancellation[] = [];
  const toolReleased = new Set<() => void>(), ready = new Set<() => void>(), events = new Set<(event: { stream: 'durable'; cursor: number }) => void>();
  const observe = <T>(set: Set<T>, listener: T) => { set.add(listener); return () => { set.delete(listener); }; };
  const input = deferred<DriverResponse>(), started = deferred<void>();
  const calls: string[] = [];
  const driver: ComputerDriverSession = { capabilities: null, alive: () => true, cancel: () => true, dispose: () => {},
    interrupt: async () => { releases++; input.reject(new Error('original input interrupted without a final action response')); return { released: releaseSucceeds }; },
    async request(op, dispatch) {
      dispatch?.beforeDispatch?.(); calls.push(String(op.tool));
      if (op.tool === 'capabilities') return response({ capabilities: { platform: 'windows', driver: 'controlled', status: 'ready' } });
      if (op.tool === 'get_app_state') return response({ snapshot: { app: { name: 'editor', pid: 3, windowTitle: 'Controlled' },
        windowBounds: { x: 0, y: 0, width: 100, height: 100 }, treeLines: ['0 Edit'], elements: [{ index: 0, name: 'Edit', controlType: 'Edit' }] } });
      if (op.tool === 'type_text' && blockInput) { started.resolve(); return input.promise; }
      return response({ receipt: { effect: 'dispatched' } });
    } };
  void input.promise.catch(() => undefined);
  const storage = {
    async getRecord(_workspace: string, id: string) { return records.get(id) ?? null; },
    async listRecords({ recordType }: { recordType: string }) {
      if (failList && recordType === 'computer.desktop') { failList = false; throw new Error('controlled desktop Storage read failure'); }
      return { records: [...records.values()].filter(value => value.recordType === recordType), nextCursor: null };
    },
    async putRecord(params: Record<string, unknown>) {
      const id = params.recordId as string, previous = records.get(id);
      if (params.expectedRecordRevision !== undefined && previous?.recordRevision !== params.expectedRecordRevision) throw new Error('revision conflict');
      if (failClear && typeof params.payloadJson === 'string' && JSON.parse(params.payloadJson).physicalControl === null && previous && JSON.parse(previous.payloadJson).physicalControl) { failClear = false; throw new Error('controlled storage clear failure'); }
      const stored = { ...params, createdAt: previous?.createdAt ?? 1, updatedAt: 1, recordRevision: (previous?.recordRevision ?? 0) + 1 } as unknown as KernelRecordResult;
      records.set(id, stored); return stored;
    },
  };
  const kernel = { onToolReleased: (listener: () => void) => observe(toolReleased, listener), issueGrant: async () => ({ grantId: 'controlled' }), scoped: () => storage,
    async agentRuntimeRequest(method: string, params: { threadId: string; branchId: string; runId?: string }) {
      if (method === 'runtime.computer.request.list') { requestBodyReads++; if (requestBodyFailure) throw new Error('controlled request body failure'); return requestFacts.map(request => ({ request: structuredClone(request), reason: 'Original request reason', detail: null })); }
      if (method === 'runtime.computer.request.reconcile') return structuredClone(requestFacts);
      if (method === 'runtime.computer.request.cancel') return null;
      if (method === 'runtime.computer.event.cancel') {
        if (cancelFailure) throw new Error('controlled short cancellation unavailable');
        controlCancels.push(structuredClone(params as unknown as ComputerEventCancellation));
        return null;
      }
      if (method === 'runtime.computer.event.accept') {
        if (transferFailure) throw new Error('controlled fact body unavailable');
        const command = params as unknown as ComputerEventCommand;
        const id = `${command.fact.kind}:${command.fact.id}`;
        if (controlFacts.has(id)) assert.deepEqual(command, controlFacts.get(id));
        else controlFacts.set(id, structuredClone(command));
        deliveries++;
        if (ackLoss) throw new Error('controlled acceptance ACK lost');
        return { eventId: id, inputIds: [`${id}:actor`], cursor: controlFacts.size };
      }
      if (method === 'runtime.run.inspect') return runRecord(params.runId!);
      assert.equal(method, 'runtime.computer.scope');
      assert.equal(params.branchId, `${params.threadId}-branch`);
      assert.ok(params.runId === undefined || params.runId === `${params.threadId}-run`);
      return { threadId: params.threadId, branchId: params.branchId, rootThreadId: params.threadId === 'other' ? 'other' : 'root', rootBranchId: params.threadId === 'other' ? 'other-branch' : 'root-branch',
        currentRunId: idle ? null : `${params.threadId}-run`, currentRootRunId: idle ? null : params.threadId === 'other' ? 'other-run' : 'root-run', canExecute: !idle };
    } };
  const runRecord = (id: string) => {
    if (failedRuns.has(id)) throw new Error('controlled original Run read failure');
    return { id, thread_id: id.replace(/-run$/u, ''), branch_id: `${id.replace(/-run$/u, '')}-branch`, state: terminal ? 'completed' : 'executing' };
  };
  const runtime = { onReady: (listener: () => void) => observe(ready, listener), onEvent: (listener: (event: { stream: 'durable'; cursor: number }) => void) => observe(events, listener),
    run: async (id: string) => { const run = runRecord(id); if (terminal) for (const listener of toolReleased) listener(); return run; } };

  const computers = createComputerService({ client: kernel as never, hostId: 'host', platform: 'windows', dataDir, createDriver: () => driver,
    onControlEvent: async event => { await computer.acceptControlEvent(event); },
    onControlEventCancel: command => computer.cancelControlEvents(command),
    onAutomationInvalidated: event => { invalidations.push(parseComputerAutomationInvalidation(event)); },
    resolveActor: async ref => ref.runtime === 'agent' ? (await computer.resolve(ref)).actor : {
      execution: { work: ref, runId: 'pi-run' }, rootWork: ref, rootExecution: { work: ref, runId: 'pi-run' }, registry: { scopeId: 'scope', threadId: 'pi' }, label: 'Pi', roleAccess: { kind: 'pi-role', readOnly: false } },
    resolveScope: async ref => ref.runtime === 'agent' ? (await computer.resolve(ref)).scope : null,
  });
  const computer = createComputerRuntime({ kernel: kernel as never, runtime: runtime as never, computers, enabled: async () => enabled });
  async function invoke(method: string, args: Record<string, unknown>, threadId = 'root', policy = false, signal = new AbortController().signal) {
    const declaration = COMPUTER_TOOL_DECLARATIONS.find(value => value.id === `varin.computer.${method}`)!;
    const runId = `${threadId}-run`;
    const config = await computer.prepareConfiguration({ runId, threadId }, []);
    const origin: ToolOrigin = policy ? { kind: 'policy_action', action_id: `policy-${method}`, node_id: 'input' } : { kind: 'model_step', request_id: `model-${method}` };
    let receipt!: ToolExecutionReceipt;
    const content = await withToolInvocation({ owner, signal, authority: { callId: 'input', executorOwner: { kind: 'kernel' }, invocationId: 'controlled-invocation', runId, threadId,
      operationId: policy ? `policy-${method}:node:input` : `model-${method}:tool:input`, origin, source: null,
      toolName: declaration.tool!.name, operation: declaration.tool!.operation, arguments: args, configurationIdentity: config(declaration) },
      onEffectReceipt: result => { receipt = result; },
    }, async invocation => computer.capability(method, parseVarinToolJson(args), { owner, signal, invocation }));
    return { content, receipt };
  }
  return { computer, computers, calls, records, invoke, started, dataDir, releases: () => releases,
    controlFacts, controlCancels,
    failTransfer: (value = true) => { transferFailure = value; }, loseAck: (value = true) => { ackLoss = value; }, failCancel: (value = true) => { cancelFailure = value; },
    requestFacts, invalidations, failRequestBody: () => { requestBodyFailure = true; }, requestBodyReads: () => requestBodyReads,
    durable: () => { for (const listener of events) listener({ stream: 'durable', cursor: 1 }); },
    failRestore: () => { failList = true; },
    failRun: (id: string) => { failedRuns.add(id); }, failRelease: () => { releaseSucceeds = false; },
    terminal: () => { idle = true; terminal = true; for (const listener of events) listener({ stream: 'durable', cursor: 1 }); },
    channelReady: () => { for (const listener of ready) listener(); }, releaseTools: () => { for (const listener of toolReleased) listener(); },
    idle: () => { idle = true; }, deliveries: () => deliveries, disable: () => { enabled = false; }, block: () => { blockInput = true; }, failClear: () => { failClear = true; },
    cleanup: async () => { computer.stop(); input.resolve(response()); await computers.dispose(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('obsolete desktop stays visible and fenced without poisoning healthy work restoration or its Storage retry', async () => {
  const f = await fixture();
  try {
    await f.computers.ensureLocal();
    const original = f.records.get('computer.desktop:local-console')!;
    const payload = JSON.parse(original.payloadJson);
    for (const [id, runtime] of [
      ['obsolete', { runtimeVersion: 1, usage: { sessionId: 'legacy', at: '2026-10-11' } }],
      ['malformed', { runtimeVersion: 4, interrupted: { id: 'old', actor: { sessionId: 'legacy' } } }],
    ] as const) f.records.set(`computer.desktop:${id}`, { ...structuredClone(original), recordId: `computer.desktop:${id}`,
      payloadJson: JSON.stringify({ ...payload, id, label: id, ...runtime }) });
    const catalog = await f.computers.list();
    assert.equal(catalog.desktops.find(desktop => desktop.id === 'local-console')?.status, 'available');
    for (const id of ['obsolete', 'malformed']) {
      const desktop = catalog.desktops.find(desktop => desktop.id === id);
      assert.equal(desktop?.status, 'unavailable'); assert.ok(desktop?.statusDetail);
    }
    f.failRestore();
    await assert.rejects(f.computer.user.state(work() as never), /controlled desktop Storage read failure/u);
    assert.equal((await f.computer.user.state(work() as never)).state.status, 'enabled');
    await assert.rejects(f.computers.control('obsolete'), { computerCode: 'computer-runtime-format-unsupported' });
    await assert.rejects(f.computers.control('malformed'), { computerCode: 'computer-runtime-record-invalid' });
    const { receipt } = await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    assert.equal(receipt.completion.kind, 'result');
    if (receipt.completion.kind === 'result') assert.equal(receipt.completion.effect, 'dispatched');
  } finally { await f.cleanup(); }
});

test('both original tool origins dispatch through Computer owner without a file source and retain dispatched effect', async () => {
  for (const policy of [false, true]) {
    const f = await fixture();
    try {
      await f.invoke('observe', { desktopId: 'local-console', app: 'editor' }, 'root', policy);
      const { receipt } = await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } }, 'root', policy);
      assert.equal(receipt.executor_stopped, true); assert.equal(receipt.completion.kind, 'result');
      if (receipt.completion.kind === 'result') assert.equal(receipt.completion.effect, 'dispatched');
      assert.equal(f.calls.filter(call => call === 'press_key').length, 1);
      const state = await f.computer.user.state(work() as never);
      assert.equal(state.state.currentExecution?.runId, 'root-run'); assert.equal(state.state.leases.length, 2);
      await f.computer.user.stop(work() as never, { runId: 'root-run' });
      assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl, null);
    } finally { await f.cleanup(); }
  }
});

test('child assignment, missing desktop and disabled settings reject before input with none/stopped receipts', async () => {
  const f = await fixture();
  try {
    await f.invoke('list', {}, 'child');
    for (const [method, args, thread] of [
      ['apps', { desktopId: 'local-console' }, 'child'],
      ['act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } }, 'child'],
      ['act', { desktopId: 'missing', action: { kind: 'key', app: 'editor', key: 'enter' } }, 'root'],
    ] as const) {
      const { receipt } = await f.invoke(method, args, thread);
      assert.equal(receipt.executor_stopped, true); assert.equal(receipt.completion.kind, 'result');
      if (receipt.completion.kind === 'result') { assert.equal(receipt.completion.effect, 'none'); assert.equal(receipt.completion.outcome, 'failed'); }
    }
    f.disable(); const disabled = await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    assert.equal(disabled.receipt.executor_stopped, true);
    assert.equal(f.calls.filter(call => call === 'press_key').length, 0);
  } finally { await f.cleanup(); }
});

for (const cause of ['signal', 'overview', 'desktop', 'takeover'] as const) test(`${cause} cancellation retains original action Unknown but joins actual same-owner input drain`, async () => {
  const f = await fixture();
  try {
    await f.invoke('observe', { desktopId: 'local-console', app: 'editor' });
    f.block(); const cancel = new AbortController();
    const pending = f.invoke('act', { desktopId: 'local-console', action: { kind: 'type', app: 'editor', text: 'controlled' } }, 'root', true, cancel.signal);
    await f.started.promise;
    const stopping = cause === 'signal' ? (cancel.abort(), Promise.resolve()) : cause === 'overview'
      ? f.computer.user.stop(work() as never, { runId: 'root-run' }) : cause === 'takeover'
        ? f.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' })
        : f.computers.stopDesktop({ desktopId: 'local-console', automationEpoch: (await f.computers.control('local-console')).automationEpoch });
    await stopping;
    const { receipt } = await pending;
    assert.equal(receipt.executor_stopped, true);
    assert.equal(receipt.completion.kind, 'result');
    if (receipt.completion.kind === 'result') assert.equal(receipt.completion.effect, 'unknown');
    assert.equal(f.releases(), 1);
    assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl, null);
  } finally { await f.cleanup(); }
});

test('actual release proof survives a failed durable clear and retries without a new helper', async () => {
  const f = await fixture();
  try {
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    f.failClear();
    const first = await f.computer.user.stop(work() as never, { runId: 'root-run' });
    assert.equal(first.state.status, 'cancel-unconfirmed'); assert.ok(first.state.cleanups.some(cleanup => cleanup.desktopId === "local-console"));
    const second = await f.computer.user.stop(work() as never, { runId: 'root-run' });
    assert.equal(second.state.status, 'enabled'); assert.equal(second.state.cleanups.length, 0);
    assert.equal(f.releases(), 1);
  } finally { await f.cleanup(); }
});

test('target restart retains original peer assignment Unknown and rejects Pi, Agent and peer replacement control', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await f.computers.ensureLocal();
    const actor = (await f.computer.resolve(work())).actor!;
    const token = await f.computers.claimDesktop('peer-host:original', 'assignment', actor, 'local-console', 'control');
    await f.computers.automation.delegated(token, 'local-console', 'control', () => f.computers.act({ desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } }));
    // Copy exactly the durable state at the crash boundary; no in-memory receipt travels with it.
    restarted = await fixture(new Map([...f.records].map(([key, value]) => [key, structuredClone(value)])));
    await restarted.computers.probe('local-console');
    const fresh = restarted;
    await assert.rejects(fresh.computers.dropDesktopClaim('peer-host:original', 'assignment', actor, 'local-console', 'control'), /no release receipt|not confirmed|unknown/u);
    await assert.rejects(fresh.computers.automation.authorize({ runtime: 'pi', sessionId: 'same' }, 'control', 'local-console', async () => {}), /unconfirmed|unresolved/u);
    const rejected = await fresh.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    if (rejected.receipt.completion.kind === 'result') assert.equal(rejected.receipt.completion.effect, 'none');
    await assert.rejects(fresh.computers.claimDesktop('other-host:new', 'replacement', actor, 'local-console', 'control'), /unconfirmed|unresolved/u);
    const record = JSON.parse(fresh.records.get('computer.desktop:local-console')!.payloadJson);
    assert.equal(record.physicalControl.holder.origin, 'peer-host:original');
    assert.equal(fresh.calls.filter(call => call === 'press_key').length, 0);
  } finally { await restarted?.cleanup(); await f.cleanup(); }
});

test('human input marker remains unconfirmed after restart and a new helper cannot hand it back', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await f.computers.subscribeFrames('local-console', 'viewer', () => {}, { frames: false });
    await f.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    const control = await f.computers.control('local-console');
    await f.computers.input({ desktopId: 'local-console', holderId: 'viewer', controlEpoch: control.automationEpoch, input: { kind: 'down', x: 1, y: 1, button: 'left' } });
    restarted = await fixture(new Map([...f.records].map(([key, value]) => [key, structuredClone(value)])));
    await restarted.computers.probe('local-console');
    await assert.rejects(restarted.computers.handback({ desktopId: 'local-console', holderId: 'viewer' }), /not confirmed release/u);
    const actual = await restarted.computers.control('local-console');
    assert.equal(actual.owner, 'human'); assert.equal(actual.workStatus, 'cancel-unconfirmed');
    assert.equal(actual.operator, undefined);
    assert.equal(JSON.parse(restarted.records.get('computer.desktop:local-console')!.payloadJson).physicalControl.holder.kind, 'human');
  } finally { unsubscribe?.(); await restarted?.cleanup(); await f.cleanup(); }
});

test('the original null desktop configuration survives required binding preparation', async () => {
  const f = await fixture();
  try {
    const original = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root' }, []);
    const declaration = COMPUTER_TOOL_DECLARATIONS[0]!;
    const identity = original(declaration);
    assert.equal(JSON.parse(identity!).defaultDesktopId, null);
    await f.computers.ensureLocal(); await f.computers.setDefaultDesktop('local-console'); await f.computers.prewarm('local-console');
    const rebound = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root' }, [{ configurationIdentity: identity } as never]);
    assert.equal(rebound(declaration, identity), identity);
    assert.throws(() => rebound(declaration, null), /original Computer tool configuration/u);
  } finally { await f.cleanup(); }
});

test('a malformed Computer default is frozen only for its selected services while exact original bindings remain usable', async () => {
  const f = await fixture();
  try {
    const declaration = COMPUTER_TOOL_DECLARATIONS[0]!;
    const original = (await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root' }, []))(declaration);
    await writeFile(join(f.dataDir, 'computer-target.json'), '{broken', 'utf8');
    const captured = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root' }, []);
    assert.equal(captured({ ...declaration, id: 'example.independent.read' }), null);
    assert.throws(() => captured(declaration), SyntaxError);
    const rebound = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root' }, [{ configurationIdentity: original } as never]);
    assert.equal(rebound(declaration, original), original);
    await f.computers.setDefaultDesktop(null);
    assert.throws(() => captured(declaration), SyntaxError);
  } finally { await f.cleanup(); }
});

test('idle Native work projects exact accepted cleanup and Stop never invents a current Run', async () => {
  const f = await fixture();
  try {
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    f.idle();
    const projection = await f.computer.user.state(work() as never);
    assert.equal(projection.state.currentExecution, null); assert.equal(projection.state.currentRootExecution, null);
    assert.ok(projection.state.cleanups.some(cleanup => cleanup.execution.runId === 'root-run'));
    const stopped = await f.computer.user.stop(work() as never, { runId: 'root-run' });
    assert.equal(stopped.state.currentExecution, null); assert.equal(stopped.state.cleanups.length, 0);
    await assert.rejects(f.computer.user.stop(work() as never, { runId: 'other-run' }), /no remaining Computer Use cleanup/u);
  } finally { await f.cleanup(); }
});

test('Native takeover and handback transfer the original typed fact through the runtime consumer', async () => {
  const f = await fixture();
  try {
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    await f.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    await f.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
    await f.computers.reconcileControlEvents();
    const body = JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson);
    assert.equal(body.controlEvents.length, 0);
    assert.ok(f.deliveries() >= 2); assert.equal((await f.computers.control('local-console')).owner, 'agent');
  } finally { await f.cleanup(); }
});

test('real terminal lifecycle drains accepted Computer work while channel/tool generation changes preserve live control', async () => {
  const f = await fixture();
  try {
    const errors: unknown[] = []; f.computer.start(error => errors.push(error));
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    f.releaseTools(); f.channelReady(); await f.computer.reconcileExecutions();
    assert.equal(f.computers.automation.controller('local-console')?.execution.runId, 'root-run');
    assert.equal(f.releases(), 0);
    f.terminal(); await f.computer.reconcileExecutions();
    assert.equal(f.releases(), 1);
    const state = (await f.computer.user.state(work() as never)).state;
    assert.equal(state.currentExecution, null); assert.equal(state.leases.length, 0); assert.equal(state.cleanups.length, 0);
    assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl, null);
    assert.deepEqual(errors, []);
  } finally { await f.cleanup(); }
});

test('unconfirmed terminal cleanup waits for another real notification instead of its own inspection callback', async () => {
  const f = await fixture();
  try {
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    f.failRelease(); f.terminal();
    const errors: unknown[] = []; f.computer.start(error => errors.push(error));
    await assert.rejects(f.computer.reconcileExecutions(), /remain unconfirmed/u);
    const attempts = f.releases(); assert.ok(attempts > 0);
    await Promise.resolve(); await Promise.resolve(); assert.equal(f.releases(), attempts);
    assert.ok(errors.length > 0);
    assert.ok(f.computers.automation.acceptedExecutions().some(execution => execution.runId === 'root-run'));
    assert.ok(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl);
  } finally { await f.cleanup(); }
});

test('one unreadable accepted Run does not block another terminal desktop cleanup', async () => {
  const f = await fixture();
  try {
    await f.computers.ensureLocal();
    const original = f.records.get('computer.desktop:local-console')!;
    f.records.set('computer.desktop:other-desktop', { ...original, recordId: 'computer.desktop:other-desktop', payloadJson: JSON.stringify({ ...JSON.parse(original.payloadJson), id: 'other-desktop' }) });
    await f.computers.automation.authorize(work(), 'control', 'local-console', async () => {});
    await f.computers.automation.authorize(work('other'), 'control', 'other-desktop', async () => {});
    f.failRun('root-run'); f.terminal();
    await assert.rejects(f.computer.reconcileExecutions(), /remain unconfirmed/u);
    assert.equal(f.computers.automation.controller('other-desktop'), null);
    assert.equal(f.computers.automation.controller('local-console')?.execution.runId, 'root-run');
  } finally { await f.cleanup(); }
});

test('release false receipt ends this release attempt without clearing the old physical owner', async () => {
  const f = await fixture();
  try {
    await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    f.failRelease();
    const { receipt, content } = await f.invoke('release', { desktopId: 'local-console' });
    assert.equal(receipt.executor_stopped, true);
    if (receipt.completion.kind === 'result') { assert.equal(receipt.completion.effect, 'unknown'); assert.equal(receipt.completion.outcome, 'indeterminate'); }
    assert.equal((content as { released: boolean }).released, false);
    assert.ok(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl);
  } finally { await f.cleanup(); }
});


test('Native request durable changes and recovery invalidate the original root projection without hydrating request bodies', async () => {
  const f = await fixture();
  try {
    const request: ComputerRequestRecord = { id: 'request', operationId: 'request-tool', executionOwner: { kind: 'external', identity: 'original-computer-tool', epoch: 'tool-epoch' },
      requester: { threadId: 'child', branchId: 'child-branch', runId: 'child-run' }, rootThreadId: 'root', rootBranchId: 'root-branch', desktopId: 'local-console',
      access: 'control', revision: 1, status: 'pending', createdAtMs: 1, requestRef: null, detailRef: null, claim: null };
    f.requestFacts.push(request);
    f.computer.start();
    await f.computer.reconcileExecutions();
    assert.ok(f.invalidations.some(event => JSON.stringify(event.work) === JSON.stringify(work())));
    assert.equal(f.requestBodyReads(), 0, 'startup recovery publishes a short invalidation, never a body-dependent state');
    assert.equal((await f.computer.user.state(work() as never)).state.requests[0]?.status, 'pending');
    request.claim = { actor: { kind: 'user', threadId: 'root', branchId: 'root-branch', key: 'original-grant' }, manager: null, hostEpoch: f.computers.controlOwnerEpoch, assignmentId: 'original-assignment', approved: true, reasonRef: null };
    for (const status of ['granting', 'cancelled'] as const) {
      f.invalidations.length = 0; request.status = status; request.revision++;
      const reads = f.requestBodyReads();
      f.durable(); await f.computer.reconcileExecutions();
      assert.ok(f.invalidations.some(event => JSON.stringify(event.work) === JSON.stringify(work())));
      assert.equal(f.requestBodyReads(), reads);
    }
    f.requestFacts.push({ ...request, id: 'denied-request', operationId: 'second-request-tool', status: 'denied', revision: 2, claim: { ...request.claim, actor: { kind: 'user', threadId: 'root', branchId: 'root-branch', key: 'original-denial' }, approved: false } });
    f.failRequestBody(); f.invalidations.length = 0;
    f.durable(); await f.computer.reconcileExecutions();
    assert.ok(f.invalidations.length > 0, 'a bad body cannot hide its root invalidation');
    await assert.rejects(f.computer.user.state(work() as never), /controlled request body failure/);
  } finally { await f.cleanup(); }
});


test('original desktop outbox replays the same typed fact after a lost durable ACK and Host reopen', async () => {
  const records = new Map<string, KernelRecordResult>();
  const first = await fixture(records);
  let event: ComputerEventCommand | undefined;
  try {
    first.loseAck();
    await first.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    await first.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    await first.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
    await assert.rejects(first.computers.reconcileControlEvents(), /ACK lost/u);
    event = [...first.controlFacts.values()][0];
    assert.ok(event);
    const body = JSON.parse(records.get('computer.desktop:local-console')!.payloadJson);
    assert.ok(body.controlEvents.length >= 2);
    assert.equal(body.controlEvents.find((entry: { kind: string }) => entry.kind === 'handback').releaseConfirmed, true);
  } finally { await first.cleanup(); }
  const second = await fixture(records);
  try {
    await second.computers.reconcileControlEvents();
    assert.deepEqual(second.controlFacts.get(`${event!.fact.kind}:${event!.fact.id}`), event);
    assert.equal(JSON.parse(records.get('computer.desktop:local-console')!.payloadJson).controlEvents.length, 0);
    assert.ok([...second.controlFacts.values()].some(entry => entry.fact.kind === 'handback'));
  } finally { await second.cleanup(); }
});

test('physical Stop and its durable exact handback cancellation survive unavailable fact bodies and restart', async () => {
  const records = new Map<string, KernelRecordResult>();
  const first = await fixture(records);
  let handbackId = '';
  try {
    first.failTransfer();
    await first.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    await first.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    await first.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
    await assert.rejects(first.computers.reconcileControlEvents(), /fact body/u);
    let body = JSON.parse(records.get('computer.desktop:local-console')!.payloadJson);
    handbackId = body.controlEvents.find((entry: { kind: string }) => entry.kind === 'handback').id;
    first.failCancel();
    const stopped = await first.computer.user.stop(work() as never, { runId: 'root-run', desktopId: 'local-console' });
    assert.equal(stopped.state.status, 'cancel-unconfirmed');
    assert.ok(first.releases() > 0);
    body = JSON.parse(records.get('computer.desktop:local-console')!.payloadJson);
    assert.equal(body.physicalControl, null, 'failed metadata does not undo confirmed physical cleanup');
    assert.ok(body.controlCancellations.some((entry: { pendingEventIds: string[] }) => entry.pendingEventIds.includes(handbackId)));
    first.failTransfer(false);
    await assert.rejects(first.computers.reconcileControlEvents(), /short cancellation/u);
    assert.equal(first.controlFacts.size, 0, 'body recovery cannot overtake the pending exact Stop');
  } finally { await first.cleanup(); }
  const second = await fixture(records);
  try {
    await second.computers.reconcileControlEvents();
    assert.ok(second.controlCancels.some(command => command.pendingEventIds.includes(handbackId)));
    const body = JSON.parse(records.get('computer.desktop:local-console')!.payloadJson);
    assert.deepEqual(body.controlCancellations, []); assert.deepEqual(body.controlEvents, []);
    assert.ok([...second.controlFacts.values()].some(entry => entry.fact.kind === 'cancel'));
  } finally { await second.cleanup(); }
});

test('natural Native completion retains only handoff provenance for later handback and exact idle Stop', async () => {
  for (const stopBeforeReturn of [false, true]) {
    const f = await fixture();
    try {
      await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
      await f.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
      f.terminal(); await f.computer.reconcileExecutions();
      assert.equal(f.computers.automation.controller('local-console'), null);
      const original = JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).interrupted;
      assert.equal(original.actor.execution.runId, 'root-run');
      const denied = await f.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
      assert.equal(denied.receipt.completion.kind, 'result');
      if (denied.receipt.completion.kind === 'result') assert.equal(denied.receipt.completion.effect, 'none');
      assert.equal(f.computers.automation.controller('local-console'), null);
      if (!stopBeforeReturn) {
        await f.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
        await f.computers.reconcileControlEvents();
        assert.equal(f.controlFacts.get(`handback:${original.id}`)?.fact.execution.runId, 'root-run');
        assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).interrupted.returned, true);
        assert.equal((await f.computers.control('local-console')).operator, undefined);
      }
      const control = await f.computers.control('local-console');
      if (!stopBeforeReturn) {
        f.failCancel();
        const pending = await f.computers.stopDesktop({ desktopId: 'local-console', automationEpoch: control.automationEpoch });
        assert.equal(pending.released, true);
        assert.equal(pending.control.workStatus, 'cancel-unconfirmed');
        assert.equal(pending.control.operator?.execution.runId, 'root-run');
        f.failCancel(false);
      }
      const latest = await f.computers.control('local-console');
      const stopped = await f.computers.stopDesktop({ desktopId: 'local-console', automationEpoch: latest.automationEpoch });
      assert.equal(stopped.released, true);
      await f.computers.reconcileControlEvents();
      assert.ok([...f.controlFacts.values()].filter(command => command.fact.kind === 'cancel').every(command => command.fact.releaseConfirmed));
      assert.ok(f.controlCancels.some(command => command.execution.runId === 'root-run' && command.pendingEventIds.includes(original.id)));
      assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).interrupted, null);
      if (stopBeforeReturn) assert.equal(f.controlFacts.has(`handback:${original.id}`), false);
    } finally { await f.cleanup(); }
  }
});

test('reopened idle Thread Stop captures returned handoff after ACK without touching unrelated desktops', async () => {
  const records = new Map<string, KernelRecordResult>();
  const first = await fixture(records);
  let id = '';
  try {
    await first.invoke('act', { desktopId: 'local-console', action: { kind: 'key', app: 'editor', key: 'enter' } });
    await first.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    first.terminal(); await first.computer.reconcileExecutions();
    await first.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
    await first.computers.reconcileControlEvents();
    const record = records.get('computer.desktop:local-console')!;
    id = JSON.parse(record.payloadJson).interrupted.id;
    records.set('computer.desktop:unrelated', { ...record, recordId: 'computer.desktop:unrelated', payloadJson: JSON.stringify({ ...JSON.parse(record.payloadJson), id: 'unrelated', runtimeVersion: 1 }) });
  } finally { await first.cleanup(); }
  const second = await fixture(records);
  second.terminal();
  try {
    const unrelated = records.get('computer.desktop:unrelated');
    const stopped = await second.computer.user.stop(work() as never, { runId: 'root-run' });
    assert.equal(stopped.state.currentExecution, null);
    assert.ok(second.controlCancels.some(command => command.pendingEventIds.includes(id)));
    assert.equal(records.get('computer.desktop:unrelated'), unrelated);
  } finally { await second.cleanup(); }
});
