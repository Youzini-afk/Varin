import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import type { JsonValue } from '@varin/extension-contract';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import type { CalendarOwner } from '../scheduled-tasks/calendar-owner.js';
import type { CalendarOccurrence } from './protocol.generated.js';
import type { ManagedSourceBinding, ManagedSourceLocalScope, SourceServiceOperation } from '../harness/managed-remote-types.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import { createManagedScheduleOwner, createManagedScheduleService, createKernelManagedScheduleReceipts, createManagedScheduleReconciler, type ManagedScheduleReceipts } from './managed-schedule-service.js';
import { createScheduleToolOwner } from './schedule-tool-owner.js';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const capabilities = ['filesystem:read', 'filesystem:write', 'filesystem:delete', 'config:read', 'config:write', 'terminal:use', 'process:control'];
const task = { name: 'B calendar', runtime: 'agent', enabled: false, execution: { prompt: 'B instruction' },
  schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
  target: { kind: 'new_work', source: { kind: 'project' }, model: { providerId: 'fixture', modelId: 'model', temperature: 0 }, sourceMode: 'fixed_branch', goal: null } };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-managed-schedule-'));
  const targetRoot = path.join(root, 'B', 'same-project'), coordinatorRoot = path.join(root, 'A', 'same-project');
  await fs.mkdir(targetRoot, { recursive: true }); await fs.mkdir(coordinatorRoot, { recursive: true });
  const config = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'B', 'config') });
  const scheduler = createScheduledTasksRuntime({ projectConfigRuntime: config, listProjects: async () => [{ id: 'same-project', path: targetRoot }] });
  const occurrence = { id: 'original-B-occurrence', state: 'preparing', thread_id: 'B-calendar-thread', run_id: null } as CalendarOccurrence;
  const run = vi.fn(async () => occurrence), control = vi.fn(async () => ({ occurrence }));
  scheduler.setCalendarOwner({ sync: async (_id: string, tasks: unknown) => tasks, run, control, stop() {} } as unknown as CalendarOwner);
  const service = createScheduledTaskService({ projectConfigRuntime: config, scheduledTasksRuntime: scheduler,
    readSettingsFromDisk: async () => ({ projects: [{ id: 'same-project', path: targetRoot }] }), sanitizeProjects: value => value as Array<{ id: string; path: string }> });
  cleanups.push(async () => { await scheduler.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const scope: ManagedSourceLocalScope = { principal: { principalId: 'paired-A', capabilities }, coordinatorHostId: 'A', authorityId: 'original-source', resourceEpoch: 'B-epoch',
    scope: { kind: 'run', runId: 'run-A', threadId: 'thread-A', epoch: 1 },
    source: { resource_owner: { kind: 'managed_host', hostId: 'B', connectionId: 'connection-B', endpointIdentity: 'endpoint-B' },
      workspace_id: 'same-workspace', execution_workspace_id: 'same-workspace', mode: 'fixed_branch', branch_id: 'source-branch', revision: 2, live_root: null },
    grant: { pathScopes: [''] } as unknown as ManagedSourceLocalScope['grant'], physicalRoot: null };
  // Only the receipt port is a fixture. Asset persistence, Markdown CAS, service
  // dispatch and the coordinator capability invocation use the real owners.
  const stored = new Map<string, { invocation: ToolInvocationAuthority; receipt: ToolExecutionReceipt | null }>();
  const receipts: ManagedScheduleReceipts = {
    begin: vi.fn(async (_scope, invocation) => {
      const original = stored.get(invocation.operationId);
      if (original) {
        if (!isDeepStrictEqual(original.invocation, invocation)) throw new Error('Original invocation changed');
        return { fresh: false, receipt: original.receipt };
      }
      stored.set(invocation.operationId, { invocation: structuredClone(invocation), receipt: null });
      return { fresh: true, receipt: null };
    }),
    complete: vi.fn(async (_scope, invocation, receipt) => { stored.get(invocation.operationId)!.receipt = structuredClone(receipt); return receipt; }),
  };
  const workspaceRoot = vi.fn(async id => { if (id !== 'same-workspace') throw new Error('Wrong workspace'); return targetRoot; });
  const onReceiptError = vi.fn();
  const target = () => createManagedScheduleService({ service, hostId: 'B', workspaceRoot, receipts, onReceiptError });
  const binding: ManagedSourceBinding = { authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, source: scope.source, physicalRoot: null,
    executionOwner: { kind: 'external', identity: 'source-B-owner', epoch: 'B-epoch' }, capabilities: { tools: [], grantCapabilities: [], clientCapabilities: capabilities, unavailable: [] } };
  let targetHandler = target();
  const client = {
    service: vi.fn(async (input, signal) => targetHandler(scope, input.operation, signal)),
    observe: vi.fn(async input => {
      const original = stored.get(input.operationId);
      return { operationId: input.operationId, resourceEpoch: scope.resourceEpoch, executionOwner: binding.executionOwner,
        accepted: Boolean(original), executorStopped: original?.receipt?.executor_stopped ?? false, result: original?.receipt ?? null };
    }),
  } as unknown as ManagedSourceClient;
  const withRunAuthority = vi.fn(async (_runId, _source, consume) => consume({ client, binding }));
  const managed = createManagedScheduleOwner({ coordinatorHostId: () => 'A', withRunAuthority });
  const localRoot = vi.fn(async () => { throw new Error(`A must not read its same-named directory ${coordinatorRoot}`); });
  const hostOwner = { extensionId: 'schedule-example', entrypointId: 'host', extensionVersion: '1', instanceKey: 'instance', generation: 1 };
  const local = createScheduleToolOwner({ service, workspaceRoot: localRoot, manageManaged: managed });
  let sequence = 0;
  const invocation = (args: unknown): ToolInvocationAuthority => {
    const callId = `call-${++sequence}`;
    return { invocationId: `invocation-${sequence}`, runId: 'run-A', threadId: 'thread-A', operationId: `request:tool:${callId}`, callId,
      source: scope.source, origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'external', identity: 'A-extension', epoch: 'A-epoch' },
      toolName: 'scheduled_task', operation: 'effect', completion: 'result', arguments: args };
  };
  const execute = async (inv: ToolInvocationAuthority, signal = new AbortController().signal) => {
    let receipt: ToolExecutionReceipt | undefined;
    const data = await withToolInvocation({ authority: inv, owner: hostOwner, signal, onEffectReceipt: value => { receipt = value; } },
      async invocation => local('manage', inv.arguments as JsonValue, { invocation, owner: hostOwner, signal } as HostCapabilityCallContext));
    return { data, receipt };
  };
  return { root, targetRoot, coordinatorRoot, scope, config, service, run, control, receipts, stored, target, client, binding, managed, localRoot, workspaceRoot,
    invocation, execute, withRunAuthority, onReceiptError, reopen: () => { targetHandler = target(); } };
}

it('manages B project assets through the original A invocation and B occurrence owner, never a same-named A directory', async () => {
  const f = await fixture();
  const saved = await f.execute(f.invocation({ action: 'upsert', task }));
  expect(saved.receipt).toMatchObject({ executor_stopped: true, completion: { outcome: 'succeeded', effect: 'confirmed' } });
  const [original] = await f.config.listScheduledTasks('same-project');
  expect(original!.name).toBe('B calendar');
  expect(await f.execute(f.invocation({ action: 'list' }))).toMatchObject({ data: { tasks: [expect.objectContaining({ id: original!.id })] } });
  expect(await f.execute(f.invocation({ action: 'get', taskId: original!.id }))).toMatchObject({ data: { task: { id: original!.id } } });
  const run = f.invocation({ action: 'run', taskId: original!.id });
  expect(await f.execute(run)).toMatchObject({ data: { runtime: 'agent', occurrence: { id: 'original-B-occurrence' } } });
  expect(f.run).toHaveBeenCalledWith('same-project', original!.id, run.operationId);
  await f.execute(f.invocation({ action: 'cancel_occurrence', taskId: original!.id, occurrenceId: 'original-B-occurrence', occurrenceRevision: 3 }));
  expect(f.control).toHaveBeenCalledWith('same-project', original!.id, 'original-B-occurrence', 3, 'cancel');
  expect(f.localRoot).not.toHaveBeenCalled();
  expect(await fs.readdir(f.coordinatorRoot)).toEqual([]);
});

it('reads and CAS-edits the original B Markdown loop without turning a stale revision into a write', async () => {
  const f = await fixture(); const loops = path.join(f.targetRoot, '.agents', 'loops'); await fs.mkdir(loops, { recursive: true });
  const file = path.join(loops, 'weekly.md');
  const content = `---\nname: Original loop\nruntime: agent\nschedule: "0 9 * * 1"\ntimezone: UTC\nenabled: false\ntarget: ${JSON.stringify(task.target)}\n---\nOriginal body\n`;
  await fs.writeFile(file, content);
  const listed = await f.execute(f.invocation({ action: 'list' }));
  const tasks = (listed.data as { tasks: Array<{ id: string; loopFile?: string }> }).tasks;
  const id = tasks.find(task => task.loopFile === file)!.id;
  const read = await f.execute(f.invocation({ action: 'read_loop', taskId: id }));
  const document = (read.data as { document: { revision: string; content: string; path: string } }).document;
  expect(document).toMatchObject({ path: file, content });
  const changed = content.replace('Original body', 'B updated body');
  expect(await f.execute(f.invocation({ action: 'write_loop', taskId: id, content: changed, expectedRevision: document.revision })))
    .toMatchObject({ receipt: { completion: { effect: 'confirmed' } } });
  expect(await f.execute(f.invocation({ action: 'write_loop', taskId: id, content, expectedRevision: document.revision })))
    .toMatchObject({ receipt: { completion: { outcome: 'failed', effect: 'none' } } });
  expect(await fs.readFile(file, 'utf8')).toBe(changed);
});

it('rejects changed source/Run, file-only permissions and narrow paths before touching the project owner', async () => {
  const f = await fixture(); const handler = f.target();
  const request = (invocation: ToolInvocationAuthority): SourceServiceOperation => ({ kind: 'schedule', invocation });
  const read = f.invocation({ action: 'list' });
  for (const invocation of [{ ...read, runId: 'other-run' }, { ...read, source: { ...read.source!, revision: 4 } }, { ...read, operationId: 'unrelated-operation' },
    { ...read, arguments: { action: 'list', directory: f.coordinatorRoot } }]) {
    expect(await handler(f.scope, request(invocation))).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
  }
  expect(await handler({ ...f.scope, principal: { ...f.scope.principal, capabilities: ['filesystem:read'] } }, request(read)))
    .toMatchObject({ completion: { effect: 'none', outcome: 'failed' } });
  expect(await handler({ ...f.scope, grant: { ...f.scope.grant, pathScopes: ['src'] } }, request(read)))
    .toMatchObject({ completion: { effect: 'none', outcome: 'failed' } });
  expect(f.workspaceRoot).not.toHaveBeenCalled(); expect(f.receipts.begin).not.toHaveBeenCalled();
  const readOnly = { ...f.scope, principal: { ...f.scope.principal, capabilities: ['filesystem:read', 'config:read'] } };
  expect(await handler(readOnly, request(read))).toMatchObject({ completion: { outcome: 'succeeded', effect: 'none' } });
  expect(await handler(readOnly, request(f.invocation({ action: 'upsert', task })))).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
});

it('recalls completed receipts after a lost response and never replays a started or uncertain mutation after Host reopening', async () => {
  const f = await fixture(); const invoke = f.invocation({ action: 'upsert', task });
  const originalUpsert = f.service.upsert.bind(f.service);
  const service = vi.spyOn(f.service, 'upsert');
  const original = f.client.service.bind(f.client);
  vi.mocked(f.client.service).mockImplementationOnce(async (...args) => { await original(...args); f.reopen(); throw new Error('Response lost'); });
  expect(await f.execute(invoke)).toMatchObject({ receipt: { completion: { outcome: 'succeeded', effect: 'confirmed' } } });
  expect(f.client.observe).toHaveBeenCalledTimes(1); expect(service).toHaveBeenCalledTimes(1);
  expect(await f.target()(f.scope, { kind: 'schedule', invocation: invoke })).toMatchObject({ completion: { effect: 'confirmed' } });
  expect(service).toHaveBeenCalledTimes(1);
  const pending = f.invocation({ action: 'upsert', task: { ...task, name: 'Must not replay' } });
  await f.receipts.begin(f.scope, pending); f.reopen();
  expect(await f.execute(pending)).toMatchObject({ receipt: { executor_stopped: false, completion: { outcome: 'indeterminate', effect: 'unknown' } } });
  expect(service).toHaveBeenCalledTimes(1);
  service.mockImplementationOnce(async (...args) => { await originalUpsert(...args); throw new Error('Calendar response uncertain after persisted write'); });
  const uncertain = f.invocation({ action: 'upsert', task: { ...task, name: 'Actually saved' } });
  expect(await f.execute(uncertain)).toMatchObject({ receipt: { executor_stopped: true, completion: { effect: 'unknown' } } });
  f.reopen(); await f.execute(uncertain);
  expect(service).toHaveBeenCalledTimes(2);
  expect((await f.config.listScheduledTasks('same-project')).some(value => value.name === 'Actually saved')).toBe(true);
});

it('joins an entered asset writer through cancellation and retains its real completion when receipt publication fails', async () => {
  const f = await fixture(), controller = new AbortController();
  let finish!: () => void;
  const release = new Promise<void>(resolve => { finish = resolve; });
  const original = f.service.upsert.bind(f.service);
  const upsert = vi.spyOn(f.service, 'upsert').mockImplementation(async (...args) => { await release; return original(...args); });
  const invocation = f.invocation({ action: 'upsert', task });
  let returned = false;
  const work = f.execute(invocation, controller.signal).then(value => { returned = true; return value; });
  await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
  controller.abort(); await Promise.resolve(); expect(returned).toBe(false);
  vi.mocked(f.receipts.complete).mockRejectedValueOnce(new Error('Receipt storage unavailable'));
  finish();
  expect(await work).toMatchObject({ receipt: { executor_stopped: true, completion: { outcome: 'succeeded', effect: 'confirmed' } } });
  expect(f.onReceiptError).toHaveBeenCalledWith(invocation.operationId, expect.any(Error));
  expect((await f.config.listScheduledTasks('same-project'))[0]!.name).toBe('B calendar');
});

it('a lost service and unconfirmed original receipt remain unknown without a second dispatch', async () => {
  const f = await fixture();
  vi.mocked(f.client.service).mockRejectedValue(new Error('Disconnected'));
  vi.mocked(f.client.observe).mockRejectedValue(new Error('Original owner unavailable'));
  expect(await f.execute(f.invocation({ action: 'remove', taskId: 'old-task' })))
    .toMatchObject({ receipt: { executor_stopped: false, completion: { outcome: 'indeterminate', effect: 'unknown' } } });
  expect(f.client.service).toHaveBeenCalledOnce(); expect(f.client.observe).toHaveBeenCalledOnce(); expect(f.localRoot).not.toHaveBeenCalled();
});


it('retries only original receipt publication on its authority cleanup and kernel readiness', async () => {
  const f = await fixture();
  const known: ToolExecutionReceipt = { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: { saved: true }, parts: [] } } };
  let ready!: () => void, fail = true;
  const calls: Array<{ action: string; operationId?: string; authorityId?: string }> = [];
  const sourceRequest = vi.fn(async (_method: string, input: { action: string; operationId?: string; authorityId?: string; receipt?: unknown }) => {
    calls.push(input);
    if (input.action === 'begin') return { fresh: true, receipt: null };
    if (fail) throw new Error('Storage temporarily unavailable');
    return input.receipt;
  });
  const port = createKernelManagedScheduleReceipts({ sourceRequest, subscribeReady: (listener: () => void) => { ready = listener; return () => {}; } } as never, vi.fn());
  const invocation = f.invocation({ action: 'upsert', task });
  await expect(port.complete(f.scope, invocation, known)).rejects.toThrow('temporarily');
  await port.flush({ ...f.scope, authorityId: 'unrelated-authority' });
  expect(calls).toHaveLength(1);
  fail = false;
  await port.flush(f.scope);
  expect(calls.map(value => value.action)).toEqual(['finish', 'finish']);
  await port.flush(f.scope); expect(calls).toHaveLength(2);
  fail = true;
  const next = f.invocation({ action: 'remove', taskId: 'other' });
  await expect(port.complete(f.scope, next, known)).rejects.toThrow('temporarily');
  fail = false; ready();
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  await port.dispose();
  expect(calls.every(value => value.action === 'finish')).toBe(true);
});


it('rejects a withdrawn original Run binding before dispatch without inventing unknown effects', async () => {
  const f = await fixture();
  f.withRunAuthority.mockRejectedValueOnce(new Error('Original Source retired'));
  expect(await f.execute(f.invocation({ action: 'run', taskId: 'old-task' })))
    .toMatchObject({ receipt: { executor_stopped: true, completion: { outcome: 'failed', effect: 'none' } } });
  expect(f.client.service).not.toHaveBeenCalled(); expect(f.client.observe).not.toHaveBeenCalled();
});


it('keeps a lost durable begin acknowledgement unknown and does not dispatch or finish its action', async () => {
  const f = await fixture(), invocation = f.invocation({ action: 'upsert', task });
  vi.mocked(f.receipts.begin).mockImplementationOnce(async () => {
    f.stored.set(invocation.operationId, { invocation: structuredClone(invocation), receipt: null });
    throw new Error('Durable begin acknowledgement lost');
  });
  expect(await f.execute(invocation)).toMatchObject({ receipt: { executor_stopped: false,
    completion: { outcome: 'indeterminate', effect: 'unknown' } } });
  expect(f.workspaceRoot).not.toHaveBeenCalled(); expect(f.receipts.complete).not.toHaveBeenCalled();
  f.reopen();
  expect(await f.execute(invocation)).toMatchObject({ receipt: { executor_stopped: false,
    completion: { outcome: 'indeterminate', effect: 'unknown' } } });
  expect(await f.config.listScheduledTasks('same-project')).toEqual([]);
  expect(f.workspaceRoot).not.toHaveBeenCalled(); expect(f.receipts.complete).not.toHaveBeenCalled();
});

it('reconciles only original unknown unstopped schedule calls with their saved executor identity', async () => {
  const executionOwner = { kind: 'external', identity: 'original-extension-owner', epoch: 'original-epoch' };
  const original = { id: 'original-request:tool:schedule', run_id: 'historical-run', effect: 'unknown',
    execution_owner: executionOwner, external_receipt: { executor_stopped: false }, intent: { call: { name: 'scheduled_task' } } };
  const signal = new AbortController().signal;
  const request = vi.fn(async (method: string, params: unknown, observedSignal: AbortSignal) => {
    expect(observedSignal).toBe(signal);
    if (method === 'runtime.thread.list') return [{ thread_id: 'original-thread', branches: [], parent_thread_id: null, observer_project_ids: [] }];
    if (method === 'runtime.thread.operations.active') {
      expect(params).toEqual({ threadId: 'original-thread' });
      return [original,
        { ...original, id: 'other-tool', intent: { call: { name: 'integrate_child' } } },
        { ...original, id: 'known-schedule', effect: 'confirmed' },
        { ...original, id: 'stopped-schedule', external_receipt: { executor_stopped: true } },
        { ...original, id: 'no-external-owner', execution_owner: null },
        { ...original, id: 'kernel-owner', execution_owner: { kind: 'kernel' } }];
    }
    if (method === 'runtime.host_tool.reconcile') return { reconciled: [original.id], unresolved: [] };
    throw new Error(`Unexpected source admission, replay or unrelated query: ${method}`);
  });
  const runtime = new AgentRuntimeClient({ agentRuntimeRequest: request, subscribeExit: () => () => {}, onToolReleased: () => {} } as unknown as KernelClient);
  const onError = vi.fn();
  await createManagedScheduleReconciler({ runtime, onError })(signal);
  expect(request.mock.calls).toEqual([
    ['runtime.thread.list', {}, signal],
    ['runtime.thread.operations.active', { threadId: 'original-thread' }, signal],
    ['runtime.host_tool.reconcile', { operationId: original.id, executionOwner }, signal],
  ]);
  expect(onError).not.toHaveBeenCalled();
});
