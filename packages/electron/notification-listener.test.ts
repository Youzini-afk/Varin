import { afterEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import { NotificationListener } from './notification-listener.js';

const servers: Server[] = [];
const listeners: NotificationListener[] = [];

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  while (listeners.length > 0) {
    const listener = listeners.pop();
    if (!listener) continue;
    try { listener.stop(); } catch { /* best-effort cleanup; test result already determined */ }
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('NotificationListener', () => {
  const requireHeaders = (headers: IncomingHttpHeaders | null): IncomingHttpHeaders => {
    if (!headers) throw new Error('Expected request headers to be observed');
    return headers;
  };

  test('forwards sanitized custom requestHeaders to /auth/session', async () => {
    let observedAuthHeaders: IncomingHttpHeaders | null = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') {
        observedAuthHeaders = req.headers;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/api/notifications/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      password: 'shh',
      requestHeaders: {
        'CF-Access-Client-Id': 'client-id',
        'X-Custom-Header': 'value',
        // Reserved — must not be forwarded / must not override listener's own value.
        Authorization: 'Bearer evil',
        Cookie: 'stolen=1',
        'Content-Length': '999',
        'Content-Type': 'text/evil',
        '': 'empty-name',
        'Bad\nName': 'value',
        'Bad-Value': 'line\nbreak',
      },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    await listener.start();
    // Give the SSE stream a tick to open.
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedAuthHeaders).not.toBeNull();
    const authHeaders = requireHeaders(observedAuthHeaders);
    expect(authHeaders['cf-access-client-id']).toBe('client-id');
    expect(authHeaders['x-custom-header']).toBe('value');
    // Reserved headers dropped from custom set; listener's own values win.
    expect(authHeaders['content-type']).toBe('application/json');
    expect(authHeaders['authorization']).toBeUndefined();
    expect(authHeaders['cookie']).toBeUndefined();
  });

  test('forwards sanitized custom requestHeaders to /api/notifications/stream and preserves auth', async () => {
    let observedStreamHeaders: IncomingHttpHeaders | null = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === '/api/notifications/stream') {
        observedStreamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      password: '',
      clientToken: 'token-abc',
      requestHeaders: {
        'X-Forwarded-Host': 'example.com',
        // Reserved — must not override listener's own Authorization/Accept/Cache-Control.
        Authorization: 'Bearer evil',
        Accept: 'text/evil',
        'Cache-Control': 'must-revalidate',
      },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    await listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedStreamHeaders).not.toBeNull();
    const streamHeaders = requireHeaders(observedStreamHeaders);
    expect(streamHeaders['x-forwarded-host']).toBe('example.com');
    expect(streamHeaders['authorization']).toBe('Bearer token-abc');
    expect(streamHeaders['accept']).toBe('text/event-stream');
    expect(streamHeaders['cache-control']).toBe('no-cache');
  });

  test('updateAuth replaces requestHeaders and re-sanitizes reserved names', async () => {
    let observedStreamHeaders: IncomingHttpHeaders | null = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/notifications/stream') {
        observedStreamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      clientToken: 'tok',
      requestHeaders: { 'X-Old': 'old' },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    listener.updateAuth({
      clientToken: 'tok',
      requestHeaders: { 'X-New': 'new', Authorization: 'Bearer evil', Cookie: 'c=1' },
    });

    await listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedStreamHeaders).not.toBeNull();
    const updateHeaders = requireHeaders(observedStreamHeaders);
    expect(updateHeaders['x-new']).toBe('new');
    expect(updateHeaders['x-old']).toBeUndefined();
    expect(updateHeaders['authorization']).toBe('Bearer tok');
    expect(updateHeaders['cookie']).toBeUndefined();
  });
  test('receives native Thread and branch with the configured source Host', async () => {
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      if (req.url !== '/api/notifications/stream') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'varin:notification', properties: { threadId: 'thread:a', branchId: 'branch:b', title: 'Ready', sourceUrl: 'https://forged.invalid' } })}\n\n`);
    });
    const baseUrl = await listen(server);
    const listener = new NotificationListener({ serverUrl: baseUrl, clientToken: 'token', logger: noopLogger, onNotification: detail => received.push(detail) });
    listeners.push(listener); await listener.start();
    await new Promise(resolve => setTimeout(resolve, 30)); listener.stop();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ threadId: 'thread:a', branchId: 'branch:b', sourceUrl: baseUrl });
    expect(received[0]).not.toHaveProperty('sessionId');
  });

});
