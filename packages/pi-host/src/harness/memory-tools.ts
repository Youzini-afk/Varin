import { Type, type TSchema } from "typebox";
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
  AgentPersonalizationContext,
} from "@varin/protocol";
import { renderAgentMemoryMutation } from '@varin/protocol';

/**
 * Memory tool (BC1): one tool for the durable memory verbs — record, inspect,
 * correct, forget. The Host selects the actual note/Bot authority. Ordinary
 * writes default to session scope; Bot writes default to their owning Bot.
 */

const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("remember", { description: "Add content to persistent memory" }),
    Type.Literal("get", { description: "Read the entry identified by id" }),
    Type.Literal("search", { description: "Find entries matching query; k selects the result count (default 8)" }),
    Type.Literal("correct", { description: "Replace the content of the entry identified by id" }),
    Type.Literal("forget", { description: "Remove the entry identified by id from active memory" }),
  ]),
  /** remember/correct: the durable statement. */
  content: Type.Optional(Type.String({ description: "remember/correct: text to save" })),
  sourceText: Type.Optional(Type.String({ description: "Exact source passage supporting remember/correct; omit when content is already a verbatim quote." })),
  sourceEntryId: Type.Optional(Type.String({ description: "Native conversation entry containing sourceText, when needed to disambiguate." })),
  includeSource: Type.Optional(Type.Boolean({ description: "get: read the original passages behind this memory." })),
  /** search: natural-language query against durable memory. */
  query: Type.Optional(Type.String({ description: "search: text to find" })),
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
  id: Type.Optional(Type.Integer({ minimum: 1, description: "get/correct/forget: existing memory id" })),
  /** Omit for the owning scope; "user" writes the user-level store. */
  scope: Type.Optional(Type.Union([
    Type.Literal("bot"),
    Type.Literal("workspace"),
    Type.Literal("user"),
    Type.Literal("session"),
  ])),
});

export function memoryToolPresentation(context: Pick<AgentPersonalizationContext, 'mode' | 'projectId'> & Partial<Pick<AgentPersonalizationContext, 'threadRole'>>) {
  const bot = context.mode === 'bot';
  const readOnly = context.threadRole === 'read-only';
  const properties: Record<string, TSchema> = { ...MemoryParams.properties };
  if (!bot) for (const key of ['sourceText', 'sourceEntryId', 'includeSource', 'trigger', 'nature']) delete properties[key];
  if (readOnly) {
    properties.action = Type.Union(MemoryParams.properties.action.anyOf.filter(action => ['get', 'search'].includes(action.const)));
    for (const key of ['content', 'sourceText', 'sourceEntryId', 'trigger', 'nature']) delete properties[key];
  }
  const scopes = bot ? ['bot', 'user', 'session'] : ['user', ...(context.projectId ? ['workspace'] : []), 'session'];
  properties.scope = Type.Optional(Type.Union(scopes.map(scope => Type.Literal(scope)), {
    description: bot ? 'Omitted/bot: this Bot; user: user memory; session: this conversation'
      : 'Omitted/session: this conversation; user: global notes' + (context.projectId ? '; workspace: this project’s notes, shared by its conversations' : ''),
  }));
  return {
    parameters: Type.Object(properties) as typeof MemoryParams,
    description: readOnly
      ? bot ? 'Inspect this Bot’s persistent memory with get(id) or search(query). get(includeSource=true) includes original sources and correction history.'
        : 'Inspect persistent global' + (context.projectId ? ', project' : '') + ' and conversation notes with get(id) or search(query).'
      : bot
      ? 'Manage persistent memory belonging to this Bot: remember, get, search, correct or forget. Writes commit immediately; related memories are retrieved on demand. sourceText binds a saved statement to its original passage; get(includeSource=true) reads sources and correction history.'
      : 'Manage persistent text notes: remember, get, search, correct or forget. Global notes apply across conversations' + (context.projectId ? '; project notes apply across this project’s conversations' : '') + '; session notes belong to this conversation. Omitted scope writes session notes. Writes save immediately.',
    promptSnippet: 'memory: ' + (readOnly ? 'inspect' : 'manage') + (bot ? ' this Bot’s persistent memory' : ' persistent global' + (context.projectId ? ', project' : '') + ' and conversation notes'),
    promptGuidelines: bot ? [
      readOnly ? 'search/recall retrieve relevant memories; get reads an entry and its revision chain.'
        : 'remember/correct/forget commit to the memory store immediately. correct creates a new accepted revision; get can read its revision chain. Memories are retrieved through search/recall.',
    ] : [
      'Applicable notes form a system memory snapshot and consume input context. Changes arrive through tool results or memory-change messages; the snapshot updates when context compaction commits. New conversations load current notes.'
        + (readOnly ? '' : ' remember returns an existing entry when text and scope are identical; correct replaces an entry in place; forget removes it.'),
    ],
  };
}

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
    ...memoryToolPresentation({ mode: 'agent' }),
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
              content: [{ type: "text", text: result.agentMemoryMutation
                ? `${result.created ? 'remembered' : 'already remembered'}:\n${renderAgentMemoryMutation(result.agentMemoryMutation)}`
                : (result.created
                ? `remembered: ${item ? describeItem(item) : "stored"}`
                : `already remembered${item ? `: ${describeItem(item)}` : ""}`) }],
              details: { created: result.created, duplicate: result.duplicate === true, id: item?.id,
                ...(result.agentMemoryMutation ? { agentMemoryMutation: result.agentMemoryMutation } : {}) },
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
              content: [{ type: "text", text: result.agentMemoryMutation
                ? `corrected:\n${renderAgentMemoryMutation(result.agentMemoryMutation)}`
                : `memory ${params.id} corrected → #${result.id}` }],
              details: { corrected: result.corrected, id: result.id,
                ...(result.agentMemoryMutation ? { agentMemoryMutation: result.agentMemoryMutation } : {}) },
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
              content: [{ type: "text", text: result.agentMemoryMutation ? `forgotten:\n${renderAgentMemoryMutation(result.agentMemoryMutation)}`
                : (result.forgotten ? `memory ${params.id} deleted; this entry is no longer active` : `memory ${params.id} was not forgotten`) }],
              details: { forgotten: result.forgotten,
                ...(result.agentMemoryMutation ? { agentMemoryMutation: result.agentMemoryMutation } : {}) },
            };
          }
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
