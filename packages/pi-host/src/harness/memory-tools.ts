import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  MemoryCorrectResult,
  MemoryForgetResult,
  MemoryGetResult,
  MemoryItem,
  MemoryRememberResult,
  MemorySearchResult,
} from "@varin/protocol";

/**
 * Memory tool (BC1): one tool for the durable memory verbs — record, inspect,
 * correct, forget. All calls go through the Host's unified memory service, so
 * an agent write and a UI write share dedupe, supersede, and forgetting
 * semantics. Writes default to the calling session's owning scope (Bot memory
 * for Bot-owned sessions, workspace memory otherwise); `scope: "user"` opts
 * into the user-level store explicitly.
 */

const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("remember"),
    Type.Literal("get"),
    Type.Literal("search"),
    Type.Literal("correct"),
    Type.Literal("forget"),
  ]),
  /** remember/correct: the durable statement. */
  content: Type.Optional(Type.String()),
  sourceText: Type.Optional(Type.String({ description: "Exact source passage supporting remember/correct; omit when content is already a verbatim quote." })),
  sourceEntryId: Type.Optional(Type.String({ description: "Native conversation entry containing sourceText, when needed to disambiguate." })),
  includeSource: Type.Optional(Type.Boolean({ description: "get: read the original passages behind this memory." })),
  /** search: natural-language query against durable memory. */
  query: Type.Optional(Type.String()),
  /** search: requested result count (default 8). */
  k: Type.Optional(Type.Integer({ minimum: 1 })),
  /** remember/correct: when this memory applies. */
  trigger: Type.Optional(Type.String()),
  /** remember/correct: what kind of claim this is. */
  nature: Type.Optional(Type.Union([
    Type.Literal("experience"),
    Type.Literal("decision"),
    Type.Literal("preference"),
    Type.Literal("judgment"),
    Type.Literal("instruction"),
  ])),
  /** get/correct/forget: the memory row id. */
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Omit for the owning scope; "user" writes the user-level store. */
  scope: Type.Optional(Type.Union([
    Type.Literal("bot"),
    Type.Literal("workspace"),
    Type.Literal("user"),
    Type.Literal("session"),
  ])),
});

const errorResult = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? "failed";
  return {
    content: [{ type: "text" as const, text: `memory failed (${code}): ${message}` }],
    isError: true as const,
    details: { code },
  };
};

const describeItem = (item: MemoryItem): string => {
  const nature = item.nature ? ` ${item.nature}` : "";
  const state = item.invalidAt !== undefined ? " (retired)" : item.status === "suggested" ? " (suggested)" : "";
  return `#${item.id} [${item.scope}${nature}]${state} ${item.content}${item.trigger ? `\n  trigger: ${item.trigger}` : ""}`;
};

export function createMemoryTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "memory",
    label: "Memory",
    description: "Record, search, inspect, correct, or forget durable memory that persists across sessions",
    promptSnippet: "memory: record/search/inspect/correct/forget durable cross-session memory",
    promptGuidelines: [
      "Use memory remember when the user states a durable preference, a decision is made, or an outcome is worth keeping for future sessions.",
      "Use memory search for a natural-language lookup over durable memory; use memory get to inspect one id and its revision chain.",
      "For remember/correct, cite the exact supporting passage in sourceText when paraphrasing. This shares source coverage with background memory and makes forgetting effective. Use get with includeSource to read original evidence, including other native branches.",
      "Use memory correct to replace a memory that is wrong or stale; use memory forget when it should no longer apply.",
      "memory remember persists immediately — do not also call recall or wait for a review step.",
    ],
    parameters: MemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        switch (params.action) {
          case "remember": {
            if (!params.content?.trim()) {
              return errorResult(new HarnessRequestError("invalid-params", "remember requires content"));
            }
            const result = await bridge.request<"memory.remember">("memory.remember", {
              content: params.content,
              ...(params.sourceText !== undefined ? { sourceText: params.sourceText } : {}),
              ...(params.sourceEntryId !== undefined ? { sourceEntryId: params.sourceEntryId } : {}),
              ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
              ...(params.nature !== undefined ? { nature: params.nature } : {}),
              ...(params.scope !== undefined ? { scope: params.scope } : {}),
            }) as MemoryRememberResult;
            const item = result.item;
            return {
              content: [{ type: "text", text: result.created
                ? `remembered: ${item ? describeItem(item) : "stored"}`
                : `already remembered${item ? `: ${describeItem(item)}` : ""}` }],
              details: { created: result.created, duplicate: result.duplicate === true, id: item?.id },
            };
          }
          case "get": {
            if (params.id === undefined) {
              return errorResult(new HarnessRequestError("invalid-params", "get requires id"));
            }
            const result = await bridge.request<"memory.get">("memory.get", {
              id: params.id,
              ...(params.includeSource ? { includeSource: true } : {}),
              ...(params.scope !== undefined ? { scope: params.scope } : {}),
            }) as MemoryGetResult;
            if (!result.item) {
              return errorResult(new HarnessRequestError("invalid-params", `memory ${params.id} not found`));
            }
            const lines = [describeItem(result.item)];
            if (result.item.source) {
              const source = result.item.source;
              lines.push(`  source: ${source.kind}${source.sessionId ? ` session ${source.sessionId}` : ""}${source.threadId ? ` thread ${source.threadId}` : ""}`);
            }
            if (result.chain && result.chain.length > 1) {
              lines.push("", "revision chain:");
              for (const row of result.chain) lines.push(`  ${describeItem(row)}`);
            }
            for (const source of result.sources ?? []) {
              lines.push(`\nOriginal ${source.span.kind} ${source.span.id} (${source.status}):`, source.text ?? "Original source is no longer available at this revision.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { item: result.item, chain: result.chain ?? [], ...(result.sources ? { sources: result.sources } : {}) },
            };
          }
          case "search": {
            if (!params.query?.trim()) {
              return errorResult(new HarnessRequestError("invalid-params", "search requires a query"));
            }
            const result = await bridge.request<"memory.search">("memory.search", {
              query: params.query,
              ...(params.k !== undefined ? { k: params.k } : {}),
              ...(params.scope !== undefined ? { scope: params.scope } : {}),
            }) as MemorySearchResult;
            if (result.results.length === 0) {
              return {
                content: [{ type: "text", text: `no durable memory matches "${params.query}"` }],
                details: { count: 0, results: [] },
              };
            }
            return {
              content: [{ type: "text", text: result.results.map(({ item }) => describeItem(item)).join("\n") }],
              details: { count: result.results.length, results: result.results.map(({ item }) => item) },
            };
          }
          case "correct": {
            if (params.id === undefined || !params.content?.trim()) {
              return errorResult(new HarnessRequestError("invalid-params", "correct requires id and the corrected content"));
            }
            const result = await bridge.request<"memory.correct">("memory.correct", {
              id: params.id,
              content: params.content,
              ...(params.sourceText !== undefined ? { sourceText: params.sourceText } : {}),
              ...(params.sourceEntryId !== undefined ? { sourceEntryId: params.sourceEntryId } : {}),
              ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
              ...(params.nature !== undefined ? { nature: params.nature } : {}),
              ...(params.scope !== undefined ? { scope: params.scope } : {}),
            }) as MemoryCorrectResult;
            return {
              content: [{ type: "text", text: `memory ${params.id} corrected → #${result.id}` }],
              details: { corrected: result.corrected, id: result.id },
            };
          }
          case "forget": {
            if (params.id === undefined) {
              return errorResult(new HarnessRequestError("invalid-params", "forget requires id"));
            }
            const result = await bridge.request<"memory.forget">("memory.forget", {
              id: params.id,
              ...(params.scope !== undefined ? { scope: params.scope } : {}),
            }) as MemoryForgetResult;
            return {
              content: [{ type: "text", text: result.forgotten ? `memory ${params.id} forgotten` : `memory ${params.id} was not forgotten` }],
              details: { forgotten: result.forgotten },
            };
          }
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
