import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { toJsonValue } from "./json.js";
import { MCP_STATUS_CHANNEL } from "./pi-mcp-config-bridge.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

export const MCP_ADAPTER_STATUS_CHANNEL = "pi-mcp-adapter/status/v1";

const PUBLIC_STATE_CHANNELS = [MCP_ADAPTER_STATUS_CHANNEL] as const;

/**
 * Projects versioned, public extension snapshots into the Varin transport.
 * The producing extension remains the only owner of runtime state and behavior.
 */
export function createExtensionStateBridgeExtension(emit: EventEmitter): ExtensionFactory {
  return (pi) => {
    let sessionId: string | undefined;
    const unsubscribers = PUBLIC_STATE_CHANNELS.map((channel) => (
      pi.events.on(channel, (value) => {
        if (!sessionId) return;
        emit("extension.state", {
          channel: channel === MCP_ADAPTER_STATUS_CHANNEL ? MCP_STATUS_CHANNEL : channel,
          sessionId,
          value: toJsonValue(value),
        });
      })
    ));

    pi.on("session_start", (_event, context) => {
      sessionId = context.sessionManager.getSessionId();
    });

    pi.on("session_shutdown", () => {
      const closingSessionId = sessionId;
      sessionId = undefined;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      if (!closingSessionId) return;
      for (const channel of PUBLIC_STATE_CHANNELS) {
        emit("extension.state", {
          channel: channel === MCP_ADAPTER_STATUS_CHANNEL ? MCP_STATUS_CHANNEL : channel,
          sessionId: closingSessionId,
          value: null,
        });
      }
    });
  };
}
