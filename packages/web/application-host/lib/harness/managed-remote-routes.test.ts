import { createServer } from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import { registerManagedRemoteRoutes } from "./managed-remote-routes.js";
import type { ManagedRemoteExecutionService } from "./managed-remote-service.js";

describe("managed remote shell observation cancellation", () => {
  it.each(["exec", "read"])("releases a %s wait when its HTTP client disconnects", async (kind) => {
    let entered!: () => void;
    let cancelled!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const handlerCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
    const observe = async (signal: AbortSignal): Promise<never> => {
      entered();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      cancelled();
      throw new Error("observation cancelled");
    };
    const service = {
      hostId: "remote-host",
      shellExec: async (_principal: string, _input: unknown, signal: AbortSignal) => observe(signal),
      shellRead: async (_principal: string, _coordinator: string, _process: string,
        _offset: number, _length: number, _waitMs: number, signal: AbortSignal) => observe(signal),
    } as unknown as ManagedRemoteExecutionService;
    const app = express();
    app.use(express.json());
    registerManagedRemoteRoutes(app, {
      service,
      resolveAuthContext: async () => ({
        type: "client", clientId: "test-principal",
        client: { capabilities: ["filesystem:read", "filesystem:write", "logs:read", "terminal:use", "process:control"] } as never,
      }),
    });
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server has no TCP address");
      const controller = new AbortController();
      const path = kind === "exec"
        ? "/api/harness/managed-execution/v1/shell/exec"
        : "/api/harness/managed-execution/v1/shell/coordinator/process-1?waitMs=60000";
      const request = fetch(`http://127.0.0.1:${address.port}${path}`, {
        ...(kind === "exec" ? { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ coordinatorHostId: "coordinator", toolCallId: "call-1", command: "echo test", waitMs: 60_000 }) } : {}),
        signal: controller.signal,
      });
      await handlerEntered;
      controller.abort();
      await expect(request).rejects.toThrow();
      await handlerCancelled;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
