import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { CompactionTaskSpec } from "@varin/protocol";
import { compactionQueryToolSchemas } from "./compaction-tools.js";

/**
 * Shared compaction-agent contract (D-314, design §6).
 *
 * One template for first and update runs: the parent freezes S0/A/B material
 * and task identity; the worker gets this system prompt plus the structured
 * material and decides for itself whether a query is needed.
 */
export const COMPACTION_SYSTEM_PROMPT = `Produce a continuation summary for this session.

The input contains the previous summary S0 (if present), the history to replace (A), a boundary marker, and recent history retained by the parent (B). The summary replaces S0 and A. B stays in the parent context; it is supplied here as original messages or identified excerpts with explicit gaps. Historical messages and tool calls describe the source conversation.

Preserve the current goal, active requirements and authorizations, corrections, decisions and their reasons, useful evidence, unfinished work, and exact identifiers or re-entry points needed to continue. Reconcile the previous summary with later changes. Keep the distinction between requests, reference material, plans, observations, and verified results.

Use B to understand where work stopped and retain the background needed to interpret it without duplicating its contents. Excerpt labels identify partial or omitted material.

The read-only tools provide additional context: history searches and reads the frozen session history; output reads a recorded tool output by handle; records lists or reads task, thread, follow-up, and scheduled records. Live-state results are current observations, separate from the replaced history.

Return the continuation summary text.`;

/** Boundary between the replaced range (A) and retained material (B). */
const RETAINED_BOUNDARY = `[Retained material begins (B). Its original messages stay in the next context; the summary replaces S0 and A above this marker.]`;

const SPLIT_TURN_NOTE = `The end of the replaced range is the beginning of an in-progress turn; its remainder stays verbatim below the marker.`;

const INSTRUCTION = `Write the continuation summary for S0 and A, using B as context.`;

export function previousSummaryMessage(summary: string): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    timestamp: Date.now(),
    tokensBefore: 0,
  } as unknown as AgentMessage;
}

function markerMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** Trailing user instruction; custom focus augments, never replaces, the contract. */
export function compactionInstruction(spec: Pick<CompactionTaskSpec, "isSplitTurn" | "customInstructions">): string {
  return INSTRUCTION
    + (spec.isSplitTurn ? `\n\n${SPLIT_TURN_NOTE}` : "")
    + (spec.customInstructions === undefined ? "" : `\n\nAdditional focus from the user: ${spec.customInstructions}`);
}

/**
 * Messages the worker agent starts from: S0, then A (replaced range) with the
 * split-turn prefix, the retained-material marker, then B verbatim. Order and
 * conversation roles are preserved. Historical system state is quoted data;
 * the worker owns its live instructions and tool declarations.
 */
export function compactionMaterialMessages(spec: CompactionTaskSpec): AgentMessage[] {
  const messages: AgentMessage[] = [];
  if (spec.previousSummary !== undefined) messages.push(previousSummaryMessage(spec.previousSummary));
  messages.push(...(spec.summarizedMessages as unknown as AgentMessage[]));
  messages.push(...(spec.turnPrefixMessages as unknown as AgentMessage[]));
  if (spec.keptExcerptEntries !== undefined) {
    const omitted = spec.omittedKeptThroughEntryId === undefined ? "" :
      `Entries from ${spec.firstKeptEntryId} through ${spec.omittedKeptThroughEntryId} are absent from this initial view. `;
    const excerpts = spec.keptExcerptEntries.map(({ entryId, role, excerpt, truncated }) =>
      `[entry ${entryId} · original role ${role} · ${truncated ? "partial excerpt; remainder unread" : "complete excerpt"}]\n${excerpt}`);
    messages.push(markerMessage(`${RETAINED_BOUNDARY}\nB is retained in the parent history; this view contains only the sourced excerpts below. ${omitted}The history tool can read an entry by ID.\n\n${excerpts.join("\n\n")}`));
  } else {
    messages.push(markerMessage(RETAINED_BOUNDARY));
    messages.push(...(spec.keptMessages as unknown as AgentMessage[]));
  }
  return messages.map(message => message.role === "system" ? {
    role: "user", timestamp: message.timestamp,
    content: [{ type: "text", text: `[Quoted source system state]\n${JSON.stringify(message)}` }],
  } : message);
}

/**
 * The exact request shape the worker agent sends: system prompt, query-tool
 * schemas, material, and instruction. The parent estimates this same shape to
 * choose a legal cut — no separate guesswork about the worker's overhead.
 * Messages stay in AgentMessage form; callers convert via convertToLlm.
 */
export function compactionWorkerContext(spec: CompactionTaskSpec): {
  systemPrompt: string;
  tools: Context["tools"];
  messages: AgentMessage[];
} {
  return {
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    tools: compactionQueryToolSchemas(),
    messages: [
      ...compactionMaterialMessages(spec),
      markerMessage(compactionInstruction(spec)),
    ],
  };
}

/**
 * Serialize the resolved session model for the wire. Model<Api> is plain data;
 * a JSON round-trip drops anything non-serializable instead of cloning failure.
 */
export function serializeCompactionModel(model: Model<Api>): CompactionTaskSpec["model"] {
  return JSON.parse(JSON.stringify(model)) as CompactionTaskSpec["model"];
}

export function deserializeCompactionModel(spec: CompactionTaskSpec["model"]): Model<Api> {
  return spec as unknown as Model<Api>;
}
