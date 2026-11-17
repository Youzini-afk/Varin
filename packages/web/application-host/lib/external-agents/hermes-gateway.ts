import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import WebSocket, { WebSocketServer, createWebSocketStream } from "ws";
import { ExternalAgentError } from "@varin/application-client";
import type { createKernelProcessService } from "../kernel/process-service.js";

/** Hermes' ACP viewer auto-starts a shared daemon when no explicit endpoint is
 * supplied. Attach through the official single-use ticket instead; the viewer's
 * native process tree must never own a daemon used by other conversations. */
export async function connectHermesGateway(input: {
  spawn: ReturnType<typeof createKernelProcessService>["spawn"];
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
}) {
  await mkdir(input.cwd, { recursive: true });
  const args =
    input.args.at(-1) === "acp" ? input.args.slice(0, -1) : input.args;
  const child = await input.spawn(
    input.command,
    [...args, "gateway", "attach", "--json"],
    {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  let output = "";
  const drained = finished(child.stdout, { cleanup: true });
  void drained.catch(() => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.resume();
  try {
    await child.completion;
    if (!child.exitConfirmed)
      throw new Error("Hermes discovery process exit is unconfirmed");
    await drained;
    input.signal?.throwIfAborted();
    if (child.exitCode !== 0)
      throw new ExternalAgentError(
        "gateway_unavailable",
        "Start Hermes Gateway on this execution device with “hermes gateway ensure”, then reconnect.",
      );
  } finally {
    if (child.exitConfirmed) await child.release();
  }
  let endpoint: { url?: string; protocol?: string; protocols?: string[] };
  try {
    endpoint = JSON.parse(output);
  } catch {
    throw new ExternalAgentError(
      "gateway_discovery",
      "Hermes Gateway discovery did not return JSON",
    );
  }
  if (
    !endpoint.url ||
    !Array.isArray(endpoint.protocols) ||
    !endpoint.protocols.length
  )
    throw new ExternalAgentError(
      "gateway_unavailable",
      "Hermes did not provide an attachable Gateway. Use a version supporting “gateway attach --json”.",
    );
  const route = `/${randomUUID()}`;
  // Consume the short-lived ticket before the ACP process performs its cold start.
  const upstream = new WebSocket(endpoint.url, endpoint.protocols);
  const outgoing = createWebSocketStream(upstream, {
    encoding: "utf8",
    decodeStrings: false,
  });
  outgoing.on("error", () => upstream.terminate());
  const abort = () => upstream.terminate();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once("open", resolve);
      upstream.once("error", reject);
    });
    if (endpoint.protocol && upstream.protocol !== endpoint.protocol)
      throw new Error("Hermes Gateway selected another protocol");
    input.signal?.throwIfAborted();
  } catch (error) {
    upstream.terminate();
    outgoing.destroy();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: route,
  });
  const sockets = new Set<WebSocket>([upstream]);
  let used = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    })());
  server.on("connection", (downstream) => {
    if (used) {
      downstream.close(1008);
      return;
    }
    used = true;
    sockets.add(downstream);
    const incoming = createWebSocketStream(downstream, {
      encoding: "utf8",
      decodeStrings: false,
    });
    // Stream backpressure applies in both directions; messages and tickets are not logged or stored.
    void Promise.all([
      pipeline(incoming, outgoing),
      pipeline(outgoing, incoming),
    ])
      .catch(() => {
        downstream.terminate();
        upstream.terminate();
      })
      .finally(() => {
        sockets.delete(downstream);
        sockets.delete(upstream);
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    upstream.terminate();
    outgoing.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Hermes local transport could not start");
  }
  if (input.signal?.aborted) {
    await close();
    input.signal.throwIfAborted();
  }
  return {
    env: {
      ...input.env,
      HERMES_TUI_GATEWAY_URL: `ws://127.0.0.1:${address.port}${route}`,
    },
    close,
  };
}
