import { afterEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import https from 'node:https';
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

// Test-only localhost identity, deliberately absent from every trust store.
// Keeping the fixture here avoids requiring OpenSSL on desktop test runners.
const untrustedLocalhostIdentity = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgl5n/vi2VeXjmJQw3
RqDoLy9SF9kutivDjhMtxg5dQlKhRANCAAQrzvRbzr7V5A3+Ti4Y/wqCMe4l+jNu
qxiq9jdVEKG12rwJDH3kx9Hmc9OAHGEW0yTYYZbr840hTXGSqqWJ/Ul8
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUEmyaZy2DG5qJXlaYxI7f2TNo6SQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMzIyNDg1OVoYDzIxMjYwOTI5
MjI0ODU5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQrzvRbzr7V5A3+Ti4Y/wqCMe4l+jNuqxiq9jdVEKG12rwJDH3kx9Hm
c9OAHGEW0yTYYZbr840hTXGSqqWJ/Ul8o28wbTAdBgNVHQ4EFgQUq8pa5jotEN+v
FFqCv/zKRzQEIC8wHwYDVR0jBBgwFoAUq8pa5jotEN+vFFqCv/zKRzQEIC8wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAI5dTHH4iUp2wtusybea3uyvyL+NVXAmYaUR74GKFc74AiBL
8CKvax0i/BkjU/X0s/KNp5dFfabZ7Ie2hCaeoAKXWg==
-----END CERTIFICATE-----`,
};

const listen = async (server: Server, protocol = 'http'): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `${protocol}://127.0.0.1:${address.port}`;
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

  test.each([
    { name: 'password authentication', auth: { password: 'local-test-password' } },
    { name: 'bearer-authenticated notifications', auth: { clientToken: 'remote-test-token' } },
  ])('rejects an untrusted HTTPS server before sending $name', async ({ auth }) => {
    const requests: string[] = [];
    const warnings: string[] = [];
    let finish: (outcome: 'rejected' | 'received') => void = () => {};
    const outcome = new Promise<'rejected' | 'received'>((resolve) => { finish = resolve; });
    const server = https.createServer(untrustedLocalhostIdentity, (req, res) => {
      requests.push(req.url || '');
      finish('received');
      res.writeHead(req.url === '/auth/session' ? 204 : 200);
      res.end();
    });
    const serverUrl = await listen(server, 'https');
    const listener = new NotificationListener({
      ...auth,
      serverUrl,
      requestHeaders: { 'CF-Access-Client-Secret': 'test-access-secret' },
      logger: {
        ...noopLogger,
        warn(...values: unknown[]) {
          warnings.push(values.join(' '));
          finish('rejected');
        },
      },
      onNotification: () => {},
    });
    listeners.push(listener);

    await listener.start();
    expect(await outcome).toBe('rejected');
    listener.stop();

    expect(requests).toEqual([]);
    expect(listener.isConnected()).toBe(false);
    expect(warnings.join('\n')).toMatch(/self-signed certificate/i);
  });

  test('authenticates with sanitized headers and delivers the original Thread and Host', async () => {
    let passwordBody = '';
    let authHeaders: IncomingHttpHeaders | null = null;
    let streamHeaders: IncomingHttpHeaders | null = null;
    let receive!: (value: unknown) => void;
    const received = new Promise<unknown>(resolve => { receive = resolve; });
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') {
        authHeaders = req.headers;
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { passwordBody += chunk; });
        req.on('end', () => {
          res.writeHead(204, { 'Set-Cookie': 'session=local-test-session; HttpOnly' });
          res.end();
        });
        return;
      }
      if (req.url === '/api/notifications/stream') {
        streamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ type: 'varin:notification', properties: {
          threadId: 'thread:local', branchId: 'branch:local', title: 'Ready', sourceUrl: 'https://forged.invalid',
        } })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const serverUrl = await listen(server);
    const listener = new NotificationListener({
      serverUrl,
      password: 'local-test-password',
      requestHeaders: {
        ' CF-Access-Client-Id ': ' client-id ',
        'X-Custom-Header': 'value',
        Authorization: 'Bearer evil',
        Cookie: 'stolen=1',
        'Content-Length': '999',
        'Content-Type': 'text/evil',
        '': 'empty-name',
        'Bad\nName': 'value',
        'Bad-Value': 'line\nbreak',
      },
      logger: noopLogger,
      onNotification: receive,
    });
    listeners.push(listener);

    await listener.start();
    expect(await received).toMatchObject({ threadId: 'thread:local', branchId: 'branch:local', sourceUrl: serverUrl });
    listener.stop();

    expect(JSON.parse(passwordBody)).toEqual({ password: 'local-test-password' });
    const auth = requireHeaders(authHeaders);
    expect(auth['content-type']).toBe('application/json');
    expect(Number(auth['content-length'])).toBe(Buffer.byteLength(passwordBody));
    expect(auth.authorization).toBeUndefined();
    expect(auth.cookie).toBeUndefined();
    const stream = requireHeaders(streamHeaders);
    expect(stream.cookie).toBe('session=local-test-session');
    for (const headers of [auth, stream]) {
      expect(headers['cf-access-client-id']).toBe('client-id');
      expect(headers['x-custom-header']).toBe('value');
      expect(headers['bad-value']).toBeUndefined();
    }
  });

  test('replaces custom headers on auth update without overriding bearer or stream headers', async () => {
    let request!: (value: IncomingHttpHeaders) => void;
    const requested = new Promise<IncomingHttpHeaders>(resolve => { request = resolve; });
    const server = http.createServer((req, res) => {
      if (req.url !== '/api/notifications/stream') { res.writeHead(404); res.end(); return; }
      request(req.headers);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: \n\n');
    });
    const serverUrl = await listen(server);
    const listener = new NotificationListener({
      serverUrl,
      clientToken: 'old-token',
      requestHeaders: { 'X-Old': 'old' },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);
    listener.updateAuth({
      clientToken: 'new-token',
      requestHeaders: {
        'X-New': 'new', Authorization: 'Bearer evil', Cookie: 'stolen=1',
        Accept: 'text/evil', 'Cache-Control': 'must-revalidate',
      },
    });

    await listener.start();
    const headers = await requested;
    listener.stop();
    expect(headers['x-new']).toBe('new');
    expect(headers['x-old']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer new-token');
    expect(headers.cookie).toBeUndefined();
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
  });
});
