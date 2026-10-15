// Host side of the tunnel mux (Layer 3): consumes decrypted tunnel frames for
// ONE relay connection and dispatches them to the local loopback origin.
// HTTP streams -> fetch http://127.0.0.1:<port> with streamed duplex bodies;
// WS streams -> `ws` client to the loopback WebSocket endpoints.
// The dispatcher NEVER injects credentials: tunneled requests authenticate
// exactly like any remote client (Varin bearer token and URL auth token).
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  chunkPayload,
  createFragmentAssembler,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

interface HttpRequestPayload {
  hasBody?: boolean;
  headers: Record<string, string>;
  method: string;
  path: string;
  query: string;
}

interface WsOpenPayload {
  path: string;
  protocols?: string[];
  query: string;
}

interface WsClosePayload {
  code?: number;
  reason?: string;
}

interface HttpBodySink {
  close(): void;
  enqueue(payload: Uint8Array): void;
  error(error: Error): void;
}

interface HttpTunnelStream {
  abort: AbortController;
  body: HttpBodySink | null;
  kind: 'http';
  noBody: boolean;
}

interface WsTunnelStream {
  kind: 'ws';
  opened: boolean;
  socket: WebSocket;
}

type TunnelStream = HttpTunnelStream | WsTunnelStream;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

const rawDataBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

// Path allowlists (defense in depth; same families realtime-proxy.js allows).
const isAllowedHttpPath = (pathname: string): boolean =>
  pathname === '/health'
  || pathname === '/api'
  || pathname.startsWith('/api/')
  || pathname === '/auth'
  || pathname.startsWith('/auth/');

const ALLOWED_WS_PATHS = new Set([
  '/api/terminal/ws',
  '/api/dictation/ws',
]);

export const isRelayWebSocketPathAllowed = (pathname: string): boolean => ALLOWED_WS_PATHS.has(pathname);

// Hop-by-hop headers stripped from tunneled requests; `host` is set by fetch
// to the loopback origin. content-length is dropped too because the body is
// re-chunked through the tunnel and undici computes framing itself.
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

// Response framing headers that no longer apply once the body crosses the
// tunnel as HttpBody chunks (loopback fetch already decoded content-encoding).
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

// v1 backpressure rule: pause reading the loopback source while the outbound
// relay socket has more than this buffered.
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 20;

// Ordinary control requests are held until every tunnel body frame arrives,
// preventing a reconnect from turning a partial request into a misleading 400.
// Larger uploads keep the existing streaming behavior instead of being rejected.
const BODY_BUFFER_MAX_BYTES = 512 * 1024;
const BODY_DELIVERY_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isHttpRequestPayload = (parsed: unknown): parsed is HttpRequestPayload => {
  const record = asRecord(parsed);
  const headers = asRecord(record?.headers);
  return Boolean(record
    && typeof record.method === 'string'
    && typeof record.path === 'string'
    && typeof record.query === 'string'
    && headers
    && Object.values(headers).every((value) => typeof value === 'string'));
};

const isWsOpenPayload = (parsed: unknown): parsed is WsOpenPayload => {
  const record = asRecord(parsed);
  return Boolean(record
    && typeof record.path === 'string'
    && typeof record.query === 'string'
    && (record.protocols === undefined
      || (Array.isArray(record.protocols) && record.protocols.every((value) => typeof value === 'string'))));
};

const isWsClosePayload = (parsed: unknown): parsed is WsClosePayload => Boolean(asRecord(parsed));

/**
 * @param {{
 *   connectionId: string,
 *   getLocalPort: () => number,
 *   sendFrame: (plaintextFrame: Uint8Array) => void | Promise<void>,
 *   getBufferedAmount: () => number,
 *   bodyDeliveryTimeoutMs?: number,
 * }} deps
 */
export const createTunnelHost = ({ connectionId, getLocalPort, sendFrame, getBufferedAmount, bodyDeliveryTimeoutMs = BODY_DELIVERY_TIMEOUT_MS }: {
  bodyDeliveryTimeoutMs?: number;
  connectionId: string;
  getBufferedAmount: () => number;
  getLocalPort: () => number;
  sendFrame: (plaintextFrame: Uint8Array) => Promise<void> | void;
}) => {
  /** @type {Map<number, { kind: 'http', abort: AbortController, body: { enqueue(payload: Uint8Array): void, close(): void, error(error: Error): void } | null, noBody: boolean } | { kind: 'ws', socket: WebSocket, opened: boolean }>} */
  const streams = new Map<number, TunnelStream>();
  const assembler = createFragmentAssembler();
  let closed = false;

  const send = async (frame: Uint8Array): Promise<void> => {
    if (closed) return;
    await sendFrame(frame);
  };

  const sendJson = (frameType: number, streamId: number, payload: unknown) =>
    send(encodeTunnelFrame(frameType, streamId, encodeJsonPayload(payload)));

  const sendAbort = async (streamId: number, reason: unknown): Promise<void> => {
    await sendJson(TunnelFrameType.StreamAbort, streamId, { reason: String(reason ?? 'stream error') });
  };

  const dropStream = (streamId: number): void => {
    streams.delete(streamId);
    assembler.dropStream(streamId);
  };

  const abortLocalStream = (streamId: number, reason: unknown): void => {
    const stream = streams.get(streamId);
    if (!stream) return;
    dropStream(streamId);
    if (stream.kind === 'http') {
      try {
        stream.body?.error(new Error(String(reason ?? 'aborted')));
      } catch {
        // body already closed
      }
      stream.abort.abort();
    } else {
      try {
        stream.socket.terminate();
      } catch {
        // socket already gone
      }
    }
  };

  const waitForBackpressure = async (signal: AbortSignal | null): Promise<void> => {
    while (!closed && getBufferedAmount() > BACKPRESSURE_LIMIT_BYTES) {
      if (signal?.aborted) return;
      await sleep(BACKPRESSURE_POLL_MS);
    }
  };

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const buildRequestHeaders = (rawHeaders: Record<string, string>, loopbackOrigin: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
      headers[lower] = value;
    }
    headers['x-varin-relay-connection'] = connectionId;
    // Browser-generated Origin is not visible to the tunnel client. Present the
    // loopback origin being dialed and overwrite any client-supplied value.
    headers.origin = loopbackOrigin;
    return headers;
  };

  // Synthetic responses never ship an empty body: `reason` states explicitly
  // that the relay host (not the upstream server) produced this response.
  const syntheticResponse = async (streamId: number, status: number, message: string): Promise<void> => {
    await sendJson(TunnelFrameType.HttpResponse, streamId, {
      status,
      headers: { 'content-type': 'application/json' },
    });
    await send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, encodeJsonPayload({ error: message, reason: message, source: 'relay-tunnel-host' })));
    await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
  };

  const forwardRequest = async (
    streamId: number,
    stream: HttpTunnelStream,
    url: string,
    method: string,
    request: HttpRequestPayload,
    body: Buffer | ReadableStream<Uint8Array> | null,
    loopbackOrigin: string,
  ): Promise<void> => {
    let response: Response;
    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers: buildRequestHeaders(request.headers, loopbackOrigin),
        signal: stream.abort.signal,
        ...(body ? { body, duplex: 'half' } : {}),
      };
      response = await fetch(url, init);
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await sendAbort(streamId, errorMessage(error, 'loopback request failed'));
      }
      return;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
      responseHeaders[name] = value;
    }
    await sendJson(TunnelFrameType.HttpResponse, streamId, { status: response.status, headers: responseHeaders });

    try {
      if (response.body) {
        for await (const chunk of response.body) {
          if (closed || stream.abort.signal.aborted) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          for (const piece of chunkPayload(bytes, MAX_TUNNEL_PAYLOAD_BYTES)) {
            await waitForBackpressure(stream.abort.signal);
            if (closed || stream.abort.signal.aborted) return;
            await send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece));
          }
        }
      }
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
      }
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await sendAbort(streamId, errorMessage(error, 'loopback response failed'));
      }
    }
  };

  const runHttpStream = async (streamId: number, request: HttpRequestPayload): Promise<void> => {
    const method = request.method.toUpperCase();
    if (!isAllowedHttpPath(request.path)) {
      dropStream(streamId);
      await syntheticResponse(streamId, 403, 'Path is not allowed through the relay');
      return;
    }

    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const loopbackOrigin = `http://127.0.0.1:${getLocalPort()}`;
    const url = `${loopbackOrigin}${request.path}${request.query ? `?${request.query}` : ''}`;
    if (!hasBody) {
      stream.noBody = true;
      await forwardRequest(streamId, stream, url, method, request, null, loopbackOrigin);
      return;
    }

    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let bodyFrameCount = 0;
    let liveStream: ReadableStream<Uint8Array> | null = null;
    let liveController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let completed = false;
    let bodyFailure: Error | null = null;
    let resolveBodyEnd: () => void = () => undefined;
    const bodyEnded = new Promise<void>((resolve) => { resolveBodyEnd = resolve; });

    const finishBody = (error: Error | null): void => {
      if (completed) return;
      completed = true;
      bodyFailure = error ?? null;
      if (liveController) {
        try {
          if (error) liveController.error(error);
          else liveController.close();
        } catch {
          // The request stream already settled.
        }
      }
      resolveBodyEnd();
    };

    let deliveryDeadline: ReturnType<typeof setTimeout> | null = null;
    const switchToLive = (): void => {
      liveStream = new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>) {
          liveController = controller;
          stream.body = controller;
        },
      });
      const controller = liveController;
      if (!controller) throw new Error('request body stream did not initialize');
      for (const chunk of buffered) {
        try { controller.enqueue(chunk); } catch { break; }
      }
      buffered.length = 0;
      if (deliveryDeadline) clearTimeout(deliveryDeadline);
      resolveBodyEnd();
      void forwardRequest(streamId, stream, url, method, request, liveStream, loopbackOrigin);
    };

    stream.body = {
      enqueue(payload) {
        if (completed) return;
        bodyFrameCount += 1;
        if (liveController) {
          try { liveController.enqueue(payload); } catch {
            // The request stream already settled.
          }
          return;
        }
        buffered.push(payload);
        bufferedBytes += payload.length;
        if (bufferedBytes > BODY_BUFFER_MAX_BYTES) switchToLive();
      },
      close() {
        finishBody(null);
      },
      error(error) {
        finishBody(error);
      },
    };

    deliveryDeadline = setTimeout(() => {
      if (streams.get(streamId) === stream && !completed && !liveStream) {
        dropStream(streamId);
        void sendAbort(streamId, 'tunnel request body was not delivered in time');
        finishBody(new Error('tunnel request body was not delivered in time'));
      }
    }, bodyDeliveryTimeoutMs);
    deliveryDeadline.unref?.();

    await bodyEnded;
    if (deliveryDeadline) clearTimeout(deliveryDeadline);
    if (streams.get(streamId) !== stream) return;
    const failure = bodyFailure as Error | null;
    if (failure) {
      dropStream(streamId);
      await sendAbort(streamId, failure.message || 'tunnel request body failed');
      return;
    }
    if (liveStream) return;

    if (request.hasBody === true && bodyFrameCount === 0) {
      dropStream(streamId);
      await sendAbort(streamId, 'tunnel request body frames were lost');
      return;
    }

    stream.body = null;
    await forwardRequest(streamId, stream, url, method, request, Buffer.concat(buffered), loopbackOrigin);
  };

  const handleHttpRequest = (streamId: number, payload: Uint8Array): void => {
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let request;
    try {
      request = decodeJsonPayload(payload, isHttpRequestPayload);
    } catch (error) {
      void sendAbort(streamId, errorMessage(error, 'malformed request'));
      return;
    }
    const stream: HttpTunnelStream = { kind: 'http', abort: new AbortController(), body: null, noBody: false };
    streams.set(streamId, stream);
    void runHttpStream(streamId, request);
  };

  const handleHttpBody = (streamId: number, payload: Uint8Array): void => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http' || stream.noBody) return;
    // The buffering sink attaches synchronously before body frames arrive.
    try {
      stream.body?.enqueue(payload);
    } catch {
      // stream already errored/closed
    }
  };

  const handleStreamEnd = (streamId: number): void => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;
    try {
      stream.body?.close();
    } catch {
      // stream already errored/closed
    }
    // Response side keeps running; only the request body is half-closed.
  };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  const handleWsOpen = (streamId: number, payload: Uint8Array): void => {
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let open;
    try {
      open = decodeJsonPayload(payload, isWsOpenPayload);
    } catch (error) {
      void sendAbort(streamId, errorMessage(error, 'malformed ws open'));
      return;
    }
    if (!isRelayWebSocketPathAllowed(open.path)) {
      void sendAbort(streamId, 'Path is not allowed through the relay');
      return;
    }

    const url = `ws://127.0.0.1:${getLocalPort()}${open.path}${open.query ? `?${open.query}` : ''}`;
    // Present the loopback origin we're actually dialing. The server derives this
    // as a trusted same-origin candidate from the Host header (127.0.0.1:<port>),
    // so the WS origin check passes reliably for every client platform. We do NOT
    // use the client's window.location.origin: it's unreliable in WKWebView (empty
    // or "null" for custom schemes), and the `ws` client sends no Origin at all
    // otherwise — a no-origin upgrade is rejected 403. The request itself is still
    // authenticated by the tunneled Varin URL token, not by this origin.
    const dialHeaders = {
      'x-varin-relay-connection': connectionId,
      origin: `http://127.0.0.1:${getLocalPort()}`,
    };
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, open.protocols ?? [], {
        headers: dialHeaders,
      });
    } catch (error) {
      void sendAbort(streamId, errorMessage(error, 'ws dial failed'));
      return;
    }
    const stream: WsTunnelStream = { kind: 'ws', socket, opened: false };
    streams.set(streamId, stream);

    socket.on('open', () => {
      if (streams.get(streamId) !== stream) return;
      stream.opened = true;
      void sendJson(TunnelFrameType.WsOpened, streamId, socket.protocol ? { protocol: socket.protocol } : {});
    });
    socket.on('message', (data, isBinary) => {
      if (streams.get(streamId) !== stream || closed) return;
      const bytes = rawDataBytes(data);
      const frameType = isBinary ? TunnelFrameType.WsBinary : TunnelFrameType.WsText;
      void (async () => {
        for (const frame of encodeFragmentedMessage(frameType, streamId, bytes)) {
          await waitForBackpressure(null);
          if (streams.get(streamId) !== stream || closed) return;
          await send(frame);
        }
      })();
    });
    socket.on('close', (code, reasonBuffer) => {
      if (streams.get(streamId) !== stream) return;
      dropStream(streamId);
      const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
      if (stream.opened) {
        void sendJson(TunnelFrameType.WsClose, streamId, { code: code || 1000, reason });
      } else {
        void sendAbort(streamId, reason || `upstream ws closed (${code || 'no code'})`);
      }
    });
    socket.on('error', (error) => {
      if (streams.get(streamId) !== stream) return;
      if (!stream.opened) {
        dropStream(streamId);
        try {
          socket.terminate();
        } catch {
          // already gone
        }
        void sendAbort(streamId, errorMessage(error, 'upstream ws error'));
      }
      // Post-open errors are followed by 'close', handled above.
    });
  };

  const handleWsMessage = (streamId: number, frameType: number, message: Uint8Array): void => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws' || stream.socket.readyState !== WebSocket.OPEN) return;
    if (frameType === TunnelFrameType.WsText) {
      stream.socket.send(Buffer.from(message).toString('utf8'));
    } else {
      stream.socket.send(message, { binary: true });
    }
  };

  const handleWsClose = (streamId: number, payload: Uint8Array): void => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws') return;
    dropStream(streamId);
    let close: WsClosePayload = { code: 1000, reason: '' };
    try {
      close = decodeJsonPayload(payload, isWsClosePayload);
    } catch {
      // fall through with defaults
    }
    const code = typeof close.code === 'number'
      && Number.isInteger(close.code)
      && close.code >= 1000
      && close.code <= 4999
      ? close.code
      : 1000;
    try {
      stream.socket.close(code, typeof close.reason === 'string' ? close.reason : '');
    } catch {
      stream.socket.terminate();
    }
  };

  // -------------------------------------------------------------------------
  // Frame entrypoint
  // -------------------------------------------------------------------------

  /** @param {Uint8Array} plaintextFrame one decrypted tunnel frame */
  const handleFrame = async (plaintextFrame: Uint8Array): Promise<void> => {
    if (closed) return;
    const frame = decodeTunnelFrame(plaintextFrame);

    // WS message frames can be fragmented; everything else arrives whole.
    if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
      const message = assembler.push(frame);
      if (message === null) return;
      handleWsMessage(frame.streamId, frame.frameType, message);
      return;
    }

    switch (frame.frameType) {
      case TunnelFrameType.HttpRequest:
        handleHttpRequest(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.HttpBody:
        handleHttpBody(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.StreamEnd:
        handleStreamEnd(frame.streamId);
        return;
      case TunnelFrameType.StreamAbort:
        abortLocalStream(frame.streamId, 'aborted by client');
        return;
      case TunnelFrameType.WsOpen:
        handleWsOpen(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.WsClose:
        handleWsClose(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.Ping:
        await send(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, new Uint8Array(0)));
        return;
      case TunnelFrameType.Pong:
        return;
      default:
        // Host never receives HttpResponse/WsOpened; ignore rather than tear down.
        return;
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const streamId of [...streams.keys()]) {
      abortLocalStream(streamId, 'connection closed');
    }
    streams.clear();
  };

  return {
    handleFrame,
    close,
    get streamCount() {
      return streams.size;
    },
  };
};
