import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { createSettingsFileStore } from '@varin/settings-store';
import { createRuntimeUrlResolver } from '@varin/application-client';
import { attachConnectionProxy } from './host-proxy.js';
import { writeHostConnections } from './hosts.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const stop of cleanup.reverse()) await stop(); cleanup.length = 0; });
const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
};

describe('Host connection gateway', () => {
  it('serves HTTP bodies, local token minting and authenticated WebSockets through the saved connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'varin-connection-'));
    cleanup.push(async () => { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid fixture path'); await rm(dir, { recursive: true, force: true }); });
    const settings = createSettingsFileStore({ filePath: join(dir, 'settings.json') });
    const peerApp = express();
    peerApp.use(express.json());
    peerApp.post('/api/echo', (request, response) => response.set('Set-Cookie', 'peer=secret').json({
      body: request.body, authorization: request.headers.authorization, cookie: request.headers.cookie ?? null, url: request.url,
    }));
    const peer = createServer(peerApp);
    const peerUrl = await listen(peer);
    const upstreamWs = new WebSocketServer({ server: peer });
    cleanup.push(() => { for (const client of upstreamWs.clients) client.terminate(); upstreamWs.close(); });
    upstreamWs.on('connection', (socket, request) => socket.on('message', (data) => socket.send(JSON.stringify({
      data: data.toString(), authorization: request.headers.authorization, cookie: request.headers.cookie ?? null, url: request.url,
    }))));
    await writeHostConnections(settings, { hosts: [{ id: 'remote', label: 'Remote', url: peerUrl, clientToken: 'peer-token' }], defaultHostId: 'remote' });
    const app = express();
    app.use(express.json());
    app.post('/auth/url-token', (_request, response) => response.json({ token: 'local-url-token' }));
    const server = createServer(app);
    const gatewayUrl = await listen(server);
    const gateway = attachConnectionProxy({ app, server, settings,
      requireAuth: (request, response, next) => request.headers.authorization === 'Bearer local-token' ? next() : void response.sendStatus(401),
      authenticateUpgrade: async (request) => new URL(request.url!, gatewayUrl).searchParams.get('varin_url_token') === 'local-url-token',
      originAllowed: () => true,
    });
    cleanup.push(gateway.stop);
    const base = `${gatewayUrl}/api/connections/hosts/remote/proxy`;
    const resolver = createRuntimeUrlResolver({ apiBaseUrl: base });
    expect(resolver.api('/api/echo')).toBe(`${base}/api/echo`);
    const response = await fetch(resolver.api('/api/echo?varin_url_token=local-url-token'), {
      method: 'POST', headers: { authorization: 'Bearer local-token', cookie: 'local=private', 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ body: { text: '你好' }, authorization: 'Bearer peer-token', cookie: null, url: '/api/echo' });
    expect((await fetch(`${base}/api/echo`, { method: 'POST' })).status).toBe(401);
    expect(await (await fetch(`${base}/auth/url-token`, { method: 'POST', headers: { authorization: 'Bearer local-token' } })).json()).toEqual({ token: 'local-url-token' });
    const socket = new WebSocket(`${resolver.websocket('/api/varin/runtime/ws')}?varin_url_token=local-url-token`, { headers: { cookie: 'local=private' } });
    cleanup.push(() => socket.terminate());
    await once(socket, 'open');
    socket.send('native session');
    const [data] = await once(socket, 'message');
    expect(JSON.parse(String(data))).toEqual({ data: 'native session', authorization: 'Bearer peer-token', cookie: null, url: '/api/varin/runtime/ws' });
  });
});
