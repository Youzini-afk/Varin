import { WebSocket, WebSocketServer } from 'ws';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import {
  OBSERVATION_WEBSOCKET_PATH,
  isAllowedObservationRequest,
  type ObservationClientMessage,
  type ObservationServerMessage,
} from '@varin/application-client';

interface ObservationOptions {
  server: Server;
  authenticate(request: IncomingMessage): Promise<boolean>;
  isRequestOriginAllowed(request: IncomingMessage): boolean | Promise<boolean>;
  rejectWebSocketUpgrade(socket: Duplex, status: number, message: string): void;
}

interface Channel {
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  credits: number;
  reading: boolean;
  ready: boolean;
}

const requestHeaders = new Set([
  'accept', 'content-type', 'authorization', 'x-varin-application-token',
  'x-varin-directory', 'x-varin-directory-encoding', 'last-event-id', 'cache-control',
]);
const forbiddenRequestHeaders = new Set([
  'host', 'cookie', 'origin', 'connection', 'upgrade', 'content-length', 'transfer-encoding',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'keep-alive', 'forwarded',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isOpenRequest = (value: Record<string, unknown>): value is Extract<ObservationClientMessage, { type: 'open' }> => (
  value.type === 'open'
  && typeof value.method === 'string'
  && typeof value.path === 'string'
  && isAllowedObservationRequest(value.method, value.path)
  && isRecord(value.headers)
  && Object.entries(value.headers).every(([name, content]) => /^[!#$%&'*+.^_`|~\w-]+$/u.test(name)
    && !forbiddenRequestHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-forwarded-')
    && typeof content === 'string' && !/[\r\n]/u.test(content))
  && (value.body === undefined || (value.method === 'POST' && typeof value.body === 'string'))
);

/** Only the destination comes from the listener. The original handshake's
 * authority and request scope still go through the ordinary Host middleware.
 * Channel frames cannot inject cookies, proxy headers, a Host or an Origin.
 */
const buildRequestHeaders = (request: IncomingMessage, supplied: Record<string, string>, path: string): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(supplied)) {
    if (requestHeaders.has(name.toLowerCase())) headers.set(name, value);
  }
  for (const name of [
    'cookie', 'host', 'origin', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'user-agent',
  ]) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  // The Host already trusts its proxy chain. Retain that chain and the original
  // peer for its existing req.ip audit rather than recording our loopback hop.
  if (request.socket.remoteAddress) {
    const forwarded = headers.get('x-forwarded-for');
    headers.set('x-forwarded-for', forwarded ? `${forwarded}, ${request.socket.remoteAddress}` : request.socket.remoteAddress);
  }
  // Never shadow a channel's own credential with a different handshake token:
  // URL-token auth has different route scope and takes precedence over bearer.
  const explicitCredential = headers.has('authorization') || headers.has('x-varin-application-token')
    || new URL(path, 'http://localhost').searchParams.has('varin_url_token');
  if (!explicitCredential) {
    const bearer = request.headers.authorization;
    const applicationToken = request.headers['x-varin-application-token'];
    const urlToken = new URL(request.url || '/', 'http://localhost').searchParams.get('varin_url_token');
    if (typeof bearer === 'string' && bearer) headers.set('authorization', bearer);
    else if (typeof applicationToken === 'string') headers.set('x-varin-application-token', applicationToken);
    else if (urlToken) headers.set('x-varin-application-token', urlToken);
  }
  return headers;
};

const requestObservation = (server: Server, request: IncomingMessage,
  message: Extract<ObservationClientMessage, { type: 'open' }>, signal: AbortSignal,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array> | null; headers: Record<string, string>; status: number; statusText: string }> => (
  new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') { reject(new Error('Host listener is unavailable')); return; }
    const headers = buildRequestHeaders(request, message.headers, message.path);
    headers.set('accept-encoding', 'identity');
    // fetch discards an explicit Host header. Use the actual listener directly
    // so the original Host remains available to tunnel/auth scope checks. Node
    // HTTP does not follow redirects, including those returned by middleware.
    // A dedicated agent also keeps this local hop out of global proxy settings.
    const upstream = httpRequest({
      hostname: address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address,
      port: address.port,
      path: message.path, method: message.method, headers: Object.fromEntries(headers), signal, agent: false,
    }, (response) => {
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) {
          responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
      const encoding = response.headers['content-encoding']?.toLowerCase();
      const decoder = encoding === 'gzip' || encoding === 'deflate' ? createUnzip()
        : encoding === 'br' ? createBrotliDecompress() : null;
      const body = decoder ? response.pipe(decoder) : response;
      if (decoder) {
        response.on('error', (error) => decoder.destroy(error));
        decoder.once('close', () => response.destroy());
      }
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) {
        response.resume();
        resolve({ reader: null, headers: responseHeaders, status, statusText: response.statusMessage ?? '' });
        return;
      }
      const stream = Readable.toWeb(body, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>;
      resolve({ reader: stream.getReader(), headers: responseHeaders, status, statusText: response.statusMessage ?? '' });
    });
    upstream.on('error', reject);
    upstream.end(message.body);
  })
);

/** A flow-controlled transport for existing HTTP observations, not an HTTP
 * gateway or an observation owner. Route auth, cursors and lease cleanup remain
 * at the original listener. Neither connection loss nor an error replays work.
 */
export const attachObservations = (options: ObservationOptions) => {
  const { server } = options;
  const websocketServer = new WebSocketServer({ noServer: true });
  const connections = new Map<WebSocket, () => void>();
  const upgrades = new Set<Duplex>();
  let stopped = false;

  websocketServer.on('connection', (socket, request) => {
    const channels = new Map<number, Channel>();
    let closed = false;
    const cancel = (id: number) => {
      const channel = channels.get(id);
      if (!channel) return;
      channels.delete(id);
      channel.abort.abort();
      void channel.reader?.cancel().catch(() => {});
    };
    const dispose = () => {
      closed = true;
      for (const id of channels.keys()) cancel(id);
      connections.delete(socket);
    };
    connections.set(socket, dispose);
    const failSocket = () => {
      dispose();
      socket.terminate();
    };
    const send = (message: ObservationServerMessage): Promise<boolean> => new Promise((resolve) => {
      if (closed || socket.readyState !== WebSocket.OPEN) { resolve(false); return; }
      socket.send(JSON.stringify(message), (error) => {
        if (error) failSocket();
        resolve(!error && !closed);
      });
    });
    const pump = async (id: number, channel: Channel): Promise<void> => {
      if (!channel.ready || channel.reading || !channel.reader) return;
      channel.reading = true;
      try {
        while (channels.get(id) === channel && channel.credits > 0) {
          channel.credits -= 1;
          const chunk = await channel.reader.read();
          if (channels.get(id) !== channel) return;
          if (chunk.done) {
            await send({ type: 'end', id });
            cancel(id);
            return;
          }
          // Await the socket's write completion before consuming more credits.
          if (!await send({ type: 'data', id, data: Buffer.from(chunk.value).toString('base64') })) return;
        }
      } catch {
        if (channels.get(id) === channel) {
          await send({ type: 'error', id, message: 'Observation response interrupted' });
          cancel(id);
        }
      } finally {
        channel.reading = false;
      }
    };
    const open = async (message: Extract<ObservationClientMessage, { type: 'open' }>, channel: Channel) => {
      try {
        const response = await requestObservation(server, request, message, channel.abort.signal);
        if (channels.get(message.id) !== channel) { await response.reader?.cancel(); return; }
        channel.reader = response.reader;
        if (!await send({ type: 'headers', id: message.id, status: response.status, statusText: response.statusText, headers: response.headers })) return;
        channel.ready = true;
        if (!channel.reader) {
          await send({ type: 'end', id: message.id });
          cancel(message.id);
        } else {
          await pump(message.id, channel);
        }
      } catch {
        if (channels.get(message.id) === channel) {
          await send({ type: 'error', id: message.id, message: 'Observation request failed' });
          cancel(message.id);
        }
      }
    };

    socket.on('message', (data, binary) => {
      if (closed || stopped) return;
      let value: unknown;
      try { value = binary ? null : JSON.parse(data.toString()); } catch { value = null; }
      if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
        dispose(); socket.close(1008, 'Invalid observation message'); return;
      }
      const id = value.id as number;
      if (value.type === 'cancel') { cancel(id); return; }
      if (value.type === 'pull') {
        const channel = channels.get(id);
        if (!channel) return;
        if (channel.credits === Number.MAX_SAFE_INTEGER) { failSocket(); return; }
        channel.credits += 1;
        void pump(id, channel);
        return;
      }
      if (channels.has(id)) {
        dispose(); socket.close(1008, 'Observation channel is already open'); return;
      }
      if (!isOpenRequest(value)) {
        void send({ type: 'error', id, message: 'Observation request is not allowed' });
        return;
      }
      const channel: Channel = { abort: new AbortController(), reader: null, credits: 0, reading: false, ready: false };
      channels.set(id, channel);
      void open(value, channel);
    });
    socket.on('close', dispose);
    socket.on('error', failSocket);
  });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { return; }
    if (pathname !== OBSERVATION_WEBSOCKET_PATH) return;
    upgrades.add(socket);
    socket.once('close', () => upgrades.delete(socket));
    void (async () => {
      if (stopped || !await options.authenticate(request)) {
        options.rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return;
      }
      if (!await options.isRequestOriginAllowed(request)) {
        options.rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return;
      }
      if (stopped || socket.destroyed) return;
      upgrades.delete(socket);
      websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request));
    })().catch(() => options.rejectWebSocketUpgrade(socket, 401, 'UI authentication required'));
  };
  server.on('upgrade', upgrade);
  return {
    stop: () => {
      stopped = true;
      server.off('upgrade', upgrade);
      for (const socket of upgrades) socket.destroy();
      upgrades.clear();
      for (const [socket, dispose] of connections) { dispose(); socket.terminate(); }
      websocketServer.close();
    },
  };
};
