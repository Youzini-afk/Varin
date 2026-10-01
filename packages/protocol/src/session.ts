import type { JsonValue, SessionSnapshot, SessionStats, ThinkingLevel } from "./types.js";

export const VARIN_RECOVERY_NAVIGATION_MARKER_SCHEMA_VERSION = 1 as const;
export const VARIN_RECOVERY_NAVIGATION_MARKER_TYPE = "varin.recovery.navigation/v1";

export interface PiRecoveryNavigationMarkerData {
  expectedLeafId: string | null;
  operationId: string;
  schemaVersion: typeof VARIN_RECOVERY_NAVIGATION_MARKER_SCHEMA_VERSION;
  targetId: string | null;
  targetLeafId: string | null;
}

export interface PiUsageCost {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

export interface PiUsage {
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cost: PiUsageCost;
  input: number;
  output: number;
  reasoning?: number;
  totalTokens: number;
}

export interface PiTextContent {
  text: string;
  type: "text";
}

export interface PiImageContent {
  data: string;
  mimeType: string;
  type: "image";
}

export interface PiThinkingContent {
  redacted?: boolean;
  thinking: string;
  type: "thinking";
}

export interface PiToolCall {
  arguments: JsonValue;
  id: string;
  name: string;
  type: "toolCall";
}

export type PiUserContent = PiTextContent | PiImageContent;

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;

export interface PiUserMessage {
  content: string | PiUserContent[];
  role: "user";
  timestamp: number;
}

export interface PiSystemMessage {
  role: "system";
  content: string | PiTextContent[];
  timestamp: number;
  sections?: Record<string, string | null>;
  toolsAdded?: JsonValue;
  toolsRemoved?: Array<{ name: string }>;
}

export interface PiAssistantMessage {
  api: string;
  content: PiAssistantContent[];
  errorMessage?: string;
  model: string;
  provider: string;
  rawStopReason?: string;
  responseModel?: string;
  thinkingLevel?: string;
  role: "assistant";
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  timestamp: number;
  usage: PiUsage;
}

export interface PiToolResultMessage {
  nestedCalls?: {
    calls: Array<{ id: string; name: string; arguments?: JsonValue; argumentsBytes?: number;
      status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }>;
    complete: boolean;
  };
  content: PiUserContent[];
  details?: JsonValue;
  isError: boolean;
  role: "toolResult";
  timestamp: number;
  toolCallId: string;
  toolName: string;
  usage?: PiUsage;
}

export interface PiBashExecutionMessage {
  cancelled: boolean;
  command: string;
  excludeFromContext?: boolean;
  exitCode?: number;
  fullOutputPath?: string;
  output: string;
  role: "bashExecution";
  timestamp: number;
  truncated: boolean;
}

export interface PiCustomMessage {
  content: string | PiUserContent[];
  customType: string;
  details?: JsonValue;
  display: boolean;
  role: "custom";
  timestamp: number;
}

export interface PiBranchSummaryMessage {
  fromId: string | null;
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface PiCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  timestamp: number;
  tokensBefore: number;
}

export interface PiUnknownMessage {
  data: JsonValue;
  originalRole: string;
  role: "unknown";
  timestamp?: number;
}

export type PiMessage =
  | PiSystemMessage
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomMessage
  | PiBranchSummaryMessage
  | PiCompactionSummaryMessage
  | PiUnknownMessage;

export interface PiSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface PiSessionMessageEntry extends PiSessionEntryBase {
  message: PiMessage;
  type: "message";
}

export interface PiContextEditEntry extends PiSessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: JsonValue } | null;
}

export interface PiUsageEntry extends PiSessionEntryBase {
  type: "usage";
  kind: string;
  provider: string;
  model: string;
  usage: PiUsage;
  note?: string;
}

export interface PiThinkingLevelChangeEntry extends PiSessionEntryBase {
  thinkingLevel: string;
  type: "thinking_level_change";
}

export interface PiModelChangeEntry extends PiSessionEntryBase {
  modelId: string;
  provider: string;
  type: "model_change";
}

export interface PiCompactionEntry extends PiSessionEntryBase {
  details?: JsonValue;
  firstKeptEntryId: string;
  fromHook?: boolean;
  summary: string;
  tokensBefore: number;
  type: "compaction";
  usage?: PiUsage;
}

export interface PiBranchSummaryEntry extends PiSessionEntryBase {
  details?: JsonValue;
  fromHook?: boolean;
  fromId: string;
  summary: string;
  type: "branch_summary";
  usage?: PiUsage;
}

export interface PiCustomEntry extends PiSessionEntryBase {
  customType: string;
  data?: JsonValue;
  type: "custom";
}

export interface PiCustomMessageEntry extends PiSessionEntryBase {
  content: string | PiUserContent[];
  customType: string;
  details?: JsonValue;
  display: boolean;
  type: "custom_message";
}

export interface PiLabelEntry extends PiSessionEntryBase {
  label?: string;
  targetId: string;
  type: "label";
}

export interface PiSessionInfoEntry extends PiSessionEntryBase {
  name?: string;
  type: "session_info";
}

export interface PiUnknownSessionEntry extends PiSessionEntryBase {
  data: JsonValue;
  originalType: string;
  type: "unknown";
}

export type PiSessionEntry =
  | PiContextEditEntry
  | PiUsageEntry
  | PiSessionMessageEntry
  | PiThinkingLevelChangeEntry
  | PiModelChangeEntry
  | PiCompactionEntry
  | PiBranchSummaryEntry
  | PiCustomEntry
  | PiCustomMessageEntry
  | PiLabelEntry
  | PiSessionInfoEntry
  | PiUnknownSessionEntry;

export interface SessionEntriesResult {
  entries: PiSessionEntry[];
  leafId: string | null;
  scope: "branch" | "all";
  sessionId: string;
}

/** One Pi worker read of live state, requested transcript scopes, and usage. */
export interface SessionReconcileResult {
  entries: Partial<Record<"branch" | "all", SessionEntriesResult>>;
  snapshot: SessionSnapshot;
  stats: SessionStats;
}

export interface SessionTreeNode {
  children: SessionTreeNode[];
  entry: PiSessionEntry;
  label?: string;
  labelTimestamp?: string;
}

export interface SessionTreeResult {
  leafId: string | null;
  sessionId: string;
  tree: SessionTreeNode[];
}

export type PiAssistantStreamUpdate =
  | { type: "start" }
  | { contentIndex: number; type: "text_start" }
  | { contentIndex: number; delta: string; type: "text_delta" }
  | { content: string; contentIndex: number; type: "text_end" }
  | { contentIndex: number; type: "thinking_start" }
  | { contentIndex: number; delta: string; type: "thinking_delta" }
  | { content: string; contentIndex: number; type: "thinking_end" }
  | { contentIndex: number; id: string; toolName: string; type: "toolcall_start" }
  | { contentIndex: number; delta: string; type: "toolcall_delta" }
  | { contentIndex: number; toolCall: PiToolCall; type: "toolcall_end" }
  | { reason: "stop" | "length" | "toolUse" | "deferred"; type: "done" }
  | { reason: "aborted" | "error"; type: "error" };

export interface PiCompactionResult {
  details?: JsonValue;
  estimatedTokensAfter?: number;
  firstKeptEntryId: string;
  summary: string;
  tokensBefore: number;
  usage?: PiUsage;
}

export interface PiCompactionStartResult {
  taskId: string;
  status: "preparing" | "ready";
}

export interface PiAgentEventPosition {
  runId?: string;
  leafId: string | null;
  turnIndex: number;
}

export type PiAgentEvent = (
  | ({ type: "agent_start" } & PiAgentEventPosition)
  | ({ messages: PiMessage[]; type: "agent_end"; willRetry: boolean } & PiAgentEventPosition)
  | ({ type: "agent_settled" } & PiAgentEventPosition)
  | ({ type: "turn_start" } & PiAgentEventPosition)
  | ({ message: PiMessage; toolResults: PiToolResultMessage[]; type: "turn_end" } & PiAgentEventPosition)
  | { message: PiMessage; type: "message_start" }
  | { message: PiMessage; type: "message_update"; update: PiAssistantStreamUpdate }
  | { message: PiMessage; type: "message_end" }
  | { args: JsonValue; toolCallId: string; parentToolCallId?: string; toolName: string; type: "tool_execution_start" }
  | {
      args: JsonValue;
      partialResult: JsonValue;
      toolCallId: string;
      parentToolCallId?: string;
      toolName: string;
      type: "tool_execution_update";
    }
  | {
      isError: boolean;
      result: JsonValue;
      toolCallId: string;
      parentToolCallId?: string;
      toolName: string;
      type: "tool_execution_end";
    }
  | { followUp: string[]; steering: string[]; type: "queue_update" }
  | ({ entry: PiSessionEntry; type: "entry_appended" } & PiAgentEventPosition)
  | { name?: string; type: "session_info_changed" }
  | { level: ThinkingLevel; type: "thinking_level_changed" }
  | { reason: "manual" | "threshold" | "overflow"; type: "compaction_start" }
  | {
      aborted: boolean;
      errorMessage?: string;
      reason: "manual" | "threshold" | "overflow";
      result?: PiCompactionResult;
      type: "compaction_end";
      willRetry: boolean;
    }
  | {
      attempt: number;
      delayMs: number;
      errorMessage: string;
      maxAttempts: number;
      type: "auto_retry_start";
    }
  | { attempt: number; finalError?: string; success: boolean; type: "auto_retry_end" }
  | {
      attempt: number;
      delayMs: number;
      errorMessage: string;
      maxAttempts: number;
      type: "summarization_retry_scheduled";
    }
  | {
      reason?: "manual" | "threshold" | "overflow";
      source: "branchSummary" | "compaction";
      type: "summarization_retry_attempt_start";
    }
  | { type: "summarization_retry_finished" }
  | { delta: string; id?: string; type: "bash_execution_update" }
) & { runId?: string };
