import { getLocalRuntimeUrlAuthTokenSync, getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from './runtime-auth.js';
import { getRuntimeEndpointGeneration } from './runtime-switch.js';
import { getRuntimeUrlResolver } from './runtime-url.js';
import { isAllowedObservationRequest, OBSERVATION_WEBSOCKET_PATH, type ObservationClientMessage, type ObservationServerMessage } from './observation-protocol.js';

interface ObservationTarget {
  key: string;
  path: string;
  websocketUrl(): Promise<string>;
}

const websocketUrl = (url: URL): string => {
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const resolveTarget = (input: RequestInfo | URL, method: string, headers: Headers): ObservationTarget | null => {
  if (typeof window === 'undefined') return null;
  const href = window.location.href || window.location.origin;
  const raw = input instanceof Request ? input.url : String(input);
  let target: URL;
  try { target = new URL(raw, href); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) return null;
  const resolver = getRuntimeUrlResolver();
  const generation = getRuntimeEndpointGeneration();
  const localOrigin = (window as typeof window & { __VARIN_LOCAL_ORIGIN__?: string }).__VARIN_LOCAL_ORIGIN__;
  const needsRealtimeProxy = Boolean(localOrigin && Object.keys(getRuntimeExtraHeadersSync()).length);
  const activeApi = new URL(resolver.api('/api'), href);
  const mount = activeApi.pathname.slice(0, -'/api'.length);
  const activePath = target.pathname.slice(mount.length) + target.search;
  if (target.origin === activeApi.origin && target.pathname.startsWith(`${mount}/api/`)
    && isAllowedObservationRequest(method, activePath)) {
    return {
      key: `host:${activeApi.origin}${mount}`,
      path: activePath,
      async websocketUrl() {
        // The handshake cannot carry a bearer header. Mint with this captured
        // Host's normal auth path, and fence the async result before dispatch.
        await refreshRuntimeUrlAuthToken(`${activeApi.origin}${mount}`);
        if (needsRealtimeProxy && localOrigin) await refreshLocalRuntimeUrlAuthToken(localOrigin);
        if (generation !== getRuntimeEndpointGeneration() || resolver !== getRuntimeUrlResolver()) {
          throw new Error('Application Host changed before observation dispatch');
        }
        return resolver.websocket(OBSERVATION_WEBSOCKET_PATH);
      },
    };
  }

  // Extension availability/leases belong to the local Application Host even
  // when a different remote Host is selected. Never use remote auth here.
  const injected = (window as typeof window & { __VARIN_LOCAL_ORIGIN__?: string }).__VARIN_LOCAL_ORIGIN__;
  const localOrigins = [window.location.origin, injected].filter(Boolean).map(value => {
    try { return new URL(value!).origin; } catch { return ''; }
  });
  const path = target.pathname + target.search;
  if (!localOrigins.includes(target.origin) || !isAllowedObservationRequest(method, path)) return null;
  return {
    key: `host:${target.origin}`,
    path,
    async websocketUrl() {
      const endpoint = new URL(OBSERVATION_WEBSOCKET_PATH, target.origin);
      const token = target.searchParams.get('varin_url_token')
        || headers.get('X-Varin-Application-Token')
        || (target.origin !== window.location.origin ? getLocalRuntimeUrlAuthTokenSync(target.origin) : '');
      if (token) endpoint.searchParams.set('varin_url_token', token);
      return websocketUrl(endpoint);
    },
  };
};

interface Observation {
  id: number;
  opened: boolean;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  resolve(response: Response): void;
  reject(error: unknown): void;
  releasePull?: (() => void) | undefined;
  signal?: AbortSignal | null | undefined;
  onAbort(): void;
}

const connections = new Map<string, ObservationConnection>();
const abortError = (): DOMException => new DOMException('The observation was aborted', 'AbortError');

class ObservationConnection {
  private socket: WebSocket | null = null;
  private ready: Promise<void>;
  private closed = false;
  private nextId = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private observations = new Map<number, Observation>();

  constructor(private target: ObservationTarget) {
    this.ready = this.connect();
    // Connection errors are delivered through every pending fetch/body. A
    // cancellation may remove the last observer before the handshake fails.
    void this.ready.catch(() => {});
  }

  private async connect(): Promise<void> {
    try {
      const url = await this.target.websocketUrl();
      if (this.closed) throw abortError();
      if (typeof WebSocket !== 'function') throw new Error('WebSocket observations are unavailable');
      const socket = this.socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onmessage = event => this.receive(event.data);
        socket.onerror = () => {
          const error = new Error('Observation connection failed');
          reject(error);
          this.fail(error);
        };
        socket.onclose = () => {
          // Even a normal socket close is not an HTTP body EOF. Only `end`
          // completes a particular response successfully.
          const error = new Error('Observation connection closed before response completion');
          reject(error);
          this.fail(error);
        };
      });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private send(message: ObservationClientMessage): void {
    if (this.closed || this.socket?.readyState !== 1) throw new Error('Observation connection is not open');
    this.socket.send(JSON.stringify(message));
  }

  private remove(observation: Observation): void {
    this.observations.delete(observation.id);
    observation.signal?.removeEventListener('abort', observation.onAbort);
    observation.releasePull?.();
    observation.releasePull = undefined;
    if (!this.closed && this.observations.size === 0) {
      if (!this.socket || this.socket.readyState !== 1) {
        this.fail(abortError());
        return;
      }
      // Preserve a socket across consecutive long polls, but do not retain
      // inactive Hosts forever. A new open cancels this idle cleanup.
      this.idleTimer = setTimeout(() => this.fail(new Error('Idle observation connection closed')), 30_000);
    }
  }

  private rejectObservation(observation: Observation, error: unknown): void {
    if (!this.observations.has(observation.id)) return;
    observation.reject(error);
    observation.controller?.error(error);
    this.remove(observation);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (connections.get(this.target.key) === this) connections.delete(this.target.key);
    for (const observation of this.observations.values()) this.rejectObservation(observation, error);
    this.socket?.close();
  }

  private receive(raw: unknown): void {
    try {
      if (typeof raw !== 'string') throw new Error('Invalid observation response');
      const message = JSON.parse(raw) as ObservationServerMessage;
      if (!message || !Number.isSafeInteger(message.id) || message.id <= 0) throw new Error('Invalid observation response');
      const observation = this.observations.get(message.id);
      // An already cancelled stream can still have messages in flight.
      if (!observation) return;
      if (message.type === 'headers') {
        if (observation.controller || !Number.isInteger(message.status) || message.status < 200 || message.status > 599) {
          throw new Error('Invalid observation response headers');
        }
        const body = new ReadableStream<Uint8Array>({
          start: controller => { observation.controller = controller; },
          pull: () => new Promise<void>((resolve, reject) => {
            observation.releasePull = resolve;
            try { this.send({ type: 'pull', id: message.id }); } catch (error) { reject(error); }
          }),
          cancel: () => this.cancel(observation),
        }, { highWaterMark: 0 });
        const noBody = [204, 205, 304].includes(message.status);
        observation.resolve(new Response(noBody ? null : body, {
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
        }));
        if (noBody) this.cancel(observation);
      } else if (message.type === 'data') {
        if (!observation.controller || !observation.releasePull || typeof message.data !== 'string') {
          throw new Error('Unexpected observation body chunk');
        }
        const binary = atob(message.data);
        const bytes = Uint8Array.from(binary, byte => byte.charCodeAt(0));
        const release = observation.releasePull;
        observation.releasePull = undefined;
        observation.controller.enqueue(bytes);
        release();
      } else if (message.type === 'end') {
        if (!observation.controller) throw new Error('Observation ended before headers');
        observation.controller.close();
        this.remove(observation);
      } else if (message.type === 'error' && typeof message.message === 'string') {
        this.rejectObservation(observation, new Error(message.message));
      } else {
        throw new Error('Invalid observation response');
      }
    } catch (error) { this.fail(error); }
  }

  private cancel(observation: Observation, reason?: unknown): void {
    if (!this.observations.has(observation.id)) return;
    if (observation.opened && !this.closed) {
      try { this.send({ type: 'cancel', id: observation.id }); } catch (error) { this.fail(error); }
    }
    if (reason !== undefined) this.rejectObservation(observation, reason);
    else this.remove(observation);
  }

  fetch(path: string, method: 'GET' | 'POST', headers: Headers, body: string | undefined, signal?: AbortSignal | null): Promise<Response> {
    clearTimeout(this.idleTimer);
    return new Promise<Response>((resolve, reject) => {
      const id = this.nextId++;
      const observation: Observation = {
        id, opened: false, resolve, reject, signal,
        onAbort: () => this.cancel(observation, signal?.reason ?? abortError()),
      };
      this.observations.set(id, observation);
      signal?.addEventListener('abort', observation.onAbort, { once: true });
      if (signal?.aborted) { observation.onAbort(); return; }
      void this.ready.then(() => {
        if (!this.observations.has(id)) return;
        this.send({ type: 'open', id, path, method, headers: Object.fromEntries(headers.entries()), ...(body === undefined ? {} : { body }) });
        observation.opened = true;
      }).catch(error => {
        if (this.observations.has(id)) this.rejectObservation(observation, error);
      });
    });
  }
}

/** Null means an ordinary HTTP request. An eligible observation never falls
 * back to HTTP and is never replayed here; its existing domain consumer owns
 * cursor/revision/reconnect policy.
 */
export const tryObservationFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null => {
  const request = input instanceof Request ? input : undefined;
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const target = resolveTarget(input, method, headers);
  if (!target) return null;
  const signal = init?.signal ?? request?.signal;
  return (async () => {
    signal?.throwIfAborted();
    let body: string | undefined;
    if (init?.body != null) {
      if (typeof init.body === 'string') body = init.body;
      else body = await new Response(init.body).text();
    } else if (request?.body) {
      body = await request.text();
    }
    signal?.throwIfAborted();
    let connection = connections.get(target.key);
    if (!connection) {
      connection = new ObservationConnection(target);
      connections.set(target.key, connection);
    }
    return connection.fetch(target.path, method as 'GET' | 'POST', headers, body, signal);
  })();
};
