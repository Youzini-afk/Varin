import { once } from 'node:events';
import { createServer, get, type Server } from 'node:http';
import express, { type Response } from 'express';
import compression from 'compression';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationStreamRoute } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { registerVarinEventRoutes } from './lib/scheduled-tasks/routes.js';

// Exercise Express middleware, streaming headers and disconnects over real HTTP.
// Only the authentication decision and heartbeat clock are controlled here.
describe('local SSE routes', () => {
  let server: Server;
  let origin: string;
  let notifications: Set<Response>;
  let events: Set<Response>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    notifications = new Set();
    events = new Set();
    const app = express();
    app.use(compression());
    const { writeSseEvent } = createNotificationEmitterRuntime({
      process, desktopNotifyPrefix: '', getDesktopNotifyEnabled: () => false,
      getUiNotificationClients: () => notifications, getBroadcastGlobalUiEvent: () => null,
    });
    registerNotificationStreamRoute(app, {
      uiAuthController: {
        async ensureSessionToken(req, res) {
          if (req.headers.authorization === 'Bearer allowed') return 'ui-token';
          res.status(401).json({ error: 'Unauthorized' });
          return null;
        },
      },
      getUiSessionTokenFromRequest: () => null,
      getUiNotificationClients: () => notifications,
      writeSseEvent,
    });
    registerVarinEventRoutes(app, {
      getVarinEventClients: () => events,
      requireAuth(req, res, next) {
        if (req.headers.authorization === 'Bearer allowed') next();
        else res.status(401).json({ error: 'Unauthorized' });
      },
      writeSseEvent,
    });
    server = createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.useRealTimers();
  });

  it.each([
    { path: '/api/notifications/stream', ready: 'varin:notification-stream-ready', close: 'disconnect' },
    { path: '/api/notifications/stream', ready: 'varin:notification-stream-ready', close: 'response-error' },
    { path: '/api/varin/events', ready: 'varin:event-stream-ready', close: 'disconnect' },
  ])('authenticates $path and drains on $close without proxy buffering', async ({ path, ready, close }) => {
    await request(server).get(path).expect(401);
    expect(notifications.size + events.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const connection = get(`${origin}${path}`, { headers: { authorization: 'Bearer allowed' } });
    const [response] = await once(connection, 'response');
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { body += chunk; });
    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache, no-transform');
      expect(response.headers.connection).toBe('keep-alive');
      expect(response.headers['x-accel-buffering']).toBe('no');
      await vi.waitFor(() => expect(body).toContain(ready));
      expect(notifications.size + events.size).toBe(1);

      if (path === '/api/notifications/stream') {
        vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
        await vi.waitFor(() => expect(body).toContain(':heartbeat\n\n'));
      }
      if (close === 'response-error') {
        const owner = notifications.values().next().value;
        if (!owner) throw new Error('Notification stream is not registered');
        owner.emit('error', new Error('controlled response failure'));
      } else response.destroy();
      await vi.waitFor(() => expect(notifications.size + events.size).toBe(0));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      response.destroy();
      connection.destroy();
    }
  });
});
