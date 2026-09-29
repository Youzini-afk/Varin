import type { Express, Request, RequestHandler } from 'express';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { HostSshManager } from './ssh-manager.js';
import { readHostConnections } from './hosts.js';

/** Browser/mobile connections use this Host's authenticated HTTP/WS tunnel.
 * Only saved connections are addressable. Local credentials never reach the peer. */
export function attachConnectionProxy(options: {
  app: Express;
  server: Server;
  settings: HostSshManager['settingsStore'];
  requireAuth: RequestHandler;
  authenticateUpgrade(request: IncomingMessage): Promise<boolean>;
  originAllowed(request: IncomingMessage): boolean | Promise<boolean>;
}) {
  const targets = new WeakMap<IncomingMessage, { target: string; path: string; headers: Record<string, string> }>();
  const sockets = new Set<Duplex>();
  const rememberSocket = (socket: Duplex) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const resolve = (request: IncomingMessage, id: string, rest: string) => {
    const host = readHostConnections(options.settings).hosts.find((host) => host.id === id);
    if (!host) throw new Error('Host connection was removed');
    const target = host.apiUrl ?? host.url;
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('This connection has no direct or SSH transport');
    const path = new URL(rest, 'http://path.local');
    path.searchParams.delete('varin_url_token');
    const headers = { ...host.requestHeaders, ...(host.clientToken ? { authorization: `Bearer ${host.clientToken}` } : {}), origin: url.origin };
    targets.set(request, { target, path: path.pathname + path.search, headers });
  };
  const applyHeaders = (proxyRequest: import('node:http').ClientRequest, request: IncomingMessage) => {
    proxyRequest.removeHeader('authorization');
    proxyRequest.removeHeader('cookie');
    for (const [name, value] of Object.entries(targets.get(request)!.headers)) proxyRequest.setHeader(name, value);
  };
  const proxy = createProxyMiddleware<IncomingMessage, ServerResponse>({
    changeOrigin: true,
    router: (request) => targets.get(request)!.target,
    pathRewrite: (_path, request) => targets.get(request)!.path,
    on: {
      proxyReq: (proxyRequest, request) => {
        applyHeaders(proxyRequest, request);
        fixRequestBody(proxyRequest, request as Request);
      },
      proxyReqWs: (proxyRequest, request) => applyHeaders(proxyRequest, request),
      proxyRes: (response) => { delete response.headers['set-cookie']; },
      open: rememberSocket,
      error: (_error, _request, response) => {
        if ('writeHead' in response) { response.writeHead(502); response.end('Host connection is unavailable'); }
        else response.destroy();
      },
    },
  });
  options.app.use('/api/connections/hosts/:id/proxy', options.requireAuth, (request, response, next) => {
    // URL tokens authorize the gateway, so mint them at its existing auth owner.
    if (request.path === '/auth/url-token') {
      request.url = '/auth/url-token';
      request.originalUrl = request.url;
      request.baseUrl = '';
      options.app(request, response);
      return;
    }
    try { resolve(request, String(request.params.id), request.url); }
    catch (error) { response.status(404).json({ error: error instanceof Error ? error.message : 'Unknown connection' }); return; }
    void proxy(request, response, next);
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/api\/connections\/hosts\/([^/]+)\/proxy(\/.*)$/u.exec(request.url ?? '');
    if (!match) return;
    rememberSocket(socket);
    void (async () => {
      if (!await options.authenticateUpgrade(request) || !await options.originAllowed(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      resolve(request, decodeURIComponent(match[1]!), match[2]!);
      await proxy.upgrade(request, socket as import('node:net').Socket, head);
    })().catch(() => socket.destroy());
  };
  options.server.on('upgrade', upgrade);
  return { stop: () => { options.server.off('upgrade', upgrade); for (const socket of sockets) socket.destroy(); sockets.clear(); } };
}
