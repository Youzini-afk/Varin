/** Project schedules stay on their actual asset Host. The original Source receipt
 * fences dispatch; this adapter owns neither a calendar nor a second Run ledger. */
import { isDeepStrictEqual } from 'node:util';
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope, ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';
import type { ManagedSourceConsumerOptions } from './managed-source-consumers.js';
import { resourceThreadSource } from './thread-context.js';
import { toolOperationId, validToolOrigin, type SourceScheduleToolReceipt } from './protocol.generated.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { executeProjectSchedule, scheduleFailure, scheduleManagementInput, type ScheduleManagementInput, type ScheduleToolOwnerOptions } from './schedule-tool-owner.js';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export type ScheduleToolReceipt = SourceScheduleToolReceipt & { completion: { content: { data: JsonValue; parts: [] } } };
export function parseScheduleReceipt(value: unknown): ScheduleToolReceipt {
  if (!record(value) || typeof value.executor_stopped !== 'boolean' || !record(value.completion)
    || value.completion.kind !== 'result' || !['succeeded', 'failed', 'indeterminate'].includes(String(value.completion.outcome))
    || !['none', 'confirmed', 'unknown'].includes(String(value.completion.effect)) || !record(value.completion.content)
    || !Array.isArray(value.completion.content.parts) || value.completion.content.parts.length !== 0
    || value.completion.effect === 'unknown' && value.completion.outcome !== 'indeterminate'
    || !value.executor_stopped && (value.completion.effect !== 'unknown' || value.completion.outcome !== 'indeterminate')) {
    throw new Error('Original project schedule receipt is unconfirmed');
  }
  const content = value.completion.content;
  return { executor_stopped: value.executor_stopped, completion: {
    kind: 'result', outcome: value.completion.outcome as 'succeeded' | 'failed' | 'indeterminate',
    effect: value.completion.effect as 'none' | 'confirmed' | 'unknown',
    content: { data: parseVarinToolJson(content.data as JsonValue), parts: [] },
  } };
}

/** Storage supplies the atomic first-dispatch fence and immutable original receipt.
 * A started operation without a receipt can only remain unknown, never be replayed. */
export interface ManagedScheduleReceipts {
  begin(scope: ManagedSourceLocalScope, invocation: ToolInvocationAuthority): Promise<{ fresh: boolean; receipt: ToolExecutionReceipt | null }>;
  complete(scope: ManagedSourceLocalScope, invocation: ToolInvocationAuthority, receipt: ToolExecutionReceipt): Promise<ToolExecutionReceipt>;
}
export interface ManagedScheduleServiceOptions extends Pick<ScheduleToolOwnerOptions, 'service' | 'workspaceRoot'> {
  hostId: string;
  receipts: ManagedScheduleReceipts;
  onReceiptError(operationId: string, error: unknown): void;
}

/** Configuration rights cover the existing project and user-loop configuration.
 * Physical Markdown writes/deletion and execution additionally retain their own
 * paired-client permissions. A file-only grant does not grant scheduled execution. */
function authorizeSchedule(scope: ManagedSourceLocalScope, params: ScheduleManagementInput): void {
  const permissions = new Set(scope.principal.capabilities);
  const required = ['filesystem:read', 'config:read'];
  switch (params.action) {
    case 'list': case 'get': case 'status': case 'read_loop': break;
    case 'upsert': case 'write_loop':
      required.push('config:write', 'filesystem:write', 'terminal:use', 'process:control'); break;
    case 'set_enabled':
      required.push('config:write', 'filesystem:write');
      if (params.enabled === true) required.push('terminal:use', 'process:control');
      break;
    case 'remove': required.push('config:write'); break;
    case 'remove_loop': required.push('config:write', 'filesystem:delete'); break;
    case 'cancel_occurrence': required.push('config:write', 'process:control'); break;
    case 'run': case 'retry_occurrence': case 'retry_calculation': required.push('config:write', 'terminal:use', 'process:control'); break;
    default: throw new Error('Unknown scheduled task action');
  }
  if (required.some(permission => !permissions.has(permission))) throw new Error('The target Host has not granted the required project schedule permissions');
  // The existing scheduler discovers project-wide assets and their user-level
  // overrides. It cannot be represented as a selected-file Source reader.
  if (!scope.grant.pathScopes.includes('')) throw new Error('Project schedules require whole-project Source access');
}
export function createManagedScheduleService(options: ManagedScheduleServiceOptions): ManagedSourceServiceHandler {
  return async (scope, operation, suppliedSignal) => {
    if (operation.kind !== 'schedule') throw new Error('Unsupported project schedule service');
    const invocation = operation.invocation;
    let original: Awaited<ReturnType<ManagedScheduleReceipts['begin']>>;
    let params: ScheduleManagementInput;
    try {
      if (!record(invocation) || scope.scope.kind !== 'run' || scope.scope.runId !== invocation.runId || scope.scope.threadId !== invocation.threadId
        || scope.source.resource_owner.kind !== 'managed_host' || scope.source.resource_owner.hostId !== options.hostId
        || !isDeepStrictEqual(scope.source, invocation.source) || invocation.toolName !== 'scheduled_task'
        || invocation.operation !== 'effect' || invocation.completion !== 'result'
        || typeof invocation.invocationId !== 'string' || !invocation.invocationId || typeof invocation.callId !== 'string' || !invocation.callId
        || !validToolOrigin(invocation.origin) || toolOperationId(invocation.origin, invocation.callId) !== invocation.operationId
        || invocation.origin.kind === 'policy_action' && invocation.origin.node_id !== invocation.callId
        || !record(invocation.executorOwner) || invocation.executorOwner.kind !== 'external'
        || typeof invocation.executorOwner.identity !== 'string' || !invocation.executorOwner.identity
        || typeof invocation.executorOwner.epoch !== 'string' || !invocation.executorOwner.epoch) {
        throw new Error('Project schedule differs from its original source or invocation');
      }
      params = scheduleManagementInput(invocation.arguments);
      authorizeSchedule(scope, params);
      suppliedSignal?.throwIfAborted();
    } catch (error) { return scheduleFailure(error); }
    try { original = await options.receipts.begin(scope, invocation); }
    catch (error) {
      // The original durable begin may already exist, or another original caller
      // may own execution. A lost admission ACK proves neither no-effect nor stop.
      return scheduleFailure(error, true, false);
    }
    if (!original.fresh) return original.receipt ? parseScheduleReceipt(original.receipt)
      : scheduleFailure(new Error('The original project schedule operation has no confirmed receipt; it was not replayed'), true, false);
    let receipt: ToolExecutionReceipt;
    try {
      const projectId = await options.service.resolveProjectID({ directory: await options.workspaceRoot(scope.source.workspace_id) });
      receipt = await executeProjectSchedule(options.service, projectId, invocation.operationId, params, suppliedSignal ?? new AbortController().signal);
    } catch (error) { receipt = scheduleFailure(error); }
    // No late cancellation or trust check may discard a returned effect. Storage
    // publication is joined independently of the request's cancelled observer.
    try { return parseScheduleReceipt(await options.receipts.complete(scope, invocation, receipt)); }
    catch (error) {
      options.onReceiptError(invocation.operationId, error);
      return receipt;
    }
  };
}

export function createManagedScheduleOwner(options: Pick<ManagedSourceConsumerOptions, 'coordinatorHostId' | 'withRunAuthority'>): NonNullable<ScheduleToolOwnerOptions['manageManaged']> {
  return async (invocation, signal) => {
    let dispatched = false, returned: ToolExecutionReceipt | undefined;
    try {
      if (!invocation.source || invocation.source.resource_owner.kind !== 'managed_host') throw new Error('Original managed project source is required');
      const source = resourceThreadSource(invocation.source)!;
      return await options.withRunAuthority(invocation.runId, source, async access => {
        if (!isDeepStrictEqual(access.binding.source, invocation.source)) throw new Error('Project schedule source changed after admission');
        const address = { coordinatorHostId: options.coordinatorHostId(), authorityId: access.binding.authorityId, resourceEpoch: access.binding.resourceEpoch };
        signal.throwIfAborted();
        dispatched = true;
        try {
          returned = parseScheduleReceipt(await access.client.service({ ...address, requestId: `schedule:${invocation.operationId}`,
            operation: { kind: 'schedule', invocation } }, signal));
        } catch (error) {
          try {
            // Observation is safe after cancellation, retirement or a lost response.
            // It reads only the original durable receipt, never resends the action.
            const original = await access.client.observe({ ...address, operationId: invocation.operationId });
            if (original.operationId !== invocation.operationId || original.resourceEpoch !== address.resourceEpoch
              || !isDeepStrictEqual(original.executionOwner, access.binding.executionOwner) || original.accepted !== true
              || typeof original.executorStopped !== 'boolean') throw new Error('Project schedule receipt owner changed');
            const receipt = parseScheduleReceipt(original.result);
            if (receipt.executor_stopped !== original.executorStopped) throw new Error('Project schedule receipt drain differs');
            returned = receipt;
          } catch { returned = scheduleFailure(error, true, false); }
        }
        return returned;
      }, signal);
    } catch (error) { return returned ?? scheduleFailure(error, dispatched, !dispatched); }
  };
}


/** Retains only returned, not-yet-published callback results. Recovery retries the
 * same finish acknowledgement, never the scheduled asset action. Storage remains
 * the durable owner; losing this Host heap leaves an uncompleted begin unknown. */
export function createKernelManagedScheduleReceipts(kernel: Pick<KernelClient, 'sourceRequest' | 'subscribeReady'>,
  onError: (operationId: string, error: unknown) => void): ManagedScheduleReceipts & { flush(scope?: ManagedSourceCleanupScope | ManagedSourceLocalScope): Promise<void>; dispose(): Promise<void> } {
  const address = (scope: ManagedSourceCleanupScope | ManagedSourceLocalScope) => ({ principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
    authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  type Pending = { address: ReturnType<typeof address>; invocation: ToolInvocationAuthority; receipt: ScheduleToolReceipt; work?: Promise<ToolExecutionReceipt> };
  const pending = new Map<string, Pending>();
  const authorities = new Map<string, Set<string>>();
  const key = (scope: ManagedSourceLocalScope, invocation: ToolInvocationAuthority) => JSON.stringify([address(scope), invocation.operationId]);
  const publish = (id: string, entry: Pending): Promise<ToolExecutionReceipt> => {
    if (entry.work) return entry.work;
    const work = Promise.resolve().then(async () => {
      const result = parseScheduleReceipt(await kernel.sourceRequest('source.schedule.receipt', { ...entry.address,
        action: 'finish', operationId: entry.invocation.operationId, receipt: entry.receipt }));
      if (!isDeepStrictEqual(result, entry.receipt)) throw new Error('Original project schedule publication changed its receipt');
      if (pending.get(id) === entry) {
        pending.delete(id);
        const owner = JSON.stringify(entry.address), entries = authorities.get(owner);
        entries?.delete(id); if (!entries?.size) authorities.delete(owner);
      }
      return result;
    }).finally(() => { delete entry.work; });
    entry.work = work;
    return work;
  };
  const flush = async (scope?: ManagedSourceCleanupScope | ManagedSourceLocalScope) => {
    const selected: Array<[string, Pending]> = scope
      ? [...(authorities.get(JSON.stringify(address(scope))) ?? [])].flatMap(id => { const entry = pending.get(id); return entry ? [[id, entry] as [string, Pending]] : []; })
      : [...pending];
    const settled = await Promise.allSettled(selected.map(async ([id, entry]) => {
      try { await publish(id, entry); }
      catch (error) { onError(entry.invocation.operationId, error); throw error; }
    }));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Original project schedule receipt publication is pending');
  };
  const unsubscribe = kernel.subscribeReady(() => { void flush().catch(() => undefined); });
  return {
    async begin(scope, invocation) {
      const id = key(scope, invocation), original = pending.get(id);
      if (original) {
        if (!isDeepStrictEqual(original.invocation, invocation)) throw new Error('Original project schedule invocation changed');
        try { await publish(id, original); } catch (error) { onError(invocation.operationId, error); }
        return { fresh: false, receipt: original.receipt };
      }
      const result = await kernel.sourceRequest<{ fresh: boolean; receipt: ToolExecutionReceipt | null }>('source.schedule.receipt',
        { ...address(scope), action: 'begin', invocation });
      if (!record(result) || typeof result.fresh !== 'boolean' || result.fresh && result.receipt !== null) throw new Error('Original project schedule admission is unconfirmed');
      return { fresh: result.fresh, receipt: result.receipt === null ? null : parseScheduleReceipt(result.receipt) };
    },
    async complete(scope, invocation, receipt) {
      const id = key(scope, invocation), result = parseScheduleReceipt(receipt);
      let entry = pending.get(id);
      if (entry && (!isDeepStrictEqual(entry.invocation, invocation) || !isDeepStrictEqual(entry.receipt, result))) throw new Error('Original project schedule receipt changed');
      if (!entry) {
        entry = { address: address(scope), invocation: structuredClone(invocation), receipt: structuredClone(result) }; pending.set(id, entry);
        const owner = JSON.stringify(entry.address);
        let entries = authorities.get(owner); if (!entries) { entries = new Set(); authorities.set(owner, entries); } entries.add(id);
      }
      return publish(id, entry);
    },
    flush,
    async dispose() { unsubscribe(); await flush(); },
  };
}


/** Driven by the existing startup/Source reconnect owner. Catalog resolves the
 * original saved Source and receipt; this never re-admits or replays an action. */
export function createManagedScheduleReconciler(options: {
  runtime: Pick<AgentRuntimeClient, 'threads' | 'activeOperations' | 'reconcileHostTool'>;
  onError(operationId: string | undefined, error: unknown): void;
}): (signal: AbortSignal) => Promise<void> {
  return async signal => {
    const threads = await options.runtime.threads(signal);
    await Promise.all(threads.map(async thread => {
      const operations = await options.runtime.activeOperations(thread.thread_id, undefined, signal);
      await Promise.all(operations.map(async operation => {
        if (operation.effect !== 'unknown' || operation.external_receipt?.executor_stopped === true
          || operation.execution_owner?.kind !== 'external' || !record(operation.intent)
          || !record(operation.intent.call) || operation.intent.call.name !== 'scheduled_task') return;
        try {
          signal.throwIfAborted();
          await options.runtime.reconcileHostTool({ operationId: operation.id, executionOwner: operation.execution_owner }, signal);
        } catch (error) { if (!signal.aborted) options.onError(operation.id, error); }
      }));
    }));
  };
}
