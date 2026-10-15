import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { attachRealtimeProxy, buildRealtimeProxySseUrl, buildRealtimeProxyWsUrl } from './realtime-proxy.js';
import { createUiAuth } from './ui-auth/ui-auth.js';

const servers: Server[] = [];

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

interface ProxyServerOptions {
  apiBaseUrl: string;
  authToken?: string | null;
  originAllowed?: boolean;
}

interface ProxyServerWithAuthOptions {
  apiBaseUrl: string;
  originAllowed?: boolean;
  uiAuthController: NonNullable<ReturnType<NonNullable<Parameters<typeof attachRealtimeProxy>[0]['getUiAuthController']>>>;
}

const startProxyServer = async ({ apiBaseUrl, authToken = 'ui-token', originAllowed = true }: ProxyServerOptions) => {
  const app = express();
  const server = http.createServer(app);
  const runtime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl,
      requestHeaders: { 'X-Proxy-Auth': 'secret' },
    }),
    getUiAuthController: () => ({
      ensureSessionToken: async () => authToken,
    }),
    isRequestOriginAllowed: async () => originAllowed,
  });
  const origin = await listen(server);
  return { origin, runtime };
};

const startProxyServerWithAuthController = async ({ apiBaseUrl, uiAuthController, originAllowed = true }: ProxyServerWithAuthOptions) => {
  const app = express();
  const server = http.createServer(app);
  const runtime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl,
      requestHeaders: { 'X-Proxy-Auth': 'secret' },
    }),
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed: async () => originAllowed,
  });
  const origin = await listen(server);
  return { origin, runtime };
};

const startSseUpstream = async ({ path = '/api/varin/events' }: { path?: string } = {}) => {
  const requests: Array<{ headers: IncomingHttpHeaders; url: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (new URL(req.url || '/', 'http://127.0.0.1').pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write('data: first\n\n');
    res.end('data: second\n\n');
  });
  const origin = await listen(server);
  return { origin, requests };
};

const firstRequest = (requests: Array<{ headers: IncomingHttpHeaders; url: string | undefined }>) => {
  const first = requests[0];
  if (!first) throw new Error('Expected an upstream request');
  return first;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await closeServer(server);
  }
});

describe('realtime proxy URL builders', () => {
  it('builds local SSE proxy URLs with target URL encoded as query data', () => {
    const url = new URL(buildRealtimeProxySseUrl('http://127.0.0.1:57123', 'https://remote.example/api/varin/events?x=1'));

    expect(url.origin).toBe('http://127.0.0.1:57123');
    expect(url.pathname).toBe('/api/varin/realtime-proxy/sse');
    expect(url.searchParams.get('url')).toBe('https://remote.example/api/varin/events?x=1');
  });

  it('builds local WebSocket proxy URLs with ws protocol', () => {
    const url = new URL(buildRealtimeProxyWsUrl('https://127.0.0.1:57123', 'wss://remote.example/api/terminal/ws'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('127.0.0.1:57123');
    expect(url.pathname).toBe('/api/varin/realtime-proxy/ws');
    expect(url.searchParams.get('url')).toBe('wss://remote.example/api/terminal/ws');
  });
});

describe('realtime proxy', () => {
  it('streams SSE chunks and forwards safe SSE headers with configured runtime headers', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/varin/events`), {
        headers: {
          Accept: 'text/event-stream',
          'Last-Event-ID': 'evt-42',
          Origin: 'varin-ui://app',
        },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
      expect(upstream.requests).toHaveLength(1);
      expect(firstRequest(upstream.requests).headers.accept).toBe('text/event-stream');
      expect(firstRequest(upstream.requests).headers['last-event-id']).toBe('evt-42');
      expect(firstRequest(upstream.requests).headers['x-proxy-auth']).toBe('secret');
    } finally {
      runtime.stop();
    }
  });

  it('rejects unauthenticated SSE proxy requests', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin, authToken: null });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/varin/events`), {
        headers: { Origin: 'varin-ui://app' },
      });

      expect(response.status).toBe(401);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects SSE proxy requests from disallowed origins', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin, originAllowed: false });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/varin/events`), {
        headers: { Origin: 'https://evil.example' },
      });

      expect(response.status).toBe(403);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects targets outside the active runtime origin', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: 'https://different.example' });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/varin/events`), {
        headers: { Origin: 'varin-ui://app' },
      });

      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('streams native Thread observation through the realtime allowlist', async () => {
    const upstream = await startSseUpstream({ path: '/api/threads/observe' });
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/threads/observe`), {
        headers: {
          Accept: 'text/event-stream',
          Origin: 'varin-ui://app',
        },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
      expect(upstream.requests).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it.each(['/api/config/settings', '/api/varin/runtime-manager/events'])('rejects SSE target outside the realtime path allowlist: %s', async (path) => {
    const upstream = await startSseUpstream({ path });
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}${path}`), {
        headers: { Origin: 'varin-ui://app' },
      });

      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects the retired Pi runtime WebSocket before forwarding credentials', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });
    const target = `${upstream.origin.replace(/^http:/, 'ws:')}/api/varin/runtime/ws`;
    const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
      headers: { Origin: 'varin-ui://app' },
    });
    client.on('error', () => {});
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
        client.once('open', () => reject(new Error('Retired runtime WebSocket was accepted')));
        client.once('error', reject);
      });
      expect(status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      client.terminate();
      runtime.stop();
    }
  });

  it('proxies WebSocket upgrades using query params from the raw upgrade request URL', async () => {
    const upstreamRequest: { current: IncomingMessage | null } = { current: null };
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket, request) => {
      upstreamRequest.current = request;
      socket.on('message', (data, isBinary) => {
        socket.send(isBinary ? data : `echo:${data.toString()}`, { binary: isBinary });
      });
    });
    const upstreamOrigin = await listen(upstreamServer);
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });

    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/terminal/ws?lastEventId=evt-1`;
      const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
        headers: { Origin: 'varin-ui://app' },
      });
      await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });

      const message = await new Promise<string>((resolve) => {
        client.once('message', (data) => resolve(data.toString()));
        client.send('ping');
      });

      expect(message).toBe('echo:ping');
      expect(upstreamRequest.current?.url).toBe('/api/terminal/ws?lastEventId=evt-1');
      expect(upstreamRequest.current?.headers['x-proxy-auth']).toBe('secret');
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  });

  it('allows first passwordless WebSocket proxy upgrade without an existing cookie', async () => {
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket) => {
      socket.send('ready');
    });
    const upstreamOrigin = await listen(upstreamServer);
    const uiAuthController = createUiAuth({ password: '' } as unknown as Parameters<typeof createUiAuth>[0]);
    const { origin, runtime } = await startProxyServerWithAuthController({ apiBaseUrl: upstreamOrigin, uiAuthController });

    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/terminal/ws`;
      const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
        headers: { Origin: 'varin-ui://app' },
      });
      const message = await new Promise<string>((resolve, reject) => {
        client.once('message', (data) => resolve(data.toString()));
        client.once('error', reject);
      });

      expect(message).toBe('ready');
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
      uiAuthController.dispose?.();
    }
  });

  it.each(['', '/base'])('proxies only the exact observation endpoint at mount %s with the fixed remote Origin and configured credentials', async (mount) => {
    const requests: IncomingMessage[] = [];
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket, request) => { requests.push(request); socket.send('ready'); });
    const upstreamOrigin = await listen(upstreamServer);
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: `${upstreamOrigin}${mount}` });
    const client = new WebSocket(buildRealtimeProxyWsUrl(origin, `${upstreamOrigin}${mount}/api/varin/observations/ws`.replace('http:', 'ws:')), {
      headers: { Origin: 'varin-ui://app', Cookie: 'local-session=private' },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('message', () => resolve()); client.once('error', reject);
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.origin).toBe(upstreamOrigin);
      expect(requests[0]?.url).toBe(`${mount}/api/varin/observations/ws`);
      expect(requests[0]?.headers['x-proxy-auth']).toBe('secret');
      expect(requests[0]?.headers.cookie).toBeUndefined();
    } finally {
      client.close(); runtime.stop(); upstreamWs.close();
    }
  });

  it('does not forward observation credentials outside the configured runtime mount', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: `${upstream.origin}/base` });
    const client = new WebSocket(buildRealtimeProxyWsUrl(origin, `${upstream.origin.replace('http:', 'ws:')}/api/varin/observations/ws`), {
      headers: { Origin: 'varin-ui://app' },
    });
    client.on('error', () => {});
    try {
      expect(await new Promise<number | undefined>((resolve) => {
        client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
      })).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally { client.terminate(); runtime.stop(); }
  });

  it.each([
    { authToken: null, originAllowed: true, path: '/api/varin/observations/ws', status: 401 },
    { authToken: 'ui-token', originAllowed: false, path: '/api/varin/observations/ws', status: 403 },
    { authToken: 'ui-token', originAllowed: true, path: '/api/varin/observations/ws/extra', status: 404 },
  ])('rejects an observation proxy without its exact target, original UI auth or Origin: $status', async (options) => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin, ...options });
    const client = new WebSocket(buildRealtimeProxyWsUrl(origin, `${upstream.origin.replace('http:', 'ws:')}${options.path}`), {
      headers: { Origin: 'https://untrusted.example' },
    });
    client.on('error', () => {});
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
        client.once('open', () => reject(new Error('Unexpected accepted proxy')));
      });
      expect(status).toBe(options.status);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      client.terminate(); runtime.stop();
    }
  });
});
