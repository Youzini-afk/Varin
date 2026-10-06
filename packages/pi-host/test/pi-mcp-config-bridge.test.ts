import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createPiMcpConfigBridgeExtension,
  PI_MCP_RPC_READY_EVENT,
  PI_MCP_RPC_REPLY_PREFIX,
  PI_MCP_RPC_REQUEST_EVENT,
  PiMcpConfigBridge,
} from "../src/pi-mcp-config-bridge.js";

interface FakeExtensionRuntime {
  lifecycleHandlers: Map<string, (event: unknown, context: ExtensionContext) => unknown>;
  pi: ExtensionAPI;
}

function createFakeExtensionRuntime(): FakeExtensionRuntime {
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const events = {
    emit: (event: string, value: unknown) => {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(value);
    },
    on: (event: string, handler: (value: unknown) => void) => {
      const handlers = eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      return () => handlers.delete(handler);
    },
  };
  return {
    lifecycleHandlers,
    pi: {
      events,
      on: (event: string, handler: (value: unknown, context: ExtensionContext) => unknown) => {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

const context = (sessionId: string, cwd: string): ExtensionContext => ({
  cwd,
  sessionManager: { getSessionId: () => sessionId },
} as unknown as ExtensionContext);

const ready = (sessionId: string, cwd: string) => ({
  capabilities: { configCatalog: { readOnly: true, version: 1 } },
  methods: ["config.snapshot"],
  session: { cwd, sessionId },
  version: 1,
});

const emptyCatalog = {
  servers: [],
  sources: [],
  version: 1,
};

describe("pi-mcp-adapter config bridge", () => {
  it("saves a global server's project override without changing global configuration or dropping explicit defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "varin-native-mcp-override-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
    const globalPath = join(agentDir, "mcp.json");
    const projectPath = join(cwd, ".pi", "mcp.json");
    const global = JSON.stringify({ mcpServers: { docs: { command: "node", enabled: false, exposure: "direct" } } });
    writeFileSync(globalPath, global); writeFileSync(projectPath, '{"mcpServers":{}}');
    const bridge = new PiMcpConfigBridge();
    bridge.startSession("main", cwd);
    try {
      const options = bridge.nativeOptions(agentDir, () => {});
      const ctx = { ...context("main", cwd), isProjectTrusted: () => true };
      const loaded = await options.loadConfig!(ctx);
      const entry = loaded.servers.find(server => server.name === "docs")!;
      await options.updateConfig!({ ...entry, override: projectPath }, { enabled: true, exposure: "codemode" });
      assert.equal(readFileSync(globalPath, "utf8"), global);
      assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).mcpServers.docs, { enabled: true, exposure: "codemode" });
      const refreshed = await options.loadConfig!(ctx);
      assert.equal(refreshed.servers.find(server => server.name === "docs")?.config.enabled, true);
      assert.equal(refreshed.servers.find(server => server.name === "docs")?.override, projectPath);
    } finally { bridge.endSession(); rmSync(root, { recursive: true, force: true }); }
  });

  it("distinguishes unavailable from an authoritative empty catalog", async () => {
    const bridge = new PiMcpConfigBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiMcpConfigBridgeExtension(bridge)(runtime.pi);
    await runtime.lifecycleHandlers.get("session_start")?.({}, context("session-a", "/workspace/a"));
    assert.equal((await bridge.snapshot("session-a")).provider.state, "unavailable");

    runtime.pi.events.emit(PI_MCP_RPC_READY_EVENT, ready("session-a", "/workspace/a"));
    runtime.pi.events.on(PI_MCP_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_MCP_RPC_REPLY_PREFIX}${request.requestId}`, {
        data: { catalog: emptyCatalog },
        requestId: request.requestId,
        session: { cwd: "/workspace/a", sessionId: "session-a" },
        success: true,
        version: 1,
      });
    });
    assert.deepEqual(await bridge.snapshot("session-a"), {
      catalog: emptyCatalog,
      provider: { owner: "extension", bridgeVersion: 1, state: "active" },
    });
  });

  it("rejects mismatched ready state and malformed secret-bearing replies", async () => {
    const bridge = new PiMcpConfigBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiMcpConfigBridgeExtension(bridge)(runtime.pi);
    await runtime.lifecycleHandlers.get("session_start")?.({}, context("session-a", "/workspace/a"));
    runtime.pi.events.emit(PI_MCP_RPC_READY_EVENT, ready("session-other", "/workspace/a"));
    assert.equal((await bridge.snapshot("session-a")).provider.state, "incompatible");

    runtime.pi.events.emit(PI_MCP_RPC_READY_EVENT, ready("session-a", "/workspace/a"));
    runtime.pi.events.on(PI_MCP_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_MCP_RPC_REPLY_PREFIX}${request.requestId}`, {
        data: {
          catalog: {
            servers: [{
              disabled: false,
              name: "docs",
              sourceIds: [],
              transport: { kind: "http", url: "https://secret@example.test/mcp" },
            }],
            sources: [],
            version: 1,
          },
        },
        requestId: request.requestId,
        session: { cwd: "/workspace/a", sessionId: "session-a" },
        success: true,
        version: 1,
      });
    });
    const degraded = await bridge.snapshot("session-a");
    assert.equal(degraded.provider.state, "degraded");
    assert.match(degraded.provider.issue ?? "", /user information/);
    assert.equal(degraded.catalog, undefined);
  });

  it("degrades immediately when a compatible adapter does not reply and remains reusable", async () => {
    const bridge = new PiMcpConfigBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiMcpConfigBridgeExtension(bridge)(runtime.pi);
    await runtime.lifecycleHandlers.get("session_start")?.({}, context("session-a", "/workspace/a"));
    runtime.pi.events.emit(PI_MCP_RPC_READY_EVENT, ready("session-a", "/workspace/a"));

    const degraded = await bridge.snapshot("session-a");
    assert.equal(degraded.provider.state, "degraded");
    assert.match(degraded.provider.issue ?? "", /did not reply/);

    runtime.pi.events.on(PI_MCP_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_MCP_RPC_REPLY_PREFIX}${request.requestId}`, {
        data: { catalog: emptyCatalog },
        requestId: request.requestId,
        session: { cwd: "/workspace/a", sessionId: "session-a" },
        success: true,
        version: 1,
      });
    });
    assert.deepEqual(await bridge.snapshot("session-a"), {
      catalog: emptyCatalog,
      provider: { owner: "extension", bridgeVersion: 1, state: "active" },
    });
  });
});
