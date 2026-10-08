import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessMethod, LspNavigationResult } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

const PositionParams = Type.Object({
  path: Type.String({ description: "File path selecting the language server and source document" }),
  line: Type.Integer({ minimum: 1, description: "One-based line number" }),
  character: Type.Optional(Type.Integer({ minimum: 1, description: "One-based character position; defaults to 1" })),
}, { additionalProperties: false });

const SymbolsParams = Type.Object({
  path: Type.String({ description: "An existing representative file for the language to query. This selects the language provider: use a .ts/.js source file for TypeScript/JavaScript symbols, not package.json. Not every provider supports workspace symbol search." }),
  query: Type.String({ description: "Symbol name or name fragment to search for in that language's workspace." }),
}, { additionalProperties: false });

const resultContent = (result: LspNavigationResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  ...(result.status === "unavailable" || result.status === "busy" ? { isError: true as const } : {}),
  details: {
    status: result.status,
    ...(result.value === undefined ? {} : { value: result.value }),
  },
});

const failedContent = (name: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("file resource is busy under lease")) {
    return resultContent({ status: "busy", text: "LSP busy: the file is in use. Retry this request." });
  }
  return {
    content: [{ type: "text" as const, text: `${name} unavailable: ${message}` }],
    isError: true as const,
    details: { status: "unavailable" },
  };
};

export function createLspNavigationTools(bridge: HostServicesBridge): ToolDefinition[] {
  const positionTool = (
    name: "definition" | "references" | "hover",
    method: Extract<HarnessMethod, "lsp.definition" | "lsp.references" | "lsp.hover">,
    description: string,
  ): ToolDefinition => defineTool({
    name,
    label: name[0]!.toUpperCase() + name.slice(1),
    description,
    promptSnippet: `${name}: ${description}`,
    parameters: PositionParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request(method, {
          path: params.path,
          line: params.line,
          ...(params.character === undefined ? {} : { character: params.character }),
        } as never, signal ? { signal } : {});
        return resultContent(result as LspNavigationResult);
      } catch (error) {
        return failedContent(name, error);
      }
    },
  });

  return [
    defineTool({
      name: "symbols",
      label: "Symbols",
      description: "Find workspace symbols through the language server selected by a representative file path.",
      promptSnippet: "symbols: find typed workspace symbols",
      parameters: SymbolsParams,
      executionMode: "parallel",
      execute: async (_toolCallId, params, signal) => {
        try {
          return resultContent(await bridge.request("lsp.symbols", { path: params.path, query: params.query }, signal ? { signal } : {}));
        } catch (error) {
          return failedContent("symbols", error);
        }
      },
    }),
    positionTool("definition", "lsp.definition", "Find the definition at a one-based file line and character."),
    positionTool("references", "lsp.references", "Find references at a one-based file line and character."),
    positionTool("hover", "lsp.hover", "Read type, signature, and documentation at a one-based file position."),
  ];
}
