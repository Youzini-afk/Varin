/**
 * Internal context compaction task (D-314) — the wire contract between the
 * owning session worker, the Host broker, and the dedicated compaction worker
 * subprocess. The parent session freezes the material and identity below; the
 * worker only interprets it and must not fill in or rewrite these fields.
 */

import type { JsonValue } from "./types.js";
import type { HistoryReadParams, HistoryReadResult } from "./harness-history.js";
import { resolveCompactionRecoverySettings, type CompactionRecoverySettings } from "./harness-settings.js";

/**
 * Serialized Pi model descriptor. `Model<Api>` is a plain data interface; the
 * worker resolves credentials through its own Pi runtime from agentDir.
 */
export type CompactionModelSpec = JsonValue;

/**
 * Frozen task identity and material for one compaction candidate.
 *
 * - `summarizedMessages` + `turnPrefixMessages` are the replaced range (A),
 *   in original role/order with tool-call/result pairing preserved.
 * - `keptMessages` is the retained recent original (B) when it fits. Otherwise
 *   `keptExcerptEntries` is a sourced, explicitly partial view of B; the full
 *   B remains in the parent history and can be read by entry id.
 * - `previousSummary` is the prior summary (S0) when present.
 */
export interface CompactionTaskSpec {
  /** Stable id shared by preparation, live progress, and the eventual commit. */
  taskId?: string;
  /** Fresh worker attempt for this task, starting at one. */
  attempt?: number;
  /** Owning session id; must equal the requesting actor's session. */
  sessionId: string;
  /** Resolved parent trust, including a one-session grant not saved on disk. */
  projectTrusted: boolean;
  /** Entry id of the compaction bounding the summarized range, or null. */
  boundaryCompactionId: string | null;
  /** First entry covered by the summary, or null. */
  firstSummarizedEntryId: string | null;
  /** Last entry covered by the summary. */
  lastSummarizedEntryId: string;
  /** First entry retained verbatim after the summary. */
  firstKeptEntryId: string;
  /** Branch leaf at freeze time; bounds retained material and history reads. */
  fixedLeafEntryId: string;
  /** The cut lands inside an in-progress turn. */
  isSplitTurn: boolean;
  /** Serialized Pi AgentMessage list being replaced (A body). */
  summarizedMessages: JsonValue[];
  /** Split-turn prefix messages; part of the replaced range, kept verbatim tail. */
  turnPrefixMessages: JsonValue[];
  /** Serialized Pi AgentMessage list retained verbatim (B). */
  keptMessages: JsonValue[];
  /** Partial B references, each attributed to its original entry and role. */
  keptExcerptEntries?: { entryId: string; role: string; excerpt: string; truncated: boolean }[];
  /** Last B entry wholly absent from the excerpts; from firstKeptEntryId. */
  omittedKeptThroughEntryId?: string;
  /** Prior summary text (S0). */
  previousSummary?: string;
  /** Session's resolved model at freeze time. */
  model: CompactionModelSpec;
  /** Frozen stall and retry policy for this preparation. */
  recovery?: CompactionRecoverySettings;
  /** Serialized subset of the parent request's stream options. */
  options: {
    cacheRetention?: string;
    maxTokens: number;
    reasoning?: string;
    samplingParams?: Record<string, JsonValue>;
    sessionId?: string;
    temperature?: number;
    thinkingBudgets?: Record<string, JsonValue>;
    transport?: string;
  };
  /** Manual compaction emphasis; never replaces the base responsibilities. */
  customInstructions?: string;
}

export interface CompactionRunResult {
  summary: string;
  usage?: JsonValue;
  /** Number of query tool calls the worker issued; observational only. */
  queries: number;
  /** Read-only worker conversation, persisted with the committed Pi compaction entry. */
  trace?: CompactionTrace;
}

export interface CompactionTraceEntry {
  kind: "assistant" | "tool-call" | "tool-result";
  at: number;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  args?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}

export interface CompactionTrace {
  taskId: string;
  entries: CompactionTraceEntry[];
}

export type CompactionTraceUpdate = {
  sessionId: string;
  taskId: string;
} & (
  | { type: "requested"; manual: true; phase: "preparing" | "ready" }
  | { type: "started" }
  | { type: "retrying"; attempt: number; maxAttempts: number; reason: string }
  | { type: "delta"; channel: "text" | "thinking"; delta: string }
  | { type: "entry"; entry: CompactionTraceEntry }
  | { type: "finished" }
  | { type: "committed" }
  | { type: "failed"; message: string }
) & { attempt?: number };

export type CompactionHistoryParams = HistoryReadParams;
export type CompactionHistoryResult = HistoryReadResult;

/**
 * The only harness methods a compaction worker's auxiliary actor may call:
 * read-only history/output/record queries. The Host router enforces this
 * allowlist through `HarnessActorContext.allowedMethods`.
 */
export const COMPACTION_QUERY_METHODS = [
  "compaction.history",
  "output.read",
  "thread.list",
  "thread.read",
  "experiment.list",
  "experiment.get",
  "experiment.logs",
  "experiment.artifact",
  "followup.list",
  "followup.get",
  "schedule.list",
  "schedule.get",
  "schedule.status",
] as const;

/** Capability categories covering COMPACTION_QUERY_METHODS (both gates apply). */
export const COMPACTION_QUERY_CAPABILITIES = [
  "context.session",
  "read.output",
  "control.thread",
  "read.experiment",
  "read.followup",
  "read.schedule",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`compaction task requires a non-empty string: ${key}`);
  }
  return value;
};

const readNullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`compaction task ${key} must be a string or null`);
  return value;
};

const readMessageList = (record: Record<string, unknown>, key: string): JsonValue[] => {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`compaction task ${key} must be an array`);
  for (const message of value) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error(`compaction task ${key} must contain serialized messages with a role`);
    }
  }
  return value as JsonValue[];
};

const readExcerptEntries = (value: unknown): NonNullable<CompactionTaskSpec["keptExcerptEntries"]> => {
  if (!Array.isArray(value)) throw new Error("compaction task keptExcerptEntries must be an array");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.excerpt !== "string" || typeof item.truncated !== "boolean") {
      throw new Error("compaction task keptExcerptEntries requires an excerpt and truncation state");
    }
    return { entryId: readString(item, "entryId"), role: readString(item, "role"),
      excerpt: item.excerpt, truncated: item.truncated };
  });
};

/** Runtime validation for the worker-facing task spec (defense at the seam). */
export function readCompactionTaskSpec(value: unknown): CompactionTaskSpec {
  if (!isRecord(value)) throw new Error("compaction task params must be an object");
  if (typeof value.projectTrusted !== "boolean") throw new Error("compaction task requires projectTrusted");
  const options = value.options;
  if (!isRecord(options)) throw new Error("compaction task requires options");
  const maxTokens = options.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("compaction task options.maxTokens must be a positive number");
  }
  if (!isRecord(value.model)) throw new Error("compaction task requires a model spec");
  return {
    ...(value.taskId === undefined ? {} : { taskId: readString(value, "taskId") }),
    ...(value.attempt === undefined ? {} : { attempt: (() => {
      if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) {
        throw new Error("compaction task attempt must be a positive integer");
      }
      return Number(value.attempt);
    })() }),
    sessionId: readString(value, "sessionId"),
    projectTrusted: value.projectTrusted,
    boundaryCompactionId: readNullableString(value, "boundaryCompactionId"),
    firstSummarizedEntryId: readNullableString(value, "firstSummarizedEntryId"),
    lastSummarizedEntryId: readString(value, "lastSummarizedEntryId"),
    firstKeptEntryId: readString(value, "firstKeptEntryId"),
    fixedLeafEntryId: readString(value, "fixedLeafEntryId"),
    isSplitTurn: value.isSplitTurn === true,
    summarizedMessages: readMessageList(value, "summarizedMessages"),
    turnPrefixMessages: readMessageList(value, "turnPrefixMessages"),
    keptMessages: readMessageList(value, "keptMessages"),
    ...(value.keptExcerptEntries === undefined
      ? {}
      : { keptExcerptEntries: readExcerptEntries(value.keptExcerptEntries) }),
    ...(value.omittedKeptThroughEntryId === undefined
      ? {}
      : { omittedKeptThroughEntryId: readString(value, "omittedKeptThroughEntryId") }),
    ...(value.previousSummary === undefined
      ? {}
      : { previousSummary: readString(value, "previousSummary") }),
    model: value.model as CompactionModelSpec,
    ...(value.recovery === undefined ? {} : { recovery: resolveCompactionRecoverySettings(value.recovery) }),
    options: {
      maxTokens,
      ...(options.reasoning === undefined ? {} : { reasoning: String(options.reasoning) }),
      ...(options.temperature === undefined ? {} : { temperature: Number(options.temperature) }),
      ...(options.transport === undefined ? {} : { transport: String(options.transport) }),
      ...(options.cacheRetention === undefined ? {} : { cacheRetention: String(options.cacheRetention) }),
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      ...(isRecord(options.samplingParams) ? { samplingParams: options.samplingParams as Record<string, JsonValue> } : {}),
      ...(isRecord(options.thinkingBudgets) ? { thinkingBudgets: options.thinkingBudgets as Record<string, JsonValue> } : {}),
    },
    ...(value.customInstructions === undefined
      ? {}
      : { customInstructions: readString(value, "customInstructions") }),
  };
}
