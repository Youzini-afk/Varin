import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AuthEvent,
  AuthPrompt,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiAgentEvent,
  PiAgentEventPosition,
  PiAssistantContent,
  PiAssistantMessage,
  PiAssistantStreamUpdate,
  PiCompactionResult,
  PiMessage,
  PiSessionEntry,
  PiToolCall,
  PiToolResultMessage,
  PiUsage,
  PiUserContent,
  ProviderAuthEvent,
  ProviderAuthPrompt,
} from "@varin/protocol";
import { toJsonValue } from "./json.js";

type CompactionResult = NonNullable<
  Extract<AgentSessionEvent, { type: "compaction_end" }>["result"]
>;

function optionalJson(value: unknown): { details?: JsonValue } {
  return value === undefined ? {} : { details: toJsonValue(value) };
}

export function projectUsage(usage: Usage): PiUsage {
  return {
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    cost: {
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      input: usage.cost.input,
      output: usage.cost.output,
      total: usage.cost.total,
    },
    input: usage.input,
    output: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
  };
}

function projectUserContent(content: TextContent | ImageContent): PiUserContent {
  if (content.type === "image") {
    return { data: content.data, mimeType: content.mimeType, type: "image" };
  }
  return { text: content.text, type: "text" };
}

function projectUserContents(
  content: string | (TextContent | ImageContent)[],
): string | PiUserContent[] {
  return typeof content === "string" ? content : content.map(projectUserContent);
}

function projectToolCall(toolCall: ToolCall): PiToolCall {
  return {
    arguments: toJsonValue(toolCall.arguments),
    id: toolCall.id,
    name: toolCall.name,
    type: "toolCall",
  };
}

function projectAssistantContent(
  content: AssistantMessage["content"][number],
): PiAssistantContent {
  switch (content.type) {
    case "text":
      return { text: content.text, type: "text" };
    case "thinking":
      return {
        ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
        thinking: content.thinking,
        type: "thinking",
      };
    case "toolCall":
      return projectToolCall(content);
  }
}

function projectAssistantMessage(message: AssistantMessage): PiAssistantMessage {
  return {
    api: message.api,
    content: message.content.map(projectAssistantContent),
    ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    model: message.model,
    provider: message.provider,
    ...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.thinkingLevel === undefined ? {} : { thinkingLevel: message.thinkingLevel }),
    role: "assistant",
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    usage: projectUsage(message.usage),
  };
}

function projectToolResult(message: ToolResultMessage): PiToolResultMessage {
  return {
    ...(message.nestedCalls === undefined ? {} : { nestedCalls: toJsonValue(message.nestedCalls) }),
    content: message.content.map(projectUserContent),
    ...optionalJson(message.details),
    isError: message.isError,
    role: "toolResult",
    timestamp: message.timestamp,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    ...(message.usage === undefined ? {} : { usage: projectUsage(message.usage) }),
  } as PiToolResultMessage;
}

export function projectMessage(message: AgentMessage): PiMessage {
  switch (message.role) {
    case "system":
      return {
        role: "system", content: message.content, timestamp: message.timestamp,
        ...(message.sections === undefined ? {} : { sections: { ...message.sections } }),
        ...(message.toolsAdded === undefined ? {} : { toolsAdded: toJsonValue(message.toolsAdded) }),
        ...(message.toolsRemoved === undefined ? {} : { toolsRemoved: message.toolsRemoved.map(tool => ({ name: tool.name })) }),
      };
    case "user":
      return {
        content: projectUserContents(message.content),
        role: "user",
        timestamp: message.timestamp,
      };
    case "assistant":
      return projectAssistantMessage(message);
    case "toolResult":
      return projectToolResult(message);
    case "bashExecution":
      return {
        cancelled: message.cancelled,
        command: message.command,
        ...(message.excludeFromContext === undefined
          ? {}
          : { excludeFromContext: message.excludeFromContext }),
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.fullOutputPath === undefined
          ? {}
          : { fullOutputPath: message.fullOutputPath }),
        output: message.output,
        role: "bashExecution",
        timestamp: message.timestamp,
        truncated: message.truncated,
      };
    case "custom":
      return {
        content: projectUserContents(message.content),
        customType: message.customType,
        ...optionalJson(message.details),
        display: message.display,
        role: "custom",
        timestamp: message.timestamp,
      };
    case "branchSummary":
      return {
        fromId: message.fromId,
        role: "branchSummary",
        summary: message.summary,
        timestamp: message.timestamp,
      };
    case "compactionSummary":
      return {
        role: "compactionSummary",
        summary: message.summary,
        timestamp: message.timestamp,
        tokensBefore: message.tokensBefore,
      };
    default: {
      const unknown = message as unknown as Record<string, unknown>;
      return {
        data: toJsonValue(unknown),
        originalRole: typeof unknown.role === "string" ? unknown.role : "unknown",
        role: "unknown",
        ...(typeof unknown.timestamp === "number" ? { timestamp: unknown.timestamp } : {}),
      };
    }
  }
}

const entryBase = (entry: SessionEntry) => ({
  id: entry.id,
  parentId: entry.parentId,
  timestamp: entry.timestamp,
});

export function projectSessionEntry(entry: SessionEntry): PiSessionEntry {
  const base = entryBase(entry);
  switch (entry.type) {
    case "message":
      return { ...base, message: projectMessage(entry.message), type: "message" };
    case "thinking_level_change":
      return { ...base, thinkingLevel: entry.thinkingLevel, type: "thinking_level_change" };
    case "context_edit":
      return { ...base, type: "context_edit", targetId: entry.targetId,
        replacement: entry.replacement === null ? null : { content: toJsonValue(entry.replacement.content) } };
    case "usage":
      return { ...base, type: "usage", kind: entry.kind, provider: entry.provider, model: entry.model,
        usage: projectUsage(entry.usage), ...(entry.note === undefined ? {} : { note: entry.note }) };
    case "model_change":
      return {
        ...base,
        modelId: entry.modelId,
        provider: entry.provider,
        type: "model_change",
      };
    case "compaction":
      return {
        ...base,
        ...optionalJson(entry.details),
        firstKeptEntryId: entry.firstKeptEntryId,
        ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        type: "compaction",
        ...(entry.usage === undefined ? {} : { usage: projectUsage(entry.usage) }),
      } as PiSessionEntry;
    case "branch_summary":
      return {
        ...base,
        ...optionalJson(entry.details),
        ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
        fromId: entry.fromId,
        summary: entry.summary,
        type: "branch_summary",
        ...(entry.usage === undefined ? {} : { usage: projectUsage(entry.usage) }),
      } as PiSessionEntry;
    case "custom":
      return {
        ...base,
        customType: entry.customType,
        ...(entry.data === undefined ? {} : { data: toJsonValue(entry.data) }),
        type: "custom",
      };
    case "custom_message":
      return {
        ...base,
        content: projectUserContents(entry.content),
        customType: entry.customType,
        ...optionalJson(entry.details),
        display: entry.display,
        type: "custom_message",
      } as PiSessionEntry;
    case "label":
      return {
        ...base,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        targetId: entry.targetId,
        type: "label",
      };
    case "session_info":
      return {
        ...base,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        type: "session_info",
      };
    default: {
      const unknown = entry as unknown as Record<string, unknown>;
      return {
        ...base,
        data: toJsonValue(unknown),
        originalType: typeof unknown.type === "string" ? unknown.type : "unknown",
        type: "unknown",
      };
    }
  }
}

function projectAssistantUpdate(event: AssistantMessageEvent): PiAssistantStreamUpdate {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
    case "thinking_start":
      return { contentIndex: event.contentIndex, type: event.type };
    case "toolcall_start": {
      const toolCall = event.partial.content[event.contentIndex];
      if (toolCall?.type !== "toolCall") {
        throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
      }
      return {
        contentIndex: event.contentIndex,
        id: toolCall.id,
        toolName: toolCall.name,
        type: "toolcall_start",
      };
    }
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { contentIndex: event.contentIndex, delta: event.delta, type: event.type };
    case "text_end":
    case "thinking_end":
      return { content: event.content, contentIndex: event.contentIndex, type: event.type };
    case "toolcall_end":
      return {
        contentIndex: event.contentIndex,
        toolCall: projectToolCall(event.toolCall),
        type: "toolcall_end",
      };
    case "done":
      return { reason: event.reason, type: "done" };
    case "error":
      return { reason: event.reason, type: "error" };
  }
}

function projectCompactionResult(result: CompactionResult): PiCompactionResult {
  return {
    ...optionalJson(result.details),
    ...(result.estimatedTokensAfter === undefined
      ? {}
      : { estimatedTokensAfter: result.estimatedTokensAfter }),
    firstKeptEntryId: result.firstKeptEntryId,
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    ...(result.usage === undefined ? {} : { usage: projectUsage(result.usage) }),
  } as PiCompactionResult;
}

export function projectAgentEvent(
  event: AgentSessionEvent,
  position: PiAgentEventPosition = { leafId: null, turnIndex: 0 },
): PiAgentEvent {
  switch (event.type) {
    case "agent_start":
    case "agent_settled":
    case "turn_start":
      return { ...position, type: event.type };
    case "summarization_retry_finished":
      return { type: event.type };
    case "agent_end":
      return {
        ...position,
        messages: event.messages.map(projectMessage),
        type: "agent_end",
        willRetry: event.willRetry,
      };
    case "turn_end":
      return {
        ...position,
        message: projectMessage(event.message),
        toolResults: event.toolResults.map(projectToolResult),
        type: "turn_end",
      };
    case "message_start":
    case "message_end":
      return { message: projectMessage(event.message), type: event.type };
    case "message_update":
      return {
        message: projectMessage(event.message),
        type: "message_update",
        update: projectAssistantUpdate(event.assistantMessageEvent),
      };
    case "tool_execution_start":
      return {
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        args: toJsonValue(event.args),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool_execution_start",
      };
    case "tool_execution_update":
      return {
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        args: toJsonValue(event.args),
        partialResult: toJsonValue(event.partialResult),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool_execution_update",
      };
    case "tool_execution_end":
      return {
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        isError: event.isError,
        result: toJsonValue(event.result),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool_execution_end",
      };
    case "queue_update":
      return { followUp: [...event.followUp], steering: [...event.steering],
        queuedMessages: event.queuedMessages.map((message) => ({ ...message })), type: "queue_update" };
    case "entry_appended":
      return { ...position, entry: projectSessionEntry(event.entry), type: "entry_appended" };
    case "session_info_changed":
      return {
        ...(event.name === undefined ? {} : { name: event.name }),
        type: "session_info_changed",
      };
    case "thinking_level_changed":
      return { level: event.level, type: "thinking_level_changed" };
    case "compaction_start":
      return { reason: event.reason, type: "compaction_start" };
    case "compaction_end":
      return {
        aborted: event.aborted,
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
        reason: event.reason,
        ...(event.result === undefined ? {} : { result: projectCompactionResult(event.result) }),
        type: "compaction_end",
        willRetry: event.willRetry,
      };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return {
        attempt: event.attempt,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
        maxAttempts: event.maxAttempts,
        type: event.type,
      };
    case "auto_retry_end":
      return {
        attempt: event.attempt,
        ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
        success: event.success,
        type: "auto_retry_end",
      };
    case "summarization_retry_attempt_start":
      return {
        ...(event.source === "compaction" ? { reason: event.reason } : {}),
        source: event.source,
        type: "summarization_retry_attempt_start",
      };
    case "bash_execution_update":
      return {
        delta: event.delta,
        ...(event.id === undefined ? {} : { id: event.id }),
        type: "bash_execution_update",
      };
  }
}

export function projectProviderAuthPrompt(
  requestId: string,
  prompt: AuthPrompt,
): ProviderAuthPrompt {
  if (prompt.type === "select") {
    return {
      message: prompt.message,
      options: prompt.options.map((option) => ({
        ...(option.description === undefined ? {} : { description: option.description }),
        id: option.id,
        label: option.label,
      })),
      requestId,
      type: "select",
    };
  }
  return {
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    requestId,
    type: prompt.type,
  };
}

export function projectProviderAuthEvent(event: AuthEvent): ProviderAuthEvent {
  switch (event.type) {
    case "info":
      return {
        ...(event.links === undefined
          ? {}
          : {
              links: event.links.map((link) => ({
                ...(link.label === undefined ? {} : { label: link.label }),
                url: link.url,
              })),
            }),
        message: event.message,
        type: "info",
      };
    case "auth_url":
      return {
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
        type: "auth_url",
        url: event.url,
      };
    case "device_code":
      return {
        ...(event.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: event.expiresInSeconds }),
        ...(event.intervalSeconds === undefined
          ? {}
          : { intervalSeconds: event.intervalSeconds }),
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
      };
    case "progress":
      return { message: event.message, type: "progress" };
  }
}
