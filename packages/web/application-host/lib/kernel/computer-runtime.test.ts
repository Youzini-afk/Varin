import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import { parseVarinToolJson } from '@varin/extension-contract';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS, VARIN_BUILTIN_COMPUTER_EXTENSION_ID } from '@varin/extension-builtins';
import { createComputerService, type ComputerServiceOptions } from '../computer/computer-service.js';
import { registerBotRoutes } from '../bots/bot-routes.js';
import type { BotService } from '../bots/bot-service.js';
import { registerComputerServices } from '../harness/computer-services.js';
import type { HarnessServiceContext } from '../harness/router.js';
import type { HarnessServiceHost } from '../harness/service-host.js';
import { registerComputerRoutes } from '../computer/computer-routes.js';
import type { ComputerDriverSession, DriverResponse, DriverRequest } from '../computer/driver-host.js';
import { parseComputerAutomationInvalidation, type ComputerWorkRef, type ComputerAutomationInvalidation } from '@varin/protocol';
import { createComputerRuntime } from './computer-runtime.js';
import { withScriptCell, withToolInvocation } from './tool-invocation.js';
import { retainExtensionTool, type ExtensionToolLease } from './extension-tool-owner.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { toolOperationId, type HostToolCall } from './protocol.generated.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { KernelRecordResult, ToolOrigin, ComputerRequestRecord, ComputerEventCommand, ComputerEventCancellation } from './protocol.generated.js';

const work = (threadId = 'root'): ComputerWorkRef => ({ runtime: 'agent', threadId, branchId: `${threadId}-branch` });
const owner = { extensionId: 'varin.builtin.computer', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'computer-runtime-fixture', generation: 1 };
const response = (extra: Partial<DriverResponse> = {}): DriverResponse => ({ id: 'controlled', ok: true, ...extra });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(records = new Map<string, KernelRecordResult>(), remote: Partial<Pick<ComputerServiceOptions, 'hostId' | 'remoteHosts' | 'fetch' | 'platform' | 'vmExec' | 'resolveWork'>> = {}) {
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
  const requests: Array<Omit<DriverRequest, 'id'>> = [];
  let applicationReply: ((op: Omit<DriverRequest, 'id'>) => Promise<DriverResponse>) | undefined;
  const driver: ComputerDriverSession = { capabilities: null, alive: () => true, cancel: () => true, dispose: () => {},
    interrupt: async () => { releases++; input.reject(new Error('original input interrupted without a final action response')); return { released: releaseSucceeds }; },
    async request(op, dispatch) {
      dispatch?.beforeDispatch?.(); calls.push(String(op.tool)); requests.push(structuredClone(op));
      if (op.tool === 'capabilities') return response({ capabilities: { platform: 'windows', driver: 'controlled', status: 'ready' } });
      if (op.tool === 'get_app_state') return response({ snapshot: { app: { name: 'editor', pid: 3, windowTitle: 'Controlled' },
        windowBounds: { x: 0, y: 0, width: 100, height: 100 }, treeLines: ['0 Edit'], elements: [{ index: 0, name: 'Edit', controlType: 'Edit' }] } });
      if (op.tool === 'type_text' && blockInput) { started.resolve(); return input.promise; }
      if (['open', 'browser', 'office'].includes(String(op.tool)) && applicationReply) return applicationReply(op);
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
      if (params.expectedRecordRevision !== undefined && previous?.recordRevision !== params.expectedRecordRevision) throw new KernelClientError({ code: 'record-revision-conflict', message: 'record revision conflict' });
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

  const computers = createComputerService({ client: kernel as never, hostId: 'host', platform: 'windows', dataDir, createDriver: () => driver, ...remote,
    onControlEvent: async event => { await computer.acceptControlEvent(event); },
    onControlEventCancel: command => computer.cancelControlEvents(command),
    onAutomationInvalidated: event => { invalidations.push(parseComputerAutomationInvalidation(event)); },
    resolveActor: async ref => ref.runtime === 'agent' ? (await computer.resolve(ref)).actor : {
      execution: { work: ref, runId: 'pi-run' }, rootWork: ref, rootExecution: { work: ref, runId: 'pi-run' }, registry: { scopeId: 'scope', threadId: 'pi' }, label: 'Pi', roleAccess: { kind: 'pi-role', readOnly: false } },
    resolveScope: async ref => ref.runtime === 'agent' ? (await computer.resolve(ref)).scope : null,
    resolveWork: remote.resolveWork ?? (async ref => ref.runtime === 'agent' ? ref.branchId === `${ref.threadId}-branch` ? { scopeId: 'bot:bot', threadId: ref.threadId } : null
      : { scopeId: 'scope', threadId: 'pi' }),
  });
  const computer = createComputerRuntime({ kernel: kernel as never, runtime: runtime as never, computers, enabled: async () => enabled });
  async function invoke(method: string, args: Record<string, unknown>, threadId = 'root', policy = false, signal = new AbortController().signal, parentOperationId?: string) {
    const declaration = COMPUTER_TOOL_DECLARATIONS.find(value => value.id === `varin.computer.${method}`)!;
    const runId = `${threadId}-run`;
    const config = await computer.prepareConfiguration({ runId, threadId, source: null }, []);
    const origin: ToolOrigin = parentOperationId ? { kind: 'nested_call', parent_operation_id: parentOperationId }
      : policy ? { kind: 'policy_action', action_id: `policy-${method}`, node_id: 'input' } : { kind: 'model_step', request_id: `model-${method}` };
    let receipt!: ToolExecutionReceipt;
    const content = await withToolInvocation({ owner, signal, authority: { callId: 'input', executorOwner: { kind: 'kernel' }, invocationId: 'controlled-invocation', runId, threadId,
      operationId: toolOperationId(origin, 'input'), origin, source: null,
      completion: declaration.tool!.completion, toolName: declaration.tool!.name, operation: declaration.tool!.operation, arguments: args, configurationIdentity: config(declaration) },
      onEffectReceipt: result => { receipt = result; },
    }, async invocation => computer.capability(method, parseVarinToolJson(args), { owner, signal, invocation }));
    return { content, receipt };
  }
  return { computer, computers, kernel, calls, requests, records, invoke, started, dataDir, releases: () => releases,
    applicationReply: (reply: NonNullable<typeof applicationReply>) => { applicationReply = reply; },
    blockApplication: () => { applicationReply = async () => { started.resolve(); return input.promise; }; },
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
    const original = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, []);
    const declaration = COMPUTER_TOOL_DECLARATIONS[0]!;
    const identity = original(declaration);
    assert.equal(JSON.parse(identity!).defaultDesktopId, null);
    await f.computers.ensureLocal(); await f.computers.setDefaultDesktop('local-console'); await f.computers.prewarm('local-console');
    const rebound = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, [{ configurationIdentity: identity } as never]);
    assert.equal(rebound(declaration, identity), identity);
    assert.throws(() => rebound(declaration, null), /original Computer tool configuration/u);
  } finally { await f.cleanup(); }
});

test('a malformed Computer default is frozen only for its selected services while exact original bindings remain usable', async () => {
  const f = await fixture();
  try {
    const declaration = COMPUTER_TOOL_DECLARATIONS[0]!;
    const original = (await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, []))(declaration);
    await writeFile(join(f.dataDir, 'computer-target.json'), '{broken', 'utf8');
    const captured = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, []);
    assert.equal(captured({ ...declaration, id: 'example.independent.read' }), null);
    assert.throws(() => captured(declaration), SyntaxError);
    const rebound = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, [{ configurationIdentity: original } as never]);
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

test('a later terminal execution drains while an earlier desktop release is still pending', { timeout: 5000 }, async t => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  const finish = f.computers.finishExecution.bind(f.computers);
  const accepted = f.computers.automation.acceptedExecutions.bind(f.computers.automation);
  let showOther = false;
  let first: Promise<void> | undefined;
  try {
    await f.computers.ensureLocal();
    const original = f.records.get('computer.desktop:local-console')!;
    f.records.set('computer.desktop:other-desktop', { ...original, recordId: 'computer.desktop:other-desktop', payloadJson: JSON.stringify({ ...JSON.parse(original.payloadJson), id: 'other-desktop' }) });
    await f.computers.automation.authorize(work(), 'control', 'local-console', async () => {});
    await f.computers.automation.authorize(work('other'), 'control', 'other-desktop', async () => {});
    f.computers.automation.acceptedExecutions = () => accepted().filter(value => showOther || value.runId === 'root-run');
    f.computers.finishExecution = async execution => {
      if (execution.runId === 'root-run') { entered.resolve(); await release.promise; }
      return finish(execution);
    };
    f.terminal();
    first = f.computer.reconcileExecutions();
    await entered.promise;
    showOther = true;
    const second = f.computer.reconcileExecutions();
    await new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (t.signal.aborted) reject(t.signal.reason);
        else if (f.computers.automation.controller('other-desktop') === null) resolve();
        else setImmediate(inspect);
      };
      inspect();
    });
    assert.equal(f.computers.automation.controller('local-console')?.execution.runId, 'root-run');
    release.resolve();
    await Promise.all([first, second]);
  } finally {
    release.resolve(); await first;
    f.computers.automation.acceptedExecutions = accepted;
    f.computers.finishExecution = finish;
    await f.cleanup();
  }
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

test('ordinary application tools preserve original driver input, actor evidence, epochs and typed screenshot bytes', async () => {
  const f = await fixture();
  try {
    f.applicationReply(async op => op.tool === 'browser' && (op.act as { kind?: string } | undefined)?.kind === 'screenshot'
      ? { ...response(), image: 'data:image/jpeg;base64,YWJj' } as DriverResponse : response({ receipt: { effect: 'dispatched' } }));
    const snapshot = await f.invoke('browser_read', { desktopId: 'local-console', op: 'snapshot', tabId: 'tab' });
    const epoch = (snapshot.content as { result: { automationEpoch: string } }).result.automationEpoch;
    assert.ok(epoch);
    const navigation = await f.invoke('browser', { desktopId: 'local-console', op: 'act', tabId: 'tab', automationEpoch: epoch, act: { kind: 'navigate', url: 'https://example.test/path?private=secret' } }, 'root', true);
    assert.equal(navigation.receipt.executor_stopped, true);
    if (navigation.receipt.completion.kind === 'result') assert.equal(navigation.receipt.completion.effect, 'dispatched');
    assert.deepEqual(f.requests.at(-1)?.act, { kind: 'navigate', url: 'https://example.test/path?private=secret' });
    const shot = await f.invoke('browser_read', { desktopId: 'local-console', op: 'act', tabId: 'tab', act: { kind: 'screenshot' } });
    assert.equal(shot.receipt.completion.kind, 'result');
    if (shot.receipt.completion.kind === 'result') {
      assert.equal(shot.receipt.completion.effect, 'none');
      assert.deepEqual(shot.receipt.completion.content?.parts, [{ kind: 'media', media: { media_type: 'image/jpeg', data_base64: 'YWJj' } }]);
      assert.equal(JSON.stringify(shot.receipt.completion.content?.data).includes('YWJj'), false);
    }
    await f.invoke('office_read', { desktopId: 'local-console', op: 'act', act: { kind: 'read', doc: 'unsaved', range: 'A1:B2' } });
    await f.invoke('office', { desktopId: 'local-console', op: 'act', act: { kind: 'write', doc: 'unsaved', range: 'A1', values: [['x']] } });
    await f.invoke('open', { desktopId: 'local-console', command: 'editor', args: ['target.txt'] });
    const journal = await f.invoke('evidence', { desktopId: 'local-console' });
    const entries = (journal.content as { entries: Array<{ execution: unknown; tool: string; lane: string }> }).entries;
    assert.ok(entries.some(entry => entry.tool === 'office' && entry.lane === 'observe'));
    assert.ok(entries.some(entry => entry.tool === 'browser' && entry.lane === 'action'));
    assert.ok(entries.every(entry => JSON.stringify(entry.execution) === JSON.stringify({ work: work(), runId: 'root-run' })));
    assert.equal(JSON.stringify(journal.content).includes('private=secret'), false);
  } finally { await f.cleanup(); }
});

test('read schemas reject nested browser evaluation and Office writes before the driver; child labels never upgrade an observer assignment', async () => {
  const f = await fixture();
  try {
    for (const [method, args] of [
      ['browser_read', { op: 'act', act: { kind: 'evaluate', expression: 'document.title' } }],
      ['office_read', { op: 'act', act: { kind: 'write', values: [['x']] } }],
      ['browser_read', { op: 'launch' }],
    ] as const) await assert.rejects(f.invoke(method, { desktopId: 'local-console', ...args }), /selected Computer capability/);
    assert.equal(f.calls.length, 0);
    await f.computers.automation.grantRequest({ work: work('child'), runId: 'child-run' }, work(), { work: work(), runId: 'root-run' }, 'local-console', 'observe', 'observer');
    f.computers.automation.confirmRequest('observer');
    await f.invoke('browser_read', { op: 'tabs' }, 'child');
    await f.invoke('office_read', { op: 'docs' }, 'child');
    for (const [method, args] of [
      ['browser', { op: 'act', act: { kind: 'evaluate', expression: 'document.title' } }],
      ['office', { op: 'act', act: { kind: 'save' } }],
      ['control', {}],
      ['open', { command: 'editor' }],
      ['put', { relativePath: 'x', contentBase64: 'eA==' }],
      ['install', { groups: ['docs'] }],
    ] as const) {
      const denied = await f.invoke(method, { ...args }, 'child');
      if (denied.receipt.completion.kind === 'result') { assert.equal(denied.receipt.completion.effect, 'none'); assert.equal(denied.receipt.completion.outcome, 'failed'); }
      assert.equal(denied.receipt.executor_stopped, true);
    }
    assert.equal(f.requests.filter(op => ['open', 'browser', 'office'].includes(String(op.tool))).length, 2);
  } finally { await f.cleanup(); }
});

for (const method of ['open', 'browser', 'office'] as const) test(`${method} cancellation preserves Unknown effect until exact original input drain`, async () => {
  const f = await fixture();
  try {
    f.blockApplication();
    const cancel = new AbortController();
    const args = method === 'open' ? { command: 'editor' } : { op: 'act', act: method === 'browser' ? { kind: 'type', text: 'x' } : { kind: 'insert', text: 'x' } };
    const pending = f.invoke(method, { desktopId: 'local-console', ...args }, 'root', false, cancel.signal);
    await f.started.promise;
    cancel.abort();
    const { receipt } = await pending;
    assert.equal(receipt.executor_stopped, true);
    if (receipt.completion.kind === 'result') { assert.equal(receipt.completion.effect, 'unknown'); assert.equal(receipt.completion.outcome, 'indeterminate'); }
    assert.equal(f.releases(), 1);
    assert.equal(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl, null);
  } finally { await f.cleanup(); }
});

test('lost application response never proves stopped input; unsupported managed operations remain actionable and undispatched', async () => {
  const f = await fixture();
  try {
    for (const [method, args] of [['put', { relativePath: 'x.txt', contentBase64: 'eA==' }], ['install', { groups: ['docs'] }]] as const) {
      const unavailable = await f.invoke(method, { desktopId: 'local-console', ...args });
      assert.match(JSON.stringify(unavailable.content), /managed Linux/);
      assert.equal(unavailable.receipt.executor_stopped, true);
      if (unavailable.receipt.completion.kind === 'result') assert.equal(unavailable.receipt.completion.effect, 'none');
    }
    f.applicationReply(async () => { throw new Error('original browser response lost'); });
    const lost = await f.invoke('browser', { desktopId: 'local-console', op: 'act', act: { kind: 'evaluate', expression: '1' } });
    assert.equal(lost.receipt.executor_stopped, false);
    if (lost.receipt.completion.kind === 'result') assert.equal(lost.receipt.completion.effect, 'unknown');
    assert.ok(JSON.parse(f.records.get('computer.desktop:local-console')!.payloadJson).physicalControl);
    const environment = await f.invoke('environment', {});
    assert.equal((environment.content as { source: unknown }).source, null);
    assert.equal((environment.content as { placementChanges: { available: boolean } }).placementChanges.available, false);
    assert.equal(f.calls.filter(call => call === 'browser').length, 1);
  } finally { await f.cleanup(); }
});

test('application handback invalidates an old epoch and requires a fresh scene before input', async () => {
  const f = await fixture();
  try {
    const initial = await f.invoke('browser_read', { desktopId: 'local-console', op: 'snapshot' });
    const oldEpoch = (initial.content as { result: { automationEpoch: string } }).result.automationEpoch;
    await f.invoke('browser', { desktopId: 'local-console', op: 'act', act: { kind: 'type', text: 'before' } });
    await f.computers.automation.grantRequest({ work: work('child'), runId: 'child-run' }, work(), { work: work(), runId: 'root-run' }, 'local-console', 'observe', 'handback-observer');
    f.computers.automation.confirmRequest('handback-observer');
    await f.computers.takeover({ desktopId: 'local-console', holderId: 'viewer' });
    await f.computers.handback({ desktopId: 'local-console', holderId: 'viewer' });
    for (const [method, args] of [['observe', { app: 'editor' }], ['browser_read', { op: 'snapshot' }], ['office_read', { op: 'docs' }]] as const) {
      await f.invoke(method, { desktopId: 'local-console', ...args }, 'child');
      const unread = await f.invoke('browser', { desktopId: 'local-console', op: 'act', act: { kind: 'type', text: 'not yet observed by controller' } });
      if (unread.receipt.completion.kind === 'result') assert.equal(unread.receipt.completion.effect, 'none', method);
      assert.match(JSON.stringify(unread.content), /Observe.*after handback/);
    }
    const count = f.calls.filter(call => call === 'browser').length;
    const stale = await f.invoke('browser', { desktopId: 'local-console', automationEpoch: oldEpoch, op: 'act', act: { kind: 'type', text: 'stale' } });
    if (stale.receipt.completion.kind === 'result') assert.equal(stale.receipt.completion.effect, 'none');
    assert.equal(f.calls.filter(call => call === 'browser').length, count);
    const scene = await f.invoke('browser_read', { desktopId: 'local-console', op: 'snapshot' });
    const epoch = (scene.content as { result: { automationEpoch: string } }).result.automationEpoch;
    assert.notEqual(epoch, oldEpoch);
    await f.invoke('browser', { desktopId: 'local-console', automationEpoch: epoch, op: 'act', act: { kind: 'type', text: 'after' } });
    assert.equal(f.calls.filter(call => call === 'browser').length, count + 2);
  } finally { await f.cleanup(); }
});

/** Original authenticated Router, driven directly; never opens a listener or a network socket. */
function computerRouter(computers: ReturnType<typeof createComputerService>, bot = false) {
  const router = express.Router();
  registerComputerRoutes(router as unknown as Express, { computers, hostId: 'host', requireAuth: (request, response, next) => {
    if (request.get('authorization') !== 'Bearer controlled-peer') { response.status(401).json({ error: 'unauthorized' }); return; }
    next();
  } });
  if (bot) registerBotRoutes(router as unknown as Express, { computers, bots: {
    get: async () => ({ id: 'bot' }), listWork: async () => [{ runtime: 'agent', identity: work(), purpose: 'work' }],
  } as unknown as BotService, requireAuth: (request, response, next) => {
    if (request.get('authorization') !== 'Bearer controlled-peer') { response.status(401).json({ error: 'unauthorized' }); return; } next();
  } });
  return (operation: string, body: unknown, token?: string, authenticated = true, method = 'POST'): Promise<{ status: number; body: unknown; headers: Record<string, string> }> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false, headersSent: false,
      status(code: number) { this.statusCode = code; return this; }, setHeader(name: string, value: string) { headers[name] = value; return this; },
      json(value: unknown) { this.writableEnded = true; this.headersSent = true; resolve({ status: this.statusCode, body: value, headers }); response.emit('finish'); return this; } });
    const incoming = Object.assign(new EventEmitter(), { method, url: operation.startsWith('/api/') ? operation : `/api/computers/desktops/local-console/${operation}`, body,
      headers: { ...(authenticated ? { authorization: 'Bearer controlled-peer' } : {}), ...(token ? { 'x-varin-computer-lease': token } : {}) },
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; } });
    Object.defineProperty(incoming, 'path', { get: () => new URL(incoming.url, 'http://controlled.invalid').pathname });
    Object.defineProperty(incoming, 'query', { get: () => Object.fromEntries(new URL(incoming.url, 'http://controlled.invalid').searchParams) });
    (router as unknown as { handle(request: Request, response: ExpressResponse, next: (error?: unknown) => void): void })
      .handle(incoming as unknown as Request, response as unknown as ExpressResponse, error => reject(error ?? new Error('Unmatched Computer route')));
  });
}

test('authenticated peer Router uses the same observer assignment for nested reads and evidence while rejecting nested writes', async () => {
  const f = await fixture();
  try {
    await f.computers.ensureLocal();
    const actor = (await f.computer.resolve(work('child'))).actor!;
    const token = await f.computers.claimDesktop('peer-host:original', 'peer-observer', actor, 'local-console', 'observe');
    const call = computerRouter(f.computers);
    assert.equal((await call('browser', { op: 'tabs' }, token, false)).status, 401);
    assert.equal((await call('browser', { op: 'tabs' })).status, 409);
    assert.equal((await call('browser', { op: 'act', act: { kind: 'screenshot' } }, token)).status, 200);
    assert.equal((await call('office', { op: 'act', act: { kind: 'read' } }, token)).status, 200);
    const evidence = await call('evidence', {}, token);
    assert.equal(evidence.status, 200);
    assert.ok((evidence.body as { entries: unknown[] }).entries.length >= 2);
    for (const [operation, body] of [
      ['browser', { op: 'act', act: { kind: 'evaluate', expression: '1' } }],
      ['office', { op: 'act', act: { kind: 'save' } }], ['open', { command: 'editor' }],
    ] as const) assert.equal((await call(operation, body, token)).status, 409);
    assert.equal(f.calls.filter(tool => tool === 'browser' || tool === 'office').length, 2);
    await f.computers.dropDesktopClaim('peer-host:original', 'peer-observer', actor, 'local-console', 'observe');
    assert.equal((await call('browser', { op: 'tabs' }, token)).status, 409);
  } finally { await f.cleanup(); }
});

test('shipped Computer broker binds lifecycle and application declarations, keeps frozen defaults and enforces original permissions for nested calls', async () => {
  const f = await managedFixture();
  let extensions: ApplicationExtensionRuntime | undefined;
  const retained: ExtensionToolLease[] = [];
  let invocation: HostToolCall;
  let permission: 'allow' | 'deny' = 'allow';
  const executionOwner = { kind: 'external' as const, identity: 'original-broker-computer', epoch: 'original-tool-owner' };
  try {
    await f.computers.ensureLocal(); await f.computers.setDefaultDesktop('local-console');
    const captured = await f.computer.prepareConfiguration({ runId: 'root-run', threadId: 'root', source: null }, []);
    extensions = await ApplicationExtensionRuntime.create({ dataDir: join(f.dataDir, 'extensions'), varinVersion: '0.9.25',
      brokerScript: resolve('packages/extension-host/broker/broker-child.mjs') });
    extensions.capabilities.register(COMPUTER_CAPABILITY, f.computer.capability);
    await extensions.start();
    await extensions.activateExtension(VARIN_BUILTIN_COMPUTER_EXTENSION_ID);
    const kernel = { ...f.kernel, async agentRuntimeRequest(method: string, params: never) {
      if (method === 'runtime.operation.inspect') return { id: invocation.operationId, run_id: invocation.runId, phase: 'running', cancel_requested: false, execution_owner: executionOwner,
        intent: { origin: invocation.origin, call: { call_id: invocation.callId, name: invocation.name, schema_version: invocation.schemaVersion, arguments: invocation.arguments } } };
      if (method === 'runtime.launch.inspect') return { run_id: invocation.runId, selection: { source: null } };
      return f.kernel.agentRuntimeRequest(method, params);
    } } as unknown as KernelClient;
    for (const method of ['prepare', 'desktop_lifecycle', 'artifact', 'control', 'browser_read', 'browser', 'office_read', 'office', 'open', 'evidence', 'environment']) {
      const selected = await extensions.prepareService({ serviceId: `varin.computer.${method}`, version: 1, method: 'execute', args: [], routing: { sessionId: 'root' } });
      retained.push(await retainExtensionTool({ runtime: extensions, kernel, configurationIdentity: captured,
        currentPolicy: async () => ({ mode: 'normal', rules: [{ tool: `computer_${method}`, decision: permission }] }) }, selected));
    }
    const desktop = f.records.get('computer.desktop:local-console')!;
    f.records.set('computer.desktop:other-desktop', { ...desktop, recordId: 'computer.desktop:other-desktop', payloadJson: JSON.stringify({ ...JSON.parse(desktop.payloadJson), id: 'other-desktop' }) });
    await f.computers.setDefaultDesktop('other-desktop');
    let call = 0;
    const execute = async (method: string, args: Record<string, unknown>, nested = false) => {
      const selected = retained.find(entry => entry.binding.serviceId === `varin.computer.${method}`)!;
      const origin: ToolOrigin = nested ? { kind: 'nested_call', parent_operation_id: 'original-parent:tool:cell' } : { kind: 'model_step', request_id: 'broker-model' };
      const callId = `call-${++call}`;
      invocation = { runId: 'root-run', origin, operationId: toolOperationId(origin, callId), callId, name: selected.binding.tool.name, schemaVersion: selected.binding.tool.version, arguments: args };
      await selected.lease.authorize(invocation, new AbortController().signal);
      return selected.lease.execute(invocation, new AbortController().signal, executionOwner);
    };
    const prepared = await execute('prepare', {}, true);
    if (prepared.completion.kind === 'result') assert.equal(prepared.completion.effect, 'confirmed');
    const stopped = await execute('desktop_lifecycle', { desktopId: 'managed-linux', action: 'stop' }, true);
    if (stopped.completion.kind === 'result') assert.equal(stopped.completion.effect, 'confirmed');
    const artifact = await execute('artifact', { relativePath: 'not-managed.txt' }, true);
    if (artifact.completion.kind === 'result') assert.equal(artifact.completion.effect, 'none');
    const control = await execute('control', {}, true);
    if (control.completion.kind === 'result') assert.equal(control.completion.effect, 'confirmed');
    const read = await execute('browser_read', { op: 'snapshot' }, true);
    assert.equal(read.completion.kind, 'result');
    if (read.completion.kind === 'result') assert.equal(read.completion.effect, 'none');
    const opened = await execute('open', { command: 'editor' });
    if (opened.completion.kind === 'result') assert.equal(opened.completion.effect, 'dispatched');
    await execute('office_read', { op: 'docs' }, true);
    await execute('office', { op: 'act', act: { kind: 'save' } }, true);
    const count = f.calls.length;
    permission = 'deny';
    await assert.rejects(execute('browser', { op: 'act', act: { kind: 'evaluate', expression: '1' } }, true), /permission_changed/);
    assert.equal(f.calls.length, count);
    permission = 'allow';
    await assert.rejects(execute('browser_read', { op: 'act', act: { kind: 'evaluate', expression: '1' } }, true), /input_schema/);
    const environment = await execute('environment', {});
    if (environment.completion.kind === 'result') assert.equal((environment.completion.content?.data as { defaultDesktopId: string }).defaultDesktopId, 'local-console');
    assert.equal(f.calls.filter(tool => tool === 'open').length, 1);
  } finally {
    for (const entry of retained) entry.lease.release();
    await extensions?.stop(); await f.cleanup();
  }
});

for (const method of ['act', 'open', 'browser', 'office'] as const) test(`ancestor script cancellation reaches ${method} physical stop before any Catalog cancellation`, async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    const parentOperationId = 'script-model:tool:cell';
    await withToolInvocation({ owner, signal, authority: { invocationId: 'script-parent', runId: 'root-run', threadId: 'root', operationId: parentOperationId,
      callId: 'cell', executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'script-model' }, source: null,
      toolName: 'script_run', operation: 'effect', completion: 'result', arguments: {} } }, async invocation => {
      let cancelDispatch: ((reason: unknown) => void) | undefined;
      await withScriptCell({ owner, signal, invocation }, { environmentId: 'original-script', computerUsed() {}, usesComputer: () => true,
        computerCancellation(cancel) { cancelDispatch = cancel; return () => { cancelDispatch = undefined; }; } }, async () => {
        if (method === 'act') f.block(); else f.blockApplication();
        const args = method === 'act' ? { action: { kind: 'type', app: 'editor', text: 'x' } }
          : method === 'open' ? { command: 'editor' }
          : { op: 'act', act: method === 'browser' ? { kind: 'type', text: 'x' } : { kind: 'insert', text: 'x' } };
        const pending = f.invoke(method, { desktopId: 'local-console', ...args }, 'root', false, signal, parentOperationId);
        await f.started.promise;
        assert.ok(cancelDispatch);
        cancelDispatch(new Error('original script close'));
        const { receipt } = await pending;
        assert.equal(signal.aborted, false, 'the Catalog/tool cancellation has not happened');
        assert.equal(f.releases(), 1);
        assert.equal(receipt.executor_stopped, true);
        if (receipt.completion.kind === 'result') assert.equal(receipt.completion.effect, 'unknown');
      });
    });
  } finally { await f.cleanup(); }
});

test('explicit driver Unknown survives a normal cancellation response independently of stopped input', async () => {
  const f = await fixture();
  try {
    f.applicationReply(async () => ({ ...response(), ok: false, cancelled: true, outcome: 'unknown', error: 'Application bridge cancellation acknowledgement' } as DriverResponse));
    for (const method of ['browser', 'office'] as const) {
      const completed = await f.invoke(method, { desktopId: 'local-console', op: 'act', act: method === 'browser' ? { kind: 'type', text: 'x' } : { kind: 'insert', text: 'x' } });
      assert.equal(completed.receipt.executor_stopped, true);
      if (completed.receipt.completion.kind === 'result') { assert.equal(completed.receipt.completion.effect, 'unknown'); assert.equal(completed.receipt.completion.outcome, 'indeterminate'); }
      assert.equal((completed.content as { result: { outcome: string } }).result.outcome, 'unknown');
    }
  } finally { await f.cleanup(); }
});

test('invalid application screenshot encoding cannot erase original dispatched or Unknown effects', async () => {
  const f = await fixture();
  try {
    for (const effect of ['dispatched', 'unknown'] as const) {
      f.applicationReply(async () => ({ ...response({ receipt: { effect } }), image: 'not-an-image-data-url' } as DriverResponse));
      const completed = await f.invoke('browser', { desktopId: 'local-console', op: 'act', act: { kind: 'evaluate', expression: '1' } });
      assert.equal(completed.receipt.executor_stopped, true);
      if (completed.receipt.completion.kind === 'result') {
        assert.equal(completed.receipt.completion.effect, effect);
        assert.equal(completed.receipt.completion.outcome, effect === 'unknown' ? 'indeterminate' : 'failed');
        assert.deepEqual(completed.receipt.completion.content?.parts, []);
      }
      assert.match(JSON.stringify(completed.content), /invalid screenshot payload/);
    }
  } finally { await f.cleanup(); }
});

async function remoteFixture(target: Awaited<ReturnType<typeof fixture>>, intercept?: (url: URL, body: Record<string, unknown>, send: () => Promise<Response>) => Promise<Response>) {
  const call = computerRouter(target.computers);
  const directFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    // The control subscription carries no test events. All identity/admission/action calls
    // use the real target Router; no product HTTP listener or external socket is involved.
    if (url.pathname.endsWith('/stream')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* The fixture stream may already be cancelled. */ } }, { once: true }); } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-varin-computer-host': 'host' } });
    }
    const headers = new Headers(init?.headers);
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const send = async () => {
      const response = await call(url.pathname + url.search, body,
        headers.get('x-varin-computer-lease') ?? undefined, headers.get('authorization') === 'Bearer controlled-peer', init?.method ?? 'GET');
      return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
    };
    return intercept ? intercept(url, body, send) : send();
  };
  return fixture(undefined, { hostId: 'source', remoteHosts: async () => [{ id: 'peer', label: 'Original target', apiUrl: 'http://controlled.invalid', clientToken: 'controlled-peer' }], fetch: directFetch });
}

test('remote original-owner preflight proof crosses authenticated routes without turning rejection into Unknown input', async () => {
  const target = await fixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    source = await remoteFixture(target);
    await source.invoke('list', {});
    const desktopId = 'remote:peer:host:local-console';
    const before = target.calls.length;
    for (const [method, args] of [
      ['browser', { op: 'act', automationEpoch: 'old-epoch', act: { kind: 'evaluate', expression: '1' } }],
      ['office', { op: 'act', automationEpoch: 'old-epoch', act: { kind: 'save' } }],
      ['open', { automationEpoch: 'old-epoch', command: 'editor' }],
      ['put', { relativePath: 'x', contentBase64: 'eA==' }],
      ['install', { groups: ['docs'] }],
    ] as const) {
      const rejected = await source.invoke(method, { desktopId, ...args });
      assert.equal(rejected.receipt.executor_stopped, true, method);
      if (rejected.receipt.completion.kind === 'result') { assert.equal(rejected.receipt.completion.effect, 'none', method); assert.equal(rejected.receipt.completion.outcome, 'failed', method); }
    }
    assert.equal(target.calls.length, before);
    const fresh = await source.invoke('browser_read', { desktopId, op: 'snapshot' });
    const epoch = (fresh.content as { result: { automationEpoch: string } }).result.automationEpoch;
    const written = await source.invoke('browser', { desktopId, op: 'act', automationEpoch: epoch, act: { kind: 'type', text: 'fresh scene' } });
    assert.equal(written.receipt.executor_stopped, true);
    if (written.receipt.completion.kind === 'result') assert.equal(written.receipt.completion.effect, 'dispatched', JSON.stringify(written.content));
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('remote observer promotion requires a fresh scene; explicit control reserves the peer before reading', async () => {
  for (const explicitControl of [false, true]) {
    const target = await fixture();
    let source: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      source = await remoteFixture(target);
      await source.invoke('list', {});
      const desktopId = 'remote:peer:host:local-console';
      if (explicitControl) {
        const prepared = await source.invoke('control', { desktopId });
        if (prepared.receipt.completion.kind === 'result') assert.equal(prepared.receipt.completion.effect, 'confirmed');
        assert.ok(target.computers.automation.controller('local-console'));
        assert.equal(target.requests.filter(request => ['browser', 'office', 'open', 'type_text'].includes(String(request.tool))).length, 0, 'control reserves the original peer without application input');
      }
      const read = async () => {
        const observed = await source!.invoke('browser_read', { desktopId, op: 'snapshot' });
        return (observed.content as { result: { automationEpoch: string } }).result.automationEpoch;
      };
      const act = (automationEpoch: string) => source!.invoke('browser', { desktopId, automationEpoch, op: 'act', act: { kind: 'type', text: 'visible scene' } });
      const first = await act(await read());
      if (!explicitControl) {
        assert.equal(first.receipt.executor_stopped, true);
        if (first.receipt.completion.kind === 'result') assert.equal(first.receipt.completion.effect, 'none');
        assert.match(JSON.stringify(first.content), /fresh scene/);
        const recovered = await act(await read());
        if (recovered.receipt.completion.kind === 'result') assert.equal(recovered.receipt.completion.effect, 'dispatched');
      } else if (first.receipt.completion.kind === 'result') assert.equal(first.receipt.completion.effect, 'dispatched');
      assert.equal(target.requests.filter(request => request.tool === 'browser' && request.op === 'act').length, 1);
    } finally { await source?.cleanup(); await target.cleanup(); }
  }
});

test('remote revoked assignment rejects before the endpoint and keeps target no-input proof', async () => {
  const target = await fixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  let claim: Record<string, unknown> | undefined;
  try {
    source = await remoteFixture(target, async (url, body, send) => {
      if (url.pathname.endsWith('/assignment') && body.op === 'claim' && body.access === 'control') claim = body;
      return send();
    });
    await source.invoke('list', {});
    const desktopId = 'remote:peer:host:local-console';
    await source.invoke('control', { desktopId });
    assert.ok(claim);
    const dropped = await computerRouter(target.computers)('/api/computers/desktops/local-console/assignment', { ...claim, op: 'drop' });
    assert.equal(dropped.status, 200);
    const count = target.calls.length;
    const rejected = await source.invoke('browser', { desktopId, op: 'act', act: { kind: 'evaluate', expression: '1' } });
    assert.equal(rejected.receipt.executor_stopped, true);
    if (rejected.receipt.completion.kind === 'result') assert.equal(rejected.receipt.completion.effect, 'none');
    assert.equal(target.calls.length, count);
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('lost control reservation ACK with unconfirmed drop remains original assignment Unknown', async () => {
  const target = await fixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  let disconnect = true;
  try {
    source = await remoteFixture(target, async (url, body, send) => {
      if (!disconnect || !url.pathname.endsWith('/assignment')) return send();
      if (body.op === 'claim') await send();
      throw new Error('Original claim ACK or drop delivery lost');
    });
    await source.invoke('list', {});
    const uncertain = await source.invoke('control', { desktopId: 'remote:peer:host:local-console' });
    assert.equal(uncertain.receipt.executor_stopped, false);
    if (uncertain.receipt.completion.kind === 'result') { assert.equal(uncertain.receipt.completion.effect, 'unknown'); assert.equal(uncertain.receipt.completion.outcome, 'indeterminate'); }
    assert.ok(target.computers.automation.controller('local-console'));
    assert.equal(target.requests.filter(request => ['browser', 'office', 'open', 'type_text'].includes(String(request.tool))).length, 0);
    const state = await source.computers.automation.snapshot(work());
    assert.ok(state.cleanups.some(cleanup => cleanup.desktopId === 'remote:peer:host:local-console'));
  } finally { disconnect = false; await source?.cleanup(); await target.cleanup(); }
});

test('managed Linux helper rejection retains known exit while unavailable file helper proves no dispatch', async () => {
  const commands: string[] = [];
  const f = await fixture(undefined, { platform: 'linux', vmExec: async (_command, args) => {
    commands.push(args[0]!);
    assert.ok(args[0]?.endsWith('install-components.py'), 'only the injected installer response is requested');
    return { code: 2, stdout: JSON.stringify({ ok: false, error: 'unknown component groups: unknown-recipe' }), stderr: '' };
  } });
  try {
    await f.computers.ensureLocal();
    const record = f.records.get('computer.desktop:local-console')!;
    f.records.set('computer.desktop:managed-linux', { ...record, recordId: 'computer.desktop:managed-linux',
      payloadJson: JSON.stringify({ ...JSON.parse(record.payloadJson), id: 'managed-linux', managed: 'linux-xvnc' }) });
    const installed = await f.invoke('install', { desktopId: 'managed-linux', groups: ['unknown-recipe'] });
    assert.equal(installed.receipt.executor_stopped, true);
    if (installed.receipt.completion.kind === 'result') { assert.equal(installed.receipt.completion.effect, 'unknown'); assert.equal(installed.receipt.completion.outcome, 'indeterminate'); }
    assert.match(JSON.stringify(installed.content), /unknown component groups/);
    const written = await f.invoke('put', { desktopId: 'managed-linux', relativePath: 'x', contentBase64: 'eA==' });
    assert.equal(written.receipt.executor_stopped, true);
    if (written.receipt.completion.kind === 'result') assert.equal(written.receipt.completion.effect, 'none');
    assert.match(JSON.stringify(written.content), /file access is unavailable/);
    assert.equal(commands.length, 1);
  } finally { await f.cleanup(); }
});

/** Real lifecycle owner with its platform helper replaced; never starts a desktop or installer. */
async function managedFixture(options: Pick<ComputerServiceOptions, 'resolveWork'> = {}) {
  let state: 'unprepared' | 'running' | 'stopped' = 'unprepared';
  let changed: ((action: string) => Promise<{ code: number; stdout: string; stderr: string } | void>) | undefined;
  const changes: string[] = [];
  const payload = () => state === 'running' ? { state, socket: '/controlled/desktop.sock', driver: '/controlled/driver.py',
    user: 'controlled', uid: 1001, environment: {}, width: 1280, height: 800 } : { state };
  const f = await fixture(undefined, { ...options, platform: 'linux', vmExec: async (command, args) => {
    const action = command === 'sh' ? 'prepare' : args[1]!;
    assert.ok(['prepare', 'start', 'stop', 'status'].includes(action));
    if (action !== 'status') {
      changes.push(action);
      const result = await changed?.(action);
      if (result) return result;
      state = action === 'stop' ? 'stopped' : 'running';
      const data = args[args.indexOf('--data-dir') + 1]!;
      await mkdir(data, { recursive: true }); await writeFile(join(data, 'config.json'), '{}');
    }
    return { code: 0, stdout: JSON.stringify(payload()), stderr: '' };
  } });
  return { ...f, changes, changeReply: (fn: NonNullable<typeof changed>) => { changed = fn; } };
}
const assertEffect = (value: { receipt: ToolExecutionReceipt }, effect: string, stopped = true) => {
  assert.equal(value.receipt.executor_stopped, stopped);
  assert.equal(value.receipt.completion.kind, 'result');
  if (value.receipt.completion.kind === 'result') assert.equal(value.receipt.completion.effect, effect, JSON.stringify(value.receipt.completion.content));
};

test('desktop lifecycle tools prepare and transition the original managed owner with real child assignments and epochs', async () => {
  const f = await managedFixture();
  try {
    assertEffect(await f.invoke('prepare', {}, 'child'), 'none');
    assert.equal(f.changes.length, 0);
    assert.equal((await f.computers.preparationTarget()).status, 'unavailable');
    assertEffect(await f.invoke('prepare', { width: 1280, height: 800 }), 'confirmed');
    assert.deepEqual(f.changes, ['prepare']);
    const owned = await f.computers.workDesktops('bot:bot');
    assert.ok(owned.some(desktop => desktop.id === 'managed-linux' && desktop.work?.some(association => association.work.runtime === 'agent' && association.registry === null)));
    const control = await f.invoke('control', { desktopId: 'managed-linux' });
    const epoch = (control.content as { control: { automationEpoch: string } }).control.automationEpoch;
    assertEffect(await f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'stop', automationEpoch: 'obsolete' }), 'none');
    assert.deepEqual(f.changes, ['prepare']);
    const stopped = await f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'stop', automationEpoch: epoch });
    assertEffect(stopped, 'confirmed');
    assert.equal((stopped.content as { desktop: { status: string } }).desktop.status, 'stopped');
    assert.equal(f.computers.automation.controller('managed-linux'), null);
    assertEffect(await f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'start', automationEpoch: epoch }), 'none');
    assert.deepEqual(f.changes, ['prepare', 'stop']);
    await f.invoke('release', { desktopId: 'managed-linux' });
    await f.computers.automation.grantRequest({ work: work('child'), runId: 'child-run' }, work(), { work: work(), runId: 'root-run' }, 'managed-linux', 'control', 'child-lifecycle');
    f.computers.automation.confirmRequest('child-lifecycle');
    assertEffect(await f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'start' }, 'child', true), 'confirmed');
    assert.deepEqual(f.changes, ['prepare', 'stop', 'start']);
  } finally { await f.cleanup(); }
});

test('desktop lifecycle replacement drains original input and cancels queued old-generation actions', { timeout: 15_000 }, async () => {
  const f = await managedFixture();
  try {
    assertEffect(await f.invoke('prepare', {}), 'confirmed');
    await f.invoke('observe', { desktopId: 'managed-linux', app: 'editor' });
    f.block();
    const first = f.invoke('act', { desktopId: 'managed-linux', action: { kind: 'type', app: 'editor', text: 'first' } });
    await f.started.promise;
    const queued = f.invoke('act', { desktopId: 'managed-linux', action: { kind: 'key', app: 'editor', key: 'enter' } }, 'root', true);
    const stop = f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'stop' });
    assertEffect(await stop, 'confirmed');
    const old = await first; assertEffect(old, 'unknown');
    assertEffect(await queued, 'none');
    assert.equal(f.requests.filter(request => request.tool === 'press_key').length, 0);
    assert.deepEqual(f.changes, ['prepare', 'stop']);
  } finally { await f.cleanup(); }
});

test('desktop lifecycle cancellation waits for the original helper callback before confirming release', { timeout: 15_000 }, async () => {
  const f = await managedFixture();
  const entered = deferred<void>(), gate = deferred<void>();
  try {
    assertEffect(await f.invoke('prepare', {}), 'confirmed');
    f.changeReply(async action => { if (action === 'start') { entered.resolve(); await gate.promise; } });
    const running = f.invoke('desktop_lifecycle', { desktopId: 'managed-linux', action: 'start' });
    await entered.promise;
    let released = false;
    const stop = f.computer.user.stop(work() as never, { runId: 'root-run', desktopId: 'managed-linux' }).then(value => { released = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(released, false);
    assert.equal((await f.computers.automation.snapshot(work())).status, 'cancelling');
    gate.resolve();
    const completed = await running; assertEffect(completed, 'confirmed');
    assert.equal((completed.content as { cancelled: boolean }).cancelled, true);
    assert.equal((await stop).state.status, 'enabled');
    const journal = await f.computers.evidence({ desktopId: 'managed-linux' });
    assert.ok(journal.entries.some(entry => entry.tool === 'control' && entry.op === 'start' && entry.outcome === 'cancelled' && entry.execution?.runId === 'root-run'));
  } finally { gate.resolve(); await f.cleanup(); }
});

test('desktop lifecycle helper failures preserve original dispatch and helper-exit facts', async () => {
  for (const phase of ['exited', 'lost'] as const) {
    const f = await managedFixture();
    try {
      f.changeReply(async () => {
        if (phase === 'lost') throw new Error('Original lifecycle helper acknowledgement lost');
        return { code: 2, stdout: 'invalid response', stderr: 'Original helper exited without usable state' };
      });
      const failed = await f.invoke('prepare', {});
      assertEffect(failed, 'unknown', phase === 'exited');
      assert.deepEqual(f.changes, ['prepare']);
      if (phase === 'lost') {
        assertEffect(await f.invoke('prepare', {}), 'none');
        assert.deepEqual(f.changes, ['prepare']);
      }
    } finally { await f.cleanup(); }
  }
  const unsupported = await fixture();
  try { assertEffect(await unsupported.invoke('prepare', {}), 'none'); assert.equal(unsupported.records.has('computer.desktop:managed-linux'), false); }
  finally { await unsupported.cleanup(); }
});

test('remote desktop lifecycle tools reserve the original target and retain stale-epoch or revoked-token no-input proof', async () => {
  const target = await managedFixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  let claim: Record<string, unknown> | undefined;
  try {
    source = await remoteFixture(target, async (url, body, send) => {
      if (url.pathname.endsWith('/assignment') && body.op === 'claim' && body.access === 'control') claim = body;
      return send();
    });
    assertEffect(await source.invoke('prepare', { connectionId: 'peer' }), 'confirmed');
    assert.deepEqual(target.changes, ['prepare']);
    assert.ok(claim);
    const desktopId = 'remote:peer:host:managed-linux';
    const controller = target.computers.automation.controller('managed-linux');
    assert.equal(controller?.execution.work.runtime, 'agent');
    assertEffect(await source.invoke('desktop_lifecycle', { desktopId, action: 'stop', automationEpoch: 'obsolete' }), 'none');
    const control = await source.invoke('control', { desktopId });
    const epoch = (control.content as { control: { automationEpoch: string } }).control.automationEpoch;
    assertEffect(await source.invoke('desktop_lifecycle', { desktopId, action: 'start', automationEpoch: epoch }), 'confirmed');
    await computerRouter(target.computers)('/api/computers/desktops/managed-linux/assignment', { ...claim, op: 'drop' });
    assertEffect(await source.invoke('desktop_lifecycle', { desktopId, action: 'stop' }), 'none');
    assert.deepEqual(target.changes, ['prepare', 'start']);
    const raw = await computerRouter(target.computers)('/api/computers/desktops/managed-linux/lifecycle', { action: 'stop', automation: true });
    assert.equal(raw.status, 409);
    assert.deepEqual(target.changes, ['prepare', 'start']);
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('remote desktop lifecycle ACK loss remains unknown even when the target finished its actual change', async () => {
  const target = await managedFixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    source = await remoteFixture(target, async (url, _body, send) => {
      const response = await send();
      if (url.pathname.endsWith('/managed-linux/prepare')) throw new Error('Original prepare acknowledgement lost');
      return response;
    });
    assertEffect(await source.invoke('prepare', { connectionId: 'peer' }), 'unknown', false);
    assert.deepEqual(target.changes, ['prepare']);
    assert.equal((await target.computers.preparationTarget()).status, 'available');
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('Computer artifacts use the native Thread scope and original Bot catalog with pinned revisions and Host identity', async () => {
  const target = await managedFixture({ resolveWork: async () => { throw new Error('Source Thread is absent from the target Catalog'); } });
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  let revision = 'a'.repeat(64), metadataReads = 0;
  try {
    source = await remoteFixture(target, async (url, _body, send) => {
      if (url.pathname.endsWith('/artifacts/inspect')) {
        metadataReads++;
        return new Response(JSON.stringify({ version: { sha256: revision, byteLength: 3, modifiedAt: '1790712000000000000' } }),
          { headers: { 'x-varin-computer-host': 'host', 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/artifacts/read')) return new Response('pdf', { headers: { 'x-varin-computer-host': 'host', 'x-varin-artifact-sha256': revision } });
      return send();
    });
    const desktopId = 'remote:peer:host:managed-linux';
    assertEffect(await source.invoke('prepare', { connectionId: 'peer' }), 'confirmed');
    const targetBot = await computerRouter(target.computers, true)('/api/harness/bots/bot/work', {}, undefined, true, 'GET');
    assert.equal(targetBot.status, 200, 'peer work is not looked up as a target-local Thread');
    assert.deepEqual((targetBot.body as { threads: Array<{ desktops: unknown[] }> }).threads[0]?.desktops, []);
    assertEffect(await source.invoke('artifact', { desktopId, relativePath: 'Downloads/report.pdf' }, 'child'), 'none');
    assert.equal(metadataReads, 0);
    const registered = await source.invoke('artifact', { desktopId, relativePath: 'Downloads/report.pdf' });
    assertEffect(registered, 'confirmed');
    const artifact = (registered.content as { artifact: { id: string; scopeId: string; threadId: string; sourceHostId: string; sha256: string } }).artifact;
    assert.equal(artifact.scopeId, 'bot:bot'); assert.equal(artifact.threadId, 'root');
    assert.equal(artifact.sourceHostId, 'host'); assert.equal(artifact.sha256, revision);
    const bot = await computerRouter(source.computers, true)('/api/harness/bots/bot/work', {}, undefined, true, 'GET');
    assert.equal(bot.status, 200);
    const entry = (bot.body as { threads: Array<{ artifacts: unknown[]; desktops: Array<{ id: string; work: Array<{ registry: unknown }> }> }> }).threads[0]!;
    assert.deepEqual(entry.artifacts, [artifact]);
    assert.equal(entry.desktops[0]?.id, desktopId); assert.equal(entry.desktops[0]?.work[0]?.registry, null);
    const opened = await source.computers.openArtifact(artifact.id);
    const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'pdf');
    await assert.rejects(source.computers.automation.authorize(work(), 'control', desktopId,
      () => source!.computers.registerArtifact(work('other'), desktopId, 'Downloads/report.pdf')), /owner must match/);
    assert.equal((await source.computers.listArtifacts('bot:bot')).length, 1);
    revision = 'b'.repeat(64);
    await assert.rejects(source.computers.openArtifact(artifact.id), /version changed/);
    revision = artifact.sha256;
    const record = source.records.get(`computer.desktop:${desktopId}`)!;
    const raw = JSON.parse(record.payloadJson); raw.remote.hostId = 'replacement-host';
    source.records.set(record.recordId, { ...record, payloadJson: JSON.stringify(raw) });
    await assert.rejects(source.computers.openArtifact(artifact.id), /Host identity changed/);
    raw.remote.hostId = 'host'; source.records.set(record.recordId, { ...record, payloadJson: JSON.stringify(raw) });
    const storage = source.kernel.scoped();
    const put = storage.putRecord;
    storage.putRecord = async params => { const stored = await put(params); if (params.recordType === 'computer.artifact') throw new Error('Original artifact Catalog ACK lost'); return stored; };
    const unknown = await source.invoke('artifact', { desktopId, relativePath: 'Downloads/second.pdf' });
    assertEffect(unknown, 'unknown');
    storage.putRecord = put;
    assert.equal((await source.computers.listArtifacts('bot:bot')).length, 2, 'the original catalog can reconcile an uncertain registration without a second registry');
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('human desktop preparation and lifecycle keep their authenticated product authority while Agent control stays fenced', async () => {
  const f = await managedFixture();
  try {
    const call = computerRouter(f.computers);
    const prepared = await call('/api/computers/desktops/prepare', { width: 1280, height: 800 });
    assert.equal(prepared.status, 200);
    assert.equal(f.computers.automation.controller('managed-linux'), null);
    await f.computers.takeover({ desktopId: 'managed-linux', holderId: 'viewer' });
    assertEffect(await f.invoke('prepare', {}), 'none');
    assert.deepEqual(f.changes, ['prepare']);
    const stopped = await call('/api/computers/desktops/managed-linux/lifecycle', { action: 'stop' });
    assert.equal(stopped.status, 200);
    assert.equal((stopped.body as { desktop: { status: string } }).desktop.status, 'stopped');
    assert.equal((await f.computers.control('managed-linux')).owner, 'human');
    assert.equal(f.computers.automation.controller('managed-linux'), null);
    assert.deepEqual(f.changes, ['prepare', 'stop']);
  } finally { await f.cleanup(); }
});

test('existing Pi harness consumers use the same lifecycle assignment and current typed artifact owner', async () => {
  const target = await managedFixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    source = await remoteFixture(target, async (url, _body, send) => url.pathname.endsWith('/artifacts/inspect')
      ? new Response(JSON.stringify({ version: { sha256: 'c'.repeat(64), byteLength: 3, modifiedAt: '1790712000000000000' } }), { headers: { 'x-varin-computer-host': 'host' } }) : send());
    const services = new Map<string, { handle(params: never, ctx: HarnessServiceContext): Promise<unknown> }>();
    registerComputerServices({ register(method, service) { services.set(method, service); } }, { computerService: source.computers } as HarnessServiceHost);
    const ctx: HarnessServiceContext = {
      sessionId: 'existing-pi-session', workspaceId: null, authorizedPaths: [], signal: new AbortController().signal,
      actor: { authorityInstanceId: 'pi-authority', sessionId: 'existing-pi-session', runId: 'pi-run', workerId: 'pi-worker', workerGeneration: 1,
        workspaceId: null, grantedCapabilities: ['control.computer'] },
    };
    const invoke = (method: string, params: Record<string, unknown>) => services.get(method)!.handle(params as never, ctx);
    const prepared = await invoke('computer.prepare', { connectionId: 'peer' });
    assert.equal((prepared as { desktop: { status: string } }).desktop.status, 'available');
    const desktopId = 'remote:peer:host:managed-linux';
    const artifact = (await invoke('computer.artifact', { desktopId, relativePath: 'Downloads/pi.pdf' }) as { artifact: { scopeId: string; threadId: string } }).artifact;
    assert.equal(artifact.scopeId, 'scope'); assert.equal(artifact.threadId, 'pi');
    assert.deepEqual(await source.computers.listArtifacts('scope'), [artifact]);
    const stopped = await invoke('computer.desktopLifecycle', { desktopId, action: 'stop' });
    assert.equal((stopped as { desktop: { status: string } }).desktop.status, 'stopped');
    assert.deepEqual(target.changes, ['prepare', 'stop']);
  } finally { await source?.cleanup(); await target.cleanup(); }
});

test('confirmed remote desktop stop reconciles its exact assignment without SSE and separates a lost drop ACK', async () => {
  for (const failDrop of [false, true]) {
    const target = await managedFixture();
    let source: Awaited<ReturnType<typeof fixture>> | undefined;
    let dropFailure = false;
    try {
      source = await remoteFixture(target, async (url, body, send) => {
        if (dropFailure && url.pathname.endsWith('/assignment') && body.op === 'drop') throw new Error('Original assignment drop acknowledgement lost');
        return send();
      });
      const desktopId = 'remote:peer:host:managed-linux';
      assertEffect(await source.invoke('prepare', { connectionId: 'peer' }), 'confirmed');
      const original = (await source.computers.automation.snapshot(work())).leases.find(lease => lease.desktopId === desktopId && lease.access === 'control')!.id;
      dropFailure = failDrop;
      const stopped = await source.invoke('desktop_lifecycle', { desktopId, action: 'stop' });
      assertEffect(stopped, 'confirmed');
      const releases = (stopped.content as { assignmentReleases: Array<{ assignmentId: string; confirmed: boolean }> }).assignmentReleases;
      assert.equal(releases.find(release => release.assignmentId === original)?.confirmed, !failDrop);
      assert.equal((await source.computers.automation.snapshot(work())).leases.some(lease => lease.id === original), false);
      if (failDrop) {
        assert.ok((await source.computers.automation.snapshot(work())).cleanups.some(cleanup => cleanup.desktopId === desktopId));
        dropFailure = false;
        assertEffect(await source.invoke('release', { desktopId }), 'confirmed');
      }
      const ready = await source.invoke('control', { desktopId });
      assertEffect(ready, 'confirmed');
      assert.notEqual((ready.content as { assignment: { id: string } }).assignment.id, original);
      const automationEpoch = (ready.content as { control: { automationEpoch: string } }).control.automationEpoch;
      assertEffect(await source.invoke('desktop_lifecycle', { desktopId, action: 'start', automationEpoch }), 'confirmed');
      assert.deepEqual(target.changes, ['prepare', 'stop', 'start']);
    } finally { dropFailure = false; await source?.cleanup(); await target.cleanup(); }
  }
});

test('remote desktop stop ends the exact target observer assignments and preserves a grant after the actual stop', async () => {
  const target = await managedFixture();
  let source: Awaited<ReturnType<typeof fixture>> | undefined;
  const gate = deferred<void>(), entered = deferred<void>();
  const tokens = new Map<string, string>();
  const desktopId = 'remote:peer:host:managed-linux';
  const grant = async (id: string) => {
    await source!.computers.automation.grantRequest({ work: work(id), runId: `${id}-run` }, work(), { work: work(), runId: 'root-run' }, desktopId, 'observe', `${id}-assignment`);
    source!.computers.automation.confirmRequest(`${id}-assignment`);
  };
  try {
    source = await remoteFixture(target, async (url, body, send) => {
      const response = await send();
      if (url.pathname.endsWith('/assignment') && body.op === 'claim') tokens.set(String(body.assignmentId), (await response.clone().json() as { token: string }).token);
      if (url.pathname.endsWith('/managed-linux/lifecycle') && body.action === 'stop') await grant('after-stop');
      return response;
    });
    assertEffect(await source.invoke('prepare', { connectionId: 'peer' }), 'confirmed');
    await grant('before-stop');
    target.changeReply(async action => { if (action === 'stop') { entered.resolve(); await gate.promise; } });
    const pendingStop = source.invoke('desktop_lifecycle', { desktopId, action: 'stop' });
    await entered.promise;
    await grant('during-stop');
    gate.resolve();
    const stopped = await pendingStop;
    assertEffect(stopped, 'confirmed');
    const states = ['before-stop', 'during-stop', 'after-stop'].map(id => [
      source!.computers.automation.assignmentState(`${id}-assignment`), target.computers.automation.assignmentState(tokens.get(`${id}-assignment`)!),
    ]);
    assert.deepEqual(states, [['released', 'released'], ['released', 'released'], ['active', 'active']]);
    const releases = (stopped.content as { assignmentReleases: Array<{ assignmentId: string; confirmed: boolean }> }).assignmentReleases;
    assert.equal(releases.length, 3, 'the original controller and two ended observers are reconciled');
    assert.ok(releases.every(release => release.confirmed && release.assignmentId !== 'after-stop-assignment'));
    const control = await source.invoke('control', { desktopId });
    assertEffect(control, 'confirmed');
    const automationEpoch = (control.content as { control: { automationEpoch: string } }).control.automationEpoch;
    assertEffect(await source.invoke('desktop_lifecycle', { desktopId, action: 'start', automationEpoch }), 'confirmed');
    assert.deepEqual(target.changes, ['prepare', 'stop', 'start']);
  } finally { gate.resolve(); await source?.cleanup(); await target.cleanup(); }
});

test('Computer identity maps original typed absence separately from Catalog failure', async () => {
  const f = await fixture();
  try {
    for (const [code, expected] of [['not-found', 'computer-work-not-found'], ['operation-error', 'computer-owner-unavailable']] as const) {
      f.kernel.agentRuntimeRequest = async () => { throw new KernelClientError({ code, message: 'Original Catalog lookup failed' }); };
      await assert.rejects(f.computer.resolve(work()), { computerCode: expected });
    }
  } finally { await f.cleanup(); }
});
