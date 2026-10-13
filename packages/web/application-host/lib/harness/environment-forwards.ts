import { createServer, type Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket, createWebSocketStream } from 'ws';
import type { Duplex } from 'node:stream';
import type { EnvironmentServiceAccess } from '@varin/protocol';
import { HarnessServiceError } from './service-error.js';
import type { ManagedTarget } from './managed-remote-client.js';

export type EnvironmentForwardOwner = { runtime: 'pi'; sessionId: string }
  | { runtime: 'agent'; operationId: string; hostEpoch: string };
export type EnvironmentForwardState = 'opening' | 'live' | 'stopping' | 'stopped';
export interface EnvironmentForwardInspection { state: EnvironmentForwardState | 'absent'; access: EnvironmentServiceAccess | null }
/** Original Host listener owner. Catalog owns Agent intent, cancellation and durable receipts. */
export interface EnvironmentForwardRuntime {
  readonly epoch: string;
  open(input: { target: ManagedTarget; host: string; port: number; threadId: string | null;
    owner: EnvironmentForwardOwner; signal?: AbortSignal; webSocket?: typeof WebSocket }): Promise<EnvironmentServiceAccess>;
  list(owner?: EnvironmentForwardOwner): EnvironmentServiceAccess[];
  owners(runtime: EnvironmentForwardOwner['runtime']): EnvironmentForwardOwner[];
  inspect(owner: EnvironmentForwardOwner): EnvironmentForwardInspection;
  close(id: string, owner?: EnvironmentForwardOwner): Promise<boolean>;
  closeOwner(owner: EnvironmentForwardOwner): Promise<void>;
  /** Release a drained receipt only after its original Catalog acknowledgement. */
  release(owner: EnvironmentForwardOwner): void;
  closeRuntime(runtime: EnvironmentForwardOwner['runtime']): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  onChanged(listener: () => void): () => void;
  dispose(): Promise<void>;
}
interface LiveForward {
  owner: EnvironmentForwardOwner; access: EnvironmentServiceAccess | null; listener: Server;
  sockets: Set<Duplex>; streams: Set<Duplex>; channels: Set<WebSocket>; state: EnvironmentForwardState;
  ready: Promise<void>; stopping?: Promise<void>; stopRequested: boolean;
}
const sameOwner = (a: EnvironmentForwardOwner, b: EnvironmentForwardOwner) => a.runtime === 'pi'
  ? b.runtime === 'pi' && a.sessionId === b.sessionId
  : b.runtime === 'agent' && a.operationId === b.operationId && a.hostEpoch === b.hostEpoch;
const wsUrlFor = (target: ManagedTarget, host: string, port: number): string => {
  const apiUrl = new URL(target.connection.apiUrl.replace(/\/$/, '') + '/');
  const url = new URL('/api/environment/forward', apiUrl);
  url.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('host', host); url.searchParams.set('port', String(port));
  return url.toString();
};

export function createEnvironmentForwardRuntime(options: { createListener?: typeof createServer } = {}): EnvironmentForwardRuntime {
  const epoch = randomUUID();
  // One table owns listeners, opening/closing flights and unacknowledged drain receipts.
  const live = new Map<string, LiveForward>();
  const changed = new Set<() => void>();
  let disposed = false;
  const notify = () => { for (const listener of changed) listener(); };
  const entriesFor = (owner: EnvironmentForwardOwner) => [...live.entries()].filter(([, entry]) => sameOwner(entry.owner, owner));
  const stop = (id: string, entry: LiveForward): Promise<void> => {
    entry.stopRequested = true;
    if (entry.stopping) return entry.stopping;
    entry.state = 'stopping';
    entry.stopping = (async () => {
      await entry.ready.catch(() => undefined);
      const drains: Promise<void>[] = [], destroy: Array<() => void> = [];
      // Attach every drain observer before asking any linked stream to close.
      for (const channel of entry.channels) {
        if (channel.readyState === WebSocket.CLOSED) continue;
        drains.push(new Promise<void>(resolve => { channel.once('close', resolve); }));
        destroy.push(() => channel.terminate());
      }
      for (const stream of [...entry.sockets, ...entry.streams]) {
        if (stream.closed) continue;
        drains.push(new Promise<void>(resolve => { stream.once('close', resolve); }));
        destroy.push(() => { stream.destroy(); });
      }
      drains.push(new Promise<void>((resolve, reject) => {
        if (!entry.listener.listening) { resolve(); return; }
        entry.listener.close(error => error ? reject(error) : resolve());
      }));
      for (const close of destroy) close();
      await Promise.all(drains);
      entry.channels.clear(); entry.sockets.clear(); entry.streams.clear(); entry.state = 'stopped';
      if (entry.owner.runtime === 'pi') live.delete(id);
      notify();
    })();
    return entry.stopping;
  };
  const open: EnvironmentForwardRuntime['open'] = async ({ target: suppliedTarget, host, port, threadId, owner, signal, webSocket }) => {
    signal?.throwIfAborted();
    if (disposed) throw new HarnessServiceError('unavailable', 'Environment forwarding is closed');
    if (owner.runtime === 'agent' && (owner.hostEpoch !== epoch || entriesFor(owner).length))
      throw new HarnessServiceError('unavailable', 'Original forward owner is unavailable or already dispatched; reconcile instead of opening again');
    const target = { ...suppliedTarget, connection: { ...suppliedTarget.connection, requestHeaders: { ...suppliedTarget.connection.requestHeaders } } };
    const SocketImpl = webSocket ?? WebSocket;
    const id = `envfwd:${randomUUID()}`;
    const sockets = new Set<Duplex>(), streams = new Set<Duplex>(), channels = new Set<WebSocket>();
    const listener = (options.createListener ?? createServer)((socket) => {
      if (entry.stopRequested || disposed) { socket.destroy(); return; }
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      const channel = new SocketImpl(wsUrlFor(target, host, port), {
        headers: { ...target.connection.requestHeaders,
          ...(target.connection.clientToken ? { authorization: `Bearer ${target.connection.clientToken}` } : {}),
          'x-varin-managed-host': target.hostId }, maxPayload: 0, perMessageDeflate: false,
      });
      channels.add(channel);
      channel.once('close', () => { channels.delete(channel); socket.destroy(); });
      const drop = () => { socket.destroy(); channel.terminate(); };
      socket.once('close', () => channel.terminate()); socket.once('error', drop); channel.once('error', drop);
      channel.once('unexpected-response', (request, response) => { response.resume(); request.destroy(); drop(); });
      channel.once('upgrade', (response) => {
        if (response.headers['x-varin-managed-host'] !== target.hostId || entry.stopRequested) { drop(); return; }
        const stream = createWebSocketStream(channel);
        streams.add(stream); stream.once('close', () => streams.delete(stream));
        socket.pipe(stream).pipe(socket); stream.on('error', drop); stream.on('close', () => socket.destroy());
        socket.on('close', () => { stream.destroy(); channel.close(); });
      });
    });
    const entry: LiveForward = { owner: { ...owner }, access: null, listener, sockets, streams, channels, state: 'opening', ready: Promise.resolve(), stopRequested: false };
    live.set(id, entry);
    entry.ready = new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
    });
    const cancelled = () => { void stop(id, entry).catch(() => undefined); };
    signal?.addEventListener('abort', cancelled, { once: true });
    try {
      await entry.ready;
      if (disposed || signal?.aborted || entry.stopRequested) throw new HarnessServiceError('unavailable', 'Original owner closed while opening its service forward');
      const address = listener.address();
      if (!address || typeof address === 'string') throw new HarnessServiceError('unavailable', 'Service forward listener returned no address');
      entry.access = { id, service: { machineId: target.machineId, host, port },
        access: { kind: 'forward', machineId: 'local', host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}` },
        threadId, createdAt: new Date().toISOString() };
      entry.state = 'live';
      listener.once('close', () => { void stop(id, entry).catch(() => undefined); });
      listener.on('error', () => { void stop(id, entry).catch(() => undefined); });
      notify(); return entry.access;
    } catch (error) { await stop(id, entry); throw error; }
    finally { signal?.removeEventListener('abort', cancelled); }
  };
  const closeOwner = async (owner: EnvironmentForwardOwner) => { await Promise.all(entriesFor(owner).map(([id, entry]) => stop(id, entry))); };
  return {
    epoch, open,
    list: owner => [...live.values()].filter(entry => entry.state === 'live' && (!owner || sameOwner(entry.owner, owner))).flatMap(entry => entry.access ? [entry.access] : []),
    owners: runtime => [...live.values()].filter(entry => entry.owner.runtime === runtime).map(entry => ({ ...entry.owner })),
    inspect: owner => { const entry = entriesFor(owner)[0]?.[1]; return entry ? { state: entry.state, access: entry.access } : { state: 'absent', access: null }; },
    close: async (id, owner) => { const entry = live.get(id); if (!entry || owner && !sameOwner(entry.owner, owner)) return false; await stop(id, entry); return true; },
    closeOwner,
    release: owner => { for (const [id, entry] of entriesFor(owner)) { if (entry.state !== 'stopped') throw new Error('Cannot release a live forward owner'); live.delete(id); } },
    closeRuntime: async runtime => { await Promise.all([...live].filter(([, entry]) => entry.owner.runtime === runtime).map(([id, entry]) => stop(id, entry))); },
    closeSession: sessionId => closeOwner({ runtime: 'pi', sessionId }),
    onChanged: listener => { changed.add(listener); return () => { changed.delete(listener); }; },
    dispose: async () => { disposed = true; await Promise.all([...live].map(([id, entry]) => stop(id, entry))); },
  };
}
