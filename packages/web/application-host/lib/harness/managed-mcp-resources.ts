/** Original target resource observers. Notifications are lossy, in-memory invalidations. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { McpAuthorityLease, McpResourceChange, McpResourceObserver, McpResourceRelease } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpResourceBinding, SourceAuthorityAddress, SourceMcpCreationError, SourceMcpCreationOutcome,
  SourceMcpCreationReceiptResult, SourceMcpHolder, SourceMcpHolderBinding, SourceMcpHolderResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedMcpResourceAction, ManagedMcpResourceSnapshot } from './managed-mcp-contract.js';

type Scope = Pick<ManagedSourceCleanupScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
type Subscription = { listenerId: string; acknowledgement: Record<string, unknown>; revision: number };
type Inspection = { receipt: { requestHash: string; outcome: SourceMcpCreationOutcome | null } | null;
  released: boolean; live: boolean; listenerId: string | null; revision: number };
export function mcpResourceFailure(error: unknown, dispatchedFallback = false): SourceMcpCreationError {
  const e = error as Partial<SourceMcpCreationError> | null;
  return { code: typeof e?.code === 'string' ? e.code : 'mcp_resource_source_unavailable',
    dispatched: typeof e?.dispatched === 'boolean' ? e.dispatched : dispatchedFallback,
    settlement: e?.settlement === 'rpc_response' || e?.settlement === 'session_expired' ? e.settlement : 'unknown',
    ...(e?.protocolError ? { protocolError: e.protocolError } : {}),
    ...(e?.interactionProblem ? { interactionProblem: e.interactionProblem } : {}) };
}
function failure(code: string, dispatched = false): never {
  throw Object.assign(new Error(code), { code, dispatched, settlement: 'unknown' });
}
function subscription(outcome: SourceMcpCreationOutcome | null | undefined, revision: number): Subscription {
  if (!outcome) return failure('mcp_resource_original_creation_unknown', true);
  if (outcome.kind === 'failed') throw Object.assign(new Error(outcome.error.code), outcome.error);
  if (outcome.kind !== 'subscribed') return failure('mcp_resource_creation_changed');
  return { listenerId: outcome.listenerId, acknowledgement: outcome.acknowledgement, revision };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function holderBinding(binding: McpResourceBinding): SourceMcpHolderBinding {
  return { operationId: binding.operationId, executionOwner: binding.executionOwner, endpoint: binding.endpoint, purpose: 'resource_observer' };
}
const requestHash = (binding: McpResourceBinding) => createHash('sha256').update(stable(binding)).digest('hex');
async function join(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await work.catch(() => undefined); return; }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(finish, finish);
  });
}
export function createManagedMcpResources(options: {
  kernel: Pick<KernelClient, 'sourceRequest'>;
  view(scope: Scope, handleId: string, signal: AbortSignal): Promise<{ lease: McpAuthorityLease; beforeDispatch(): Promise<void> }>;
}) {
  interface Entry { binding: McpResourceBinding; requestHash: string; observer?: McpResourceObserver;
    work: Promise<Subscription>; outcome?: SourceMcpCreationOutcome; settled: boolean; released: boolean; unavailable: boolean;
    admission: AbortController; revision: number; changes: Map<McpResourceChange['kind'], { revision: number; change: McpResourceChange }>;
    watchers: Set<() => void>; cleanup?: Promise<McpResourceRelease>; }
  const entries = new Map<string, Entry>();
  const address = (scope: Scope): SourceAuthorityAddress => ({ principalId: scope.principal.principalId,
    coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  const scopeKey = (scope: Scope) => JSON.stringify(Object.values(address(scope)));
  const key = (scope: Scope, binding: McpResourceBinding) => `${scopeKey(scope)}:${binding.operationId}`;
  const entry = (scope: Scope, binding: McpResourceBinding) => {
    const original = entries.get(key(scope, binding));
    if (original && !isDeepStrictEqual(original.binding, binding)) failure('mcp_resource_holder_changed');
    return original;
  };
  const recall = (scope: Scope, binding: McpResourceBinding) => options.kernel.sourceRequest<SourceMcpCreationReceiptResult>(
    'source.mcp.creation_receipt', { ...address(scope), binding: holderBinding(binding), requestHash: requestHash(binding), action: 'inspect' });
  const wake = (selected: Entry) => { for (const listener of selected.watchers) listener(); };
  const detach = (selected: Entry): Promise<McpResourceRelease> => {
    if (selected.cleanup) return selected.cleanup;
    if (!selected.observer) return Promise.resolve({ status: 'unknown' });
    // SDK detach removes its listener synchronously, then waits for the original
    // client's bounded unsubscribe. Never attach A's Operation to B's Catalog.
    try { selected.cleanup = selected.observer.detach().catch(() => ({ status: 'unknown' as const })); }
    catch { selected.cleanup = Promise.resolve({ status: 'unknown' }); }
    return selected.cleanup;
  };
  const settle = async (scope: Scope, selected: Entry) => {
    if (!selected.outcome || selected.settled) return;
    try {
      await options.kernel.sourceRequest('source.mcp.creation_receipt', { ...address(scope), binding: holderBinding(selected.binding),
        requestHash: selected.requestHash, action: 'settle', outcome: selected.outcome });
      selected.settled = true;
    } catch { failure('mcp_resource_creation_receipt_pending', selected.outcome.kind === 'subscribed'
      || selected.outcome.kind === 'failed' && selected.outcome.error.dispatched); }
  };
  const stop = (selected: Entry) => {
    selected.released = true;
    selected.admission.abort();
    wake(selected);
    if (selected.observer) void detach(selected);
  };
  return {
    async subscribe(scope: Scope, action: Extract<ManagedMcpResourceAction, { kind: 'resource_subscribe' }>, signal: AbortSignal): Promise<Subscription> {
      const service = structuredClone(action.service), binding = structuredClone(action.binding);
      if (!binding.uri || !binding.schemaVersion || service.kind !== 'resources' || service.server !== binding.endpoint.server
        || service.resourceKey !== binding.endpoint.resourceKey || service.schemaVersion !== binding.schemaVersion)
        return failure('mcp_resource_service_changed');
      const hash = requestHash(binding), prior = entry(scope, binding);
      if (prior) {
        if (prior.requestHash !== hash) return failure('mcp_resource_creation_changed');
        if (prior.released) return failure('mcp_resource_holder_released');
        return prior.work;
      }
      signal.throwIfAborted();
      const selected: Entry = { binding, requestHash: hash, work: undefined as never, settled: false, released: false,
        unavailable: false, admission: new AbortController(), revision: 0, changes: new Map(), watchers: new Set() };
      entries.set(key(scope, binding), selected);
      selected.work = (async () => {
        try {
          // Recall admission before opening any view. A restart or lost reply can
          // never manufacture a new original SDK observer or replay subscribe.
          const original = await options.kernel.sourceRequest<SourceMcpCreationReceiptResult>('source.mcp.creation_receipt', {
            ...address(scope), binding: holderBinding(binding), requestHash: hash, action: 'begin' });
          if (!original.dispatch) {
            if (original.outcome) selected.outcome = original.outcome;
            selected.settled = !!original.holder.creationReceipt?.outcomeRef;
            selected.released ||= original.holder.released;
            return subscription(original.outcome, selected.revision);
          }
          let outcome: SourceMcpCreationOutcome, entered = false;
          try {
            const view = await options.view(scope, action.handleId, selected.admission.signal);
            if (selected.released) failure('mcp_resource_holder_released');
            if (!isDeepStrictEqual(view.lease.resourceEndpoint(service), binding.endpoint)) failure('mcp_resource_endpoint_changed');
            // The SDK detaches on options.signal abort. Requester cancellation is
            // deliberately excluded so a late original ACK still reaches Storage.
            entered = true;
            const observer = await view.lease.observeResource(service, binding.uri, {
              signal: new AbortController().signal,
              beforeDispatch: async () => {
                await view.beforeDispatch();
                const current = await options.kernel.sourceRequest<{ holder: SourceMcpHolder }>('source.mcp.holder', {
                  ...address(scope), binding: holderBinding(binding), action: 'retain' });
                if (current.holder.released || selected.released) failure('mcp_resource_holder_released');
              },
              onChange: change => {
                if (selected.released || selected.unavailable) return;
                // Synchronous bounded work only, no Storage, network, or durable
                // notification queue. These are latest invalidations, not replay.
                selected.changes.set(change.kind, { revision: ++selected.revision, change });
                if (change.kind === 'gap' || change.kind === 'unavailable') selected.unavailable = true;
                wake(selected);
              },
            });
            selected.observer = observer;
            outcome = { kind: 'subscribed', listenerId: observer.listenerId, acknowledgement: structuredClone(observer.acknowledgement) };
          } catch (error) { outcome = { kind: 'failed', error: mcpResourceFailure(error, entered) }; }
          selected.outcome = outcome;
          await settle(scope, selected);
          return subscription(outcome, selected.revision);
        } finally {
          if (selected.released) await detach(selected);
        }
      })();
      void selected.work.catch(() => undefined);
      return selected.work;
    },
    async inspect(scope: Scope, binding: McpResourceBinding, fenceUnstarted = false, signal?: AbortSignal): Promise<Inspection> {
      const selected = entry(scope, binding);
      if (fenceUnstarted) await options.kernel.sourceRequest('source.mcp.holder', { ...address(scope), binding: holderBinding(binding), action: 'release_unstarted' });
      if (selected) { await join(selected.work, signal); await settle(scope, selected); }
      signal?.throwIfAborted();
      const original = await recall(scope, binding);
      if (original.outcome?.kind === 'accepted') failure('mcp_resource_creation_changed');
      return { receipt: original.holder.creationReceipt ? { requestHash: original.holder.creationReceipt.requestHash, outcome: original.outcome } : null,
        released: original.holder.released, live: !!selected?.observer && !selected.released && !selected.unavailable && !original.holder.released,
        listenerId: original.outcome?.kind === 'subscribed' ? original.outcome.listenerId : null, revision: selected?.revision ?? 0 };
    },
    async watch(scope: Scope, action: Extract<ManagedMcpResourceAction, { kind: 'resource_watch' }>, signal: AbortSignal): Promise<ManagedMcpResourceSnapshot> {
      const selected = entry(scope, action.binding), original = await options.kernel.sourceRequest<SourceMcpHolderResult>('source.mcp.holder', {
        ...address(scope), binding: holderBinding(action.binding), action: 'inspect' });
      if (original.grantState !== 'active') return failure('mcp_resource_original_owner_revoked');
      if (original.holder.creationReceipt?.requestHash !== requestHash(action.binding)) return failure('mcp_resource_creation_changed');
      if (!selected?.observer || original.holder.released || selected.released) return failure('mcp_resource_original_observer_unavailable');
      if (!selected.settled || !original.holder.creationReceipt.outcomeRef || selected.outcome?.kind !== 'subscribed'
        || selected.outcome.listenerId !== action.listenerId || selected.observer.listenerId !== action.listenerId) return failure('mcp_resource_original_identity_unavailable');
      if (!Number.isSafeInteger(action.after) || action.after < 0 || action.after > selected.revision) return failure('mcp_resource_cursor_invalid');
      const snapshot = (): ManagedMcpResourceSnapshot => ({ listenerId: action.listenerId, revision: selected.revision,
        changes: [...selected.changes.values()].filter(change => change.revision > action.after).sort((a, b) => a.revision - b.revision) });
      signal.throwIfAborted();
      if (selected.revision <= action.after) {
        if (selected.unavailable) return failure('mcp_resource_original_observer_unavailable');
        await new Promise<void>((resolve, reject) => {
          const finish = () => { selected.watchers.delete(finish); signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { selected.watchers.delete(finish); signal.removeEventListener('abort', abort); reject(signal.reason); };
          selected.watchers.add(finish);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (selected.released) return failure('mcp_resource_original_observer_unavailable');
      const current = await options.kernel.sourceRequest<SourceMcpHolderResult>('source.mcp.holder', {
        ...address(scope), binding: holderBinding(action.binding), action: 'inspect' });
      if (current.grantState !== 'active' || current.holder.released) return failure('mcp_resource_original_owner_revoked');
      return snapshot();
    },
    async release(scope: Scope, binding: McpResourceBinding): Promise<{ retire: boolean; controlsDrained: true; release: McpResourceRelease }> {
      const selected = entry(scope, binding);
      // Fence an absent first dispatch, then check the full immutable request
      // identity before releasing a started holder. A has recovered its ACK before
      // this call; holder release is its acknowledgement that body GC may proceed.
      const fenced = await options.kernel.sourceRequest<{ holder: SourceMcpHolder }>('source.mcp.holder', {
        ...address(scope), binding: holderBinding(binding), action: 'release_unstarted' });
      if (fenced.holder.creationReceipt && fenced.holder.creationReceipt.requestHash !== requestHash(binding)) failure('mcp_resource_creation_changed');
      const result = await options.kernel.sourceRequest<{ authority: { phase: string } }>('source.mcp.holder', {
        ...address(scope), binding: holderBinding(binding), action: 'release' });
      let release: McpResourceRelease = { status: 'unknown' };
      if (selected) {
        stop(selected);
        await join(selected.work);
        release = await detach(selected);
        entries.delete(key(scope, binding));
      }
      return { retire: result.authority.phase === 'draining', controlsDrained: true, release };
    },
    async close(scope: Scope): Promise<void> {
      const prefix = `${scopeKey(scope)}:`, selected = [...entries].filter(([id]) => id.startsWith(prefix));
      for (const [, original] of selected) stop(original);
      const drained = await Promise.allSettled(selected.map(async ([id, original]) => {
        await join(original.work);
        await detach(original);
        // Keep a known ACK in memory if Storage is temporarily unavailable.
        // An inspect can retry settlement even after SDK ownership is closed.
        await settle(scope, original);
        entries.delete(id);
      }));
      const failed = drained.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Closing SDK ownership never claims that the durable holder was released.
      // Its original receipt remains a Storage root for A's later recovery.
    },
  };
}
