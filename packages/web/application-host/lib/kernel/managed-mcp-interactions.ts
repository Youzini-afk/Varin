/** Coordinator projection of original Source SDK receivers. Catalog remains the review/model owner. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { McpAuthorityError, McpSamplingRejectedError } from '../mcp/errors.js';
import type { McpInteractionOrigin, McpInteractionRequest, McpErrorInteractionItem } from '../mcp/authority.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';
import type { ManagedMcpInteractionAction, ManagedMcpInteractionBody, ManagedMcpInteractionInspection,
  ManagedMcpInteractionResponse, ManagedMcpInteractionSnapshot } from '../harness/managed-mcp-contract.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionRuntime } from './mcp-interaction-runtime.js';
import type { McpEndpoint, McpInteractionAvailability, McpInteractionBinding, McpInteractionRecord,
  McpInteractionPending, McpServerOwner, McpServerSelection, Operation, SourceMcpDeliveryReceipt } from './protocol.generated.js';

export type ManagedMcpInteractions = ReturnType<typeof createManagedMcpInteractions>;

export interface ManagedMcpInteractionRegistration {
  client: ManagedSourceClient;
  address: ManagedSourceAddress;
  origin: McpInteractionOrigin;
  server: McpServerSelection & { server: string };
  /** Task/observer continuations require the original full endpoint, including its grant. */
  endpoint?: McpEndpoint;
}
type Settled = 'sent' | 'unknown' | 'not_sent';
type Context = { record: McpInteractionRecord; owner: McpServerOwner };
interface Source {
  client: ManagedSourceClient;
  address: ManagedSourceAddress;
  resourceOwner: McpServerOwner['resource_owner'];
  registrations: ManagedMcpInteractionRegistration[];
  inspections: Map<string, ManagedMcpInteractionInspection>;
  watching?: Promise<void>;
  retiring?: Promise<void>;
  incarnation?: string;
  revision: number;
}
interface Projection {
  source: Source;
  receipt: SourceMcpDeliveryReceipt;
  controller: AbortController;
  before: Array<() => void | Promise<void>>;
  settled: Array<(state: Settled) => void>;
  listeners: Set<{ complete: () => void; unavailable?: () => void }>;
  responseAttempted: boolean;
  responseUncertain: boolean;
  notifiedSettlement?: Settled;
  localClose?: Exclude<McpInteractionAvailability, 'live'>;
}
interface Flight {
  binding: McpInteractionBinding;
  runId: string | undefined;
  next?: () => Promise<void>;
  promise: Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const identity = (binding: McpInteractionBinding) => `mcp-interaction:${hash([binding.connectionId, binding.source])}`;
const fail = (code: string): never => { throw new McpAuthorityError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const terminal = (delivery: unknown): delivery is Settled => ['sent', 'unknown', 'not_sent'].includes(String(delivery));
const addressKey = (address: ManagedSourceAddress, owner: McpServerOwner['resource_owner']) => JSON.stringify([stable(owner), address.coordinatorHostId, address.authorityId, address.resourceEpoch]);
const ownerAddress = (owner: McpServerOwner): ManagedSourceAddress => {
  const source = owner.source_authority;
  if (!source || owner.resource_owner.kind !== 'managed_host' || owner.execution_scope !== 'workspace') return fail('mcp_interaction_source_owner_changed');
  return { coordinatorHostId: source.coordinator_host_id, authorityId: source.authority_id, resourceEpoch: source.resource_epoch };
};

export function createManagedMcpInteractions(options: {
  kernel: KernelClient;
  runtime: Pick<AgentRuntimeClient, 'onReady' | 'onEvent' | 'managedSource' | 'coordinatorHostId'>;
  interactions: Pick<McpInteractionRuntime, 'receiver' | 'samplingReceiver' | 'errorReceiver' | 'published'>;
  onError?: (error: Error) => void;
}) {
  const sources = new Map<string, Source>(), projections = new Map<string, Projection>();
  const flights = new Map<string, Flight>();
  const lifetime = new AbortController(), removers: Array<() => void> = [];
  let started = false, disposed = false, dirty = false, pumping: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const report = (error: unknown) => { if (!disposed) options.onError?.(error instanceof Error ? error : new Error('MCP Source interaction reconciliation failed')); };
  const pause = (ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref?.();
    lifetime.signal.addEventListener('abort', done, { once: true });
    if (lifetime.signal.aborted) done();
  });
  const request = async <T>(source: Source, action: ManagedMcpInteractionAction): Promise<T> => {
    lifetime.signal.throwIfAborted();
    const result = await source.client.service({ ...source.address, requestId: `mcp-interaction:${randomUUID()}`,
      operation: { kind: 'mcp', action } }, lifetime.signal);
    if (!result.ok) throw new McpAuthorityError(result.error.code, result.error.dispatched, result.error.settlement,
      result.error.protocolError, result.error.interactionProblem);
    return result.value as T;
  };
  const context = (record: Pick<McpInteractionRecord, 'id' | 'binding'>) => options.kernel.agentRuntimeRequest<Context,
    'runtime.mcp.interaction.context'>('runtime.mcp.interaction.context', { operationId: record.binding.operationId, interactionId: record.id });
  const short = (method: 'runtime.mcp.interaction.close' | 'runtime.mcp.interaction.response.settle'
    | 'runtime.mcp.interaction.complete' | 'runtime.mcp.interaction.delivery.released', record: Pick<McpInteractionRecord, 'id' | 'binding'>,
    extra: Record<string, unknown> = {}) => options.kernel.agentRuntimeRequest<McpInteractionRecord, typeof method>(method,
      { binding: record.binding, interactionId: record.id, ...extra } as never);
  const validate = (inspection: ManagedMcpInteractionInspection, expected?: SourceMcpDeliveryReceipt) => {
    const receipt = inspection?.receipt;
    if (!object(receipt) || !object(receipt.binding) || !object(receipt.binding.endpoint) || !object(receipt.binding.source)
      || receipt.deliveryId !== identity(receipt.binding as unknown as McpInteractionBinding)
      || !['elicitation', 'sampling', 'error'].includes(String(receipt.kind))
      || (receipt.kind === 'error') !== (receipt.binding.source.kind === 'rpc_error')
      || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1
      || typeof receipt.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestHash)
      || receipt.responseHash !== null && (typeof receipt.responseHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.responseHash))
      || receipt.delivery !== null && receipt.delivery !== 'sending' && !terminal(receipt.delivery)
      || !['live', 'rpc_closed', 'connection_lost', 'owner_unavailable', 'cancelled'].includes(String(receipt.availability))
      || typeof receipt.completed !== 'boolean' || typeof receipt.released !== 'boolean' || typeof inspection.live !== 'boolean'
      || !Number.isSafeInteger(receipt.acknowledgedRevision) || Number(receipt.acknowledgedRevision) < 0
      || Number(receipt.acknowledgedRevision) > Number(receipt.revision)
      || expected && (receipt.deliveryId !== expected.deliveryId || !isDeepStrictEqual(receipt.binding, expected.binding)
        || receipt.kind !== expected.kind || receipt.requestHash !== expected.requestHash)) return fail('mcp_interaction_source_receipt_changed');
    return inspection;
  };
  const remember = (source: Source, inspection: ManagedMcpInteractionInspection) => {
    validate(inspection, source.inspections.get(inspection.receipt.deliveryId)?.receipt);
    const previous = source.inspections.get(inspection.receipt.deliveryId);
    if (!previous || inspection.receipt.revision >= previous.receipt.revision) source.inspections.set(inspection.receipt.deliveryId, inspection);
    return inspection;
  };
  const readReceipt = async (source: Source, receipt: SourceMcpDeliveryReceipt) => remember(source, validate(await request<ManagedMcpInteractionInspection>(source,
    { kind: 'interaction_inspect', deliveryId: receipt.deliveryId, binding: receipt.binding }), receipt));
  const registration = (source: Source, binding: McpInteractionBinding) => source.registrations.find(item =>
    item.origin.operationId === binding.operationId && isDeepStrictEqual(item.origin.executionOwner, binding.executionOwner)
    && item.server.server === binding.endpoint.server);
  const validateBinding = (source: Source, binding: McpInteractionBinding) => {
    const registered = registration(source, binding);
    if (!registered || binding.endpoint.resourceKey !== registered.server.resource_key
      || binding.endpoint.configurationVersion !== registered.server.definition_version || !binding.endpoint.credentialVersion
      || !binding.connectionId || !isDeepStrictEqual(ownerAddress(registered.server.owner), source.address)
      || registered.endpoint && !isDeepStrictEqual(registered.endpoint, binding.endpoint)) return fail('mcp_interaction_original_binding_changed');
    return registered;
  };
  const notify = (entry: Projection, inspection: ManagedMcpInteractionInspection) => {
    entry.receipt = inspection.receipt;
    if (inspection.receipt.completed) for (const listener of [...entry.listeners]) listener.complete();
    if (!inspection.live && !terminal(inspection.receipt.delivery) || !['live', 'rpc_closed'].includes(inspection.receipt.availability)) {
      if (!inspection.receipt.completed) for (const listener of [...entry.listeners]) listener.unavailable?.();
    }
    if (inspection.receipt.availability !== 'live' && !entry.controller.signal.aborted) entry.controller.abort(inspection.receipt.availability);
    const delivery = inspection.receipt.responseHash === null && (!inspection.live || inspection.receipt.availability !== 'live') ? 'not_sent' : inspection.receipt.delivery;
    if (terminal(delivery) && entry.notifiedSettlement !== delivery) {
      entry.notifiedSettlement = delivery;
      for (const settled of entry.settled) settled(inspection.receipt.responseHash === null ? 'not_sent' : delivery);
    }
  };
  const schedule = () => {
    if (disposed || retry) return;
    retry = setTimeout(() => { retry = undefined; wake(); }, 250); retry.unref?.();
  };
  const flight = (binding: McpInteractionBinding, work: () => Promise<void>, runId?: string) => {
    const id = identity(binding), active = flights.get(id);
    if (active) {
      if (!isDeepStrictEqual(active.binding, binding) || active.runId && runId && active.runId !== runId) return fail('mcp_interaction_original_binding_changed');
      active.runId ??= runId;
      active.next = work;
      return active.promise;
    }
    const pending: Flight = { binding, runId, next: work, promise: Promise.resolve() };
    flights.set(id, pending);
    pending.promise = Promise.resolve().then(async () => {
      try {
        // Discovery coalesces another pass while this original delivery is waiting on B.
        while (pending.next && !disposed) {
          const next = pending.next; delete pending.next;
          await next();
        }
      } finally {
        flights.delete(id);
        if (pending.next && !disposed) wake();
      }
    });
    void pending.promise.catch(error => { report(error); schedule(); });
    return pending.promise;
  };
  const retire = (source: Source) => {
    source.retiring ??= (async () => {
      const retired = await source.client.release({ ...source.address, mode: 'retire' }, lifetime.signal);
      if (!object(retired) || !['retired', 'revoked'].includes(String(retired.phase))) return fail('mcp_interaction_source_retirement_unconfirmed');
    })().finally(() => { delete source.retiring; });
    return source.retiring;
  };
  const watch = (source: Source) => {
    if (source.watching || disposed) return;
    source.watching = (async () => {
      let delay = 250;
      while (!disposed) {
        try {
          const snapshot = await request<ManagedMcpInteractionSnapshot>(source, { kind: 'interaction_watch', after: source.revision,
            ...(source.incarnation ? { incarnation: source.incarnation } : {}) });
          if (!snapshot || !snapshot.incarnation || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
            || !Array.isArray(snapshot.deliveries)
            || snapshot.incarnation === source.incarnation && snapshot.revision <= source.revision) fail('mcp_interaction_source_watch_changed');
          for (const item of snapshot.deliveries) remember(source, item);
          source.incarnation = snapshot.incarnation; source.revision = snapshot.revision; delay = 250; wake();
        } catch (error) { if (!disposed) {
          // Losing the projection fences its current receivers. A later watch may expose fresh
          // requests on a retained Task, but it never resumes an old response/model decision.
          for (const entry of projections.values()) if (entry.source === source) {
            entry.localClose = 'connection_lost';
            for (const listener of [...entry.listeners]) listener.unavailable?.();
            entry.controller.abort('connection_lost');
          }
          report(error); wake(); await pause(delay); delay = Math.min(delay * 2, 30000);
        } }
      }
    })().finally(() => { delete source.watching; });
  };
  const sourceFor = (client: ManagedSourceClient, address: ManagedSourceAddress, owner: McpServerOwner): Source => {
    if (disposed) return fail('mcp_interaction_owner_unavailable');
    if (address.coordinatorHostId !== options.runtime.coordinatorHostId) return fail('mcp_interaction_source_coordinator_changed');
    const key = addressKey(address, owner.resource_owner);
    let source = sources.get(key);
    if (!source) { source = { client, address: structuredClone(address), resourceOwner: structuredClone(owner.resource_owner), registrations: [], inspections: new Map(), revision: 0 }; sources.set(key, source); }
    else source.client = client;
    watch(source); return source;
  };
  const facade = (source: Source, receipt: SourceMcpDeliveryReceipt): { entry: Projection; input: Omit<McpInteractionRequest, 'request'> } => {
    const entry: Projection = { source, receipt, controller: new AbortController(), before: [], settled: [], listeners: new Set(), responseAttempted: false, responseUncertain: false };
    projections.set(receipt.deliveryId, entry);
    const input: Omit<McpInteractionRequest, 'request'> = {
      binding: receipt.binding, signal: entry.controller.signal,
      async assertLive() {
        entry.controller.signal.throwIfAborted();
        const current = await readReceipt(source, receipt); validateBinding(source, current.receipt.binding);
        if (!current.live || current.receipt.availability !== 'live' || current.receipt.responseHash !== null || current.receipt.released) return fail('mcp_interaction_not_live');
      },
      beforeResponse: (callback: () => void | Promise<void>) => { entry.before.push(callback); },
      onResponseSettled: (callback: (state: Settled) => void) => { entry.settled.push(callback); },
      onComplete(complete, unavailable) {
        const listener = { complete, ...(unavailable ? { unavailable } : {}) }; entry.listeners.add(listener);
        // Source completion may precede Catalog's asynchronous body publication.
        queueMicrotask(() => { if (entry.listeners.has(listener)) notify(entry, source.inspections.get(receipt.deliveryId) ?? { receipt: entry.receipt, live: true }); });
        return () => { entry.listeners.delete(listener); };
      },
    };
    return { entry, input };
  };
  const respond = async (entry: Projection, response: ManagedMcpInteractionResponse) => {
    if (entry.responseAttempted || disposed) return;
    try {
      for (const callback of entry.before) await callback();
      lifetime.signal.throwIfAborted(); entry.controller.signal.throwIfAborted();
      // Mark the attempt before crossing the network. Neither failures nor recovery resend bodies.
      entry.responseAttempted = true;
      const inspection = validate(await request<ManagedMcpInteractionInspection>(entry.source, { kind: 'interaction_respond',
        deliveryId: entry.receipt.deliveryId, binding: entry.receipt.binding, response }), entry.receipt);
      remember(entry.source, inspection); notify(entry, inspection);
    } catch (error) {
      if (entry.responseAttempted) entry.responseUncertain = true;
      else entry.localClose = 'owner_unavailable';
      report(error);
    } finally { wake(); }
  };
  const open = async (source: Source, inspection: ManagedMcpInteractionInspection) => {
    const receipt = inspection.receipt; validateBinding(source, receipt.binding);
    if (receipt.released || projections.has(receipt.deliveryId)) return;
    const body = await request<ManagedMcpInteractionBody>(source, { kind: 'interaction_read', deliveryId: receipt.deliveryId, binding: receipt.binding });
    if (!body || body.kind !== receipt.kind || !object(body.request) || hash(stable(body)) !== receipt.requestHash) return fail('mcp_interaction_source_body_changed');
    if (body.kind === 'error') {
      if (!Array.isArray(body.items) || !body.items.length || !body.items.some(item => item.deliveryId === receipt.deliveryId)) return fail('mcp_interaction_source_body_changed');
      // A shared error body is delivered once, with every actual original URL item.
      const checked = body.items.map(item => {
        const current = source.inspections.get(item.deliveryId);
        if (!current || current.receipt.kind !== 'error' || current.receipt.requestHash !== receipt.requestHash
          || item.deliveryId !== identity(item.binding) || !isDeepStrictEqual(current.receipt.binding, item.binding)) return fail('mcp_interaction_source_body_changed');
        validateBinding(source, item.binding); return { item, current };
      });
      if (checked.some(({ item }) => projections.has(item.deliveryId))) return;
      const items = checked.map(({ item, current }): McpErrorInteractionItem => ({ ...facade(source, current.receipt).input, presentation: item.presentation }));
      options.interactions.errorReceiver({ request: body.request, items });
      await Promise.all(items.map(item => options.interactions.published(item.binding)));
    } else {
      if (body.deliveryId !== receipt.deliveryId || !isDeepStrictEqual(body.binding, receipt.binding)) return fail('mcp_interaction_source_body_changed');
      if (receipt.responseHash !== null) return;
      const { entry, input } = facade(source, receipt);
      if (!inspection.live || receipt.availability !== 'live') entry.controller.abort(receipt.availability === 'live' ? 'connection_lost' : receipt.availability);
      const answer = body.kind === 'sampling' ? options.interactions.samplingReceiver({ ...input, request: body.request })
        : options.interactions.receiver({ ...input, request: body.request });
      void answer.then(value => respond(entry, { kind: 'result', value: value as Record<string, unknown> }), error => {
        if (error instanceof McpSamplingRejectedError) return respond(entry, { kind: 'sampling_rejected' });
        const reason: unknown = entry.controller.signal.reason;
        entry.localClose ??= reason === 'rpc_closed' || reason === 'connection_lost' || reason === 'owner_unavailable' || reason === 'cancelled'
          ? reason : entry.controller.signal.aborted ? 'cancelled' : 'owner_unavailable';
        wake();
      }).catch(report);
      await options.interactions.published(receipt.binding);
    }
    schedule();
  };
  const retainCompletion = (record: McpInteractionRecord) => record.mode === 'url' && !record.completionReported
    && record.delivery !== 'not_sent' && ['live', 'rpc_closed'].includes(record.availability)
    && (record.binding.source.kind === 'rpc_error' ? record.choice === null || record.choice === 'accept' : record.choice === 'accept');
  const finished = (record: McpInteractionRecord) => !retainCompletion(record) && (record.availability !== 'live'
    || record.binding.source.kind === 'rpc_error' && (record.completionReported || record.choice !== null)
    || terminal(record.delivery));
  const publish = async (record: McpInteractionRecord, inspection: ManagedMcpInteractionInspection) => {
    const receipt = inspection.receipt;
    if (receipt.availability !== 'live') record = await short('runtime.mcp.interaction.close', record, { availability: receipt.availability });
    if (receipt.kind !== 'error' && (terminal(receipt.delivery) || (!inspection.live || receipt.availability !== 'live') && receipt.responseHash === null)) {
      const delivery = record.choice === null || receipt.responseHash === null ? 'not_sent' : receipt.delivery!;
      if (record.delivery !== delivery) record = await short('runtime.mcp.interaction.response.settle', record, { delivery });
    }
    if (receipt.completed && !record.completionReported) record = await short('runtime.mcp.interaction.complete', record);
    return record;
  };
  const reconcileRecord = async (pending: McpInteractionRecord) => {
    const loaded = await context(pending);
    if (!isDeepStrictEqual(loaded.record.binding, pending.binding)) return fail('mcp_interaction_original_binding_changed');
    if (loaded.record.deliveryReleased) return;
    const address = ownerAddress(loaded.owner);
    const source = sourceFor(await options.runtime.managedSource(loaded.owner.resource_owner as Extract<McpServerOwner['resource_owner'], { kind: 'managed_host' }>, lifetime.signal), address, loaded.owner);
    let record = loaded.record;
    const entry = projections.get(record.id);
    if (entry && (entry.source !== source || !isDeepStrictEqual(validateBinding(source, record.binding).server.owner, loaded.owner))) return fail('mcp_interaction_source_owner_changed');
    let inspection = remember(source, validate(await request<ManagedMcpInteractionInspection>(source, { kind: 'interaction_inspect',
      deliveryId: record.id, binding: record.binding }), source.inspections.get(record.id)?.receipt));
    if (inspection.receipt.deliveryId !== record.id || !isDeepStrictEqual(inspection.receipt.binding, record.binding)) return fail('mcp_interaction_original_binding_changed');
    if (entry) notify(entry, inspection);
    // An A reopen retains only original factual cleanup; it never reconstructs a receiver/model.
    if (!entry && record.availability === 'live') record = await short('runtime.mcp.interaction.close', record, { availability: 'connection_lost' });
    const lost = !inspection.live && !inspection.receipt.completed && retainCompletion(record);
    const closeReason = entry?.localClose ?? (entry?.responseUncertain || lost ? 'connection_lost' : undefined)
      ?? (record.availability !== 'live' && !retainCompletion(record) ? record.availability : undefined);
    if (!inspection.receipt.released && (closeReason || finished(record))) {
      inspection = remember(source, validate(await request<ManagedMcpInteractionInspection>(source, { kind: 'interaction_close',
        deliveryId: record.id, binding: record.binding, availability: closeReason ?? 'rpc_closed' }), inspection.receipt));
      if (entry) { entry.responseUncertain = false; delete entry.localClose; notify(entry, inspection); }
    }
    record = await publish(record, inspection);
    // Only a successful durable Catalog projection allows acknowledging this exact Source revision.
    if (inspection.receipt.acknowledgedRevision < inspection.receipt.revision) await request(source, { kind: 'interaction_ack',
      deliveryId: record.id, binding: record.binding, revision: inspection.receipt.revision });
    if (!finished(record) || inspection.receipt.delivery === 'sending') return;
    const released = await request<ManagedMcpInteractionInspection & { retire?: boolean }>(source, { kind: 'interaction_release',
      deliveryId: record.id, binding: record.binding, revision: inspection.receipt.revision });
    validate(released, inspection.receipt);
    if (!released.receipt.released || released.receipt.acknowledgedRevision !== released.receipt.revision) return fail('mcp_interaction_source_release_unconfirmed');
    // B alone reports whether its already-sealed Source now needs final native retirement.
    if (released.retire) await retire(source);
    await short('runtime.mcp.interaction.delivery.released', record);
    projections.delete(record.id); source.inspections.delete(record.id);
  };
  const reconcile = async (runId?: string) => {
    const records = await options.kernel.agentRuntimeRequest<McpInteractionPending[], 'runtime.mcp.interaction.pending'>('runtime.mcp.interaction.pending', {});
    const duties: Promise<void>[] = [];
    const known = new Set(records.map(record => record.id));
    for (const record of records) {
      if (record.deliveryReleased || runId && record.runId !== runId) continue;
      duties.push(flight(record.binding, () => reconcileRecord(record), record.runId));
    }
    if (!runId) for (const source of sources.values()) for (const inspection of [...source.inspections.values()]) {
      if (known.has(inspection.receipt.deliveryId) || inspection.receipt.released || projections.has(inspection.receipt.deliveryId)
        || !registration(source, inspection.receipt.binding)) continue;
      duties.push(flight(inspection.receipt.binding, async () => {
        const current = source.inspections.get(inspection.receipt.deliveryId);
        if (current) await open(source, current);
      }));
    }
    // Only the short Catalog discovery is global. No remote completion occupies its pump.
    return duties;
  };
  const wake = () => {
    if (disposed) return; dirty = true;
    if (pumping) return;
    pumping = (async () => { while (dirty && !disposed) { dirty = false; await reconcile(); } })()
      .catch(error => { report(error); schedule(); }).finally(() => { pumping = undefined; if (dirty && !disposed) wake(); });
  };
  return {
    async ensure(input: ManagedMcpInteractionRegistration) {
      if (disposed) return fail('mcp_interaction_owner_unavailable');
      if (!input.origin.operationId || !isDeepStrictEqual(ownerAddress(input.server.owner), input.address)
        || input.endpoint && (input.endpoint.server !== input.server.server || input.endpoint.resourceKey !== input.server.resource_key
          || input.endpoint.configurationVersion !== input.server.definition_version)) return fail('mcp_interaction_source_owner_changed');
      const source = sourceFor(input.client, input.address, input.server.owner);
      const previous = source.registrations.find(item => item.origin.operationId === input.origin.operationId
        && isDeepStrictEqual(item.origin.executionOwner, input.origin.executionOwner) && item.server.server === input.server.server);
      if (previous && (!isDeepStrictEqual(previous.server, input.server) || previous.endpoint && input.endpoint && !isDeepStrictEqual(previous.endpoint, input.endpoint))) return fail('mcp_interaction_original_binding_changed');
      if (previous && !previous.endpoint && input.endpoint) previous.endpoint = structuredClone(input.endpoint);
      if (!previous) source.registrations.push({ ...input, address: structuredClone(input.address), origin: structuredClone(input.origin), server: structuredClone(input.server), ...(input.endpoint ? { endpoint: structuredClone(input.endpoint) } : {}) });
      wake();
    },
    start() { if (started || disposed) return; started = true; removers.push(options.runtime.onReady(wake), options.runtime.onEvent(wake)); wake(); },
    wake,
    async releaseSource(runId: string) {
      if (disposed) return;
      const duties = await reconcile(runId);
      for (const active of flights.values()) duties.push((async () => {
        if (!active.runId) {
          // A body read may precede its Catalog interaction row. Resolve its original
          // Operation locally rather than joining every Source's unfinished open.
          const operation = await options.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>(
            'runtime.operation.inspect', { operationId: active.binding.operationId });
          if (operation.id !== active.binding.operationId || !isDeepStrictEqual(operation.execution_owner, active.binding.executionOwner)) return fail('mcp_interaction_original_binding_changed');
          active.runId = operation.run_id;
        }
        if (active.runId === runId) await active.promise;
      })());
      await Promise.all(duties);
      // Include rows published by those original opens, without waiting on another Run.
      await Promise.all(await reconcile(runId));
    },
    async dispose() {
      if (disposed) return; disposed = true; lifetime.abort(); if (retry) clearTimeout(retry);
      for (const remove of removers) remove();
      for (const entry of projections.values()) entry.controller.abort('connection_lost');
      // Original Catalog cleanup obligations survive. Shutdown never posts an answer or retires B's owner.
      projections.clear(); sources.clear();
    },
  };
}
