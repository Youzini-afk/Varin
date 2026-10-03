import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@varin/protocol";
import {
  createExtensionStateBridgeExtension,
  MCP_ADAPTER_STATUS_CHANNEL,
} from "../src/extension-state-bridge.js";
import { MCP_STATUS_CHANNEL } from "../src/pi-mcp-config-bridge.js";

describe("extension state bridge", () => {
  it("projects public snapshots for the active session and clears them on shutdown", async () => {
    const channelHandlers = new Map<string, (value: unknown) => void>();
    const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
    const events: Array<{ data: HostEventData<HostEvent>; event: HostEvent }> = [];
    const pi = {
      events: {
        emit: (channel: string, value: unknown) => channelHandlers.get(channel)?.(value),
        on: (channel: string, handler: (value: unknown) => void) => {
          channelHandlers.set(channel, handler);
          return () => channelHandlers.delete(channel);
        },
      },
      on: (event: string, handler: (value: unknown, context: ExtensionContext) => unknown) => {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    const factory = createExtensionStateBridgeExtension((event, data) => {
      events.push({ data, event });
    });
    await factory(pi);

    pi.events.emit(MCP_ADAPTER_STATUS_CHANNEL, { version: 1, servers: [] });
    assert.equal(events.length, 0);

    const context = {
      sessionManager: { getSessionId: () => "session-a" },
    } as unknown as ExtensionContext;
    await lifecycleHandlers.get("session_start")?.({}, context);
    pi.events.emit(MCP_ADAPTER_STATUS_CHANNEL, {
      connectedCount: 1,
      servers: [{ disabled: false, name: "docs", status: "connected", toolCount: 2 }],
      version: 1,
    });

    assert.deepEqual(events.at(-1), {
      event: "extension.state",
      data: {
        channel: MCP_STATUS_CHANNEL,
        sessionId: "session-a",
        value: {
          connectedCount: 1,
          servers: [{ disabled: false, name: "docs", status: "connected", toolCount: 2 }],
          version: 1,
        },
      },
    });

    await lifecycleHandlers.get("session_shutdown")?.({}, context);
    assert.deepEqual(events.at(-1), {
      event: "extension.state",
      data: {
        channel: MCP_STATUS_CHANNEL,
        sessionId: "session-a",
        value: null,
      },
    });
    const countAfterShutdown = events.length;
    pi.events.emit(MCP_ADAPTER_STATUS_CHANNEL, { version: 1 });
    assert.equal(events.length, countAfterShutdown);
  });
});
