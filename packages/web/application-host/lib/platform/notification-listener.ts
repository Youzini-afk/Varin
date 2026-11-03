/** Shared desktop SSE observation. It owns one connection, not notification
 * claims, task state, or destination selection. Native shells inject transport. */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export interface NotificationLogger { error(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void }
export interface DesktopNotificationDetail {
  body: string; directory: string | null; kind: string; requireHidden: boolean;
  threadId: string | null; branchId: string | null; sourceUrl: string; tag: string; title: string;
}
export interface NotificationTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Resolve only after this signal's original transport has actually stopped. */
  settle(signal: AbortSignal): Promise<void>;
}
export interface NotificationListenerOptions {
  clientToken?: string; logger?: NotificationLogger; password?: string; requestHeaders?: unknown;
  onNotification(detail: DesktopNotificationDetail): void;
  serverUrl: string; transport?: NotificationTransport;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reserved = new Set(['authorization', 'cookie', 'content-length', 'content-type', 'accept', 'cache-control', 'host', 'connection', 'transfer-encoding']);
export function sanitizeNotificationHeaders(input: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(record(input))) {
    const name = rawName.trim(), value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n]/.test(value) || reserved.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}
export function parseDesktopNotification(raw: string, sourceUrl: string): DesktopNotificationDetail | null {
  try {
    const event = record(JSON.parse(raw)); if (event.type !== 'varin:notification') return null;
    const p = record(event.properties);
    return { title: typeof p.title === 'string' && p.title ? p.title : 'Varin', body: typeof p.body === 'string' ? p.body : '',
      threadId: typeof p.threadId === 'string' ? p.threadId : null, branchId: typeof p.branchId === 'string' ? p.branchId : null,
      sourceUrl, directory: typeof p.directory === 'string' ? p.directory : null, tag: typeof p.tag === 'string' ? p.tag : '',
      requireHidden: Boolean(p.requireHidden ?? p.require_hidden), kind: typeof p.kind === 'string' ? p.kind : '' };
  } catch { return null; }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** The legacy Electron path keeps its Node HTTP/TLS transport. Tauri must always
 * inject its managed Chromium transport instead of silently using this one. */
function createHttpTransport(): NotificationTransport {
  const active = new WeakMap<AbortSignal, Set<Promise<void>>>();
  return { fetch: async (raw, init) => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid notification endpoint');
    const signal = init.signal; signal?.throwIfAborted();
    const completion = deferred<void>();
    const pending = signal ? active.get(signal) ?? new Set<Promise<void>>() : undefined;
    if (signal && pending) { active.set(signal, pending); pending.add(completion.promise); void completion.promise.finally(() => pending.delete(completion.promise)); }
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), ...(signal ? { signal } : {}),
      }, res => {
        const headers = new Headers();
        for (let index = 0; index < res.rawHeaders.length; index += 2) headers.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!);
        const status = res.statusCode ?? 500;
        const noBody = [204, 205, 304].includes(status) || init.method === 'HEAD';
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      });
      req.once('close', () => completion.resolve());
      req.once('error', reject);
      if (init.body != null) {
        if (typeof init.body !== 'string') { req.destroy(); reject(new Error('Notification authentication body must be text')); return; }
        req.write(init.body);
      }
      req.end();
    });
  }, async settle(signal) { await Promise.all(active.get(signal) ?? []); } };
}
interface Connection { abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; done: Promise<void>; opened: ReturnType<typeof deferred<void>> }
export class NotificationListener {
  readonly #serverUrl: string;
  readonly #transport: NotificationTransport;
  readonly #logger: NotificationLogger;
  readonly #onNotification: NotificationListenerOptions['onNotification'];
  #password: string;
  #clientToken: string;
  #headers: Record<string, string>;
  #cookie = '';
  #connection: Connection | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #delay = 2_000;
  #stopped = true;
  #connected = false;
  #generation = 0;
  #stop: Promise<void> | undefined;
  constructor(options: NotificationListenerOptions) {
    const url = new URL(options.serverUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid notification endpoint');
    url.hash = ''; this.#serverUrl = url.toString().replace(/\/+$/, '');
    this.#transport = options.transport ?? createHttpTransport(); this.#logger = options.logger ?? console;
    this.#onNotification = options.onNotification; this.#password = options.password ?? ''; this.#clientToken = options.clientToken?.trim() ?? '';
    this.#headers = sanitizeNotificationHeaders(options.requestHeaders);
  }
  isConnected(): boolean { return this.#connected; }
  updateAuth({ password, clientToken, requestHeaders }: Partial<NotificationListenerOptions> = {}): void {
    this.#password = password ?? ''; this.#clientToken = clientToken?.trim() ?? ''; this.#cookie = '';
    if (requestHeaders !== undefined) this.#headers = sanitizeNotificationHeaders(requestHeaders);
  }
  async start(): Promise<void> {
    const stopping = this.stop(); const generation = ++this.#generation;
    await stopping;
    if (generation !== this.#generation) return;
    this.#stop = undefined; this.#stopped = false; this.#delay = 2_000;
    await this.#connect(generation);
  }
  stop(): Promise<void> {
    this.#stopped = true; this.#connected = false; ++this.#generation;
    if (this.#stop) return this.#stop;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    const connection = this.#connection; this.#connection = undefined;
    const cancelling = connection?.reader?.cancel().catch(() => undefined);
    connection?.abort.abort();
    return this.#stop = (async () => {
      await cancelling;
      await connection?.done;
      if (connection) await this.#transport.settle(connection.abort.signal);
    })();
  }
  #endpoint(path: string): string { return `${this.#serverUrl}${path}`; }
  async #connect(generation: number): Promise<void> {
    if (this.#stopped || generation !== this.#generation) return;
    const connection: Connection = { abort: new AbortController(), done: Promise.resolve(), opened: deferred<void>() };
    this.#connection = connection;
    connection.done = this.#consume(connection, generation).catch(error => {
      if (!connection.abort.signal.aborted && generation === this.#generation) this.#logger.warn('[notification-listener] connection failed:', error instanceof Error ? error.message : 'UnknownError');
    }).finally(() => {
      connection.opened.resolve();
      if (this.#connection === connection) { this.#connected = false; this.#connection = undefined; }
      if (!this.#stopped && generation === this.#generation) {
        const delay = this.#delay; this.#delay = Math.min(delay * 2, 60_000);
        this.#timer = setTimeout(() => { this.#timer = undefined; void this.#connect(generation); }, delay);
      }
    });
    await connection.opened.promise;
  }
  async #consume(connection: Connection, generation: number): Promise<void> {
    const { signal } = connection.abort;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!this.#clientToken && !this.#cookie && this.#password) {
        const timeout = setTimeout(() => connection.abort.abort(new Error('Notification authentication timed out')), 10_000);
        try {
          const response = await this.#transport.fetch(this.#endpoint('/auth/session'), { method: 'POST', headers: { ...this.#headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.#password }), signal, redirect: 'manual' });
          await response.arrayBuffer(); signal.throwIfAborted();
          if (response.status !== 200 && response.status !== 204) throw new Error(`Notification authentication failed: ${response.status}`);
          this.#cookie = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
        } finally { clearTimeout(timeout); }
      }
      signal.throwIfAborted();
      const headers: Record<string, string> = { ...this.#headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (this.#cookie) headers.Cookie = this.#cookie;
      if (this.#clientToken) headers.Authorization = `Bearer ${this.#clientToken}`;
      const response = await this.#transport.fetch(this.#endpoint('/api/notifications/stream'), { headers, signal, redirect: 'manual' });
      if (response.status !== 200 || !response.body) {
        if (response.status === 401 || response.status === 403) this.#cookie = '';
        await response.body?.cancel(); throw new Error(`Notification stream rejected: ${response.status}`);
      }
      signal.throwIfAborted(); this.#connected = true; this.#delay = 2_000; connection.opened.resolve();
      reader = connection.reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let data: string[] = [];
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        signal.throwIfAborted(); if (generation !== this.#generation) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (line === '') {
            if (data.length) { const detail = parseDesktopNotification(data.join('\n'), this.#serverUrl); data = []; if (detail && !signal.aborted && generation === this.#generation) this.#onNotification(detail); }
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock(); delete connection.reader;
      // No reconnect/switch can outrun cancellation of the old native request.
      await this.#transport.settle(signal);
    }
  }
}
