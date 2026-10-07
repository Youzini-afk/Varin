import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const RelatedParams = Type.Object({
  anchor: Type.String({
    description: "Workspace path or symbol / connection-literal name. For a symbol name, related also answers resolved reference sites and call edges when a language service has resolved them.",
  }),
});

export function createRelatedTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "related",
    label: "Related",
    description: "Find definitions, imports, connection endpoints, references and calls for a file path or symbol name.",
    promptSnippet: "related: file-level topology plus resolved references/calls for a symbol name from the symbol graph",
    promptGuidelines: [
      "Graph ranges identify indexed locations; [unpinned] locations have no bound file revision. references resolves references at an exact file position.",
    ],
    parameters: RelatedParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"related.query">(
          "related.query",
          { anchor: params.anchor },
          { ...(signal ? { signal } : {}), timeoutMs: 0 },
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            status: result.status,
            anchor: result.anchor,
            roles: result.roles,
            definitions: result.definitions,
            imports: result.imports,
            importers: result.importers,
            connections: result.connections,
            references: result.references,
            calls: result.calls,
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `related failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
