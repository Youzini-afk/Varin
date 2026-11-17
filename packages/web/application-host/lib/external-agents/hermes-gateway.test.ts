import { it, expect, vi } from "vitest";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { connectHermesGateway } from "./hermes-gateway.js";
import type { createKernelProcessService } from "../kernel/process-service.js";

it("attaches without starting a daemon and closing one viewer preserves the shared Gateway", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varin-hermes-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const frames: boolean[] = [];
  gateway.on("connection", (socket) =>
    socket.on("message", (bytes, binary) => {
      frames.push(binary);
      socket.send(bytes.toString());
    }),
  );
  const address = gateway.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const spawn = vi.fn(async () => {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let done!: () => void;
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      exitConfirmed: false,
      exitCode: 0,
      completion: new Promise<void>((resolve) => {
        done = resolve;
      }),
      release: vi.fn(async () => {}),
    });
    setTimeout(() => {
      stdout.end(
        JSON.stringify({
          url: `ws://127.0.0.1:${address.port}`,
          protocol: "hermes-gateway-v1",
          protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.single-use"],
        }),
      );
      stderr.end();
      child.exitConfirmed = true;
      done();
    }, 0);
    return child;
  });
  const bridges: Awaited<ReturnType<typeof connectHermesGateway>>[] = [];
  const viewers: WebSocket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const bridge = await connectHermesGateway({
        spawn: spawn as unknown as ReturnType<
          typeof createKernelProcessService
        >["spawn"],
        command: "hermes",
        args: ["acp"],
        env: {},
        cwd: directory,
      });
      bridges.push(bridge);
      const viewer = new WebSocket(bridge.env.HERMES_TUI_GATEWAY_URL);
      viewers.push(viewer);
      await once(viewer, "open");
    }
    expect(
      spawn.mock.calls.every(
        (call) =>
          (call as unknown as [string, string[]])[1].join(" ") ===
          "gateway attach --json",
      ),
    ).toBe(true);
    viewers[0]!.close();
    await bridges[0]!.close();
    const reply = once(viewers[1]!, "message");
    viewers[1]!.send(
      JSON.stringify({ id: 1, method: "ping", params: { text: "中文" } }),
    );
    expect(JSON.parse(String((await reply)[0]))).toEqual({
      id: 1,
      method: "ping",
      params: { text: "中文" },
    });
    expect(frames).toEqual([false]);
  } finally {
    viewers.forEach((viewer) => viewer.terminate());
    await Promise.all(bridges.map((bridge) => bridge.close()));
    gateway.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
