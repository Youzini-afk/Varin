import { connect } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";

/**
 * Target side of `environment.forward` (execution-environment design §8.2):
 * an authenticated coordinator Host upgrades to a WebSocket and this Host
 * bridges the stream onto a local TCP connection. The service's address is
 * resolved HERE — a remote loopback is never mistaken for the caller's own.
 *
 * The caller holds the same trust level as a managed-remote client (it can
 * already run shell commands on this machine), so `host` is unrestricted;
 * the recorded service descriptor keeps the address it actually dialed.
 */
export function attachServiceForward(options: {
  server: Server;
  hostId: string;
  authenticate(request: IncomingMessage): Promise<boolean>;
  originAllowed(request: IncomingMessage): boolean | Promise<boolean>;
}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 0, perMessageDeflate: false });
  const streams = new Set<Duplex>();
  server.on("headers", (headers) => {
    headers.push(`x-varin-managed-host: ${options.hostId}`);
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://local");
    if (url.pathname !== "/api/environment/forward") return;
    void (async () => {
      const expected = request.headers["x-varin-managed-host"];
      if ((expected && expected !== options.hostId) || !await options.authenticate(request) || !await options.originAllowed(request)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const port = Number(url.searchParams.get("port"));
      const host = url.searchParams.get("host")?.trim() || "127.0.0.1";
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !host) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      server.handleUpgrade(request, socket, head, (channel) => {
        const downstream = createWebSocketStream(channel);
        const upstream = connect({ host, port });
        streams.add(downstream);
        streams.add(upstream);
        const close = () => {
          downstream.destroy();
          upstream.destroy();
          streams.delete(downstream);
          streams.delete(upstream);
        };
        downstream.on("error", close);
        upstream.on("error", close);
        downstream.on("close", close);
        upstream.on("close", close);
        downstream.pipe(upstream).pipe(downstream);
      });
    })().catch(() => {
      if (!socket.destroyed) socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    });
  };
  options.server.on("upgrade", upgrade);
  return {
    stop() {
      options.server.off("upgrade", upgrade);
      for (const stream of streams) stream.destroy();
      streams.clear();
      server.close();
    },
  };
}
