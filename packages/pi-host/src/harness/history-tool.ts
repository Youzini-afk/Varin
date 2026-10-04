import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readHistoryPage } from "@varin/protocol";
import { projectSessionEntry } from "../protocol-projector.js";
import type { HostServicesBridge } from "./host-services-bridge.js";

const MAX_NEIGHBOURS = 20;
const MAX_MATCHES = 50;
const DEFAULT_LIMIT = 8;

const HistoryParams = Type.Object({
  run: Type.Optional(Type.String({ description: "An earlier Run of this same Thread. Omit for the current session. Never grants parent or sibling history access." })),
  query: Type.Optional(Type.String({
    description: "Case-insensitive substring matched against each entry's text.",
  })),
  path: Type.Optional(Type.String({
    description: "Restrict matches to entries whose text mentions this path fragment.",
  })),
  entry: Type.Optional(Type.String({
    description: "Entry id to read directly. Combine with before/after for neighbouring entries.",
  })),
  before: Type.Optional(Type.Integer({
    minimum: 0, maximum: MAX_NEIGHBOURS,
    description: "Entries before the target to include (with `entry`, default 0).",
  })),
  after: Type.Optional(Type.Integer({
    minimum: 0, maximum: MAX_NEIGHBOURS,
    description: "Entries after the target to include (with `entry`, default 0).",
  })),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Matching-entry offset for pagination. Use nextOffset from the previous result with the same query/path.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1, maximum: MAX_MATCHES,
    description: `Maximum matching entries to return (default ${DEFAULT_LIMIT}).`,
  })),
});

/** Original Pi entries remain the authority, including across fresh Runs. */
export function createHistoryTool(bridge?: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "history",
    label: "History",
    description: "Read raw session entries by keyword, path, or entry id with neighbours and pagination. "
      + "Use run to read a retained earlier Run of this same Thread; parent and sibling transcripts are not accessible.",
    promptSnippet: "history: read original entries from this session or an authorized earlier Run of the same Thread",
    promptGuidelines: [
      "run selects a retained earlier Run of this same Thread; entry ids belong to that selected transcript. Parent and sibling transcripts are not accessible.",
      "Images retain their original bytes. Output handles for large text are ephemeral; the history query can retrieve the retained entry again.",
    ],
    parameters: HistoryParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const { run, ...query } = params;
      if (run !== undefined) {
        if (!bridge) throw new Error("Previous-Run history is unavailable on this Host");
        return bridge.request("thread.history", { ...query, runId: run }, signal ? { signal } : undefined);
      }
      return readHistoryPage(ctx.sessionManager.getBranch().map(projectSessionEntry), query);
    },
  });
}
