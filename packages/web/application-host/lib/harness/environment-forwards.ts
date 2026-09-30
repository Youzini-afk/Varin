import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket, createWebSocketStream } from "ws";
import type { Duplex } from "node:stream";
import type { EnvironmentServiceAccess } from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";
import type { ManagedTarget } from "./managed-remote-client.js";

/**
 * Coordinator side of `environment.forward` (execution-environment §8.2).
 * Each forward is a live loopback listener on this Host; every accepted
 * socket opens an authenticated WebSocket to the target Host's
 * `/api/environment/forward` endpoint, which bridges onto the service's own
 * address on that machine. Handles are in-memory by design — a forward dies
 * with this Host and is never reported as durable or synced.
 */
export interface EnvironmentForwardRuntime {
  open(input: {
    target: ManagedTarget;
    host: string;
    port: number;
    threadId: string | null;
    sessionId?: string;
    signal?: AbortSignal;
    webSocket?: typeof WebSocket;
  }): Promise<EnvironmentServiceAccess>;
  list(sessionId?: string): EnvironmentServiceAccess[];
  close(id: string, sessionId?: string): Promise<boolean>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface LiveForward {
  access: EnvironmentServiceAccess;
  listener: Server;
  sockets: Set<Duplex>;
  channels: Set<WebSocket>;
  sessionId: string;
}

const wsUrlFor = (target: ManagedTarget, host: string, port: number): string => {
  const apiUrl = new URL(target.connection.apiUrl.replace(/\/$/, "") + "/");
  const url = new URL("/api/environment/forward", apiUrl);
  url.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("host", host);
  url.searchParams.set("port", String(port));
  return url.toString();
};

export function createEnvironmentForwardRuntime(): EnvironmentForwardRuntime {
  const live = new Map<string, LiveForward>();
  const generations = new Map<string, number>();
  let disposed = false;

  const stop = async (entry: LiveForward): Promise<void> => {
    for (const channel of entry.channels) channel.terminate();
    for (const socket of entry.sockets) socket.destroy();
    entry.channels.clear();
    entry.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!entry.listener.listening) { resolve(); return; }
      entry.listener.close(() => resolve());
    });
  };

  const open: EnvironmentForwardRuntime["open"] = async ({ target, host, port, threadId, sessionId = "", signal, webSocket }) => {
    signal?.throwIfAborted();
    if (disposed) throw new HarnessServiceError("unavailable", "Environment forwarding is closed");
    const generation = generations.get(sessionId) ?? 0;
    const SocketImpl = webSocket ?? WebSocket;
    const sockets = new Set<Duplex>();
    const channels = new Set<WebSocket>();
    const listener = createServer((socket) => {
      const channel = new SocketImpl(wsUrlFor(target, host, port), {
        headers: {
          ...target.connection.requestHeaders,
          ...(target.connection.clientToken ? { authorization: `Bearer ${target.connection.clientToken}` } : {}),
          "x-varin-managed-host": target.hostId,
        },
        maxPayload: 0,
        perMessageDeflate: false,
      });
      channels.add(channel);
      channel.once("close", () => { channels.delete(channel); socket.destroy(); });
      const drop = () => { socket.destroy(); channel.terminate(); };
      socket.once("close", () => { channels.delete(channel); channel.terminate(); });
      socket.once("error", drop);
      channel.once("error", drop);
      channel.once("unexpected-response", (request, response) => { response.resume(); request.destroy(); drop(); });
      // Trust only the target Host this forward was created for: the upgrade
      // receipt carries its managed-host identity before any byte is bridged.
      channel.once("upgrade", (response) => {
        if (response.headers["x-varin-managed-host"] !== target.hostId) {
          channel.terminate();
          socket.destroy();
          return;
        }
        const stream = createWebSocketStream(channel);
        socket.pipe(stream).pipe(socket);
        stream.on("error", drop);
        stream.on("close", () => socket.destroy());
        socket.on("close", () => { stream.destroy(); channel.close(); });
      });
    });

    const close = async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        if (!listener.listening) { resolve(); return; }
        listener.close(() => resolve());
      });
    };
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    if (disposed || signal?.aborted || (generations.get(sessionId) ?? 0) !== generation) {
      for (const channel of channels) channel.terminate();
      await close();
      signal?.throwIfAborted();
      throw new HarnessServiceError("unavailable", "The session closed while opening its service forward");
    }
    const address = listener.address();
    if (!address || typeof address === "string") {
      await close();
      throw new HarnessServiceError("unavailable", "Service forward listener returned no address");
    }
    const access: EnvironmentServiceAccess = {
      id: `envfwd:${randomUUID()}`,
      service: { machineId: target.machineId, host, port },
      access: { kind: "forward", machineId: "local", host: "127.0.0.1", port: address.port, url: `http://127.0.0.1:${address.port}` },
      threadId,
      createdAt: new Date().toISOString(),
    };
    live.set(access.id, { access, listener, sockets, channels, sessionId });
    listener.once("close", () => { if (live.get(access.id)?.listener === listener) live.delete(access.id); });
    return access;
  };

  return {
    open,
    list: (sessionId) => [...live.values()].filter((entry) => sessionId === undefined || entry.sessionId === sessionId).map((entry) => entry.access),
    close: async (id, sessionId) => {
      const entry = live.get(id);
      if (!entry || (sessionId !== undefined && entry.sessionId !== sessionId)) return false;
      live.delete(id);
      await stop(entry);
      return true;
    },
    closeSession: async (sessionId) => {
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
      const entries = [...live.entries()].filter(([, entry]) => entry.sessionId === sessionId);
      for (const [id] of entries) live.delete(id);
      await Promise.all(entries.map(([, entry]) => stop(entry)));
    },
    dispose: async () => {
      disposed = true;
      const entries = [...live.values()];
      live.clear();
      await Promise.all(entries.map(stop));
    },
  };
}
