import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, Socket, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { attachServiceForward } from "./environment-forward-server.js";
import { createEnvironmentForwardRuntime } from "./environment-forwards.js";
import type { ManagedTarget } from "./managed-remote-client.js";

const servers: Array<HttpServer | TcpServer> = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const listen = async <S extends HttpServer | TcpServer>(server: S): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
};

const targetFor = (port: number, hostId = "target-h"): ManagedTarget => ({
  machineId: `managed:${hostId}`,
  hostId,
  connection: { id: "h1", label: "Target", apiUrl: `http://127.0.0.1:${port}`, requestHeaders: {}, source: "configured-host" },
  identity: { protocolVersion: 1 } as never,
});

describe("environment service forwards (real TCP over the Host↔Host channel)", () => {
  it("pipes bytes from a coordinator-loopback port onto the target machine's service", async () => {
    const echo = createTcpServer((socket: Socket) => {
      socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    });
    const servicePort = await listen(echo);
    const http = createHttpServer((_req, res) => { res.statusCode = 404; res.end(); });
    const httpPort = await listen(http);
    stops.push(attachServiceForward({
      server: http, hostId: "target-h",
      authenticate: async () => true, originAllowed: () => true,
    }).stop);

    const runtime = createEnvironmentForwardRuntime();
    stops.push(() => void runtime.dispose());
    const access = await runtime.open({ target: targetFor(httpPort), host: "127.0.0.1", port: servicePort, threadId: "t1" });
    expect(access.access.kind).toBe("forward");
    expect(access.service).toEqual({ machineId: "managed:target-h", host: "127.0.0.1", port: servicePort });

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      s.once("error", reject);
      s.connect(access.access.port, "127.0.0.1", () => resolve(s));
    });
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (chunk) => resolve(chunk.toString()));
      socket.write("hello");
    });
    expect(reply).toBe("echo:hello");
    socket.destroy();

    expect(runtime.list().map((entry) => entry.id)).toEqual([access.id]);
    expect(await runtime.close(access.id)).toBe(true);
    expect(runtime.list()).toEqual([]);
  });

  it("refuses to bridge when the upgrade receipt names a different Host", async () => {
    const service = createTcpServer((socket: Socket) => socket.on("data", (chunk) => socket.write(chunk)));
    const servicePort = await listen(service);
    const http = createHttpServer((_req, res) => { res.statusCode = 404; res.end(); });
    const httpPort = await listen(http);
    stops.push(attachServiceForward({
      server: http, hostId: "impostor",
      authenticate: async () => true, originAllowed: () => true,
    }).stop);

    const runtime = createEnvironmentForwardRuntime();
    stops.push(() => void runtime.dispose());
    const access = await runtime.open({ target: targetFor(httpPort, "target-h"), host: "127.0.0.1", port: servicePort, threadId: null });
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      s.once("error", reject);
      s.connect(access.access.port, "127.0.0.1", () => resolve(s));
    });
    const closed = await new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      socket.write("x");
      setTimeout(() => resolve(socket.destroyed), 750);
    });
    expect(closed).toBe(true);
  });

  it("authenticates upgrade requests on the target Host", async () => {
    const http = createHttpServer((_req, res) => { res.statusCode = 404; res.end(); });
    const httpPort = await listen(http);
    stops.push(attachServiceForward({
      server: http, hostId: "target-h",
      authenticate: async () => false, originAllowed: () => true,
    }).stop);
    const service = createTcpServer(() => undefined);
    const servicePort = await listen(service);

    const runtime = createEnvironmentForwardRuntime();
    stops.push(() => void runtime.dispose());
    const access = await runtime.open({ target: targetFor(httpPort), host: "127.0.0.1", port: servicePort, threadId: null });
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      s.once("error", reject);
      s.connect(access.access.port, "127.0.0.1", () => resolve(s));
    });
    const closed = await new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      setTimeout(() => resolve(socket.destroyed), 750);
    });
    expect(closed).toBe(true);
  });
});
