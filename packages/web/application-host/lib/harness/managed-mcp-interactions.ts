/** Original SDK reverse-request responders. Review, Catalog and model execution stay on A. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { McpSamplingRejectedError } from '@varin/pi-host/mcp-errors';
import type { McpErrorInteraction, McpErrorInteractionItem, McpInteractionOrigin, McpInteractionRequest } from '@varin/pi-host/mcp-authority';
import type { McpElicitationResponse, McpSamplingResult } from '@varin/protocol';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpInteractionBinding, SourceAuthorityAddress, SourceMcpDeliveryParams, SourceMcpDeliveryReceipt,
  SourceMcpDeliveryResult, SourceMcpHolderBinding } from '../kernel/protocol.generated.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedMcpInteractionAction, ManagedMcpInteractionBody, ManagedMcpInteractionInspection,
  ManagedMcpInteractionResponse, ManagedMcpInteractionSnapshot } from './managed-mcp-contract.js';

export type ManagedMcpInteractionScope = Pick<ManagedSourceCleanupScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
type Scope = ManagedMcpInteractionScope;
type Answer = McpElicitationResponse | McpSamplingResult;
type Availability = Exclude<SourceMcpDeliveryReceipt['availability'], 'live'>;
type Settlement = 'sent' | 'not_sent' | 'unknown';
type WithoutAddress<T> = T extends unknown ? Omit<T, keyof SourceAuthorityAddress | 'deliveryId' | 'binding'> : never;
type Mutation = WithoutAddress<SourceMcpDeliveryParams>;
function failure(code: string): Error { return Object.assign(new Error(code), { code, dispatched: false, settlement: 'unknown' }); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const deliveryId = (binding: McpInteractionBinding) => `mcp-interaction:${createHash('sha256').update(JSON.stringify([binding.connectionId, binding.source])).digest('hex')}`;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const permanent = (error: unknown) => !!error && typeof error === 'object' && 'code' in error
  && (String(error.code).startsWith('mcp_interaction_')
    || ['forbidden', 'unauthorized', 'operation-error', 'protocol-error', 'invalid-params', 'cancelled'].includes(String(error.code)));

export function createManagedMcpInteractions(options: {
  kernel: Pick<KernelClient, 'sourceRequest'>;
  authorizeRead(scope: Scope, signal: AbortSignal): Promise<unknown>;
  onError?: (error: Error) => void;
}) {
  interface Owner {
    scope: Scope; incarnation: string; revision: number; closed: boolean;
    entries: Map<string, Entry>; receipts: Map<string, SourceMcpDeliveryReceipt>; watchers: Set<() => void>;
    cleanups: Map<string, { holder: SourceMcpHolderBinding; listeners: Set<symbol> }>;
  }
  interface Entry {
    owner: Owner; id: string; binding: McpInteractionBinding; kind: SourceMcpDeliveryReceipt['kind'];
    input: McpInteractionRequest | McpErrorInteractionItem; body?: ManagedMcpInteractionBody; requestHash: string;
    ready: ReturnType<typeof deferred<SourceMcpDeliveryReceipt>>; lane: Promise<unknown>;
    answer: ReturnType<typeof deferred<Answer>>; settled: ReturnType<typeof deferred<void>>;
    responseHash?: string; responseWork?: Promise<ManagedMcpInteractionInspection>;
    settlement?: Settlement; controller: AbortController; releasing: boolean; detached: boolean; originalConfirmed: boolean;
    completion?: () => void; unobserve?: () => void; completionArrived: boolean; closeAvailability?: Availability; cleanupHolder?: SourceMcpHolderBinding;
  }
  const owners = new Map<string, Owner>();
  const address = (scope: Scope): SourceAuthorityAddress => ({ principalId: scope.principal.principalId,
    coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch });
  const key = (scope: Scope) => JSON.stringify(Object.values(address(scope)));
  const cleanupKey = (origin: McpInteractionOrigin, endpoint: SourceMcpHolderBinding['endpoint']) => stable([origin.operationId, origin.executionOwner, endpoint]);
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : failure('mcp_interaction_receipt_unavailable'));
  const wake = (owner: Owner) => { owner.revision++; for (const listener of [...owner.watchers]) listener(); };
  const ownerFor = (scope: Scope): Owner => {
    const found = owners.get(key(scope));
    if (found) return found;
    const created: Owner = { scope: structuredClone(scope), incarnation: randomUUID(), revision: 1, closed: false,
      entries: new Map(), receipts: new Map(), watchers: new Set(), cleanups: new Map() };
    owners.set(key(scope), created); return created;
  };
  const remember = (owner: Owner, receipt: SourceMcpDeliveryReceipt) => {
    const previous = owner.receipts.get(receipt.deliveryId);
    if (previous && receipt.revision < previous.revision) return;
    if (!isDeepStrictEqual(previous, receipt)) { owner.receipts.set(receipt.deliveryId, structuredClone(receipt)); wake(owner); }
  };
  const live = (entry?: Entry) => !!entry && entry.originalConfirmed && !entry.detached && !entry.owner.closed && !entry.releasing;
  const inspection = (owner: Owner, receipt: SourceMcpDeliveryReceipt): ManagedMcpInteractionInspection =>
    ({ receipt: structuredClone(receipt), live: live(owner.entries.get(receipt.deliveryId)) });
  const call = async (owner: Owner, id: string, binding: McpInteractionBinding, mutation: Mutation) => {
    const result = await options.kernel.sourceRequest<SourceMcpDeliveryResult>('source.mcp.delivery', {
      ...address(owner.scope), deliveryId: id, binding, ...mutation,
    } as SourceMcpDeliveryParams);
    if (result.receipt.deliveryId !== id || !isDeepStrictEqual(result.receipt.binding, binding)) throw failure('mcp_interaction_binding_changed');
    remember(owner, result.receipt); return result;
  };
  const currentEntry = (owner: Owner, id: string, binding: McpInteractionBinding) => {
    if (id !== deliveryId(binding)) throw failure('mcp_interaction_binding_changed');
    const entry = owner.entries.get(id);
    if (entry && !isDeepStrictEqual(entry.binding, binding)) throw failure('mcp_interaction_binding_changed');
    return entry;
  };
  const enqueue = <T>(entry: Entry, work: () => Promise<T>): Promise<T> => {
    const result = entry.lane.then(work); entry.lane = result.catch(() => undefined); return result;
  };
  // Retry only immutable original facts, never an SDK invocation or response-begin fence.
  const persist = async (entry: Entry, mutation: Mutation) => {
    let delay = 250;
    for (;;) {
      try { return await call(entry.owner, entry.id, entry.binding, mutation); }
      catch (error) {
        if (permanent(error)) throw error;
        report(error);
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  };
  const fact = (entry: Entry, mutation: Mutation, fromOriginal = false) => {
    const work = enqueue(entry, async () => {
      await entry.ready.promise;
      if (fromOriginal && !entry.originalConfirmed) return;
      return persist(entry, mutation);
    });
    void work.catch(report); return work;
  };
  const detachCompletion = (entry: Entry) => { entry.completion?.(); delete entry.completion; };
  const stop = (entry: Entry, availability: Availability, fromOriginal = false) => {
    if (fromOriginal && entry.detached) return Promise.resolve();
    if (entry.closeAvailability && entry.closeAvailability !== 'rpc_closed' && availability === 'rpc_closed') availability = entry.closeAvailability;
    entry.closeAvailability = availability;
    entry.controller.abort(availability); entry.answer.reject(failure('mcp_interaction_not_live'));
    if (availability !== 'rpc_closed') detachCompletion(entry);
    return fact(entry, { action: 'close', availability }, fromOriginal);
  };
  const register = (entry: Entry) => {
    const abort = () => {
      const reason = entry.input.signal.reason;
      void stop(entry, reason === 'rpc_closed' ? 'rpc_closed' : reason === 'owner_unavailable' ? 'owner_unavailable'
        : reason === 'connection_lost' ? 'connection_lost' : 'cancelled', true);
    };
    entry.input.signal.addEventListener('abort', abort, { once: true });
    entry.unobserve = () => entry.input.signal.removeEventListener('abort', abort);
    entry.completion = entry.input.onComplete(() => {
      entry.completionArrived = true; detachCompletion(entry);
      void fact(entry, { action: 'complete' }, true);
    }, () => { void stop(entry, 'connection_lost', true); });
    // An SDK watcher may deliver a latched notification from inside registration.
    if (entry.completionArrived || entry.controller.signal.aborted && entry.controller.signal.reason !== 'rpc_closed') detachCompletion(entry);
    if (entry.input.signal.aborted) abort();
  };
  const stage = (owner: Owner, input: Entry['input'], kind: Entry['kind'], body: ManagedMcpInteractionBody): Entry => {
    const binding = structuredClone(input.binding), id = deliveryId(binding);
    if (owner.closed) throw failure('mcp_interaction_owner_unavailable');
    if (owner.entries.has(id)) throw failure('mcp_interaction_conflict');
    const ready = deferred<SourceMcpDeliveryReceipt>();
    const entry: Entry = { owner, id, binding, kind, input, body, requestHash: hash(body), ready,
      lane: ready.promise, answer: deferred<Answer>(), settled: deferred<void>(), controller: new AbortController(),
      releasing: false, detached: false, originalConfirmed: false, completionArrived: false };
    const cleanup = owner.cleanups.get(cleanupKey(binding, binding.endpoint));
    if (cleanup) entry.cleanupHolder = structuredClone(cleanup.holder);
    owner.entries.set(id, entry); return entry;
  };
  const open = (entry: Entry) => {
    queueMicrotask(() => {
      void persist(entry, { action: 'open', kind: entry.kind, requestHash: entry.requestHash,
        ...(entry.cleanupHolder ? { cleanupHolder: entry.cleanupHolder } : {}) }).then(result => {
        if (result.receipt.kind !== entry.kind || result.receipt.requestHash !== entry.requestHash)
          throw failure('mcp_interaction_request_changed');
        // Matching immutable bytes can still be published after an uncertain open ACK.
        // Only a confirmed creation binds this heap's original SDK callback; a recalled
        // receipt never grants a replacement responder or its queued completion facts.
        entry.originalConfirmed = result.created;
        if (!result.created || result.receipt.released || result.receipt.responseHash !== null || result.receipt.availability !== 'live') {
          entry.controller.abort('owner_unavailable'); entry.answer.reject(failure('mcp_interaction_original_transport_unavailable'));
          entry.unobserve?.(); detachCompletion(entry); entry.detached = true;
          delete entry.closeAvailability;
        }
        entry.ready.resolve(result.receipt); wake(entry.owner);
      }).catch(error => {
        entry.controller.abort('owner_unavailable'); entry.answer.reject(error); entry.ready.reject(error);
        entry.unobserve?.(); detachCompletion(entry); entry.detached = true; delete entry.body;
        entry.owner.entries.delete(entry.id); wake(entry.owner); report(error);
      });
    });
  };
  const authorize = async (scope: Scope, signal: AbortSignal) => { signal.throwIfAborted(); await options.authorizeRead(scope, signal); signal.throwIfAborted(); };
  const active = (result: SourceMcpDeliveryResult) => { if (result.grantState !== 'active') throw failure('mcp_interaction_original_owner_revoked'); };
  const recall = async (owner: Owner, id: string, binding: McpInteractionBinding) => {
    const entry = currentEntry(owner, id, binding);
    if (entry) await entry.lane;
    let result = await call(owner, id, binding, { action: 'inspect' });
    if ((!entry || !entry.originalConfirmed) && !result.receipt.released) {
      // The metadata survived this heap, but its original SDK responder did not.
      if (result.receipt.delivery === 'sending') result = await call(owner, id, binding, { action: 'settle', delivery: 'unknown' });
      if (['live', 'rpc_closed'].includes(result.receipt.availability))
        result = await call(owner, id, binding, { action: 'close', availability: 'connection_lost' });
    }
    return result;
  };
  const drain = async (entry: Entry) => {
    // The SDK callback alone establishes whether an already released answer left B.
    if (entry.kind !== 'error') await entry.settled.promise;
    await entry.lane;
  };
  const receive = (scope: Scope, input: McpInteractionRequest, kind: 'elicitation' | 'sampling'): Promise<Answer> => {
    const owner = ownerFor(scope), binding = structuredClone(input.binding), id = deliveryId(binding);
    const entry = stage(owner, input, kind, { kind, deliveryId: id, binding, request: structuredClone(input.request) });
    // Install every observer before the first native request or asynchronous continuation.
    input.beforeResponse(async () => {
      entry.controller.signal.throwIfAborted();
      if (!entry.responseHash) return;
      await entry.ready.promise; input.signal.throwIfAborted(); await input.assertLive();
      await authorize(owner.scope, entry.controller.signal);
      const result = await enqueue(entry, () => call(owner, id, binding, { action: 'begin', responseHash: entry.responseHash! }));
      active(result);
      if (!result.dispatch) throw failure('mcp_interaction_response_already_admitted');
      entry.controller.signal.throwIfAborted(); input.signal.throwIfAborted(); await input.assertLive();
      await authorize(owner.scope, entry.controller.signal);
    });
    input.onResponseSettled((state: Settlement) => {
      if (entry.settlement !== undefined) return;
      entry.settlement = state;
      // Generic handler errors are not delivery evidence for A's reviewed response.
      const work = enqueue(entry, async () => {
        await entry.ready.promise;
        if (entry.originalConfirmed && entry.responseHash) {
          // Inspect also recalls a begin whose native ACK was lost. Never begin again.
          const result = await persist(entry, { action: 'inspect' });
          if (result.receipt.responseHash === entry.responseHash)
            await persist(entry, { action: 'settle', delivery: state });
        }
      });
      void work.then(() => entry.settled.resolve(), error => { entry.settled.reject(error); report(error); });
    });
    register(entry); open(entry);
    return entry.answer.promise;
  };
  const request = async (scope: Scope, action: ManagedMcpInteractionAction, signal: AbortSignal): Promise<ManagedMcpInteractionSnapshot | ManagedMcpInteractionBody | (ManagedMcpInteractionInspection & { retire?: boolean })> => {
    const owner = ownerFor(scope);
    if (action.kind === 'interaction_watch') {
      await authorize(scope, signal);
      if (!Number.isSafeInteger(action.after) || action.after < 0) throw failure('mcp_interaction_watch_invalid');
      if (action.incarnation === owner.incarnation && action.after > owner.revision) throw failure('mcp_interaction_watch_invalid');
      if (action.incarnation === owner.incarnation && action.after === owner.revision) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { owner.watchers.delete(changed); signal.removeEventListener('abort', aborted); };
          const changed = () => { cleanup(); resolve(); }, aborted = () => { cleanup(); reject(signal.reason); };
          owner.watchers.add(changed); signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted(); else if (action.after !== owner.revision) changed();
        });
      }
      await authorize(scope, signal);
      // Closing the SDK owner fences sends, not authorized publication of its retained facts.
      for (const receipt of owner.receipts.values()) {
        if (receipt.released) continue;
        const result = await call(owner, receipt.deliveryId, receipt.binding, { action: 'inspect' }); active(result);
      }
      await authorize(scope, signal);
      // Capture both cursor and projection without an await between them.
      return { incarnation: owner.incarnation, revision: owner.revision,
        deliveries: [...owner.receipts.values()].filter(receipt => !receipt.released).map(receipt => inspection(owner, receipt)) };
    }
    const entry = currentEntry(owner, action.deliveryId, action.binding);
    if (action.kind === 'interaction_read' || action.kind === 'interaction_respond') await authorize(scope, signal);
    const original = await recall(owner, action.deliveryId, action.binding);
    if (action.kind === 'interaction_inspect') return inspection(owner, original.receipt);
    if (action.kind === 'interaction_read') {
      active(original); await authorize(scope, signal);
      if (!entry?.body || original.receipt.released) throw failure('mcp_interaction_original_transport_unavailable');
      return structuredClone(entry.body);
    }
    if (action.kind === 'interaction_respond') {
      active(original);
      if (!entry || entry.detached || entry.kind === 'error') throw failure('mcp_interaction_original_transport_unavailable');
      const response: ManagedMcpInteractionResponse = structuredClone(action.response), responseHash = hash(response);
      if (entry.responseHash) {
        if (entry.responseHash !== responseHash) throw failure('mcp_interaction_response_changed');
        return entry.responseWork!;
      }
      if (entry.releasing || original.receipt.released || original.receipt.completed || original.receipt.availability !== 'live'
        || original.receipt.responseHash !== null || entry.controller.signal.aborted) throw failure('mcp_interaction_not_live');
      if (response.kind === 'sampling_rejected' && entry.kind !== 'sampling') throw failure('mcp_interaction_response_invalid');
      await authorize(scope, signal);
      // Authorization may await. Recheck the one-shot latch after it without yielding.
      if (entry.responseHash) {
        if (entry.responseHash !== responseHash) throw failure('mcp_interaction_response_changed');
        return entry.responseWork!;
      }
      if (entry.releasing || entry.controller.signal.aborted) throw failure('mcp_interaction_not_live');
      entry.responseHash = responseHash;
      entry.responseWork = entry.settled.promise.then(async () => {
        const result = await call(owner, entry.id, entry.binding, { action: 'inspect' });
        return inspection(owner, result.receipt);
      });
      void entry.responseWork.catch(() => undefined);
      if (response.kind === 'sampling_rejected') entry.answer.reject(new McpSamplingRejectedError());
      else entry.answer.resolve(response.value as unknown as Answer);
      // This promise has no A HTTP cancellation signal. Losing that ACK cannot resend it.
      return entry.responseWork;
    }
    if (action.kind === 'interaction_close') {
      if (entry) { await stop(entry, action.availability); await drain(entry); }
      const result = await call(owner, action.deliveryId, action.binding, { action: 'close', availability: entry?.closeAvailability ?? action.availability });
      return inspection(owner, result.receipt);
    }
    if (action.kind === 'interaction_ack') {
      const result = await call(owner, action.deliveryId, action.binding, { action: 'ack', revision: action.revision });
      return inspection(owner, result.receipt);
    }
    if (action.kind !== 'interaction_release') throw failure('mcp_interaction_action_invalid');
    if (original.receipt.revision !== action.revision || original.receipt.acknowledgedRevision < action.revision)
      throw failure('mcp_interaction_acknowledgement_changed');
    if (entry) {
      entry.releasing = true; entry.controller.abort('cancelled'); entry.answer.reject(failure('mcp_interaction_not_live'));
      entry.unobserve?.(); detachCompletion(entry); wake(owner); await drain(entry);
    }
    const result = await call(owner, action.deliveryId, action.binding, { action: 'release', revision: action.revision });
    if (entry) { entry.detached = true; delete entry.body; owner.entries.delete(entry.id); wake(owner); }
    return { ...inspection(owner, result.receipt), retire: result.phase === 'draining' };
  };

  return {
    bind(scope: Scope): string {
      const owner = ownerFor(scope); if (owner.closed) throw failure('mcp_interaction_owner_unavailable'); return owner.incarnation;
    },
    /** The outer Host reply joins registration, never an SDK callback reader. */
    async published(scope: Scope): Promise<void> {
      const entries = [...(owners.get(key(scope))?.entries.values() ?? [])];
      await Promise.all(entries.map(entry => entry.ready.promise));
    },
    /** Scoped only to an admitted, still-running original resources/unsubscribe call. */
    registerCleanup(scope: Scope, origin: McpInteractionOrigin, holder: SourceMcpHolderBinding): () => void {
      const owner = ownerFor(scope);
      if (owner.closed || holder.purpose !== 'resource_observer')
        throw failure('mcp_interaction_cleanup_changed');
      const selected = cleanupKey(origin, holder.endpoint), current = owner.cleanups.get(selected);
      if (current && !isDeepStrictEqual(current.holder, holder)) throw failure('mcp_interaction_cleanup_changed');
      const registration = current ?? { holder: structuredClone(holder), listeners: new Set<symbol>() };
      const listener = Symbol(); registration.listeners.add(listener); owner.cleanups.set(selected, registration);
      return () => { registration.listeners.delete(listener); if (!registration.listeners.size && owner.cleanups.get(selected) === registration) owner.cleanups.delete(selected); };
    },
    receive,
    receiveError(scope: Scope, input: McpErrorInteraction): void {
      const owner = ownerFor(scope);
      const body: ManagedMcpInteractionBody = { kind: 'error', request: structuredClone(input.request),
        items: input.items.map(item => ({ deliveryId: deliveryId(item.binding), binding: structuredClone(item.binding), presentation: structuredClone(item.presentation) })) };
      const ids = body.items.map(item => item.deliveryId);
      if (new Set(ids).size !== ids.length || ids.some(id => owner.entries.has(id))) throw failure('mcp_interaction_conflict');
      const entries = input.items.map(item => stage(owner, item, 'error', body));
      try { for (const entry of entries) register(entry); }
      catch (error) {
        for (const entry of entries) { entry.unobserve?.(); detachCompletion(entry); owner.entries.delete(entry.id); entry.ready.reject(error); }
        throw error;
      }
      for (const entry of entries) open(entry);
    },
    async request(scope: Scope, action: ManagedMcpInteractionAction, signal: AbortSignal) {
      try { return await request(scope, action, signal); }
      catch (error) {
        if (action.kind === 'interaction_watch') throw error;
        const owner = owners.get(key(scope)), entry = owner?.entries.get(action.deliveryId);
        const receipt = owner?.receipts.get(action.deliveryId);
        if (!entry?.responseHash && !receipt?.responseHash) throw error;
        // A replacement callback's local rejection is not the old response's delivery fact.
        const known = entry?.originalConfirmed ? entry.settlement : receipt?.delivery;
        throw Object.assign(error instanceof Error ? error : failure('mcp_interaction_receipt_unavailable'), {
          dispatched: known !== 'not_sent', settlement: known === 'sent' ? 'rpc_response' : 'unknown',
        });
      }
    },
    async close(scope: Scope): Promise<void> {
      const owner = owners.get(key(scope)); if (!owner) return;
      owner.closed = true; owner.cleanups.clear(); wake(owner);
      const entries = [...owner.entries.values()];
      const work = entries.map(entry => {
        entry.releasing = true; entry.unobserve?.(); detachCompletion(entry);
        const stopped = stop(entry, 'owner_unavailable');
        return Promise.all([stopped, drain(entry)]);
      });
      const results = await Promise.allSettled(work);
      // A must acknowledge the exact final receipt before release can discard its body,
      // including when an SDK/native drain failed. Neither retention nor reads restore a send.
      for (const entry of entries) entry.detached = true;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
