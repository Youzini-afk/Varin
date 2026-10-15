import { WebSocket, WebSocketServer } from 'ws';
import type { Express, Response } from 'express';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData } from 'ws';

const PROXY_SSE_PATH = '/api/varin/realtime-proxy/sse';
const PROXY_WS_PATH = '/api/varin/realtime-proxy/ws';

type ProxyType = 'sse' | 'ws';

interface DesktopRuntimeConfig {
  apiBaseUrl?: string;
  requestHeaders?: unknown;
}

interface ProxyRequest extends IncomingMessage {
  query?: Record<string, unknown>;
}

interface UiAuthController {
  ensureSessionToken(
    req: IncomingMessage,
    res: { setHeader(name: string, value: number | string | readonly string[]): unknown },
  ): Promise<unknown>;
}

interface RealtimeProxyOptions {
  app?: Express | null;
  getDesktopRuntimeConfig?: (() => DesktopRuntimeConfig | null) | null;
  getUiAuthController?: (() => UiAuthController | null) | null;
  isRequestOriginAllowed?: ((req: IncomingMessage) => boolean | Promise<boolean>) | null;
  server?: Server | null;
}

interface ResolvedProxyTarget {
  requestHeaders: Record<string, string>;
  target: URL;
}

const isAllowedSsePath = (pathname: string): boolean => {
  return pathname === '/api/varin/events'
    || pathname === '/api/threads/observe'
    || pathname === '/api/notifications/stream';
};

const isAllowedWebSocketPath = (pathname: string): boolean => {
  return pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws';
};

const normalizeBaseUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
};

const sanitizeHeaders = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const next: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (name.toLowerCase() === 'authorization') continue;
    next[name] = value;
  }
  return next;
};

const hasHeaders = (headers: Record<string, string>): boolean => Object.keys(headers).length > 0;

const getTargetParam = (req: ProxyRequest): URL | null => {
  let raw = typeof req.query?.url === 'string' ? req.query.url : '';
  if (!raw) {
    try {
      raw = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('url') || '';
    } catch {
      raw = '';
    }
  }
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const urlsMatchRuntime = (target: URL, apiBaseUrl: unknown): boolean => {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) return false;
  try {
    const baseUrl = new URL(base);
    const targetForCompare = new URL(target.toString());
    if (targetForCompare.protocol === 'ws:') targetForCompare.protocol = 'http:';
    if (targetForCompare.protocol === 'wss:') targetForCompare.protocol = 'https:';
    return targetForCompare.origin === baseUrl.origin;
  } catch {
    return false;
  }
};

const protocolMatchesProxyType = (target: URL, type: ProxyType): boolean => {
  if (type === 'ws') return target.protocol === 'ws:' || target.protocol === 'wss:';
  return target.protocol === 'http:' || target.protocol === 'https:';
};

const pathMatchesProxyType = (target: URL, type: ProxyType): boolean => {
  return type === 'ws' ? isAllowedWebSocketPath(target.pathname) : isAllowedSsePath(target.pathname);
};

const resolveProxyTarget = (
  req: ProxyRequest,
  getDesktopRuntimeConfig: () => DesktopRuntimeConfig | null,
  type: ProxyType,
): ResolvedProxyTarget | null => {
  const config = typeof getDesktopRuntimeConfig === 'function' ? getDesktopRuntimeConfig() : null;
  const requestHeaders = sanitizeHeaders(config?.requestHeaders);
  const apiBaseUrl = normalizeBaseUrl(config?.apiBaseUrl);
  const target = getTargetParam(req);
  if (!target || !apiBaseUrl || !hasHeaders(requestHeaders)) return null;
  if (!protocolMatchesProxyType(target, type)) return null;
  if (!pathMatchesProxyType(target, type)) return null;
  if (!urlsMatchRuntime(target, apiBaseUrl)) return null;
  return { target, requestHeaders };
};

const safeHeader = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => typeof item === 'string' && item.trim()) || '';
  return typeof value === 'string' ? value.trim() : '';
};

const buildSseRequestHeaders = (req: IncomingMessage, requestHeaders: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {};
  const accept = safeHeader(req.headers, 'accept');
  const lastEventId = safeHeader(req.headers, 'last-event-id');
  if (accept) headers.Accept = accept;
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  return { ...headers, ...requestHeaders };
};

const rejectWebSocketUpgrade = (socket: Duplex, statusCode: number, message: string): void => {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export const buildRealtimeProxySseUrl = (localOrigin: string, targetUrl: string): string => {
  const url = new URL(PROXY_SSE_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  return url.toString();
};

export const buildRealtimeProxyWsUrl = (localOrigin: string, targetUrl: string): string => {
  const url = new URL(PROXY_WS_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const attachRealtimeProxy = ({
  app,
  server,
  getDesktopRuntimeConfig,
  getUiAuthController,
  isRequestOriginAllowed,
}: RealtimeProxyOptions) => {
  if (!app || !server || typeof getDesktopRuntimeConfig !== 'function') {
    return { stop: () => {} };
  }

  const originAllowed = async (req: IncomingMessage): Promise<boolean> => {
    if (typeof isRequestOriginAllowed !== 'function') return false;
    try {
      return await isRequestOriginAllowed(req);
    } catch {
      return false;
    }
  };

  const ensureAuthenticated = async (
    req: IncomingMessage,
    res: Response | null,
  ): Promise<boolean> => {
    const controller = typeof getUiAuthController === 'function' ? getUiAuthController() : null;
    if (typeof controller?.ensureSessionToken !== 'function') return false;
    const response = res || { setHeader: () => undefined };
    const token = await controller.ensureSessionToken(req, response);
    return Boolean(token);
  };

  app.get(PROXY_SSE_PATH, async (req, res) => {
    if (!await ensureAuthenticated(req, res)) {
      res.status(401).json({ error: 'UI authentication required' });
      return;
    }
    if (!await originAllowed(req)) {
      res.status(403).json({ error: 'Realtime proxy origin is not allowed' });
      return;
    }
    const resolved = resolveProxyTarget(req, getDesktopRuntimeConfig, 'sse');
    if (!resolved) {
      res.status(404).json({ error: 'Realtime proxy is unavailable' });
      return;
    }

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      const response = await fetch(resolved.target.toString(), {
        headers: buildSseRequestHeaders(req, resolved.requestHeaders),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        res.status(response.status || 502).end();
        return;
      }

      res.status(response.status);
      res.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', response.headers.get('cache-control') || 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      for await (const chunk of response.body) {
        if (abort.signal.aborted) break;
        res.write(chunk);
      }
      res.end();
    } catch (error) {
      if (!abort.signal.aborted && !res.headersSent) {
        res.status(502).json({ error: error instanceof Error ? error.message : 'Realtime proxy failed' });
      } else if (!res.destroyed) {
        res.end();
      }
    }
  });

  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (client, request) => {
    const resolved = resolveProxyTarget(request, getDesktopRuntimeConfig, 'ws');
    if (!resolved) {
      client.close(1008, 'Realtime proxy is unavailable');
      return;
    }

    const upstream = new WebSocket(resolved.target.toString(), {
      headers: resolved.requestHeaders,
    });
    const pending: Array<[RawData, boolean]> = [];

    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const pendingMessage = pending.shift();
        if (!pendingMessage) break;
        const [data, isBinary] = pendingMessage;
        upstream.send(data, { binary: isBinary });
      }
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code || 1000, reason);
      }
    });
    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'Realtime proxy upstream error');
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = (() => {
      try { return new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { return ''; }
    })();
    if (pathname !== PROXY_WS_PATH) return;
    void ensureAuthenticated(req, null).then((authenticated) => {
      if (!authenticated) {
        rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      void originAllowed(req).then((allowed) => {
        if (!allowed) {
          rejectWebSocketUpgrade(socket, 403, 'Forbidden');
          return;
        }
        if (!resolveProxyTarget(req, getDesktopRuntimeConfig, 'ws')) {
          rejectWebSocketUpgrade(socket, 404, 'Not Found');
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      }).catch(() => {
        rejectWebSocketUpgrade(socket, 403, 'Forbidden');
      });
    }).catch(() => {
      rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
    });
  };

  server.on('upgrade', upgradeHandler);
  return {
    stop: () => {
      server.off('upgrade', upgradeHandler);
      wsServer.close();
    },
  };
};
