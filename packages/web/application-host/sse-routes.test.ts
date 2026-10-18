import { describe, expect, it, vi } from 'vitest';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { OutgoingHttpHeader } from 'node:http';

import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationStreamRoute } from './lib/notifications/routes.js';
import { registerVarinEventRoutes } from './lib/scheduled-tasks/routes.js';

const createRouteRegistry = () => {
  const routes = new Map<string, RequestHandler>();

  const register = (method: string, path: string, handlers: RequestHandler[]): void => {
    const handler = handlers.at(-1);
    if (!handler) throw new TypeError(`Expected a handler for ${method} ${path}`);
    routes.set(`${method} ${path}`, handler);
  };

  return {
    app: {
      get(path: string, ...handlers: RequestHandler[]) {
        register('GET', path, handlers);
      },
      post(path: string, ...handlers: RequestHandler[]) {
        register('POST', path, handlers);
      },
      put(path: string, ...handlers: RequestHandler[]) {
        register('PUT', path, handlers);
      },
      patch(path: string, ...handlers: RequestHandler[]) {
        register('PATCH', path, handlers);
      },
      delete(path: string, ...handlers: RequestHandler[]) {
        register('DELETE', path, handlers);
      },
    } as unknown as Express,
    getRoute(method: string, path: string): RequestHandler {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Route not registered: ${method} ${path}`);
      return handler;
    },
  };
};

const createMockRequest = () => {
  const listeners = new Map<string, () => void>();

  return {
    headers: {},
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
    once(event: string, handler: () => void) {
      listeners.set(event, () => { listeners.delete(event); handler(); });
      return this;
    },
    emit(event: string) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
  };
};

const createMockResponse = () => {
  const headers = new Map<string, OutgoingHttpHeader>();
  const listeners = new Map<string, () => void>();
  let statusCode = 200;
  let body = '';
  let flushed = false;
  let bodyFlushCount = 0;

  return {
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
    emit(event: string) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    setHeader(name: string, value: OutgoingHttpHeader) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
    },
    flush() {
      bodyFlushCount += 1;
    },
    write(chunk: unknown) {
      body += String(chunk);
      return true;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body += JSON.stringify(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get flushed() {
      return flushed;
    },
    get bodyFlushCount() {
      return bodyFlushCount;
    },
  };
};

describe('local SSE routes', () => {
  it('serves notification SSE with nginx-safe headers', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set<Response>();

    try {
      registerNotificationStreamRoute(app, {
        uiAuthController: {
          ensureSessionToken: async () => 'ui-token',
        },
        getUiSessionTokenFromRequest: () => 'ui-token',
        getUiNotificationClients: () => clients,
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });

      const handler = getRoute('GET', '/api/notifications/stream');
      const req = createMockRequest();
      const res = createMockResponse();
      const expressRequest = req as unknown as Request;
      const expressResponse = res as unknown as Response;

      await handler(expressRequest, expressResponse, () => {});

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toContain('text/event-stream');
      expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
      expect(res.getHeader('connection')).toBe('keep-alive');
      expect(res.getHeader('x-accel-buffering')).toBe('no');
      expect(res.flushed).toBe(true);
      expect(res.body).toContain('varin:notification-stream-ready');
      expect(clients.has(expressResponse)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(res.bodyFlushCount).toBe(1);

      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toContain(':heartbeat\n\n');
      expect(res.bodyFlushCount).toBe(2);

      res.emit('error');
      expect(clients.has(expressResponse)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      const bodyAfterClose = res.body;
      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toBe(bodyAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves Varin SSE with nginx-safe headers', async () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set<Response>();

    registerVarinEventRoutes(app, {
      getVarinEventClients: () => clients,
      requireAuth: (_req, _res, next) => next(),
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const handler = getRoute('GET', '/api/varin/events');
    const req = createMockRequest();
    const res = createMockResponse();
    const expressRequest = req as unknown as Request;
    const expressResponse = res as unknown as Response;

    await handler(expressRequest, expressResponse, () => {});

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(res.body).toContain('varin:event-stream-ready');
    expect(clients.has(expressResponse)).toBe(true);

    req.emit('close');
    expect(clients.has(expressResponse)).toBe(false);
  });
});
