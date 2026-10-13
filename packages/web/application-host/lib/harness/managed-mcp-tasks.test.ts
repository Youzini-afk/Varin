import { expect, it } from 'vitest';
import { createManagedMcpTasks } from './managed-mcp-tasks.js';
import type { SourceMcpHolder, SourceMcpHolderBinding, SourceMcpCreationOutcome } from '../kernel/protocol.generated.js';
import type { ManagedMcpTaskAction } from './managed-mcp-contract.js';
const binding: SourceMcpHolderBinding = { operationId: 'a-operation', executionOwner: { kind: 'external', identity: 'b', epoch: 'b-kernel' }, purpose: 'task',
  endpoint: { server: 'peer', resourceKey: 'original-daemon', configurationVersion: 'definition', credentialVersion: 'credential' } };
const scope = { principal: { principalId: 'a-principal', capabilities: [] }, coordinatorHostId: 'a', authorityId: 'original-source', resourceEpoch: 'b-kernel' };
const response = { task: { taskId: 'remote-task', status: 'working' as const, createdAt: '2026-10-13T00:00:00Z', lastUpdatedAt: '2026-10-13T00:00:00Z', ttl: null }, result: { task: { taskId: 'remote-task' } } };
const start: Extract<ManagedMcpTaskAction, { kind: 'task_start' }> = { kind: 'task_start', handleId: 'view', binding, name: 'compute', schemaVersion: 'schema', arguments: { x: 1 } };
function fixture() {
  let holder: SourceMcpHolder | undefined, dispatches = 0, releases = 0, acquisitions = 0, sealed = false, failedSettle = false;
  let outcome: SourceMcpCreationOutcome | null = null;
  const controls: string[] = [];
  let run = async () => response, get = async (_signal: AbortSignal) => response;
  const kernel = { async sourceRequest(method: string, params: any) {
    expect(params.principalId).toBe(scope.principal.principalId); expect(params.authorityId).toBe(scope.authorityId);
    if (holder && JSON.stringify(holder.binding) !== JSON.stringify(params.binding)) throw new Error('binding changed');
    if (method === 'source.mcp.holder') {
      if (!holder) holder = { binding: params.binding, released: false, creationReceipt: null };
      if (params.action === 'release' || params.action === 'release_unstarted' && !holder.creationReceipt) holder.released = true;
      return { holder: structuredClone(holder), authority: {}, grantState: 'active' };
    }
    if (params.action === 'begin') {
      if (holder?.released) throw new Error('holder released');
      if (holder?.creationReceipt) {
        if (holder.creationReceipt.requestHash !== params.requestHash) throw new Error('request changed');
        return { dispatch: false, holder: structuredClone(holder), outcome: holder.released ? null : structuredClone(outcome) };
      }
      holder = { binding: params.binding, released: false, creationReceipt: { requestHash: params.requestHash, outcomeRef: null } };
      return { dispatch: true, holder: structuredClone(holder), outcome: null };
    }
    if (!holder) throw new Error('holder absent');
    if (params.action === 'settle') {
      if (failedSettle) { failedSettle = false; throw new Error('Storage reply interrupted'); }
      outcome = params.outcome; holder.creationReceipt!.outcomeRef = { objectHash: 'sha256-body', byteLength: 100 };
    }
    return { dispatch: false, holder: structuredClone(holder), outcome: holder.released ? null : structuredClone(outcome) };
  } };
  const view = async () => {
    if (sealed) throw new Error('view sealed');
    return { beforeDispatch: async () => { if (sealed) throw new Error('view sealed'); }, lease: {
      async taskOwner() { acquisitions++; return { endpoint: binding.endpoint,
        async start(_name: string, _args: unknown, options: any) { await options.beforeDispatch(); expect(options.interaction).toBeUndefined(); dispatches++; return run(); },
        async get(_id: string, signal: AbortSignal) { controls.push('get'); return get(signal); }, async result() { controls.push('result'); return { content: [] }; },
        async cancel() { controls.push('cancel'); return { ...response, task: { ...response.task, status: 'cancelled' } }; },
        release() { releases++; }, onChange() { return () => {}; } }; },
    } };
  };
  const create = () => createManagedMcpTasks({ kernel, view } as never);
  return { tasks: create(), create, counts: () => ({ dispatches, releases, acquisitions }), controls,
    hold: () => holder, outcome: () => outcome, seal: () => { sealed = true; }, failSettle: () => { failedSettle = true; }, run: (next: typeof run) => { run = next; }, get: (next: typeof get) => { get = next; } };
}
it('prepares no durable holder, creates once, and keeps original control after the Run view seals', async () => {
  const f = fixture(), signal = new AbortController().signal;
  expect(await f.tasks.prepare(scope, 'view', 'peer', undefined, signal)).toEqual(binding.endpoint);
  expect(f.hold()).toBeUndefined();
  expect(await f.tasks.start(scope, start, signal)).toEqual(response);
  expect(await f.tasks.start(scope, { ...start }, signal)).toEqual(response);
  expect(f.counts().dispatches).toBe(1); f.seal();
  await f.tasks.control(scope, { kind: 'task_get', binding, taskId: response.task.taskId }, signal);
  await f.tasks.control(scope, { kind: 'task_cancel', binding, taskId: response.task.taskId }, signal);
  expect(f.controls).toEqual(['get', 'cancel']); expect(f.hold()?.released).toBe(false);
  await f.tasks.release(scope, binding); expect(f.hold()?.released).toBe(true);
  expect(f.counts().releases).toBe(2);
});
it('recovers the original creation response after interrupted Storage settlement without another dispatch', async () => {
  const f = fixture(); f.failSettle();
  await expect(f.tasks.start(scope, start, new AbortController().signal)).rejects.toMatchObject({ code: 'mcp_task_creation_receipt_pending', dispatched: true });
  expect(f.outcome()).toBeNull();
  expect(await f.tasks.inspect(scope, binding)).toMatchObject({ live: true, receipt: { outcome: { kind: 'accepted', response } } });
  expect(f.counts().dispatches).toBe(1);
  const reopened = f.create(); f.seal();
  expect(await reopened.inspect(scope, binding)).toMatchObject({ live: false, receipt: { outcome: { kind: 'accepted', response } } });
  await expect(reopened.control(scope, { kind: 'task_get', binding, taskId: response.task.taskId }, new AbortController().signal)).rejects.toThrow('original_transport_unavailable');
  expect(f.counts().dispatches).toBe(1);
  await reopened.release(scope, binding); await f.tasks.close(scope);
});
it('retains unknown creation and typed protocol evidence instead of replaying or claiming Task stop', async () => {
  const f = fixture(); f.run(async () => { throw Object.assign(new Error('lost'), { code: 'original-lost', dispatched: true, kind: 'transport', settlement: 'unknown', rpcCode: -32042, interactionProblem: 'unsupported' }); });
  for (let i = 0; i < 2; i++) await expect(f.tasks.start(scope, start, new AbortController().signal)).rejects.toMatchObject({ code: 'original-lost', taskKind: 'transport' });
  expect(f.hold()?.released).toBe(false); expect(f.outcome()).toMatchObject({ kind: 'failed', error: { dispatched: true, settlement: 'unknown', rpcCode: -32042, interactionProblem: 'unsupported' } });
  expect(f.counts()).toMatchObject({ dispatches: 1, releases: 0 });
  await f.tasks.close(scope); expect(f.counts().releases).toBe(1); expect(f.hold()?.released).toBe(false);
});
it('an original release tombstone rejects late start and changed Operation bindings', async () => {
  const f = fixture(); await f.tasks.release(scope, binding);
  await expect(f.tasks.start(scope, start, new AbortController().signal)).rejects.toThrow('holder released');
  await expect(f.tasks.inspect(scope, { ...binding, endpoint: { ...binding.endpoint, resourceKey: 'replacement' } })).rejects.toThrow('changed');
  expect(f.counts()).toMatchObject({ dispatches: 0, releases: 1 });
});
it('uses the real coordinator projection across Run release, preserving typed errors and detached durable ownership', async () => {
  const { createManagedMcpTaskLease } = await import('../kernel/managed-mcp-task-lease.js');
  const { McpTaskRequestError } = await import('@varin/pi-host/mcp-errors');
  const f = fixture(), run = new AbortController(), signal = new AbortController().signal;
  let failControl = false;
  const client = { async service(input: { operation: { action: ManagedMcpTaskAction } }, active: AbortSignal) {
    const action = input.operation.action;
    if (action.kind === 'task_start') return { ok: true, value: await f.tasks.start(scope, action, active), executorStopped: true };
    if (action.kind === 'task_get') {
      if (failControl) return { ok: false, executorStopped: true, error: { code: 'original-protocol-error', taskKind: 'protocol', dispatched: true,
        settlement: 'rpc_response', rpcCode: -32042, protocolError: { code: -32042 }, interactionProblem: 'original-interaction' } };
      return { ok: true, value: await f.tasks.control(scope, action, active), executorStopped: true };
    }
    throw new Error('Unexpected effect');
  } };
  const lease = createManagedMcpTaskLease({ client: client as never, address: scope, binding, creation: { handleId: 'view', lifetime: run.signal } });
  expect(await lease.start(start.name, start.arguments, { schemaVersion: start.schemaVersion, signal,
    interaction: { operationId: binding.operationId, executionOwner: binding.executionOwner } })).toEqual(response);
  run.abort(); f.seal();
  expect(await lease.get(response.task.taskId, signal)).toEqual(response);
  failControl = true;
  await expect(lease.get(response.task.taskId, signal)).rejects.toMatchObject({ kind: 'protocol', rpcCode: -32042, settlement: 'rpc_response', interactionProblem: 'original-interaction' });
  await expect(lease.get(response.task.taskId, signal)).rejects.toBeInstanceOf(McpTaskRequestError);
  lease.release(); expect(f.hold()?.released).toBe(false); expect(f.counts().dispatches).toBe(1);
  await f.tasks.close(scope);
});

it('inspection follows the original still-running creation after its first requester loses the reply', async () => {
  const f = fixture(); let accepted!: () => void;
  const waiting = new Promise<void>(resolve => { accepted = resolve; });
  f.run(async () => { await waiting; return response; });
  const first = f.tasks.start(scope, start, new AbortController().signal);
  while (!f.counts().dispatches) await Promise.resolve();
  let observed = false;
  const original = f.tasks.inspect(scope, binding, true).then(value => { observed = true; return value; });
  await Promise.resolve(); await Promise.resolve(); expect(observed).toBe(false);
  expect(f.hold()?.released).toBe(false); accepted(); await first;
  expect(await original).toMatchObject({ receipt: { outcome: { kind: 'accepted', response } } });
  expect(f.counts().dispatches).toBe(1); await f.tasks.release(scope, binding);
});

it('holder release fences new controls and waits for actual original callbacks even after abort', async () => {
  const f = fixture(); let finish!: () => void, controlSignal!: AbortSignal;
  const active = new Promise<void>(resolve => { finish = resolve; });
  f.get(async signal => { controlSignal = signal; await active; return response; });
  const signal = new AbortController().signal;
  await f.tasks.start(scope, start, signal);
  const reading = f.tasks.control(scope, { kind: 'task_get', binding, taskId: response.task.taskId }, signal);
  while (!f.controls.length) await Promise.resolve();
  let drained = false;
  const releasing = f.tasks.release(scope, binding).then(value => { drained = true; return value; });
  while (!controlSignal.aborted) await Promise.resolve();
  expect(drained).toBe(false); expect(f.counts().releases).toBe(0);
  await expect(f.tasks.control(scope, { kind: 'task_get', binding, taskId: response.task.taskId }, signal)).rejects.toThrow('original_transport_unavailable');
  finish(); await reading;
  expect(await releasing).toMatchObject({ controlsDrained: true }); expect(f.counts().releases).toBe(1);
});
