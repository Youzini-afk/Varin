import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { RecallSearchResult } from "@varin/protocol";

const RecallParams = Type.Object({
  query: Type.String(),
  k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

export function createRecallTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "recall",
    label: "Recall",
    description: "Search this workspace's memory of past sessions and decisions",
    promptSnippet: "recall: search this workspace's memory of past sessions and decisions",
    parameters: RecallParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"recall.search">("recall.search", {
          query: params.query,
          ...(params.k !== undefined ? { k: params.k } : {}),
        });
        const typed = result as RecallSearchResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: { count: typed.results.length, results: typed.results },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `recall failed: ${message}` }],
          details: { count: 0, results: [] },
        };
      }
    },
  });
}
