/** Background plugin ingress. Catalog owns subscriptions, checkpoints, content and delivery. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compileToolJsonSchema } from '../models/schema.js';
import { VARIN_EVENTS_CAPABILITY, parseVarinEventBatch, parseVarinEventConnections,
  type JsonObject, type JsonValue, type VarinEventSourceDescriptor, type VarinEventSourceIdentity,
  type VarinCredentialMetadata } from '@varin/extension-contract';
import { declaredEventSources, type ApplicationExtensionRuntime, type DeclaredEventSource,
  type HostCapabilityCallContext, type HostInvocationScope, type HostServiceOwnerIdentity,
  type HostServicePin } from '@varin/extension-host';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { FollowupEventSourceIdentity, FollowupEventSourceStatus } from '../kernel/protocol.generated.js';
import { bindPluginInvocationPrincipal } from './invocation-principal.js';
import type { PluginCredentialCapability } from './credentials.js';

type Catalog = Pick<AgentRuntimeClient, 'eventSourceSubscriptions' | 'eventSourceCheckpoint' | 'updateEventSourceStatus'
  | 'receivePluginEvents' | 'eventTransportSources' | 'onEvent' | 'onExit' | 'onReady'>;
interface Held { pin: HostServicePin; owner: HostServiceOwnerIdentity; scope: HostInvocationScope;
  context: HostCapabilityCallContext; allowReceive(): void; release(): void }
interface Flight { identity: FollowupEventSourceIdentity; controller: AbortController; fingerprint: string;
  providerId?: string; work: Promise<void> }
const keyFor = ({ principalId, source }: FollowupEventSourceIdentity) => JSON.stringify([
  principalId, source.extensionId, source.sourceId, source.connectionId, source.accountId]);
const unavailable = (code: string) => Object.assign(new Error(code), { code });

export class PluginEventSources {
  readonly #stop = new AbortController();
  readonly #flights = new Map<string, Flight>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #receivers = new WeakMap<HostInvocationScope, { held: Held; identity: FollowupEventSourceIdentity;
    declaration: DeclaredEventSource; status: FollowupEventSourceStatus | null }>();
  readonly #removers: Array<() => void> = [];
  #remote?: Pick<import('./event-transport.js').PluginEventTransport, 'discover' | 'validateArrangement'>;
  setRemote(remote: Pick<import('./event-transport.js').PluginEventTransport, 'discover' | 'validateArrangement'>): void { this.#remote = remote; }
  #pumping: Promise<void> | undefined;
  #dirty = false;
  #suspended = false;
  #started = false;
  constructor(readonly extensions: ApplicationExtensionRuntime, readonly catalog: Catalog,
    readonly credentials: PluginCredentialCapability, readonly retryDelayMs = 5_000, readonly hostId = '') {}

  start(): void {
    if (this.#started) return;
    this.#stop.signal.throwIfAborted(); this.#started = true;
    this.#removers.push(this.extensions.capabilities.register(VARIN_EVENTS_CAPABILITY, (method, raw, context) => this.call(method, raw, context)),
      this.extensions.subscribe(() => { void this.reconcile(); }),
      this.catalog.onEvent(event => { if (event.stream === 'durable') void this.reconcile(); }),
      this.catalog.onExit(() => { this.#suspended = true; for (const timer of this.#retries.values()) clearTimeout(timer); this.#retries.clear(); for (const flight of this.#flights.values()) flight.controller.abort(); }),
      this.catalog.onReady(() => { this.#suspended = false; void this.reconcile(); }),
      this.credentials.subscribe(({ principalId, extensionId, connectionId }) => {
        for (const flight of this.#flights.values()) if (flight.identity.principalId === principalId
          && flight.identity.source.extensionId === extensionId && flight.identity.source.connectionId === connectionId) flight.controller.abort();
        void this.reconcile();
      }));
    void this.reconcile();
  }

  async #held(declaration: DeclaredEventSource, principalId: string | null, signal: AbortSignal): Promise<Held> {
    if (!declaration.enabled) throw unavailable('plugin_disabled');
    if (!declaration.granted) throw unavailable('source_capability_unavailable');
    const binding = await this.extensions.prepareEventSource(declaration.extensionId, declaration.serviceId, declaration.version, signal);
    let pin: HostServicePin;
    try {
      if (!isDeepStrictEqual(binding.descriptor.contract?.events?.[declaration.event], declaration.contract)) throw unavailable('source_changed');
      pin = binding.pin();
    } finally { binding.release(); }
    const owner = this.extensions.services.getSnapshot().providers.find(provider => provider.providerId === pin.providerId);
    if (!owner) { pin.release(); throw unavailable('source_unavailable'); }
    const scope: HostInvocationScope = Object.freeze({ id: randomUUID(), value: null });
    const context: HostCapabilityCallContext = { owner, invocation: scope,
      signal: AbortSignal.any([signal, pin.revocationSignal, this.#stop.signal]) };
    const unbind = principalId === null ? () => {} : bindPluginInvocationPrincipal(scope, principalId,
      candidate => !context.signal.aborted && candidate.owner.extensionId === owner.extensionId
        && candidate.owner.instanceKey === owner.instanceKey && candidate.owner.generation === owner.generation);
    const releaseDiscovery = this.credentials.bindConnectionDiscovery(scope);
    return { pin, owner, scope, context, allowReceive: releaseDiscovery, release: () => { releaseDiscovery(); unbind(); pin.release(); } };
  }

  async #connections(declaration: DeclaredEventSource, held: Held): Promise<VarinEventSourceDescriptor['connections']> {
    const rows = parseVarinEventConnections(await held.pin.invoke(declaration.declaration.connectionsMethod,
      [{ sourceId: declaration.declaration.sourceId }], held.context.signal, held.scope));
    return Promise.all(rows.map(async row => {
      if (declaration.declaration.credentials === 'none') return { ...row, accountId: row.accountId ?? null,
        available: !!row.accountId, ...(!row.accountId ? { code: 'account_identity_missing' } : {}) };
      try {
        const metadata = await this.credentials.call('inspect', { connectionId: row.connectionId }, held.context) as unknown as VarinCredentialMetadata;
        return { connectionId: row.connectionId, displayName: row.displayName, accountId: metadata.account ?? null,
          available: metadata.connected, ...(!metadata.connected ? { code: 'connection_unavailable' } : {}) };
      } catch { return { connectionId: row.connectionId, displayName: row.displayName, accountId: null,
        available: false, code: 'connection_unavailable' }; }
    }));
  }

  async discover(principalId: string | null, signal?: AbortSignal): Promise<VarinEventSourceDescriptor[]> {
    const [local, remote] = await Promise.all([this.discoverLocal(principalId, signal), this.#remote?.discover(principalId, signal) ?? []]);
    return [...local, ...remote];
  }
  async discoverLocal(principalId: string | null, signal?: AbortSignal): Promise<VarinEventSourceDescriptor[]> {
    const declarations = declaredEventSources(await this.extensions.catalog.snapshot());
    return Promise.all(declarations.map(async declaration => {
      const data = declaration.declaration;
      const result: VarinEventSourceDescriptor = { extensionId: declaration.extensionId, sourceId: data.sourceId,
        displayName: data.displayName, ...(declaration.contract.description ? { description: declaration.contract.description } : {}),
        filterSchema: data.filterSchema, modes: data.modes, recovery: data.recovery, credentials: data.credentials,
        available: false, connections: [] };
      if (!declaration.enabled) return { ...result, code: 'plugin_disabled' };
      if (!declaration.granted) return { ...result, code: 'source_capability_unavailable' };
      if (data.credentials === 'required' && principalId === null) return { ...result, code: 'authentication_required' };
      let held: Held | undefined;
      try {
        held = await this.#held(declaration, principalId, signal ?? this.#stop.signal);
        result.connections = await this.#connections(declaration, held);
        result.available = true;
        return result;
      } catch { if (signal?.aborted) throw signal.reason; return { ...result, code: 'source_unavailable' }; }
      finally { held?.release(); }
    }));
  }

  async validateArrangement(principalId: string | null, source: VarinEventSourceIdentity, filter: JsonObject, signal?: AbortSignal): Promise<void> {
    if (source.host) { if (!this.#remote) throw unavailable('remote_source_unavailable');
      return this.#remote.validateArrangement(principalId, source, filter, signal); }
    const declaration = declaredEventSources(await this.extensions.catalog.snapshot()).find(item =>
      item.extensionId === source.extensionId && item.declaration.sourceId === source.sourceId);
    if (!declaration) throw unavailable('source_unavailable');
    if (!compileToolJsonSchema(declaration.declaration.filterSchema)(filter)) throw unavailable('source_filter_invalid');
    if (principalId === null && declaration.declaration.credentials === 'required') throw unavailable('authentication_required');
    const held = await this.#held(declaration, principalId, signal ?? this.#stop.signal);
    try { await this.#checkConnection(declaration, held, source); } finally { held.release(); }
  }

  async #checkConnection(declaration: DeclaredEventSource, held: Held, source: VarinEventSourceIdentity): Promise<void> {
    const connection = (await this.#connections(declaration, held)).find(item => item.connectionId === source.connectionId);
    if (!connection?.available) throw unavailable('connection_unavailable');
    if (connection.accountId !== source.accountId) throw unavailable('account_changed');
  }

  /** Only the exact retained receive invocation can commit. JSON cannot select a user or source. */
  async call(method: string, raw: JsonValue, context: HostCapabilityCallContext): Promise<JsonValue> {
    const receiver = context.invocation && this.#receivers.get(context.invocation);
    if (!receiver || context.owner.extensionId !== receiver.held.owner.extensionId
      || context.owner.instanceKey !== receiver.held.owner.instanceKey || context.owner.generation !== receiver.held.owner.generation
      || context.owner.entrypointId !== receiver.held.owner.entrypointId) throw unavailable('event_receiver_unavailable');
    context.signal.throwIfAborted(); receiver.held.context.signal.throwIfAborted(); receiver.held.pin.assertAvailable();
    if (method === 'assertReceiver' && raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length) return null;
    if (method !== 'submit') throw unavailable('event_receiver_method_invalid');
    const batch = parseVarinEventBatch(raw);
    const validate = compileToolJsonSchema(receiver.declaration.contract.schema);
    if (batch.events.some(event => !validate(event.attributes))) throw unavailable('event_attributes_invalid');
    // Credential replacement is checked at commit admission, even if no network refresh occurred.
    if (receiver.declaration.declaration.credentials === 'required') await this.credentials.call('inspect', {
      connectionId: receiver.identity.source.connectionId, expectedAccount: receiver.identity.source.accountId }, receiver.held.context);
    const coverage = receiver.declaration.declaration.recovery === 'realtime'
      ? { kind: 'from', fromMs: Math.max(receiver.status?.coverage?.fromMs ?? Date.now(), batch.coverage?.fromMs ?? 0) }
      : batch.coverage ? { kind: batch.coverage.kind, fromMs: batch.coverage.fromMs ?? null } : receiver.status?.coverage ?? null;
    const status: FollowupEventSourceStatus = { code: null, message: null, coverage,
      lastConnectedAtMs: receiver.status?.lastConnectedAtMs ?? Date.now() };
    const receipt = await this.catalog.receivePluginEvents({ identity: receiver.identity,
      expectedCursor: batch.expectedCursor, nextCursor: batch.nextCursor, status,
      events: batch.events.map(event => ({ ...event, objectId: event.objectId ?? null, senderId: event.senderId ?? null, revision: event.revision ?? null, files: event.files ?? [],
        echoOf: event.echoOf ? { ...event.echoOf, ownerHostId: event.echoOf.ownerHostId === this.hostId ? null : event.echoOf.ownerHostId ?? null } : null })) }, receiver.held.context.signal);
    receiver.status = receipt.checkpoint.status;
    return { cursor: receipt.checkpoint.cursor, accepted: receipt.accepted, duplicates: receipt.duplicates };
  }

  reconcile(): Promise<void> {
    if (this.#stop.signal.aborted || this.#suspended) return Promise.resolve();
    this.#dirty = true;
    if (this.#pumping) return this.#pumping;
    this.#pumping = this.#reconcile().catch(() => { this.#retry('catalog'); }).finally(() => { this.#pumping = undefined; });
    return this.#pumping;
  }
  async #reconcile(): Promise<void> {
    while (this.#dirty && !this.#stop.signal.aborted && !this.#suspended) {
      this.#dirty = false;
      const [subscriptions, transportSources, snapshot] = await Promise.all([this.catalog.eventSourceSubscriptions(this.#stop.signal), this.catalog.eventTransportSources(this.#stop.signal), this.extensions.catalog.snapshot()]);
      const declarations = declaredEventSources(snapshot);
      const desired = new Map<string, { identity: FollowupEventSourceIdentity; declaration: DeclaredEventSource | undefined; fingerprint: string }>();
      for (const identity of [...subscriptions.filter(item => item.state === 'active').map(item => item.identity), ...transportSources]) {
        const source = identity.source;
        if (source.host) continue;
        const declaration = declarations.find(item => item.extensionId === source.extensionId && item.declaration.sourceId === source.sourceId);
        const entry = snapshot.extensions.find(item => item.manifest.id === source.extensionId);
        desired.set(keyFor(identity), { identity, declaration,
          fingerprint: JSON.stringify([declaration, entry?.integrity, entry?.manifest.version]) });
      }
      const providers = this.extensions.services.getSnapshot().providers;
      for (const [key, flight] of this.#flights) {
        const selected = desired.get(key);
        if (!selected || selected.fingerprint !== flight.fingerprint || flight.providerId
          && !providers.some(provider => provider.providerId === flight.providerId && provider.status === 'active')) flight.controller.abort();
      }
      for (const [key, selected] of desired) {
        if (this.#flights.has(key) || this.#retries.has(key)) continue;
        const controller = new AbortController();
        const flight: Flight = { identity: selected.identity, controller, fingerprint: selected.fingerprint, work: Promise.resolve() };
        this.#flights.set(key, flight);
        flight.work = this.#run(flight, selected.declaration).catch(async error => {
          if (!controller.signal.aborted && !this.#stop.signal.aborted) {
            const code = ['account_changed', 'connection_unavailable', 'plugin_disabled', 'authentication_required', 'source_capability_unavailable'].includes(error?.code) ? error.code : 'source_unavailable';
            const checkpoint = await this.catalog.eventSourceCheckpoint(flight.identity).catch(() => null);
            await this.catalog.updateEventSourceStatus({ identity: flight.identity,
              status: { code, message: null, coverage: checkpoint?.status?.coverage ?? null,
                lastConnectedAtMs: checkpoint?.status?.lastConnectedAtMs ?? null } }).catch(() => {});
            this.#retry(key);
          }
        }).finally(() => { this.#flights.delete(key); if (controller.signal.aborted) void this.reconcile(); });
      }
      for (const [key, timer] of this.#retries) if (key !== 'catalog' && !desired.has(key)) { clearTimeout(timer); this.#retries.delete(key); }
    }
  }
  #retry(key: string): void {
    if (this.#stop.signal.aborted || this.#suspended || this.#retries.has(key)) return;
    const timer = setTimeout(() => { this.#retries.delete(key); void this.reconcile(); }, this.retryDelayMs);
    timer.unref(); this.#retries.set(key, timer);
  }
  async #run(flight: Flight, declaration?: DeclaredEventSource): Promise<void> {
    if (!declaration) throw unavailable('source_unavailable');
    if (flight.identity.principalId === null && declaration.declaration.credentials === 'required') throw unavailable('authentication_required');
    const signal = AbortSignal.any([flight.controller.signal, this.#stop.signal]);
    const held = await this.#held(declaration, flight.identity.principalId, signal);
    flight.providerId = held.pin.providerId;
    let unrestricted: (() => void) | undefined;
    try {
      await this.#checkConnection(declaration, held, flight.identity.source);
      const checkpoint = await this.catalog.eventSourceCheckpoint(flight.identity, held.context.signal);
      held.allowReceive();
      if (declaration.declaration.credentials === 'required') unrestricted = this.credentials.bindEventReceiver(
        held.scope, flight.identity.source.connectionId, flight.identity.source.accountId);
      const status: FollowupEventSourceStatus = { code: 'connecting', message: null,
        coverage: declaration.declaration.recovery === 'realtime' ? { kind: 'from', fromMs: Date.now() } : checkpoint.status?.coverage ?? null,
        lastConnectedAtMs: checkpoint.status?.lastConnectedAtMs ?? null };
      await this.catalog.updateEventSourceStatus({ identity: flight.identity, status }, held.context.signal);
      this.#receivers.set(held.scope, { held, identity: flight.identity, declaration, status });
      await held.pin.invoke(declaration.declaration.receiveMethod, [{ sourceId: declaration.declaration.sourceId,
        connectionId: flight.identity.source.connectionId, accountId: flight.identity.source.accountId, cursor: checkpoint.cursor }], held.context.signal, held.scope);
      held.context.signal.throwIfAborted();
      throw unavailable('event_receiver_stopped');
    } finally { this.#receivers.delete(held.scope); unrestricted?.(); held.release(); }
  }
  async close(): Promise<void> {
    this.#stop.abort(); for (const remove of this.#removers.splice(0)) remove();
    for (const timer of this.#retries.values()) clearTimeout(timer); this.#retries.clear();
    for (const flight of this.#flights.values()) flight.controller.abort();
    await this.#pumping;
    await Promise.allSettled([...this.#flights.values()].map(flight => flight.work));
  }
}
