// Long-lived relay host client: maintains the signed `host-control` socket to
// the relay, and per connected client a signed `host-data` socket that runs the
// responder E2EE handshake and feeds decrypted frames into a tunnel-host
// dispatcher. Spec: relay/DOCUMENTATION.md (Layer 1).

import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import { RELAY_PROTOCOL_VERSION, RelayCloseCode, createHostHandshake } from './e2ee.js';
import type { RelayFrameChannel } from './e2ee.js';
import { createOutboundFrameBatcher, decodeFrameBatch } from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';
import type { RelayIdentity } from './identity.js';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const DATA_SOCKET_OPEN_TIMEOUT_MS = 15000;
// Clients send a tunnel Ping at least every ~30s when idle, so a data socket
// with no inbound traffic for 3 ping intervals belongs to a client that died
// without a WebSocket close (network loss, battery kill). The relay worker may
// not notice the dead client leg for a long time, so the host must reap these
// itself — both to free resources and to keep the "N devices connected" status
// honest instead of counting ghosts.
const DATA_SOCKET_IDLE_TIMEOUT_MS = 90_000;
const DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS = 30_000;
// Protocol-level keepalive for the control socket. Without it, a network path
// that dies silently (NAT timeout, relay-edge eviction without close frames)
// leaves the host believing it is registered while the relay has forgotten it —
// every client tunnel then hangs in `connecting` forever. A missed pong window
// terminates the socket, which drives the normal reconnect + re-registration.
const CONTROL_PING_INTERVAL_MS = 30_000;
const CONTROL_PONG_GRACE_MS = 10_000;
const DEFAULT_BATCH_WINDOW_MS = 150;

// Resolve the frame-batching flush window: explicit option wins, then env, then
// the 150 ms default. Only applies on directions where batching was negotiated.
type RelayHostState = 'connected' | 'connecting' | 'disabled' | 'reconnecting';

interface RelayHostStatus {
  connectedClients: number;
  lastError: string | null;
  state: RelayHostState;
}

interface RelayHostOptions {
  batch?: boolean;
  batchWindowMs?: number;
  getLocalPort?: () => number;
  identity: RelayIdentity;
  localPort?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
  onStatus?: (status: RelayHostStatus) => void;
  relayUrl: string;
}

type TunnelHost = ReturnType<typeof createTunnelHost>;
type FrameBatcher = ReturnType<typeof createOutboundFrameBatcher>;

interface DataSocketEntry {
  batcher: FrameBatcher | null;
  lastActivityAt: number;
  openTimer: ReturnType<typeof setTimeout> | null;
  socket: WebSocket;
  tunnel: TunnelHost | null;
}

const rawDataBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const resolveBatchWindowMs = (option?: number): number => {
  if (typeof option === 'number' && Number.isFinite(option) && option >= 0) return option;
  const envValue = Number.parseInt(process.env.VARIN_RELAY_BATCH_WINDOW_MS ?? '', 10);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return DEFAULT_BATCH_WINDOW_MS;
};

/**
 * @param {{
 *   relayUrl: string,
 *   identity: { serverId: string, hostEncPrivateKey: CryptoKey, signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string } },
 *   localPort?: number,
 *   getLocalPort?: () => number,
 *   onStatus?: (status: { state: string, lastError: string | null, connectedClients: number }) => void,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const startRelayHost = ({ relayUrl, identity, localPort, getLocalPort, onStatus, logger = console, batchWindowMs, batch }: RelayHostOptions) => {
  const resolveLocalPort = typeof getLocalPort === 'function' ? getLocalPort : () => localPort ?? 0;
  const localBatch = batch !== false;
  const resolvedBatchWindowMs = resolveBatchWindowMs(batchWindowMs);

  let stopped = false;
  let state: RelayHostState = 'connecting';
  let lastError: string | null = null;
  let controlSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  /** @type {Map<string, { socket: WebSocket, tunnel: ReturnType<typeof createTunnelHost> | null, openTimer: NodeJS.Timeout | null }>} */
  const dataSockets = new Map<string, DataSocketEntry>();

  const emitStatus = (): void => {
    try {
      onStatus?.({ state, lastError, connectedClients: dataSockets.size });
    } catch {
      // status consumers must not break the transport
    }
  };

  const setState = (nextState: RelayHostState, error?: string | null): void => {
    state = nextState;
    if (error !== undefined) lastError = error;
    emitStatus();
  };

  const buildSocketUrl = (role: string, connectionId?: string): string => {
    const url = new URL(relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', role);
    url.searchParams.set('serverId', identity.serverId);
    if (connectionId) url.searchParams.set('connectionId', connectionId);
    const auth = identity.signRelayAuth(role, connectionId ?? null);
    url.searchParams.set('ts', String(auth.ts));
    url.searchParams.set('sig', auth.sig);
    url.searchParams.set('pk', auth.pk);
    return url.toString();
  };

  const teardownDataSocket = (connectionId: string, closeCode?: number, reason?: string): void => {
    const entry = dataSockets.get(connectionId);
    if (!entry) return;
    dataSockets.delete(connectionId);
    if (entry.openTimer) clearTimeout(entry.openTimer);
    entry.batcher?.dispose();
    entry.tunnel?.close();
    try {
      if (entry.socket.readyState === WebSocket.OPEN || entry.socket.readyState === WebSocket.CONNECTING) {
        if (closeCode) entry.socket.close(closeCode, reason ?? '');
        else entry.socket.terminate();
      }
    } catch {
      // socket already gone
    }
    emitStatus();
  };

  const openDataSocket = (connectionId: string): void => {
    if (stopped || dataSockets.has(connectionId)) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildSocketUrl('host-data', connectionId));
    } catch (error) {
      logger.warn(`[Relay] host-data dial failed: ${errorMessage(error)}`);
      return;
    }

    const entry: DataSocketEntry = { socket, tunnel: null, openTimer: null, batcher: null, lastActivityAt: Date.now() };
    dataSockets.set(connectionId, entry);
    entry.openTimer = setTimeout(() => {
      logger.warn('[Relay] host-data socket open timeout');
      teardownDataSocket(connectionId);
    }, DATA_SOCKET_OPEN_TIMEOUT_MS);

    const handshake = createHostHandshake(identity.hostEncPrivateKey, { batch: localBatch });
    let channel: RelayFrameChannel | null = null;
    let batchNegotiated = false;
    // Serialize async message handling so encrypted frame order (and the
    // strictly-increasing decrypt counter) is preserved.
    let processing = Promise.resolve();
    // Serialize encrypt+send so the per-direction IV counter reaches the wire in
    // encryption order. One encrypt() == one WS message == one counter tick,
    // whether it carries a batch or a lone frame.
    let sendChain = Promise.resolve();
    const sendEncryptedPlaintext = (plaintext: Uint8Array): void => {
      sendChain = sendChain
        .then(async () => {
          if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN || !channel) return;
          const encrypted = await channel.encryptor.encrypt(plaintext);
          socket.send(encrypted, { binary: true });
        })
        .catch((error) => {
          logger.warn(`[Relay] host-data send failed: ${errorMessage(error)}`);
        });
    };

    const failChannel = (closeCode: number, reason?: string): void => {
      // connectionId + reason only — never payload contents.
      logger.warn(`[Relay] data channel failed connectionId=${connectionId} reason=${reason ?? 'unknown'}`);
      teardownDataSocket(connectionId, closeCode, reason);
    };

    const handleMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
      const current = dataSockets.get(connectionId);
      if (current !== entry) return;
      // Any inbound message (including the client's keepalive Ping) proves the
      // client is alive; the idle sweeper reaps sockets this stops updating.
      entry.lastActivityAt = Date.now();

      if (!isBinary) {
        const action = await handshake.handleText(data.toString('utf8'));
        if (action.type === 'send-text') {
          socket.send(action.text);
        } else if (action.type === 'established') {
          channel = action.channel;
          batchNegotiated = action.batch === true;
          entry.batcher = batchNegotiated
            ? createOutboundFrameBatcher({ windowMs: resolvedBatchWindowMs, sendBatch: sendEncryptedPlaintext })
            : null;
          entry.tunnel = createTunnelHost({
            connectionId,
            getLocalPort: resolveLocalPort,
            getBufferedAmount: () => socket.bufferedAmount,
            sendFrame: (plaintextFrame) => {
              if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN) return;
              if (entry.batcher) entry.batcher.enqueue(plaintextFrame);
              else sendEncryptedPlaintext(plaintextFrame);
            },
          });
          if (action.replyText) socket.send(action.replyText);
        } else if (action.type === 'fail') {
          failChannel(action.closeCode, action.reason);
        }
        return;
      }

      if (!channel || !entry.tunnel) {
        // Encrypted traffic before the handshake completed: fail closed.
        failChannel(RelayCloseCode.ChannelFailure, 'binary frame before handshake');
        return;
      }
      let plaintext;
      try {
        plaintext = await channel.decryptor.decrypt(rawDataBytes(data));
      } catch {
        failChannel(RelayCloseCode.ChannelFailure, 'frame decryption failed');
        return;
      }
      try {
        if (batchNegotiated) {
          // One encrypted message may carry several tunnel frames; dispatch each
          // in order through the same per-frame handling as legacy.
          for (const frame of decodeFrameBatch(plaintext)) {
            if (dataSockets.get(connectionId) !== entry) return;
            await entry.tunnel.handleFrame(frame);
          }
        } else {
          await entry.tunnel.handleFrame(plaintext);
        }
      } catch (error) {
        logger.warn(`[Relay] tunnel frame handling failed: ${errorMessage(error)}`);
      }
    };

    socket.on('open', () => {
      if (entry.openTimer) {
        clearTimeout(entry.openTimer);
        entry.openTimer = null;
      }
      emitStatus();
    });
    socket.on('message', (data, isBinary) => {
      processing = processing
        .then(() => handleMessage(data, isBinary))
        .catch((error) => {
          logger.warn(`[Relay] data socket message failed: ${errorMessage(error)}`);
          failChannel(RelayCloseCode.ChannelFailure, 'internal error');
        });
    });
    socket.on('close', () => {
      teardownDataSocket(connectionId);
    });
    socket.on('error', (error) => {
      logger.warn(`[Relay] host-data socket error: ${errorMessage(error)}`);
    });
  };

  const handleControlMessage = (raw: string): void => {
    let message: Record<string, unknown> | null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      message = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return;
    }
    if (!message) return;
    if (message.type === 'sync' && Array.isArray(message.connectionIds)) {
      // The WebSocket `open` event only proves that the local transport completed
      // its upgrade. The relay's first sync is the authoritative registration
      // acknowledgement: only now may callers advertise the host as connected.
      consecutiveFailures = 0;
      setState('connected', null);
      const wanted = new Set<string>(message.connectionIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
      for (const connectionId of [...dataSockets.keys()]) {
        if (!wanted.has(connectionId)) teardownDataSocket(connectionId);
      }
      for (const connectionId of wanted) {
        openDataSocket(connectionId);
      }
      return;
    }
    if (message.type === 'connected' && typeof message.connectionId === 'string') {
      openDataSocket(message.connectionId);
      return;
    }
    if (message.type === 'disconnected' && typeof message.connectionId === 'string') {
      teardownDataSocket(message.connectionId);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** consecutiveFailures, BACKOFF_CAP_MS);
    consecutiveFailures += 1;
    setState('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl();
    }, delay);
  };

  function connectControl(): void {
    if (stopped) return;
    setState(consecutiveFailures === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildSocketUrl('host-control'));
    } catch (error) {
      lastError = errorMessage(error);
      scheduleReconnect();
      return;
    }
    controlSocket = socket;

    // Liveness: ping on an interval; any pong (or message) proves the path.
    // A quiet window beyond interval+grace means the connection silently died —
    // terminate so the close handler reconnects and re-registers at the relay.
    let lastAliveAt = Date.now();
    const pingTimer = setInterval(() => {
      if (controlSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAliveAt > CONTROL_PING_INTERVAL_MS + CONTROL_PONG_GRACE_MS) {
        logger.warn('[Relay] control socket unresponsive (missed pong) — reconnecting');
        try {
          socket.terminate();
        } catch {
          // terminate is best-effort; the close handler still runs.
        }
        return;
      }
      try {
        socket.ping();
      } catch {
        // Send failure surfaces via the error/close handlers.
      }
    }, CONTROL_PING_INTERVAL_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();

    socket.on('open', () => {
      if (controlSocket !== socket) return;
      lastAliveAt = Date.now();
    });
    socket.on('pong', () => {
      lastAliveAt = Date.now();
    });
    socket.on('message', (data, isBinary) => {
      if (controlSocket !== socket || isBinary) return;
      lastAliveAt = Date.now();
      handleControlMessage(data.toString('utf8'));
    });
    socket.on('error', (error) => {
      if (controlSocket !== socket) return;
      lastError = errorMessage(error);
    });
    socket.on('close', (code, reasonBuffer) => {
      clearInterval(pingTimer);
      if (controlSocket !== socket) return;
      controlSocket = null;
      const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
      if (!lastError && code && code !== 1000) {
        lastError = `control socket closed (${code}${reason ? `: ${reason}` : ''})`;
      }
      // Data sockets ride their own relay connections; the relay keeps clients
      // alive through a 30 s control-reconnect grace window, so leave them up.
      scheduleReconnect();
    });
  }

  // Reap data sockets whose client went silent (no frames, no keepalive pings)
  // — a dead phone leg the relay worker hasn't noticed yet.
  const idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [connectionId, entry] of [...dataSockets.entries()]) {
      if (now - entry.lastActivityAt <= DATA_SOCKET_IDLE_TIMEOUT_MS) continue;
      logger.info(`[Relay] reaping idle data socket connectionId=${connectionId}`);
      teardownDataSocket(connectionId, 1001, 'client idle timeout');
    }
  }, DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS);
  if (typeof idleSweepTimer.unref === 'function') idleSweepTimer.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(idleSweepTimer);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const connectionId of [...dataSockets.keys()]) {
      teardownDataSocket(connectionId, 1001, 'host stopping');
    }
    const socket = controlSocket;
    controlSocket = null;
    if (socket) {
      try {
        socket.close(1001, 'host stopping');
      } catch {
        socket.terminate();
      }
    }
    setState('disabled');
  };

  connectControl();

  return {
    stop,
    getStatus: () => ({ state, lastError, connectedClients: dataSockets.size }),
  };
};
