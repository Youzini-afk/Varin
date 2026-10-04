import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { SearchContentResult } from "@varin/protocol";

const GrepParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  glob: Type.Optional(Type.Array(Type.String())),
  ignoreCase: Type.Optional(Type.Boolean()),
  fixedStrings: Type.Optional(Type.Boolean()),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  context: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

function formatSearchResult(result: SearchContentResult, pattern: string): string {
  if (result.status === "empty") {
    // searchedFiles is the kernel's real scanned count when present; absent
    // means the backend did not report one — never present a fabricated zero.
    const scanned = result.searchedFiles !== undefined ? ` (searched ${result.searchedFiles} files)` : "";
    return `0 hits — no matches in the requested scope${scanned}`;
  }
  if (result.status === "unavailable") {
    return `search unavailable`;
  }
  // ready
  const partialSuffix = result.partial ? " (partial result)" : "";
  const lines: string[] = [`${result.totalHits} hits in ${result.totalFiles} files for ${pattern}${partialSuffix}`, ""];

  for (const file of result.files) {
    lines.push(file.path);
    for (const hit of file.hits) {
      for (const before of hit.before) lines.push(`    ${before}`);
      lines.push(`  ${hit.line}: ${hit.text}`);
      for (const after of hit.after) lines.push(`    ${after}`);
    }
  }

  // If there are more hits than shown, add handle annotation
  const shownHits = result.files.reduce((sum, f) => sum + f.hits.length, 0);
  if (shownHits < result.totalHits && result.handle) {
    const remaining = result.totalHits - shownHits;
    const moreFiles = result.totalFiles - result.files.length;
    lines.push(`\n[${remaining} more hits in ${moreFiles} files — get_output({handle:"${result.handle}"}) or narrow with glob/path]`);
  }

  return lines.join("\n");
}

export function createGrepTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "grep",
    label: "Grep",
    description: "Search file contents with ripgrep semantics",
    promptSnippet: "grep: search file contents with ripgrep semantics",
    parameters: GrepParams,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("search.content", {
          pattern: params.pattern,
          ...(params.path !== undefined ? { path: params.path } : {}),
          ...(params.paths !== undefined ? { paths: params.paths } : {}),
          ...(params.glob !== undefined ? { glob: params.glob } : {}),
          ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
          ...(params.fixedStrings !== undefined ? { fixedStrings: params.fixedStrings } : {}),
          ...(params.before !== undefined ? { before: params.before } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.context !== undefined ? { context: params.context } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }, signal === undefined ? {} : { signal });
        const text = formatSearchResult(result, params.pattern);
        return {
          content: [{ type: "text", text }],
          details: { status: result.status, totalHits: result.totalHits, totalFiles: result.totalFiles, partial: result.partial },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `search failed: ${message}` }],
          details: { status: "unavailable", totalHits: 0, totalFiles: 0, partial: false },
        };
      }
    },
  });
}
