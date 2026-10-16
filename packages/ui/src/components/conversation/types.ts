import type { JsonValue } from '@varin/protocol';

/** Read-only conversation presentation. Native history remains authoritative. */
export interface ChatUsage {
  requestId?: string;
  measurement: 'actual' | 'estimated' | 'missing';
  unknownReceipts: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  totalTokens?: number;
}

export interface ChatTextContent {
  text: string;
  type: "text";
}

export interface ChatImageContent {
  data: string;
  mimeType: string;
  type: "image";
}

export interface ChatThinkingContent {
  redacted?: boolean;
  thinking: string;
  type: "thinking";
}

export interface ChatToolCall {
  rawArguments?: string;
  sequence?: number;
  interrupted?: boolean;
  arguments: JsonValue;
  id: string;
  name: string;
  type: "toolCall";
}

export type ChatUserContent = ChatTextContent | ChatImageContent;

export type ChatAssistantContent = ChatTextContent | ChatThinkingContent | ChatToolCall;

export interface ChatUserMessage {
  content: string | ChatUserContent[];
  role: "user";
  timestamp: number;
}

export interface ChatSystemMessage {
  role: "system";
  content: string | ChatTextContent[];
  timestamp: number;
  sections?: Record<string, string | null>;
  toolsAdded?: JsonValue;
  toolsRemoved?: Array<{ name: string }>;
}

export interface ChatAssistantMessage {
  id: string;
  api: string;
  content: ChatAssistantContent[];
  errorMessage?: string;
  model: string;
  provider: string;
  rawStopReason?: string;
  responseModel?: string;
  thinkingLevel?: string;
  role: "assistant";
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  timestamp: number;
  usage?: ChatUsage;
}

export interface ChatToolResultMessage {
  historyId?: string;
  nestedCalls?: {
    calls: Array<{ id: string; name: string; arguments?: JsonValue; argumentsBytes?: number;
      status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }>;
    complete: boolean;
  };
  content: ChatUserContent[];
  details?: JsonValue;
  isError: boolean;
  status?: ChatToolExecutionState['status'];
  role: "toolResult";
  timestamp: number;
  toolCallId: string;
  toolName: string;
  usage?: ChatUsage;
}

export interface ChatBashExecutionMessage {
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

export interface ChatCustomMessage {
  content: string | ChatUserContent[];
  customType: string;
  details?: JsonValue;
  display: boolean;
  role: "custom";
  timestamp: number;
}

export interface ChatBranchSummaryMessage {
  fromId: string | null;
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface ChatCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  timestamp: number;
  tokensBefore: number;
}

export interface ChatUnknownMessage {
  data: JsonValue;
  originalRole: string;
  role: "unknown";
  timestamp?: number;
}

export type ChatMessage =
  | ChatSystemMessage
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolResultMessage
  | ChatBashExecutionMessage
  | ChatCustomMessage
  | ChatBranchSummaryMessage
  | ChatCompactionSummaryMessage
  | ChatUnknownMessage;

export interface ChatSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface ChatSessionMessageEntry extends ChatSessionEntryBase {
  message: ChatMessage;
  type: "message";
}

export interface ChatContextEditEntry extends ChatSessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: JsonValue } | null;
}

export interface ChatUsageEntry extends ChatSessionEntryBase {
  type: "usage";
  kind: string;
  provider: string;
  model: string;
  usage: ChatUsage;
  note?: string;
}

export interface ChatThinkingLevelChangeEntry extends ChatSessionEntryBase {
  thinkingLevel: string;
  type: "thinking_level_change";
}

export interface ChatModelChangeEntry extends ChatSessionEntryBase {
  modelId: string;
  provider: string;
  type: "model_change";
}

export interface ChatCompactionEntry extends ChatSessionEntryBase {
  details?: JsonValue;
  firstKeptEntryId: string;
  fromHook?: boolean;
  summary: string;
  tokensBefore: number;
  type: "compaction";
  usage?: ChatUsage;
}

export interface ChatBranchSummaryEntry extends ChatSessionEntryBase {
  details?: JsonValue;
  fromHook?: boolean;
  fromId: string;
  summary: string;
  type: "branch_summary";
  usage?: ChatUsage;
}

export interface ChatCustomEntry extends ChatSessionEntryBase {
  customType: string;
  data?: JsonValue;
  type: "custom";
}

export interface ChatCustomMessageEntry extends ChatSessionEntryBase {
  content: string | ChatUserContent[];
  customType: string;
  details?: JsonValue;
  display: boolean;
  type: "custom_message";
}

export interface ChatLabelEntry extends ChatSessionEntryBase {
  label?: string;
  targetId: string;
  type: "label";
}

export interface ChatSessionInfoEntry extends ChatSessionEntryBase {
  name?: string;
  type: "session_info";
}

export interface ChatUnknownSessionEntry extends ChatSessionEntryBase {
  data: JsonValue;
  originalType: string;
  type: "unknown";
}

export type ChatSessionEntry =
  | ChatContextEditEntry
  | ChatUsageEntry
  | ChatSessionMessageEntry
  | ChatThinkingLevelChangeEntry
  | ChatModelChangeEntry
  | ChatCompactionEntry
  | ChatBranchSummaryEntry
  | ChatCustomEntry
  | ChatCustomMessageEntry
  | ChatLabelEntry
  | ChatSessionInfoEntry
  | ChatUnknownSessionEntry;


export interface ChatToolExecutionState {
  parentToolCallId?: string;
  args: JsonValue;
  isError?: boolean;
  name: string;
  partialResult?: JsonValue;
  result?: JsonValue;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'unknown' | 'background' | 'waiting';
  toolCallId: string;
}
export type ChatSessionSubmissionStatus = 'preparing' | 'dispatching' | 'accepted' | 'uncertain' | 'failed';
