import { afterEach, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { attachDesktopMedia } from './desktop-media.js';

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

it('bridges binary media with authenticated Host identity and leaves the desktop server alive after a viewer closes', async () => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\varin-media-${randomUUID()}` : join(tmpdir(), `varin-${randomUUID()}.sock`);
  const desktop = createSocketServer((socket) => socket.pipe(socket));
  desktop.listen(socketPath); await once(desktop, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => desktop.close(() => resolve())));
  const host = createHttpServer();
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => host.close(() => resolve())));
  let resolutions = 0;
  const media = attachDesktopMedia({ server: host, hostId: 'owner', computers: { mediaTarget: async () => { resolutions++; return { socketPath }; } },
    authenticate: async (request) => request.headers.authorization === 'Bearer viewer-token', originAllowed: () => true });
  cleanups.push(media.stop);
  const url = `ws://127.0.0.1:${(host.address() as import('node:net').AddressInfo).port}/api/computers/desktops/managed-linux/vnc`;
  for (let i = 0; i < 2; i++) {
    const viewer = new WebSocket(url, { headers: { Authorization: 'Bearer viewer-token', 'X-Varin-Computer-Host': 'owner' } });
    cleanups.push(() => viewer.terminate());
    await once(viewer, 'open');
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    viewer.send(bytes);
    const [received, binary] = await once(viewer, 'message');
    expect(binary).toBe(true); expect(received).toEqual(bytes);
    viewer.close(); await once(viewer, 'close');
  }
  expect(resolutions).toBe(2);
  const denied = new WebSocket(url, { headers: { Authorization: 'Bearer viewer-token', 'X-Varin-Computer-Host': 'another-host' } });
  denied.on('error', () => {});
  const deniedStatus = new Promise<number>((resolve) => denied.once('unexpected-response', (_request, response) => {
    response.resume(); denied.terminate(); resolve(response.statusCode!);
  }));
  expect(await deniedStatus).toBe(401);
  expect(resolutions).toBe(2);
});
