import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { attachDesktopMedia } from './computer/desktop-media.js';
import { attachServiceForward } from './harness/environment-forward-server.js';
import { attachConnectionProxy } from './connections/host-proxy.js';
import { attachRealtimeProxy } from './realtime-proxy.js';
import { createDictationRuntime } from './dictation/runtime.js';

it.each(['desktop-media', 'service-forward', 'connection-proxy', 'realtime-proxy', 'dictation'] as const)(
  '%s refuses new upgrades and rechecks admission after authentication waits without starting the target', async kind => {
    const app = express();
    const server = createServer(app);
    let draining = true;
    let release!: () => void;
    let entered!: () => void;
    const authenticating = new Promise<void>(resolve => { entered = resolve; });
    const auth = vi.fn(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return true; });
    const target = vi.fn(async () => ({ socketPath: '/unused' }));
    const isDraining = () => draining;
    const rejectWebSocketUpgrade = (socket: import('node:stream').Duplex, status: number) => {
      socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\n\r\n`);
    };
    const owner = kind === 'desktop-media' ? attachDesktopMedia({ server, hostId: 'test', isDraining, computers: { mediaTarget: target }, authenticate: auth, originAllowed: () => true })
      : kind === 'service-forward' ? attachServiceForward({ server, hostId: 'test', isDraining, authenticate: auth, originAllowed: () => true })
      : kind === 'connection-proxy' ? attachConnectionProxy({ app, server, isDraining, settings: {} as never, requireAuth: (_req, _res, next) => next(),
        authenticateUpgrade: async () => { await auth(); return { type: 'session', token: 'fixture-session' }; }, originAllowed: () => true })
      : kind === 'realtime-proxy' ? attachRealtimeProxy({ app, server, isDraining, getDesktopRuntimeConfig: () => ({ apiBaseUrl: 'http://127.0.0.1:1' }),
        getUiAuthController: () => ({ ensureSessionToken: auth }), isRequestOriginAllowed: () => true })
      : createDictationRuntime({ app, server, express, isDraining, modelsDir: '/unused', uiAuthController: { enabled: true, ensureSessionToken: async () => { await auth(); return 'fixture-session'; } },
        isRequestOriginAllowed: () => true, rejectWebSocketUpgrade });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const paths = {
      'desktop-media': '/api/computers/desktops/test/vnc', 'service-forward': '/api/environment/forward?port=12345',
      'connection-proxy': '/api/connections/hosts/test/proxy/api/terminal/ws',
      'realtime-proxy': '/api/varin/realtime-proxy/ws?url=ws%3A%2F%2F127.0.0.1%3A1%2Fapi%2Fterminal%2Fws',
      dictation: '/api/dictation/ws',
    };
    const url = `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}${paths[kind]}`;
    const refused = () => {
      const socket = new WebSocket(url);
      socket.on('error', () => {});
      return new Promise<number>((resolve, reject) => {
        socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected upgrade')); });
        socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      });
    };
    try {
      expect(await refused()).toBe(503);
      expect(auth).not.toHaveBeenCalled();
      draining = false;
      const pending = refused();
      await authenticating;
      draining = true;
      release();
      expect(await pending).toBe(503);
      expect(target).not.toHaveBeenCalled();
    } finally {
      owner.stop(); server.closeAllConnections(); server.close(); await once(server, 'close');
    }
  },
);

it('an existing dictation socket rejects a new start while retaining ping and cancellation control', async () => {
  const app = express(), server = createServer(app);
  let draining = false;
  const runtime = createDictationRuntime({ app, server, express, isDraining: () => draining, modelsDir: '/unused',
    isRequestOriginAllowed: () => true, rejectWebSocketUpgrade: () => {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/dictation/ws`);
  try {
    const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
    draining = true;
    const refused = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', dictationId: 'new', format: 'pcm16' }));
    expect(JSON.parse(String((await refused)[0]))).toMatchObject({ type: 'error', reasonCode: 'host-draining' });
    socket.send(JSON.stringify({ type: 'cancel', dictationId: 'new' }));
    const pong = once(socket, 'message'); socket.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(String((await pong)[0]))).toEqual({ type: 'pong' });
  } finally {
    const closed = once(socket, 'close'); socket.terminate(); await closed;
    runtime.stop(); server.close(); await once(server, 'close');
  }
});
