import {
  PiRuntimeClient,
  WebSocketRuntimeTransport,
  type RuntimeSequenceGap,
  type RuntimeTransport,
  type RuntimeWebSocket,
} from '@varin/runtime-client';
import {
  VARIN_PROTOCOL_VERSION,
  type HostHandshakeResult,
  type HostMode,
} from '@varin/protocol';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { refreshRuntimeUrlAuthToken } from '@varin/application-client';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  subscribeRuntimeEndpointWillChange,
} from '@varin/application-client';
import { getRuntimeUrlResolver } from '@varin/application-client';

export interface PiRuntimeConnection {
  client: PiRuntimeClient;
  handshake: HostHandshakeResult;
  runtimeKey: string;
}

export type PiRuntimeConnectionPhase =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'reconnecting';

export interface CreatePiRuntimeConnectionOptions {
  clientName?: string;
  clientVersion?: string;
  mode?: HostMode;
  onConnectionLost?(connection: PiRuntimeConnection, error: Error | undefined): void;
  onProtocolError?(error: Error): void;
  onSequenceGap?: ConstructorParameters<typeof PiRuntimeClient>[0]['onSequenceGap'];
  openSocket?: (url: string, protocols?: string[]) => RuntimeWebSocket;
  refreshAuth?: (apiBaseUrl?: string | null) => Promise<string>;
  resolveWebSocketUrl?: () => string;
  runtimeKey?: string;
  /** Deadline for auth, socket open and handshake; no agent work has been sent yet. */
  startupTimeoutMs?: number;
  transport?: RuntimeTransport;
}

const defaultMode = (): HostMode => {
  if (typeof window === 'undefined') return 'web';
  const capacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true ? 'mobile' : 'web';
};

export const createPiRuntimeConnection = async (
  options: CreatePiRuntimeConnectionOptions = {},
): Promise<PiRuntimeConnection> => {
  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('startupTimeoutMs must be positive');
  let stage = 'authentication';
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Pi runtime connection timed out during ${stage}`)), timeoutMs);
  });
  const observe = <T,>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);
  let connection: PiRuntimeConnection | null = null;
  let client: PiRuntimeClient | undefined;
  try {
    let transport = options.transport;
    if (!transport) {
      const refreshAuth = options.refreshAuth ?? refreshRuntimeUrlAuthToken;
      await observe(refreshAuth(getRuntimeApiBaseUrl() || undefined));
      const url = options.resolveWebSocketUrl?.()
        ?? getRuntimeUrlResolver().websocket('/api/varin/runtime/ws');
      transport = new WebSocketRuntimeTransport({
        url,
        webSocketFactory: options.openSocket ?? ((socketUrl, protocols) =>
          openRuntimeWebSocket(socketUrl, protocols) as unknown as RuntimeWebSocket),
      });
    }
    client = new PiRuntimeClient({
      onConnectionLost: (error) => {
        if (connection) options.onConnectionLost?.(connection, error);
      },
      ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
      ...(options.onSequenceGap ? { onSequenceGap: options.onSequenceGap } : {}),
      transport,
    });
    stage = 'socket open';
    await observe(client.connect());
    stage = 'handshake';
    const handshake = await observe(client.handshake({
      clientName: options.clientName ?? 'varin-ui',
      clientVersion: options.clientVersion ?? '0.1.0',
      mode: options.mode ?? defaultMode(),
      protocolVersions: [VARIN_PROTOCOL_VERSION],
    }));
    connection = { client, handshake, runtimeKey: options.runtimeKey ?? getRuntimeKey() };
    return connection;
  } catch (error) {
    // Close synchronously invalidates pending RPCs before awaiting transport
    // cleanup. Late auth/handshake completion cannot publish this candidate.
    if (client) void client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer!);
  }
};

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;

let activeConnection: PiRuntimeConnection | null = null;
let activeConnectionPromise: Promise<PiRuntimeConnection> | null = null;
let connectionGeneration = 0;
/** True once a connection has been established; a new connect after that is a reconnect. */
let connectionEstablishedOnce = false;
/** Auto-reconnect stays armed until disconnectPiRuntime or an endpoint change. */
let reconnectArmed = false;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connectionPhase: PiRuntimeConnectionPhase = 'disconnected';

const phaseListeners = new Set<(phase: PiRuntimeConnectionPhase) => void>();
const reconnectedListeners = new Set<(connection: PiRuntimeConnection) => void>();
const sequenceGapListeners = new Set<(gap: RuntimeSequenceGap) => void>();
const protocolErrorListeners = new Set<(error: Error) => void>();

const setConnectionPhase = (phase: PiRuntimeConnectionPhase): void => {
  if (connectionPhase === phase) return;
  connectionPhase = phase;
  for (const listener of phaseListeners) {
    try {
      listener(phase);
    } catch {
      // Listener failures must not destabilize connection supervision.
    }
  }
};

export const getPiRuntimeConnectionPhase = (): PiRuntimeConnectionPhase => connectionPhase;

export const subscribePiRuntimeConnectionPhase = (
  listener: (phase: PiRuntimeConnectionPhase) => void,
): (() => void) => {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
};

/** Fires after a reconnect completes with the new live connection. */
export const subscribePiRuntimeReconnected = (
  listener: (connection: PiRuntimeConnection) => void,
): (() => void) => {
  reconnectedListeners.add(listener);
  return () => {
    reconnectedListeners.delete(listener);
  };
};

export const subscribePiRuntimeSequenceGap = (
  listener: (gap: RuntimeSequenceGap) => void,
): (() => void) => {
  sequenceGapListeners.add(listener);
  return () => {
    sequenceGapListeners.delete(listener);
  };
};

export const subscribePiRuntimeProtocolError = (listener: (error: Error) => void): (() => void) => {
  protocolErrorListeners.add(listener);
  return () => { protocolErrorListeners.delete(listener); };
};

const notifyReconnected = (connection: PiRuntimeConnection): void => {
  for (const listener of reconnectedListeners) {
    try {
      listener(connection);
    } catch {
      // Resync consumers handle their own failures.
    }
  }
};

const currentRuntimeKey = (): string => getRuntimeKey();

const reconnectDelayMs = (attempt: number): number => {
  const backoff = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
};

const cancelRetry = (): void => {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const scheduleReconnect = (runtimeKey: string): void => {
  if (!reconnectArmed || retryTimer !== null) return;
  const generation = connectionGeneration;
  setConnectionPhase('reconnecting');
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!reconnectArmed || generation !== connectionGeneration) return;
    void getPiRuntimeConnection().then(
      () => undefined,
      () => {
        if (!reconnectArmed || generation !== connectionGeneration) return;
        retryCount += 1;
        scheduleReconnect(runtimeKey);
      },
    );
  }, reconnectDelayMs(retryCount));
};

const handleConnectionLost = (connection: PiRuntimeConnection, _error: Error | undefined): void => {
  if (activeConnection?.client !== connection.client) return;
  activeConnection = null;
  if (!reconnectArmed || connection.runtimeKey !== currentRuntimeKey()) {
    setConnectionPhase('disconnected');
    return;
  }
  scheduleReconnect(connection.runtimeKey);
};

const handleSequenceGap = (gap: RuntimeSequenceGap): void => {
  for (const listener of sequenceGapListeners) {
    try {
      listener(gap);
    } catch {
      // Gap consumers handle their own failures.
    }
  }
};

const handleProtocolError = (error: Error): void => {
  for (const listener of protocolErrorListeners) {
    try { listener(error); } catch { /* Diagnostics must not break connection supervision. */ }
  }
};

export const getPiRuntimeConnection = (): Promise<PiRuntimeConnection> => {
  const runtimeKey = currentRuntimeKey();
  if (activeConnection?.runtimeKey === runtimeKey && activeConnection.client.connected) {
    return Promise.resolve(activeConnection);
  }
  if (activeConnectionPromise) return activeConnectionPromise;
  const generation = connectionGeneration;
  const hadConnection = connectionEstablishedOnce;
  setConnectionPhase(hadConnection ? 'reconnecting' : 'connecting');
  const promise = createPiRuntimeConnection({
    onConnectionLost: handleConnectionLost,
    onProtocolError: handleProtocolError,
    onSequenceGap: handleSequenceGap,
    runtimeKey,
  }).then(async (connection) => {
    if (generation !== connectionGeneration || connection.runtimeKey !== currentRuntimeKey()) {
      await connection.client.close();
      throw new Error('Pi runtime changed while connecting');
    }
    activeConnection = connection;
    connectionEstablishedOnce = true;
    reconnectArmed = true;
    retryCount = 0;
    setConnectionPhase('connected');
    if (hadConnection) notifyReconnected(connection);
    return connection;
  }).catch((error: unknown) => {
    if (generation === connectionGeneration && !activeConnection && !reconnectArmed) {
      setConnectionPhase('disconnected');
    }
    throw error;
  }).finally(() => {
    if (activeConnectionPromise === promise) activeConnectionPromise = null;
  });
  activeConnectionPromise = promise;
  return promise;
};

export const disconnectPiRuntime = async (): Promise<void> => {
  connectionGeneration += 1;
  reconnectArmed = false;
  retryCount = 0;
  cancelRetry();
  const connection = activeConnection;
  activeConnection = null;
  activeConnectionPromise = null;
  setConnectionPhase('disconnected');
  if (connection) await connection.client.close();
};

subscribeRuntimeEndpointWillChange(() => {
  connectionEstablishedOnce = false;
  void disconnectPiRuntime();
});

// A flaky transport may only be noticed when the OS reports connectivity back
// or the page becomes visible again; both are cheap immediate-retry triggers.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!reconnectArmed || activeConnection?.client.connected) return;
    retryCount = 0;
    cancelRetry();
    scheduleReconnect(currentRuntimeKey());
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!reconnectArmed || activeConnection?.client.connected) return;
    cancelRetry();
    scheduleReconnect(currentRuntimeKey());
  });
}
