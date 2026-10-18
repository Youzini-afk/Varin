import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import type { createServer, Socket } from 'node:net';
import { ENVIRONMENT_FORWARD_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import type { JsonObject } from '@varin/extension-contract';
import { createEnvironmentForwardRuntime } from '../harness/environment-forwards.js';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity, type ManagedTarget } from '../harness/managed-remote-client.js';
import { createEnvironmentForwardJobRuntime } from './environment-forward-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import { toolOperationId, type Operation, type HostJobBinding, type HostJobPending, type LaunchSource, type OutputBody, type OperationCallCompletion } from './protocol.generated.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

// No HTTP/TCP/Unix listener, kernel default transport, process or real network is used.
class ControlledListener extends EventEmitter {
  listening = false;
  finishListen: (() => void) | undefined;
  finishClose: (() => void) | undefined;
  constructor(readonly accept: (socket: Socket) => void, readonly delayedOpen: boolean, readonly delayedClose: boolean) { super(); }
  listen(_port: number, _host: string, callback: () => void) {
    this.finishListen = () => { this.finishListen = undefined; this.listening = true; callback(); };
    if (!this.delayedOpen) queueMicrotask(this.finishListen);
    return this;
  }
  address() { return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: 43123 } : null; }
  close(callback: (error?: Error) => void) {
    this.finishClose = () => { this.finishClose = undefined; this.listening = false; this.emit('close'); callback(); };
    if (!this.delayedClose) queueMicrotask(this.finishClose);
    return this;
  }
}
const controlled = (delayedOpen = false, delayedClose = false) => {
  const listeners: ControlledListener[] = [];
  const createListener = ((accept: (socket: Socket) => void) => {
    const listener = new ControlledListener(accept, delayedOpen, delayedClose); listeners.push(listener); return listener;
  }) as unknown as typeof createServer;
  return { listeners, forwards: createEnvironmentForwardRuntime({ createListener }) };
};
const owner = { extensionId: 'varin.builtin.environment-forward', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'controlled', generation: 1 };
const executionOwner = { kind: 'external' as const, identity: 'original-extension', epoch: 'original-epoch' };
const remote: ManagedTarget = { machineId: 'managed:remote', hostId: 'remote',
  connection: { id: 'connection', label: 'Remote', apiUrl: 'https://original.invalid', requestHeaders: {}, source: 'configured-host' },
  identity: { protocolVersion: 1, hostId: 'remote', capabilities: [], machine: { machineId: 'managed:remote', kind: 'managed-remote', state: 'available',
    connection: { status: 'connected', checkedAt: 0 }, commitments: [], queued: [] } } };
const clone = <T>(value: T): T => structuredClone(value);
const metadataBody = (value: unknown): OutputBody<never> => {
  assert.ok(value && typeof value === 'object' && 'data' in value && 'parts' in value);
  assert.ok(Array.isArray(value.parts) && value.parts.length === 0, 'Forward receipts contain metadata only');
  return { data: clone(value.data), parts: [] };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(options: { delayedOpen?: boolean; delayedClose?: boolean; beginReplyLost?: boolean; acceptReplyLost?: boolean; terminalReplyLost?: boolean; cancelDuringAccept?: boolean } = {}) {
  const transport = controlled(options.delayedOpen, options.delayedClose);
  const operations = new Map<string, Operation>();
  const canonical = new Map<string, OperationCallCompletion<never>>();
  const calls: string[] = [], errors: Error[] = [], terminals: Record<string, unknown>[] = [];
  const ready = new Set<() => void>(), changes = new Set<(event: { stream: 'durable' | 'progress' }) => void>();
  let counter = 0, begins = 0, accepts = 0, resolved = 0, failReads = false;
  const pendingFor = (op: Operation): HostJobPending => ({ binding: clone(op.host_job!.binding), accepted: op.host_job!.acceptanceRef !== null,
    executorStopped: op.external_receipt?.executor_stopped ?? false, mcpHolderReleased: op.host_job!.mcpHolderReleased, cancelRequested: op.cancel_requested, phase: op.phase,
    runId: op.run_id, origin: { kind: 'tool', origin: { kind: 'model_step', request_id: 'step' }, call_id: op.id, tool_name: 'environment_forward', schema_version: 'v1' } });
  const kernel = { async agentRuntimeRequest(method: string, params: Record<string, unknown>) {
    calls.push(method);
    const binding = params.binding as HostJobBinding | undefined;
    const op = operations.get(binding?.operationId ?? String(params.targetOperationId ?? params.operationId));
    switch (method) {
      case 'runtime.host_job.begin':
        begins++; if (!op) throw new Error('No admitted original operation');
        op.host_job ??= { binding: clone(binding!), acceptanceRef: null, mcpHolderReleased: true };
        if (options.beginReplyLost && begins === 1) throw new Error('begin reply lost');
        return pendingFor(op);
      case 'runtime.host_job.accept': {
        accepts++; if (!op?.host_job) throw new Error('No original binding');
        op.host_job.acceptanceRef = 'original-acceptance'; op.handed_off = true;
        const acceptance: OperationCallCompletion<never> = { kind: 'job_accepted', operation_id: op.id, phase: 'accepted', effect: 'confirmed', lifetime: 'thread', content: metadataBody(params.content) };
        op.call_completion = clone(acceptance); canonical.set(op.id, clone(acceptance));
        if (options.cancelDuringAccept) op.cancel_requested = true;
        if (options.acceptReplyLost && accepts === 1) throw new Error('accept reply lost');
        return pendingFor(op);
      }
      case 'runtime.host_job.acceptance': {
        const completion = canonical.get(String(params.operationId)); if (!completion) throw new Error('Missing original canonical acceptance'); return clone(completion);
      }
      case 'runtime.host_job.terminal':
        if (!op) throw new Error('Missing operation');
        terminals.push(clone(params));
        assert.ok(typeof params.executorStopped === 'boolean');
        assert.ok(params.outcome === 'succeeded' || params.outcome === 'failed' || params.outcome === 'cancelled' || params.outcome === 'indeterminate');
        assert.ok(params.effect === 'none' || params.effect === 'dispatched' || params.effect === 'partial' || params.effect === 'confirmed' || params.effect === 'unknown');
        op.external_receipt = { executor: 'environment_forward', identity: op.id, epoch: executionOwner.epoch,
          executor_stopped: params.executorStopped, outcome: params.outcome, effect: params.effect, result: metadataBody(params.content) };
        op.phase = 'terminal'; op.outcome = params.outcome;
        if (options.terminalReplyLost && terminals.length === 1) throw new Error('terminal reply lost');
        return pendingFor(op);
      case 'runtime.host_job.pending': return [...operations.values()].filter(value => value.host_job && (!value.external_receipt?.executor_stopped || value.phase !== 'terminal')).map(pendingFor);
      case 'runtime.host_job.sources': return [...operations.values()].filter(value => value.run_id === params.runId && value.host_job?.acceptanceRef).map(value => ({ binding: clone(value.host_job!.binding) }));
      case 'runtime.host_job.access':
        if (!op?.host_job) throw new Error('Unknown Job');
        if (params.control && params.runId === 'child-run' && op.run_id !== 'child-run') throw new Error('Job control is outside the caller subtree');
        return clone(op);
      case 'runtime.host_job.observe': {
        const waiter = operations.get(String(params.operationId))!;
        waiter.call_completion = { kind: 'job_accepted', operation_id: waiter.id, phase: 'awaiting_job', effect: 'none', lifetime: 'thread' };
        return clone(waiter);
      }
      default: throw new Error(`Unexpected request ${method}`);
    }
  } } as unknown as KernelClient;
  const runtime = {
    coordinatorHostId: 'coordinator',
    operation: async (id: string) => { if (failReads) throw new Error('Original Catalog read unavailable'); const op = operations.get(id); if (!op) throw new Error('Missing admitted operation'); return clone(op); },
    cancelOperation: async (id: string) => { operations.get(id)!.cancel_requested = true; for (const notify of changes) notify({ stream: 'durable' }); },
    reconcileObservations: async () => [],
    onReady: (listener: () => void) => { ready.add(listener); return () => { ready.delete(listener); }; },
    onEvent: (listener: (event: { stream: 'durable' | 'progress' }) => void) => { changes.add(listener); return () => { changes.delete(listener); }; },
    inlineCompletion: async (operation: Operation) => operation.call_completion,
  } as unknown as AgentRuntimeClient;
  const targets = { forwardTarget: async () => { resolved++; return clone(remote); }, selectForwardTarget: async () => { resolved++; return clone(remote); } };
  let bridge = createEnvironmentForwardJobRuntime({ kernel, runtime, forwards: transport.forwards, targets, onError: error => errors.push(error) });
  const extras: ReturnType<typeof controlled>[] = [];
  const invoke = async (method: string, args: JsonObject, input: { id?: string; runId?: string; source?: LaunchSource; signal?: AbortSignal } = {}) => {
    const declaration = ENVIRONMENT_FORWARD_TOOL_DECLARATIONS.find(entry => entry.id === `varin.environment.${method}`)!;
    const callId = input.id ?? `call-${++counter}`, origin = { kind: 'model_step' as const, request_id: 'step' };
    const operationId = toolOperationId(origin, callId), runId = input.runId ?? 'run';
    if (!operations.has(operationId)) operations.set(operationId, { id: operationId, run_id: runId, phase: 'running', effect: 'none', lifetime: 'thread',
      revision: 0, epoch: 1, execution_owner: executionOwner, external_receipt: null, call_completion: null, outcome: null, cancel_requested: false, handed_off: false,
      executor: 'environment_forward', waiting_on: null, intent: { kind: 'tool' }, result: null });
    const signal = input.signal ?? new AbortController().signal;
    let receipt: ToolExecutionReceipt | undefined;
    const value = await withToolInvocation({ authority: { invocationId: `invocation-${counter}`, operationId, runId, threadId: runId === 'child-run' ? 'child' : 'thread', callId, origin,
      executorOwner: executionOwner, source: input.source ?? null, toolName: declaration.tool!.name, operation: declaration.tool!.operation,
      completion: declaration.tool!.completion, arguments: args }, owner, signal, onEffectReceipt: actual => { receipt = actual; } },
    async invocation => bridge.capability(method, args, { owner, signal, invocation }));
    if (method === 'forward' && receipt?.completion.kind === 'job_accepted') assert.deepEqual(receipt.completion, canonical.get(operationId), 'Rust Host tools require the immutable canonical acceptance');
    return { value: value as Record<string, unknown>, receipt: receipt!, operationId };
  };
  return { ...transport, operations, calls, errors, terminals, invoke, requestCancel: (id: string) => runtime.cancelOperation(id),
    event: (stream: 'durable' | 'progress') => { for (const listener of changes) listener({ stream }); }, failReads: (value: boolean) => { failReads = value; }, bridge: () => bridge, counts: () => ({ begins, accepts, resolved }),
    restart() { const original = bridge; const next = controlled(); extras.push(next);
      bridge = createEnvironmentForwardJobRuntime({ kernel, runtime, forwards: next.forwards, targets, onError: error => errors.push(error) }); return { original, next }; },
    async dispose() { for (const listener of transport.listeners) { listener.finishListen?.(); listener.finishClose?.(); }
      await transport.forwards.dispose(); for (const extra of extras) await extra.forwards.dispose(); await bridge.dispose(); },
  };
}

test('source-free direct access creates neither a listener nor a Job and makes no reachability claim', async () => {
  const f = fixture(); try {
    const call = await f.invoke('forward', { host: '::1', port: 3000 });
    assert.equal(call.receipt.executor_stopped, true); assert.equal(call.receipt.completion.kind, 'result');
    assert.equal(f.listeners.length, 0); assert.equal(f.counts().begins, 0);
    assert.equal(call.value.listenerState, 'not_created'); assert.equal(call.value.remoteServiceReachability, 'not_observed');
    assert.equal((call.value.access as { access: { url: string } }).access.url, 'http://[::1]:3000');
  } finally { await f.dispose(); }
});

test('remote forward is a live Thread Job; own subtree close waits for original listener drain', async () => {
  const f = fixture({ delayedClose: true }); try {
    const call = await f.invoke('forward', { target: 'connection', port: 3000 });
    assert.equal(call.receipt.completion.kind, 'job_accepted'); assert.equal(call.receipt.executor_stopped, false);
    assert.equal(f.listeners.length, 1); assert.equal(f.operations.get(call.operationId)!.host_job!.binding.subject.kind, 'environment_forward');
    assert.equal(call.value.serviceProcess, 'not_observed');
    await assert.rejects(f.invoke('forward_close', { operationId: call.operationId }, { runId: 'child-run' }), /outside the caller subtree/);
    assert.equal(f.listeners[0]!.listening, true);
    const closing = f.invoke('forward_close', { operationId: call.operationId });
    await turn(); assert.equal(f.operations.get(call.operationId)!.external_receipt, null);
    f.listeners[0]!.finishClose!(); await closing;
    assert.equal(f.operations.get(call.operationId)!.external_receipt!.executor_stopped, true);
    assert.equal((f.terminals.at(-1)!.content as { data: { serviceProcess: string } }).data.serviceProcess, 'not_observed');
  } finally { await f.dispose(); }
});

test('read/list and normal Run retirement do not close or retarget the accepted listener', async () => {
  const f = fixture(); try {
    const opened = await f.invoke('forward', { target: 'connection', port: 3000 });
    await f.bridge().reconcile();
    const listed = await f.invoke('forwards', {}); assert.equal((listed.value.jobs as unknown[]).length, 1);
    const read = await f.invoke('forward_get', { operationId: opened.operationId }, { runId: 'child-run' });
    assert.equal(read.value.listenerState, 'live'); assert.equal(f.listeners[0]!.listening, true); assert.equal(f.counts().resolved, 1);
    const wait = await f.invoke('forward_wait', { operationId: opened.operationId });
    assert.equal(wait.receipt.completion.kind, 'job_accepted'); assert.equal(wait.receipt.executor_stopped, false);
    assert.equal(f.listeners[0]!.listening, true);
  } finally { await f.dispose(); }
});

test('lost begin reply reconciles its original never-started intent; replay does not open a listener', async () => {
  const f = fixture({ beginReplyLost: true }); try {
    const first = await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    assert.equal(first.receipt.executor_stopped, true); assert.equal(f.listeners.length, 0);
    await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    assert.equal(f.counts().begins, 1); assert.equal(f.counts().resolved, 1); assert.equal(f.listeners.length, 0);
    assert.equal(f.operations.get(first.operationId)!.external_receipt!.executor_stopped, true);
  } finally { await f.dispose(); }
});

test('lost acceptance reply retains the actual original listener and reuses its receipt', async () => {
  const f = fixture({ acceptReplyLost: true }); try {
    const first = await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    assert.equal(first.receipt.executor_stopped, false);
    assert.ok(first.receipt.completion.kind === 'result');
    f.operations.get(first.operationId)!.call_completion = { ...clone(first.receipt.completion), content: metadataBody(first.receipt.completion.content) };
    const again = await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    assert.equal(again.receipt.completion.kind, 'job_accepted');
    assert.equal(f.listeners.length, 1); assert.equal(f.counts().resolved, 1); assert.equal(f.counts().begins, 1);
  } finally { await f.dispose(); }
});

test('Bot Sleep cancels and drains only original selected Run Jobs; wake reconciliation does not reopen', async () => {
  const f = fixture(); try {
    const first = await f.invoke('forward', { target: 'connection', port: 3000 });
    const other = await f.invoke('forward', { target: 'connection', port: 3001 }, { runId: 'other-run' });
    await f.bridge().drainRuns(new Set(['run']));
    assert.equal(f.operations.get(first.operationId)!.external_receipt!.executor_stopped, true);
    assert.equal(f.operations.get(other.operationId)!.external_receipt, null);
    await f.bridge().reconcile(); assert.equal(f.listeners.length, 2); assert.equal(f.listeners[1]!.listening, true);
  } finally { await f.dispose(); }
});

test('a new random Host epoch cannot prove the old listener stopped and never opens a replacement', async () => {
  const f = fixture(); try {
    const first = await f.invoke('forward', { target: 'connection', port: 3000 });
    const replacement = f.restart();
    await f.bridge().reconcile();
    const record = f.operations.get(first.operationId)!;
    assert.equal(record.external_receipt!.executor_stopped, false); assert.equal(record.external_receipt!.effect, 'unknown');
    assert.equal(f.listeners[0]!.listening, true); assert.equal(replacement.next.listeners.length, 0);
    await assert.rejects(f.bridge().drainRuns(new Set(['run'])), /drain is unconfirmed/);
    assert.equal(f.listeners[0]!.listening, true); assert.equal(replacement.next.listeners.length, 0);
    await replacement.original.dispose();
    assert.equal(f.listeners[0]!.listening, false);
  } finally { await f.dispose(); }
});

test('cancellation during listener preparation drains opening work without publishing a live acceptance', async () => {
  const f = fixture({ delayedOpen: true }); try {
    const controller = new AbortController();
    const work = f.invoke('forward', { target: 'connection', port: 3000 }, { signal: controller.signal });
    await turn(); assert.equal(f.listeners.length, 1);
    controller.abort(); f.listeners[0]!.finishListen!();
    const receipt = await work;
    assert.equal(receipt.receipt.executor_stopped, true); assert.equal(f.counts().accepts, 0);
    assert.equal(f.listeners[0]!.listening, false);
    await f.bridge().reconcile(); assert.equal(f.operations.get(receipt.operationId)!.external_receipt!.executor_stopped, true);
  } finally { await f.dispose(); }
});


test('an unreadable original operation never becomes false no-effect/stopped evidence', async () => {
  const f = fixture(); try {
    const live = await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    f.failReads(true);
    const unknown = await f.invoke('forward', { target: 'connection', port: 3000 }, { id: 'stable' });
    assert.equal(unknown.receipt.executor_stopped, false);
    assert.equal(unknown.receipt.completion.kind, 'result');
    assert.equal(unknown.receipt.completion.kind === 'result' && unknown.receipt.completion.effect, 'unknown');
    assert.equal(f.listeners.length, 1); assert.equal(f.listeners[0]!.listening, true);
    f.failReads(false); await f.bridge().reconcile();
    assert.equal(f.operations.get(live.operationId)!.external_receipt, null);
  } finally { f.failReads(false); await f.dispose(); }
});

test('native operations keep separate listener ownership and cancellation; pinned channels drain before stop', async () => {
  const transport = controlled();
  const channels: ControlledChannel[] = [];
  class ControlledChannel extends EventEmitter {
    readyState = 1;
    terminated = false;
    constructor(readonly url: string, readonly options: { headers: Record<string, string> }) { super(); channels.push(this); }
    terminate() { this.terminated = true; }
    finish() { this.readyState = 3; this.emit('close'); }
  }
  const target = clone(remote);
  const agent = { runtime: 'agent' as const, hostEpoch: transport.forwards.epoch, operationId: 'original-job' };
  const independent = { runtime: 'agent' as const, hostEpoch: transport.forwards.epoch, operationId: 'independent-job' };
  try {
    await transport.forwards.open({ target, host: '127.0.0.1', port: 3000, threadId: 'thread', owner: agent, webSocket: ControlledChannel as unknown as typeof WebSocket });
    await transport.forwards.open({ target, host: '127.0.0.1', port: 3001, threadId: 'independent-thread', owner: independent });
    target.connection.apiUrl = 'https://replacement.invalid'; target.connection.requestHeaders.changed = 'new';
    const socket = new PassThrough();
    transport.listeners[0]!.accept(socket as unknown as Socket);
    assert.equal(channels.length, 1); assert.match(channels[0]!.url, /^wss:\/\/original\.invalid/);
    assert.equal(channels[0]!.options.headers.changed, undefined);
    await transport.forwards.closeOwner(independent);
    assert.equal(transport.forwards.inspect(independent).state, 'stopped');
    transport.forwards.release(independent);
    assert.equal(transport.forwards.list(agent).length, 1);
    assert.equal(transport.listeners[0]!.listening, true);
    const closing = transport.forwards.closeOwner(agent); await turn();
    assert.equal(channels[0]!.terminated, true); assert.equal(transport.forwards.inspect(agent).state, 'stopping');
    channels[0]!.finish(); await closing;
    assert.equal(socket.closed, true); assert.equal(transport.forwards.inspect(agent).state, 'stopped');
    transport.forwards.release(agent); assert.equal(transport.forwards.inspect(agent).state, 'absent');
  } finally { for (const channel of channels) channel.finish(); await transport.forwards.dispose(); }
});


test('the actual configured-target resolver needs no file source and rejects owner/endpoint substitutions', async () => {
  let settings = { desktopHosts: [{ id: 'first', apiUrl: 'https://first.invalid' }, { id: 'second', apiUrl: 'https://second.invalid' }] };
  let remoteIdentity = 'remote';
  const probes: string[] = [];
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never,
    resources: new Proxy({}, { get() { throw new Error('A network service must not fabricate a workspace'); } }) as never,
    readSettings: async () => settings,
    fetch: (async (input, init) => {
      probes.push(String(input)); assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify({ protocolVersion: 1, hostId: remoteIdentity, capabilities: [],
        machine: { machineId: `managed:${remoteIdentity}`, kind: 'managed-remote', state: 'available' } }),
      { headers: { 'x-varin-managed-host': remoteIdentity } });
    }) as typeof fetch,
  });
  const selected = await registry.selectForwardTarget('second');
  const original = { kind: 'managed_host' as const, hostId: selected.hostId, connectionId: selected.connection.id,
    endpointIdentity: managedEndpointIdentity(selected.connection) };
  assert.equal((await registry.forwardTarget(original)).connection.id, 'second');
  assert.equal(probes.length, 2); assert.ok(probes.every(url => url.startsWith('https://second.invalid/')));
  await assert.rejects(registry.sourceTarget(original), /source resources are unavailable/);
  settings = { desktopHosts: [{ id: 'first', apiUrl: 'https://first.invalid' }, { id: 'second', apiUrl: 'https://replacement.invalid' }] };
  const before = probes.length;
  await assert.rejects(registry.forwardTarget(original), /original managed source connection is unavailable/);
  assert.equal(probes.length, before);
  settings = { desktopHosts: [{ id: 'first', apiUrl: 'https://first.invalid' }] };
  await assert.rejects(registry.forwardTarget(original), /original managed source connection is unavailable/);
  settings = { desktopHosts: [{ id: 'second', apiUrl: 'https://second.invalid' }] }; remoteIdentity = 'replacement-host';
  await assert.rejects(registry.forwardTarget(original), /Host identity changed/);
});

test('omitted target follows the admitted remote owner and local override does not change it', async () => {
  const f = fixture(); try {
    const source = { resource_owner: { kind: 'managed_host', hostId: remote.hostId, connectionId: remote.connection.id,
      endpointIdentity: managedEndpointIdentity(remote.connection) }, workspace_id: 'remote-source', execution_workspace_id: 'remote-source',
      mode: 'live_root', live_root: null, branch_id: null, revision: null, environment_run_id: null } as LaunchSource;
    const accepted = await f.invoke('forward', { port: 3000 }, { source });
    assert.equal(accepted.receipt.completion.kind, 'job_accepted');
    assert.deepEqual((f.operations.get(accepted.operationId)!.host_job!.binding.subject as { target: unknown }).target, source.resource_owner);
    const direct = await f.invoke('forward', { target: 'local', port: 3001 }, { source });
    assert.equal(direct.value.listenerState, 'not_created'); assert.equal(f.listeners.length, 1);
    assert.equal(f.counts().resolved, 1); assert.equal(f.listeners[0]!.listening, true);
  } finally { await f.dispose(); }
});


test('a committed terminal with a lost acknowledgement releases only after rereading original stop evidence', async () => {
  const f = fixture({ terminalReplyLost: true }); try {
    const opened = await f.invoke('forward', { target: 'connection', port: 3000 });
    await assert.rejects(f.invoke('forward_close', { operationId: opened.operationId }), /terminal reply lost/);
    assert.equal(f.forwards.owners('agent').length, 1);
    f.failReads(true); await f.bridge().reconcile(); assert.equal(f.forwards.owners('agent').length, 1);
    f.failReads(false); await f.bridge().reconcile(); assert.equal(f.forwards.owners('agent').length, 0);
    assert.equal(f.listeners.length, 1); assert.equal(f.listeners[0]!.listening, false);
  } finally { f.failReads(false); await f.dispose(); }
});


test('durable root/Goal cancellation drains the original Job while model progress does not scan jobs', async () => {
  const f = fixture(); try {
    f.bridge().start(); await turn();
    const scans = f.calls.filter(method => method === 'runtime.host_job.pending').length;
    for (let n = 0; n < 100; n++) f.event('progress');
    await turn(); assert.equal(f.calls.filter(method => method === 'runtime.host_job.pending').length, scans);
    const opened = await f.invoke('forward', { target: 'connection', port: 3000 });
    await f.requestCancel(opened.operationId); await turn();
    assert.equal(f.listeners[0]!.listening, false);
    assert.equal(f.operations.get(opened.operationId)!.external_receipt!.executor_stopped, true);
    assert.equal(f.counts().resolved, 1);
  } finally { await f.dispose(); }
});


test('cancellation after acceptance keeps the returned JobAccepted identical to its immutable original body', async () => {
  const f = fixture({ cancelDuringAccept: true }); try {
    const opened = await f.invoke('forward', { target: 'connection', port: 3000 });
    assert.equal(opened.receipt.completion.kind, 'job_accepted'); assert.equal(opened.value.listenerState, 'live');
    assert.equal(f.listeners[0]!.listening, false);
    await f.bridge().reconcile();
    const actual = await f.invoke('forward_get', { operationId: opened.operationId });
    assert.equal(actual.value.listenerState, 'stopped');
  } finally { await f.dispose(); }
});
