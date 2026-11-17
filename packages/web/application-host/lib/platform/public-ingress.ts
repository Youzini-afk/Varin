import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface ExternalIngressConfiguration {
  origin: string;
  /** This is an HTTP backend for an HTTPS proxy. Default to loopback. */
  host?: string;
  port: number;
}

export interface ExternalIngress extends Readonly<ExternalIngressConfiguration> { host: string }
type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

interface IngressAdmission {
  configuration: ExternalIngress;
  associate(clientId: string, expiresAt?: string | null): void;
}
const requestIngress = new WeakMap<object, IngressAdmission>();

/** Only the guarded listener can mark an incoming request. Headers never establish this boundary. */
export const getExternalIngress = (request: object): ExternalIngress | undefined => requestIngress.get(request)?.configuration;

/** Called only after resolving a persistent device identity through its owner. */
export function markExternalIngressClient(request: object, clientId: string, expiresAt?: string | null): void {
  requestIngress.get(request)?.associate(clientId, expiresAt);
}

/** Carry the same admission onto an internal path view of the original request. */
export function inheritExternalIngress(request: object, view: object): void {
  const admission = requestIngress.get(request);
  if (admission) requestIngress.set(view, admission);
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const statuses = {
  400: 'Bad Request',
  403: 'Forbidden',
  421: 'Misdirected Request',
  503: 'Service Unavailable',
} as const;

export function normalizeExternalIngress(config: ExternalIngressConfiguration): ExternalIngress {
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || !/^https:\/\/[^/?#]+\/?$/i.test(config.origin)) {
    throw new Error('External access requires an HTTPS origin without credentials, a path, or a query');
  }
  const host = config.host ?? '127.0.0.1';
  if (isIP(host) === 0 || host.includes('%')) throw new Error('External ingress bind host must be an IP address');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('External ingress requires a fixed port between 1 and 65535');
  }
  return Object.freeze({ origin: url.origin, host, port: config.port });
}

export function readExternalIngressEnvironment(env: NodeJS.ProcessEnv): ExternalIngress | null {
  const origin = env.VARIN_EXTERNAL_ORIGIN;
  const port = env.VARIN_EXTERNAL_LISTEN_PORT;
  const host = env.VARIN_EXTERNAL_LISTEN_HOST;
  if (origin === undefined && port === undefined && host === undefined) return null;
  if (!origin || !port || !/^\d+$/.test(port)) {
    throw new Error('External ingress requires VARIN_EXTERNAL_ORIGIN and VARIN_EXTERNAL_LISTEN_PORT');
  }
  return normalizeExternalIngress({ origin, port: Number(port), ...(host === undefined ? {} : { host }) });
}

function belongsToOrigin(host: string | undefined, origin: string): boolean {
  if (!host || /[^a-z0-9.\-:[\]]/i.test(host)) return false;
  try {
    return new URL(`https://${host}`).origin === origin;
  } catch {
    return false;
  }
}

function rejectRequest(response: ServerResponse, status: keyof typeof statuses) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify({ error: statuses[status] }));
}

function rejectUpgrade(socket: Duplex, status: keyof typeof statuses) {
  socket.end(`HTTP/1.1 ${status} ${statuses[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Same application routes, separate admission. Disabling fences new requests
 * and closes only sockets accepted here, without cancelling application runs. */
export function createPublicIngress(options: ExternalIngressConfiguration & {
  onRequest: RequestListener;
  onUpgrade: UpgradeListener;
  isDraining?: () => boolean;
}) {
  const configuration = normalizeExternalIngress(options);
  const sockets = new Set<Socket>();
  const deviceConnections = new Map<string, Set<() => void>>();
  let enabled = false;
  let listening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function admit(request: IncomingMessage, upgrade: boolean): keyof typeof statuses | null {
    if (!enabled || closing || options.isDraining?.()) return 503;
    if (!belongsToOrigin(request.headers.host, configuration.origin)) return 421;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== configuration.origin) return 403;
    if ((upgrade || !safeMethods.has(request.method ?? '')) && origin !== configuration.origin) return 403;
    return null;
  }

  function markRequest(
    request: IncomingMessage,
    dispose: () => void,
    onClose: (cleanup: () => void) => void,
  ) {
    // Express trusts proxies for the legacy entry. Establish canonical
    // routing metadata here rather than letting this entry inherit what a
    // downstream proxy happened to forward.
    delete request.headers.forwarded;
    delete request.headers['x-forwarded-for'];
    delete request.headers['x-forwarded-host'];
    delete request.headers['x-forwarded-port'];
    delete request.headers['x-forwarded-prefix'];
    delete request.headers['x-varin-relay-connection'];
    request.headers['x-forwarded-proto'] = 'https';
    let associated = false;
    requestIngress.set(request, {
      configuration,
      associate(clientId, expiresAt) {
        if (associated) return;
        associated = true;
        const connections = deviceConnections.get(clientId) ?? new Set<() => void>();
        connections.add(dispose);
        deviceConnections.set(clientId, connections);
        let expiryTimer: NodeJS.Timeout | undefined;
        const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
        const checkExpiry = () => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return dispose();
          expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2 ** 31 - 1));
          expiryTimer.unref();
        };
        if (Number.isFinite(deadline)) checkExpiry();
        onClose(() => {
          if (expiryTimer) clearTimeout(expiryTimer);
          connections.delete(dispose);
          if (!connections.size && deviceConnections.get(clientId) === connections) deviceConnections.delete(clientId);
        });
      },
    });
  }

  const server = createServer((request, response) => {
    const status = admit(request, false);
    if (status !== null) return rejectRequest(response, status);
    markRequest(request, () => {
      // A reverse proxy can reuse one TCP socket for several devices. End
      // this observation response, not the entire socket or an unrelated run.
      const contentType = String(response.getHeader('content-type') ?? '');
      if (!response.writableEnded && contentType.startsWith('text/event-stream')) response.end();
    }, (cleanup) => response.once('close', cleanup));
    options.onRequest(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const status = admit(request, true);
    if (status !== null) return rejectUpgrade(socket, status);
    markRequest(request, () => socket.destroy(), (cleanup) => socket.once('close', cleanup));
    options.onUpgrade(request, socket, head);
  });

  function listen(): Promise<void> {
    if (closing) return Promise.reject(new Error('External ingress is closed'));
    if (listening) return listening;
    listening = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: configuration.host, port: configuration.port });
    }).catch((error: unknown) => {
      listening = undefined;
      throw error;
    });
    return listening;
  }

  function setEnabled(value: boolean) {
    if (value && (!server.listening || closing)) throw new Error('External ingress is not listening');
    if (enabled === value) return;
    enabled = value;
    if (!enabled) for (const socket of sockets) socket.destroy();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    setEnabled(false);
    closing = (async () => {
      await listening?.catch(() => undefined);
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
        for (const socket of sockets) socket.destroy();
      });
    })();
    return closing;
  }

  function revokeClient(clientId: string): void {
    const connections = deviceConnections.get(clientId);
    if (!connections) return;
    deviceConnections.delete(clientId);
    for (const closeConnection of connections) closeConnection();
  }

  return { configuration, listen, setEnabled, revokeClient, close, get enabled() { return enabled; } };
}
