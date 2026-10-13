/** Original target MCP Task references. Catalog and Task scheduling stay on the coordinator. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { McpAuthorityLease, McpTaskLease, McpTaskResponse } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { SourceAuthorityAddress, SourceMcpHolderBinding, SourceMcpHolder, SourceMcpCreationOutcome,
  SourceMcpCreationReceiptResult, SourceMcpHolderResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedMcpTaskAction, ManagedMcpTaskCreationReceipt } from './managed-mcp-contract.js';

type Scope = Pick<ManagedSourceCleanupScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
export type ManagedMcpTaskFailure = Extract<SourceMcpCreationOutcome, { kind: 'failed' }>['error'];
export function mcpTaskFailure(error: unknown, dispatchedFallback = false): ManagedMcpTaskFailure {
  const e = error as Partial<ManagedMcpTaskFailure> & { kind?: string } | null;
  const taskKind = e?.taskKind ?? e?.kind;
  return { code: typeof e?.code === 'string' ? e.code : 'mcp_task_source_unavailable', dispatched: typeof e?.dispatched === 'boolean' ? e.dispatched : dispatchedFallback,
    settlement: e?.settlement === 'rpc_response' || e?.settlement === 'session_expired' ? e.settlement : 'unknown',
    ...(['protocol', 'transport', 'unsupported', 'owner'].includes(taskKind ?? '') ? { taskKind: taskKind as NonNullable<ManagedMcpTaskFailure['taskKind']> } : {}),
    ...(typeof e?.rpcCode === 'number' ? { rpcCode: e.rpcCode } : {}),
    ...(e?.protocolError ? { protocolError: e.protocolError } : {}), ...(e?.interactionProblem ? { interactionProblem: e.interactionProblem } : {}) };
}
function failure(code: string, dispatched = false): never {
  throw Object.assign(new Error(code), { code, dispatched, taskKind: 'owner', settlement: 'unknown' });
}
function outcomeValue(outcome: SourceMcpCreationOutcome | null): McpTaskResponse {
  if (!outcome) return failure('mcp_task_original_creation_unknown', true);
  if (outcome.kind === 'failed') throw Object.assign(new Error(outcome.error.code), outcome.error);
  if (outcome.kind !== 'accepted') return failure('mcp_task_original_identity_unavailable');
  return outcome.response;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function createManagedMcpTasks(options: {
  kernel: Pick<KernelClient, 'sourceRequest'>;
  view(scope: Scope, handleId: string, signal: AbortSignal): Promise<{ lease: McpAuthorityLease; beforeDispatch(): Promise<void> }>;
}) {
  interface Entry { binding: SourceMcpHolderBinding; requestHash: string; lease?: McpTaskLease;
    work: Promise<McpTaskResponse>; outcome?: SourceMcpCreationOutcome; settled?: boolean; controller: AbortController; released: boolean; controls: Set<Promise<unknown>>; }
  const entries = new Map<string, Entry>();
  const address = (scope: Scope): SourceAuthorityAddress => ({ principalId: scope.principal.principalId,
    coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  const scopeKey = (scope: Scope) => JSON.stringify(Object.values(address(scope)));
  const key = (scope: Scope, binding: SourceMcpHolderBinding) => `${scopeKey(scope)}:${binding.operationId}`;
  const inspect = async (scope: Scope, binding: SourceMcpHolderBinding) => options.kernel.sourceRequest<SourceMcpCreationReceiptResult>(
    'source.mcp.creation_receipt', { ...address(scope), binding, action: 'inspect' });
  const entry = (scope: Scope, binding: SourceMcpHolderBinding) => {
    const original = entries.get(key(scope, binding));
    if (original && !isDeepStrictEqual(original.binding, binding)) failure('mcp_task_holder_changed');
    return original;
  };
  return {
    async prepare(scope: Scope, handleId: string, server: string, endpoint: SourceMcpHolderBinding['endpoint'] | undefined, signal: AbortSignal) {
      const view = await options.view(scope, handleId, signal);
      const lease = await view.lease.taskOwner(server, endpoint, signal);
      try { await view.beforeDispatch(); return lease.endpoint; } finally { lease.release(); }
    },
    async start(scope: Scope, action: Extract<ManagedMcpTaskAction, { kind: 'task_start' }>, signal: AbortSignal): Promise<McpTaskResponse> {
      const { binding } = action;
      if (binding.purpose !== 'task') return failure('mcp_task_holder_changed');
      const requestHash = createHash('sha256').update(stable([action.name, action.schemaVersion, action.arguments, action.ttl ?? null])).digest('hex');
      const prior = entry(scope, binding);
      if (prior) {
        if (prior.requestHash !== requestHash) return failure('mcp_task_creation_changed');
        return prior.work;
      }
      const id = key(scope, binding), controller = new AbortController();
      const selected: Entry = { binding, requestHash, controller, released: false, controls: new Set(), work: undefined as never };
      entries.set(id, selected);
      selected.work = (async () => {
        let began = false;
        try {
          const active = AbortSignal.any([signal, controller.signal]);
          const view = await options.view(scope, action.handleId, active);
          const lease = await view.lease.taskOwner(binding.endpoint.server, binding.endpoint, active);
          selected.lease = lease;
          if (selected.released) return failure('mcp_task_holder_released');
          const original = await options.kernel.sourceRequest<SourceMcpCreationReceiptResult>('source.mcp.creation_receipt', {
            ...address(scope), binding, requestHash, action: 'begin' });
          if (!original.dispatch) {
            lease.release(); delete selected.lease;
            return outcomeValue(original.outcome);
          }
          began = true;
          let outcome: SourceMcpCreationOutcome;
          try {
            const response = await lease.start(action.name, action.arguments, { schemaVersion: action.schemaVersion,
              signal: active, interaction: { operationId: binding.operationId, executionOwner: binding.executionOwner }, ...(action.ttl === undefined ? {} : { ttl: action.ttl }), beforeDispatch: async () => {
                await view.beforeDispatch();
                const current = await options.kernel.sourceRequest<{ holder: SourceMcpHolder }>('source.mcp.holder', {
                  ...address(scope), binding, action: 'retain' });
                if (current.holder.released || selected.released) failure('mcp_task_holder_released');
              } });
            lease.bindInteraction?.(response.task.taskId, { operationId: binding.operationId, executionOwner: binding.executionOwner });
            outcome = { kind: 'accepted', response };
          } catch (error) { outcome = { kind: 'failed', error: mcpTaskFailure(error, true) }; }
          // An interrupted requester cannot discard the original response before Storage
          // owns it. A later inspect may recall this response, never repeat tools/call.
          selected.outcome = outcome;
          try { await options.kernel.sourceRequest('source.mcp.creation_receipt', { ...address(scope), binding,
            requestHash, action: 'settle', outcome }); selected.settled = true; }
          catch { failure('mcp_task_creation_receipt_pending', outcome.kind === 'accepted' || outcome.error.dispatched); }
          return outcomeValue(outcome);
        } finally {
          if (!began || selected.released) { selected.lease?.release(); delete selected.lease; }
          // Retain the original SDK holder for both acceptance and uncertain creation.
          // An explicit original-holder release or Source revoke owns its cleanup.
        }
      })();
      void selected.work.catch(() => undefined);
      return selected.work;
    },
    async inspect(scope: Scope, binding: SourceMcpHolderBinding, fenceUnstarted = false, signal?: AbortSignal): Promise<{ receipt: ManagedMcpTaskCreationReceipt | null; live: boolean; released: boolean }> {
      if (fenceUnstarted) await options.kernel.sourceRequest('source.mcp.holder', { ...address(scope), binding, action: 'release_unstarted' });
      const selected = entry(scope, binding);
      if (selected) await new Promise<void>((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else void selected.work.then(finish, finish);
      });
      if (selected?.outcome && !selected.settled) {
        try { await options.kernel.sourceRequest('source.mcp.creation_receipt', { ...address(scope), binding,
          requestHash: selected.requestHash, action: 'settle', outcome: selected.outcome }); selected.settled = true; }
        catch { failure('mcp_task_creation_receipt_pending', selected.outcome.kind === 'accepted' || selected.outcome.kind === 'failed' && selected.outcome.error.dispatched); }
      }
      const original = await inspect(scope, binding);
      return { receipt: original.holder.creationReceipt ? { requestHash: original.holder.creationReceipt.requestHash, outcome: original.outcome } : null, released: original.holder.released,
        live: !!selected?.lease && !selected.released };
    },
    async control(scope: Scope, action: Extract<ManagedMcpTaskAction, { kind: 'task_get' | 'task_result' | 'task_cancel' }>, signal: AbortSignal) {
      const original = await options.kernel.sourceRequest<SourceMcpHolderResult>('source.mcp.holder', {
        ...address(scope), binding: action.binding, action: 'inspect' });
      if (action.kind !== 'task_cancel' && original.grantState !== 'active') return failure('mcp_task_original_owner_revoked');
      const selected = entry(scope, action.binding), receipt = selected?.outcome;
      if (!selected?.lease || selected.released) return failure('mcp_task_original_transport_unavailable');
      if (!selected.settled || !original.holder.creationReceipt?.outcomeRef || original.holder.released || receipt?.kind !== 'accepted' || receipt.response.task.taskId !== action.taskId)
        return failure('mcp_task_original_identity_unavailable');
      const active = AbortSignal.any([signal, selected.controller.signal]);
      const work = action.kind === 'task_get' ? selected.lease.get(action.taskId, active)
        : action.kind === 'task_result' ? selected.lease.result(action.taskId, active) : selected.lease.cancel(action.taskId, active);
      selected.controls.add(work);
      try { return await work; } finally { selected.controls.delete(work); }
    },
    async release(scope: Scope, binding: SourceMcpHolderBinding) {
      const selected = entry(scope, binding);
      // Storage's tombstone fences even a delayed first start after this request.
      const result = await options.kernel.sourceRequest<{ authority: { phase: string } }>('source.mcp.holder', { ...address(scope), binding, action: 'release' });
      if (selected) { selected.released = true; selected.controller.abort();
        await Promise.allSettled([selected.work, ...selected.controls]); selected.lease?.release(); delete selected.lease;
        entries.delete(key(scope, binding)); }
      // This proves local SDK callbacks detached, never that a remote Task stopped.
      return { retire: result.authority.phase === 'draining', controlsDrained: true };
    },
    async close(scope: Scope) {
      // Explicit Source revocation/Host shutdown must release SDK retention before
      // composition drain. Native Source retirement still owns physical stop proof.
      const prefix = `${scopeKey(scope)}:`;
      const selected = [...entries].filter(([id]) => id.startsWith(prefix));
      for (const [, e] of selected) { e.released = true; e.controller.abort(); }
      await Promise.allSettled(selected.flatMap(([, e]) => [e.work, ...e.controls]));
      for (const [id, e] of selected) { e.lease?.release(); entries.delete(id); }
    },
  };
}
