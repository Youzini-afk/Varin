import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { errorMessage, recordOf } from './runtime-types.js';

interface NotificationLogger {
  error(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

export interface DesktopNotificationDetail {
  body: string;
  directory: string | null;
  kind: string;
  requireHidden: boolean;
  threadId: string | null;
  branchId: string | null;
  sourceUrl: string;
  tag: string;
  title: string;
}

export interface NotificationListenerOptions {
  clientToken?: string;
  logger?: NotificationLogger;
  onNotification(detail: DesktopNotificationDetail): void;
  password?: string;
  requestHeaders?: unknown;
  serverUrl: string;
}

// electron-log is the production default logger. It is loaded lazily so the
// module remains importable (and unit-testable) in environments where the
// dependency is not installed; callers that pass their own logger never
// trigger this import.
let defaultLogger: NotificationLogger | null = null;
const resolveDefaultLogger = async (): Promise<NotificationLogger> => {
  if (defaultLogger) return defaultLogger;
  try {
    const mod = await import('electron-log/main.js');
    defaultLogger = mod.default || mod;
  } catch {
    defaultLogger = console;
  }
  return defaultLogger;
};

const MIN_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const BACKOFF_FACTOR = 2;

// Header names NotificationListener sets itself when authenticating and
// streaming. Custom requestHeaders forwarded from runtime config must never
// override these, so the listener applies its own denylist at merge time
// (defense-in-depth on top of main.mjs's sanitizeRuntimeRequestHeaders).
const RESERVED_LISTENER_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'content-length',
  'content-type',
  'accept',
  'cache-control',
  'host',
  'connection',
  'transfer-encoding',
]);

const sanitizeListenerRequestHeaders = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const next: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value) continue;
    if (/[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (RESERVED_LISTENER_HEADER_NAMES.has(name.toLowerCase())) continue;
    next[name] = value;
  }
  return next;
};

export class NotificationListener {
  #serverUrl: string;
  #password: string;
  #clientToken: string;
  #requestHeaders: Record<string, string>;
  #onNotification: (detail: DesktopNotificationDetail) => void;
  #logger: NotificationLogger | undefined;
  #sessionCookie: string;
  #request: http.ClientRequest | null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null;
  #reconnectDelay: number;
  #stopped: boolean;
  #connected: boolean;

  constructor({ serverUrl, password, clientToken, requestHeaders, onNotification, logger }: NotificationListenerOptions) {
    this.#serverUrl = serverUrl.replace(/\/+$/, '');
    this.#password = password || '';
    this.#clientToken = typeof clientToken === 'string' ? clientToken.trim() : '';
    this.#requestHeaders = sanitizeListenerRequestHeaders(requestHeaders);
    this.#onNotification = onNotification;
    this.#logger = logger;
    this.#sessionCookie = '';
    this.#request = null;
    this.#reconnectTimer = null;
    this.#reconnectDelay = MIN_RECONNECT_DELAY_MS;
    this.#stopped = true;
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  updateAuth({ password, clientToken, requestHeaders }: Partial<NotificationListenerOptions> = {}): void {
    this.#password = password || '';
    this.#clientToken = typeof clientToken === 'string' ? clientToken.trim() : '';
    if (requestHeaders !== undefined) {
      this.#requestHeaders = sanitizeListenerRequestHeaders(requestHeaders);
    }
    this.#sessionCookie = '';
  }

  #getLogger(): NotificationLogger {
    if (this.#logger) return this.#logger;
    // No caller-supplied logger: lazily resolve electron-log for production,
    // falling back to console until the dynamic import completes (or if the
    // dependency is unavailable). Tests pass their own logger and skip this.
    if (!defaultLogger) void resolveDefaultLogger();
    return defaultLogger || console;
  }
  async start(): Promise<void> {
    if (!this.#stopped) this.stop();
    this.#stopped = false;
    this.#reconnectDelay = MIN_RECONNECT_DELAY_MS;
    this.#getLogger().info('[notification-listener] starting', { url: this.#serverUrl });
    await this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#connected = false;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#request) {
      try { this.#request.destroy(); } catch {
        // The request may already be closed.
      }
      this.#request = null;
    }
    this.#getLogger().info('[notification-listener] stopped');
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;

    try {
      if (!this.#clientToken && !this.#sessionCookie && this.#password) {
        await this.#authenticate();
      }
      this.#openSseStream();
    } catch (error) {
      this.#getLogger().warn('[notification-listener] connect error:', errorMessage(error));
      this.#scheduleReconnect();
    }
  }

  async #authenticate(): Promise<void> {
    const url = new URL('/auth/session', this.#serverUrl);
    const body = JSON.stringify({ password: this.#password });
    const mod = url.protocol === 'https:' ? https : http;

    return new Promise<void>((resolve, reject) => {
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          ...this.#requestHeaders,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      }, (res) => {
        res.on('data', () => { /* drain response body */ });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            const setCookie = res.headers['set-cookie'];
            if (Array.isArray(setCookie) && setCookie.length > 0) {
              this.#sessionCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
            }
            this.#getLogger().info('[notification-listener] authenticated');
            resolve();
          } else {
            reject(new Error(`auth failed: ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('auth timeout')); });
      req.setTimeout(10_000);
      req.write(body);
      req.end();
    });
  }

  #openSseStream(): void {
    if (this.#stopped) return;

    const url = new URL('/api/notifications/stream', this.#serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      ...this.#requestHeaders,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (this.#sessionCookie) {
      headers.Cookie = this.#sessionCookie;
    }
    if (this.#clientToken) {
      headers.Authorization = `Bearer ${this.#clientToken}`;
    }

    const req = mod.request(url, {
      method: 'GET',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.#getLogger().warn('[notification-listener] auth rejected, clearing session cookie');
        this.#sessionCookie = '';
        res.resume();
        this.#scheduleReconnect();
        return;
      }

      if (res.statusCode !== 200) {
        this.#getLogger().warn(`[notification-listener] unexpected status: ${res.statusCode}`);
        res.resume();
        this.#scheduleReconnect();
        return;
      }

      this.#connected = true;
      this.#reconnectDelay = MIN_RECONNECT_DELAY_MS;
      this.#getLogger().info('[notification-listener] SSE stream connected');

      let buffer = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            this.#handleSseData(line.slice(6).trim());
          }
        }
      });

      res.on('end', () => {
        this.#connected = false;
        this.#getLogger().info('[notification-listener] SSE stream ended');
        this.#scheduleReconnect();
      });

      res.on('error', (error) => {
        this.#connected = false;
        this.#getLogger().warn('[notification-listener] SSE stream error:', error?.message);
        this.#scheduleReconnect();
      });
    });

    req.on('error', (error) => {
      this.#connected = false;
      const code = typeof recordOf(error).code === 'string' ? recordOf(error).code : '';
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
        this.#getLogger().warn(`[notification-listener] connection ${code}`);
      } else {
        this.#getLogger().warn('[notification-listener] request error:', error?.message);
      }
      this.#scheduleReconnect();
    });

    req.end();
    this.#request = req;
  }

  #handleSseData(raw: string): void {
    try {
      const parsed = recordOf(JSON.parse(raw));
      if (parsed.type !== 'varin:notification') return;
      const props = recordOf(parsed.properties);
      if (!props) return;
      this.#onNotification({
        title: typeof props.title === 'string' && props.title ? props.title : 'Varin',
        body: typeof props.body === 'string' ? props.body : '',
        threadId: typeof props.threadId === 'string' ? props.threadId : null,
        branchId: typeof props.branchId === 'string' ? props.branchId : null,
        sourceUrl: this.#serverUrl,
        directory: typeof props.directory === 'string' ? props.directory : null,
        tag: typeof props.tag === 'string' ? props.tag : '',
        requireHidden: Boolean(props.requireHidden ?? props.require_hidden),
        kind: typeof props.kind === 'string' ? props.kind : '',
      });
    } catch {
      // Not JSON or not a notification event — ignore.
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    if (this.#reconnectTimer) return;

    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(this.#reconnectDelay * BACKOFF_FACTOR, MAX_RECONNECT_DELAY_MS);
    this.#getLogger().info(`[notification-listener] reconnecting in ${delay}ms`);

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }
}
