/** Authenticated transfer of the original source ledger between configured Application Hosts. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Express, RequestHandler } from 'express';
import type { JsonObject, VarinEventSourceDescriptor, VarinEventSourceIdentity } from '@varin/extension-contract';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { EventTransportAccess, EventTransportConsumer, EventTransportImport, EventTransportKey,
  EventTransportPage, FollowupEventSourceIdentity } from '../kernel/protocol.generated.js';
import { ManagedTargetClient, type ManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { hasHostConnectionAccess } from '../connections/access.js';
import type { PluginEventSources } from './event-sources.js';

type Catalog = Pick<AgentRuntimeClient, 'eventTransportBind' | 'eventTransportRead' | 'eventTransportAck' | 'eventTransportRelease'
  | 'eventTransportImports' | 'eventTransportGet' | 'eventTransportImportReleased' | 'eventSourceCheckpoint' | 'receivePluginEvents'
  | 'updateEventSourceStatus' | 'onEvent' | 'onExit' | 'onReady'>;
const base = '/api/harness/managed-execution/v1/events';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const sourceKey = (identity: FollowupEventSourceIdentity) => JSON.stringify([identity.principalId,
  identity.source.extensionId, identity.source.sourceId, identity.source.connectionId, identity.source.accountId,
  identity.source.host?.hostId, identity.source.host?.connectionId, identity.source.host?.endpointIdentity]);
const subscriptionId = (identity: FollowupEventSourceIdentity) => createHash('sha256').update(sourceKey(identity)).digest('hex');
const position = (cursor: string | null): { key: EventTransportKey; generation: number; after: number } | null => {
  if (cursor === null) return null;
  const value: unknown = JSON.parse(cursor);
  if (!object(value) || !object(value.key)) throw new Error('Invalid remote event checkpoint');
  const key = value.key;
  if (!['principalId', 'clientId', 'coordinatorHostId', 'subscriptionId'].every(field => text(key[field]))
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !Number.isSafeInteger(value.after) || Number(value.after) < 0) throw new Error('Invalid remote event checkpoint');
  return value as { key: EventTransportKey; generation: number; after: number };
};
const wait = (signal: AbortSignal, delay: number) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delay);
  timer.unref(); signal.addEventListener('abort', onAbort, { once: true });
});
function validateSource(value: unknown): asserts value is VarinEventSourceIdentity {
  if (!object(value) || Object.keys(value).some(key => !['extensionId', 'sourceId', 'connectionId', 'accountId'].includes(key))
    || !['extensionId', 'sourceId', 'connectionId', 'accountId'].every(key => text(value[key]))) throw new Error('Invalid local event source');
}
function descriptors(value: unknown): VarinEventSourceDescriptor[] {
  if (!Array.isArray(value)) throw new Error('Invalid remote event source catalog');
  for (const item of value) {
    if (!object(item) || !text(item.extensionId) || !text(item.sourceId) || !text(item.displayName)
      || typeof item.available !== 'boolean' || !Array.isArray(item.connections)
      || !Array.isArray(item.modes) || !item.modes.every(mode => ['poll', 'stream', 'push'].includes(String(mode)))
      || !['required', 'none'].includes(String(item.credentials)) || !['history', 'realtime'].includes(String(item.recovery))
      || typeof item.filterSchema !== 'boolean' && !object(item.filterSchema)) throw new Error('Invalid remote event source catalog');
    if (item.host !== undefined) throw new Error('Remote event relaying is not recursive');
    for (const connection of item.connections) if (!object(connection) || !text(connection.connectionId)
      || !text(connection.displayName) || connection.accountId !== null && !text(connection.accountId)
      || typeof connection.available !== 'boolean') throw new Error('Invalid remote event connection');
  }
  return value as VarinEventSourceDescriptor[];
}

export class PluginEventTransport {
  readonly #stop = new AbortController();
  readonly #flights = new Map<string, { state: EventTransportImport['state']; stop: AbortController; work: Promise<void> }>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #removers: Array<() => void> = [];
  readonly #settled = new Map<string, EventTransportImport['state']>();
  #pumping: Promise<void> | undefined;
  #dirty = false;
  #suspended = false;
  constructor(readonly hostId: string, readonly catalog: Catalog, readonly targets: Pick<ManagedRemoteTargetRegistry, 'sourceTargets' | 'forwardTarget'>,
    readonly canUseConnections: (principalId: string | null) => Promise<boolean>, readonly fetchImpl: typeof fetch = fetch) {}
  async #client(principalId: string | null, source: VarinEventSourceIdentity, signal?: AbortSignal): Promise<ManagedTargetClient> {
    if (!source.host || !await this.canUseConnections(principalId)) throw new Error('Saved Host connection access is unavailable');
    const target = await this.targets.forwardTarget({ kind: 'managed_host', ...source.host }, signal);
    return new ManagedTargetClient(target, this.fetchImpl);
  }
  async discover(principalId: string | null, signal?: AbortSignal): Promise<VarinEventSourceDescriptor[]> {
    if (!await this.canUseConnections(principalId)) return [];
    const { targets } = await this.targets.sourceTargets(signal);
    const results = await Promise.all(targets.map(async target => {
      const host = { hostId: target.resourceOwner.hostId, connectionId: target.resourceOwner.connectionId, endpointIdentity: target.resourceOwner.endpointIdentity };
      try {
        const client = new ManagedTargetClient(await this.targets.forwardTarget(target.resourceOwner, signal), this.fetchImpl);
        return descriptors(await client.json('/events/discover', {}, 'POST', signal)).map(item => ({ ...item, host,
          displayName: `${target.label}: ${item.displayName}` }));
      } catch { if (signal?.aborted) throw signal.reason; return []; }
    }));
    return results.flat();
  }
  async validateArrangement(principalId: string | null, source: VarinEventSourceIdentity, filter: JsonObject, signal?: AbortSignal): Promise<void> {
    const client = await this.#client(principalId, source, signal);
    const { host: _host, ...localSource } = source;
    await client.json('/events/validate', { source: localSource, filter }, 'POST', signal);
  }
  start(): void {
    this.#removers.push(this.catalog.onEvent(event => { if (event.stream === 'durable') void this.reconcile(); }),
      this.catalog.onExit(() => { this.#suspended = true; for (const timer of this.#timers.values()) clearTimeout(timer); this.#timers.clear(); for (const flight of this.#flights.values()) flight.stop.abort(); }),
      this.catalog.onReady(() => { this.#suspended = false; this.#settled.clear(); void this.reconcile(); }));
    void this.reconcile();
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
      const imports = await this.catalog.eventTransportImports(this.#stop.signal);
      const desired = new Map(imports.map(item => [sourceKey(item.identity), item]));
      for (const [key, flight] of this.#flights) if (desired.get(key)?.state !== flight.state) flight.stop.abort();
      for (const [key, item] of desired) {
        if (this.#flights.has(key) || this.#timers.has(key) || this.#settled.get(key) === item.state) continue;
        const stop = new AbortController(), signal = AbortSignal.any([stop.signal, this.#stop.signal]);
        const flight = { state: item.state, stop, work: Promise.resolve() }; this.#flights.set(key, flight);
        flight.work = this.#transfer(item, signal).then(() => { this.#settled.set(key, item.state); }).catch(async () => {
          if (!signal.aborted) {
            const checkpoint = await this.catalog.eventSourceCheckpoint(item.identity).catch(() => null);
            await this.catalog.updateEventSourceStatus({ identity: item.identity, status: {
              code: 'remote_source_unavailable', message: null, coverage: checkpoint?.status?.coverage ?? null,
              lastConnectedAtMs: checkpoint?.status?.lastConnectedAtMs ?? null } }).catch(() => {});
            this.#retry(key);
          }
        }).finally(() => { this.#flights.delete(key); if (stop.signal.aborted) void this.reconcile(); });
      }
      for (const key of this.#settled.keys()) if (!desired.has(key)) this.#settled.delete(key);
      for (const [key, timer] of this.#timers) if (key !== 'catalog' && !desired.has(key)) { clearTimeout(timer); this.#timers.delete(key); }
    }
  }
  #retry(key: string): void {
    if (this.#stop.signal.aborted || this.#suspended || this.#timers.has(key)) return;
    const timer = setTimeout(() => { this.#timers.delete(key); void this.reconcile(); }, 5_000); timer.unref(); this.#timers.set(key, timer);
  }
  async #transfer(item: EventTransportImport, signal: AbortSignal): Promise<void> {
    const client = await this.#client(item.identity.principalId, item.identity.source, signal);
    const { host: _host, ...source } = item.identity.source;
    const key = { coordinatorHostId: this.hostId, subscriptionId: subscriptionId(item.identity) };
    if (item.state === 'released') {
      const original = await client.json<EventTransportConsumer | null>('/events/get', key, 'POST', signal);
      const saved = position((await this.catalog.eventSourceCheckpoint(item.identity, signal)).cursor);
      if (saved && (!original || !isDeepStrictEqual(saved.key, original.key))) throw new Error('Original remote consumer identity is unavailable');
      if (original) await client.json('/events/release', { ...key, generation: original.generation }, 'POST', signal);
      await this.catalog.eventTransportImportReleased(item.identity, signal); return;
    }
    const consumer = await client.json<EventTransportConsumer>('/events/bind', { ...key, source, state: item.state }, 'POST', signal);
    const access = { ...key, generation: consumer.generation };
    if (item.state === 'paused') return;
    for (;;) {
      signal.throwIfAborted();
      // Recheck saved connection identity and the local principal before transmitting every page.
      const currentClient = await this.#client(item.identity.principalId, item.identity.source, signal);
      const checkpoint = await this.catalog.eventSourceCheckpoint(item.identity, signal);
      const saved = position(checkpoint.cursor);
      if (saved && !isDeepStrictEqual(saved.key, consumer.key)) throw new Error('Remote event authentication identity changed');
      if (saved?.generation === consumer.generation) await currentClient.json('/events/ack', { ...access, throughCursor: saved.after }, 'POST', signal);
      const page = await currentClient.json<EventTransportPage>('/events/read', access, 'POST', signal);
      if (page.consumer.generation !== consumer.generation || page.consumer.key.coordinatorHostId !== this.hostId
        || !isDeepStrictEqual(page.consumer.key, consumer.key) || !isDeepStrictEqual(page.consumer.identity.source, source)
        || page.throughCursor < page.consumer.afterCursor || saved?.generation === consumer.generation && page.throughCursor < saved.after || !Array.isArray(page.events)) throw new Error('Remote event page identity changed');
      const nextCursor = JSON.stringify({ key: consumer.key, generation: consumer.generation, after: page.throughCursor });
      if (page.events.length || checkpoint.cursor !== nextCursor) {
        await this.catalog.receivePluginEvents({ identity: item.identity, expectedCursor: checkpoint.cursor, nextCursor,
          status: page.status, events: page.events.map(event => ({ ...event, echoOf: event.echoOf ? { ...event.echoOf,
            ownerHostId: event.echoOf.ownerHostId === this.hostId ? null : event.echoOf.ownerHostId ?? item.identity.source.host!.hostId } : null })) }, signal);
      } else if (!isDeepStrictEqual(checkpoint.status, page.status) && page.status) {
        await this.catalog.updateEventSourceStatus({ identity: item.identity, status: page.status }, signal);
      }
      await currentClient.json('/events/ack', { ...access, throughCursor: page.throughCursor }, 'POST', signal);
      if (!page.events.length) await wait(signal, 1_000);
    }
  }
  async close(): Promise<void> {
    this.#stop.abort(); for (const remove of this.#removers.splice(0)) remove();
    for (const timer of this.#timers.values()) clearTimeout(timer); this.#timers.clear();
    for (const flight of this.#flights.values()) flight.stop.abort();
    await this.#pumping; await Promise.allSettled([...this.#flights.values()].map(flight => flight.work));
  }
}

export function registerPluginEventTransportRoutes(app: Express, options: {
  hostId: string; catalog: Catalog; sources: Pick<PluginEventSources, 'discoverLocal' | 'validateArrangement' | 'reconcile'>;
  requireAuth: RequestHandler; isDraining(): boolean;
}): void {
  for (const action of ['discover', 'validate', 'bind', 'get', 'read', 'ack', 'release'] as const) {
    app.post(`${base}/${action}`, options.requireAuth, async (request, response) => {
      const auth = request.varinAuth;
      if (auth?.type !== 'client' || !auth.clientId || !auth.principalId || !hasHostConnectionAccess(auth, 'proxy')) {
        response.status(403).json({ code: 'event_transport_forbidden', error: 'A stable authenticated full-control client is required' }); return;
      }
      response.setHeader('X-Varin-Managed-Host', options.hostId);
      response.setHeader('Cache-Control', 'no-store');
      const stop = new AbortController();
      const cancel = () => { if (!response.writableEnded) stop.abort(); }; response.once('close', cancel);
      try {
        if (options.isDraining() && !['get', 'ack', 'release'].includes(action)) { response.status(503).json({ code: 'host_draining' }); return; }
        const raw: unknown = request.body;
        if (!object(raw)) throw new Error('Invalid event transport request');
        const fields: Record<typeof action, string[]> = { discover: [], validate: ['source', 'filter'],
          bind: ['coordinatorHostId', 'subscriptionId', 'source', 'state'], get: ['coordinatorHostId', 'subscriptionId'], read: ['coordinatorHostId', 'subscriptionId', 'generation'],
          ack: ['coordinatorHostId', 'subscriptionId', 'generation', 'throughCursor'], release: ['coordinatorHostId', 'subscriptionId', 'generation'] };
        if (Object.keys(raw).some(key => !fields[action].includes(key))) throw new Error('Unexpected event transport authority');
        if (action === 'discover') { response.json(await options.sources.discoverLocal(auth.principalId, stop.signal)); return; }
        if (action === 'validate') {
          validateSource(raw.source); if (!object(raw.filter)) throw new Error('Invalid event filter');
          await options.sources.validateArrangement(auth.principalId, raw.source, raw.filter as JsonObject, stop.signal);
          response.json({ valid: true }); return;
        }
        if (!text(raw.coordinatorHostId) || !text(raw.subscriptionId) || raw.coordinatorHostId === options.hostId) throw new Error('Invalid peer event identity');
        const key: EventTransportKey = { principalId: auth.principalId, clientId: auth.clientId,
          coordinatorHostId: raw.coordinatorHostId, subscriptionId: raw.subscriptionId };
        if (action === 'get') { response.json(await options.catalog.eventTransportGet(key, stop.signal)); return; }
        if (action === 'bind') {
          validateSource(raw.source);
          if (raw.state !== 'active' && raw.state !== 'paused') throw new Error('Invalid event consumer state');
          const selected = raw.source;
          const found = raw.state === 'active' ? (await options.sources.discoverLocal(auth.principalId, stop.signal)).find(item => item.extensionId === selected.extensionId && item.sourceId === selected.sourceId) : null;
          if (raw.state === 'active' && (!found?.available || !found.connections.some(item => item.available && item.connectionId === selected.connectionId && item.accountId === selected.accountId))) throw new Error('Selected event account is unavailable');
          response.json(await options.catalog.eventTransportBind({ key, source: raw.source, state: raw.state }, stop.signal));
          void options.sources.reconcile(); return;
        }
        if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1) throw new Error('Invalid consumer generation');
        const access: EventTransportAccess = { key, generation: Number(raw.generation) };
        if (action === 'read') {
          const page = await options.catalog.eventTransportRead(access, stop.signal);
          response.json({ ...page, events: page.events.map(event => ({ ...event, echoOf: event.echoOf
            ? { ...event.echoOf, ownerHostId: event.echoOf.ownerHostId ?? options.hostId } : null })) });
        }
        else if (action === 'release') { response.json(await options.catalog.eventTransportRelease(access, stop.signal)); void options.sources.reconcile(); }
        else {
          if (!Number.isSafeInteger(raw.throughCursor) || Number(raw.throughCursor) < 0) throw new Error('Invalid event cursor');
          response.json(await options.catalog.eventTransportAck({ ...access, throughCursor: Number(raw.throughCursor) }, stop.signal));
        }
      } catch { if (!response.headersSent && !response.destroyed) response.status(503).json({ code: 'event_transport_unavailable', error: 'The selected event source or original consumer is unavailable' }); }
      finally { response.off('close', cancel); }
    });
  }
}
