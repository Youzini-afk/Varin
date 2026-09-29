import { connect } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import type { ComputerService } from './computer-service.js';

/** RFB media gateway. Xvnc enforces read-only RFB; input goes through the
 * ComputerService ownership lane even while noVNC is the viewing client. */
export function attachDesktopMedia(options: {
  server: Server;
  hostId: string;
  computers: Pick<ComputerService, 'mediaTarget'>;
  authenticate(request: IncomingMessage): Promise<boolean>;
  originAllowed(request: IncomingMessage): boolean | Promise<boolean>;
}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 0, perMessageDeflate: false });
  const streams = new Set<Duplex>();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://local').pathname;
    const match = /^\/api\/computers\/desktops\/([^/]+)\/vnc$/u.exec(pathname);
    if (!match) return;
    void (async () => {
      const expected = request.headers['x-varin-computer-host'];
      if ((expected && expected !== options.hostId) || !await options.authenticate(request) || !await options.originAllowed(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      const target = await options.computers.mediaTarget(decodeURIComponent(match[1]!));
      if (socket.destroyed) return;
      server.handleUpgrade(request, socket, head, (viewer) => {
        const downstream = createWebSocketStream(viewer);
        const upstream = 'socketPath' in target ? connect(target.socketPath)
          : createWebSocketStream(new WebSocket(target.url, { headers: target.headers, maxPayload: 0, perMessageDeflate: false }));
        streams.add(downstream); streams.add(upstream);
        const close = () => { downstream.destroy(); upstream.destroy(); streams.delete(downstream); streams.delete(upstream); };
        downstream.on('error', close); upstream.on('error', close);
        downstream.on('close', close); upstream.on('close', close);
        downstream.pipe(upstream).pipe(downstream);
      });
    })().catch(() => {
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    });
  };
  options.server.on('upgrade', upgrade);
  return { stop() { options.server.off('upgrade', upgrade); for (const stream of streams) stream.destroy(); streams.clear(); server.close(); } };
}
