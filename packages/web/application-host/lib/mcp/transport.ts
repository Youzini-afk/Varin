import { parseJSONRPCMessage, ProtocolError, PROTOCOL_VERSION_META_KEY, type Transport, type TransportSendOptions, type JSONRPCMessage, type AuthProvider } from '@modelcontextprotocol/client';
import { isModernMcpVersion, encodeMcpHeaderValue } from './headers.js';
import { createParser } from 'eventsource-parser';
import { waitWithSignal } from '../cancellation.js';
export type JsonRpcMessage = JSONRPCMessage;
export type StdioTransportOptions = { command: string; args?: readonly string[]; cwd?: string; env?: Record<string, string>; inheritEnv?: boolean; stderr?: 'pipe' | 'inherit'; onStderr?: (chunk: string) => void; maxMessageBytes?: number; maxStderrBytes?: number; closeTimeoutMs?: number };
export interface McpTransport {
  start(): Promise<void>; send(message: JsonRpcMessage, options?: TransportSendOptions): Promise<void>; close(): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage, context?: { relatedRequestId?: string | number; syntheticResponse?: true }) => void): () => void;
  onError(listener: (error: Error) => void): () => void; onClose(listener: () => void): () => void;
  setProtocolVersion?(version: string): void;
  readonly hasPerRequestStream?: boolean;
}
export class McpConnectionClosedError extends Error { constructor() { super('MCP connection closed'); } }
export class McpSessionExpiredError extends Error { constructor() { super('MCP session expired'); } }
export class McpMessageTooLargeError extends Error { readonly code = 'mcp_message_too_large'; constructor(bytes: number) { super(`MCP message exceeded ${bytes} bytes`); } }
export const parseJsonRpcMessage = (value: unknown): JsonRpcMessage => {
  try { return parseJSONRPCMessage(value); } catch { throw new ProtocolError(-32600, 'Invalid JSON-RPC message'); }
};

/** A descriptor that must be replaced by the existing Rust process service before starting. */
export class StdioTransport implements McpTransport {
  constructor(readonly options: Readonly<StdioTransportOptions>) {}
  async start(): Promise<void> { throw new Error('MCP stdio requires its Host process owner'); }
  async send(_message: JsonRpcMessage): Promise<void> { throw new McpConnectionClosedError(); }
  async close() {}
  onMessage(_listener: Parameters<McpTransport['onMessage']>[0]) { return () => {}; }
  onError(_listener: Parameters<McpTransport['onError']>[0]) { return () => {}; }
  onClose(_listener: Parameters<McpTransport['onClose']>[0]) { return () => {}; }
}
/** Transport callbacks preserve response-stream association for original user interactions. */
export class StreamableHttpTransport implements McpTransport {
  readonly hasPerRequestStream = true;
  readonly #shutdown = new AbortController();
  readonly #streams = new Set<Promise<void>>();
  #started = false;
  #closed = false;
  #protocol?: string;
  #session: string | undefined;
  #notificationsStarted = false;
  readonly #messages = new Set<Parameters<McpTransport['onMessage']>[0]>();
  readonly #errors = new Set<Parameters<McpTransport['onError']>[0]>();
  readonly #closes = new Set<() => void>();
  constructor(readonly url: string, readonly options: { headers?: Record<string, string>; authProvider?: AuthProvider; fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> } = {}) {}
  get sessionId() { return this.#session; }
  async start() { if (this.#closed || this.#started) throw new McpConnectionClosedError(); this.#started = true; }
  setProtocolVersion(version: string) { this.#protocol = version; }
  async #fetch(method: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const headers = new Headers(this.options.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (this.#protocol && !headers.has('mcp-protocol-version')) headers.set('mcp-protocol-version', this.#protocol);
    if (this.#session) headers.set('mcp-session-id', this.#session);
    const token = await waitWithSignal(this.options.authProvider?.token() ?? Promise.resolve(undefined), signal);
    if (token) headers.set('authorization', `Bearer ${token}`);
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? globalThis.fetch)(this.url, { ...init, method, headers, signal, redirect: 'manual' });
    if (!response.ok && response.status !== 401 && response.status !== 403 && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json') {
      // A protocol rejection is a received response, including discovery/version rejections.
      try { const reply = parseJSONRPCMessage(await response.clone().json()); if ('error' in reply) return response; } catch { /* Non-RPC HTTP failure below. */ }
    }
    if (response.status === 404 && this.#session) { await response.body?.cancel(); throw new McpSessionExpiredError(); }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'MCP sign-in required' : `MCP HTTP ${response.status}`), { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate') });
    }
    return response;
  }
  #emit(message: JsonRpcMessage, requestId?: string | number) { for (const listener of this.#messages) listener(message, requestId === undefined ? undefined : { relatedRequestId: requestId }); }
  async #consume(response: Response, requestId: string | number | undefined, signal: AbortSignal, onEnd?: () => void, protocolVersion = this.#protocol) {
    let answered = false, eventId: string | undefined, resumedFrom: string | undefined;
    try {
      for (;;) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('MCP response stream is missing');
        const decoder = new TextDecoder();
        const parser = createParser({ onEvent: event => {
          if (event.id) eventId = event.id;
          if (!event.data || event.event && event.event !== 'message') return;
          const message = parseJSONRPCMessage(JSON.parse(event.data));
          if (requestId !== undefined && 'id' in message && !('method' in message) && message.id === requestId) answered = true;
          this.#emit(message, requestId);
        } });
        const abort = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            parser.feed(decoder.decode(next.value, { stream: true }));
            if (answered) { await reader.cancel(); break; }
          }
          parser.feed(decoder.decode());
        } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
        // 2026 HTTP streams cannot resume. Older revisions may continue the original SSE
        // stream via GET; this never replays its POST or loops over an unchanged event cursor.
        if (answered || signal.aborted || isModernMcpVersion(protocolVersion) || !eventId || eventId === resumedFrom) break;
        resumedFrom = eventId;
        response = await this.#fetch('GET', { headers: { accept: 'text/event-stream', 'last-event-id': eventId } }, signal);
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
          await response.body?.cancel(); throw new Error('MCP resumed stream is invalid');
        }
      }
    } finally { if (!answered && requestId !== undefined && !signal.aborted) onEnd?.(); }
  }
  async send(message: JsonRpcMessage, options?: TransportSendOptions) {
    if (!this.#started || this.#closed) throw new McpConnectionClosedError();
    const signal = options?.requestSignal ? AbortSignal.any([this.#shutdown.signal, options.requestSignal]) : this.#shutdown.signal;
    const headers = new Headers(options?.headers);
    headers.set('accept', 'application/json, text/event-stream'); headers.set('content-type', 'application/json');
    if ('id' in message && 'method' in message) {
      const version = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
      if (typeof version === 'string') {
        headers.set('mcp-protocol-version', version); headers.set('mcp-method', message.method);
        const name = message.method === 'resources/read' ? message.params?.uri : ['tools/call', 'prompts/get'].includes(message.method) ? message.params?.name : undefined;
        if (typeof name === 'string') headers.set('mcp-name', encodeMcpHeaderValue(name));
      }
    }
    const response = await this.#fetch('POST', { headers, body: JSON.stringify(message) }, signal);
    if ('method' in message && message.method === 'initialize' && response.ok) this.#session = response.headers.get('mcp-session-id') ?? undefined;
    if (!('method' in message) || !('id' in message)) {
      await response.body?.cancel();
      if ('method' in message && message.method === 'notifications/initialized' && !this.#notificationsStarted) {
        this.#notificationsStarted = true;
        this.#track(this.#notifications());
      }
      return;
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type === 'application/json') {
      const body: unknown = await response.json();
      let answered = false;
      for (const value of Array.isArray(body) ? body : [body]) {
        const parsed = parseJSONRPCMessage(value);
        if ('id' in parsed && !('method' in parsed) && parsed.id === message.id) answered = true;
        this.#emit(parsed, message.id);
      }
      if (!answered) options?.onRequestStreamEnd?.();
      return;
    }
    if (type === 'text/event-stream') { this.#track(this.#consume(response, message.id, signal, options?.onRequestStreamEnd, headers.get('mcp-protocol-version') ?? this.#protocol)); return; }
    await response.body?.cancel();
    throw new Error('MCP request has no result response');
  }
  #track(work: Promise<void>) {
    this.#streams.add(work);
    void work.then(() => this.#streams.delete(work), error => { this.#streams.delete(work); if (!this.#closed) for (const listener of this.#errors) listener(error instanceof Error ? error : new Error('MCP response stream failed')); });
  }
  async #notifications() {
    // A missing legacy GET stream is an optional capability, not a failed tool connection.
    const headers = new Headers(this.options.headers);
    headers.set('accept', 'text/event-stream');
    if (this.#session) headers.set('mcp-session-id', this.#session);
    if (this.#protocol) headers.set('mcp-protocol-version', this.#protocol);
    const token = await waitWithSignal(this.options.authProvider?.token() ?? Promise.resolve(undefined), this.#shutdown.signal); if (token) headers.set('authorization', `Bearer ${token}`);
    this.#shutdown.signal.throwIfAborted();
    const response = await (this.options.fetch ?? globalThis.fetch)(this.url, { method: 'GET', headers, signal: this.#shutdown.signal, redirect: 'manual' });
    if (response.status === 405 || response.status === 404) { await response.body?.cancel(); return; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP notification stream failed (${response.status})`); }
    await this.#consume(response, undefined, this.#shutdown.signal);
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#shutdown.abort();
    await Promise.allSettled([...this.#streams]);
    for (const listener of this.#closes) listener();
  }
  onMessage(listener: Parameters<McpTransport['onMessage']>[0]) { this.#messages.add(listener); return () => { this.#messages.delete(listener); }; }
  onError(listener: Parameters<McpTransport['onError']>[0]) { this.#errors.add(listener); return () => { this.#errors.delete(listener); }; }
  onClose(listener: () => void) { this.#closes.add(listener); return () => { this.#closes.delete(listener); }; }
}
export type { Transport, TransportSendOptions };
