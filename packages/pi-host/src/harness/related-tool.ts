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
    description: "Topology and resolved relations from the symbol graph: what a path or symbol defines, what it imports, who imports it, the other ends of its connection literals — and, for a symbol name, language-server-resolved reference sites and call edges (who calls it, what it calls). Resolution is bounded to the anchor's own definitions, so related is not a positional lsp.references replacement; sites marked [unpinned] came from the server's own file read, not a bound revision.",
    promptSnippet: "related: file-level topology plus resolved references/calls for a symbol name from the symbol graph",
    promptGuidelines: [
      "Graph ranges identify indexed locations. related resolves around the anchor's own definitions; references uses an exact file position. Unpinned sites come from the language server's file read.",
    ],
    parameters: RelatedParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"related.query">(
          "related.query",
          { anchor: params.anchor },
          ...(signal ? [{ signal }] : []),
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
