import type {
  PiAssistantContent,
  PiMessage,
  PiSessionEntry,
  SessionEntriesResult,
  TranscriptRef,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";

export interface ThreadTranscriptReader {
  read(ref: TranscriptRef, since?: number): Promise<string>;
}

export interface ThreadTranscriptReaderOptions {
  readSessionEntries(sessionId: string): Promise<SessionEntriesResult>;
}

const textParts = (content: string | Array<{ type: string; text?: string }>): string => {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text ?? "" : `[${part.type}]`).join("\n");
};

const assistantPart = (part: PiAssistantContent): string => {
  if (part.type === "text") return part.text;
  if (part.type === "thinking") return `[thinking]\n${part.thinking}`;
  return `[tool ${part.name}] ${JSON.stringify(part.arguments)}`;
};

const formatMessage = (message: PiMessage): string => {
  switch (message.role) {
    case "system": return `[source system instructions]\n${textParts(message.content)}`;
    case "user": return `[user]\n${textParts(message.content)}`;
    case "assistant": return `[assistant]\n${message.content.map(assistantPart).join("\n")}`;
    case "toolResult": return `[tool result ${message.toolName}${message.isError ? " · error" : ""}]\n${textParts(message.content)}`;
    case "bashExecution": return `[bash ${message.exitCode ?? "?"}] ${message.command}\n${message.output}`;
    case "custom": return `[${message.customType}]\n${textParts(message.content)}`;
    case "branchSummary": return `[branch summary]\n${message.summary}`;
    case "compactionSummary": return `[compaction summary]\n${message.summary}`;
    case "unknown": return `[unknown message: ${message.originalRole}]`;
  }
};

export const formatTranscriptEntry = (entry: PiSessionEntry): string => {
  switch (entry.type) {
    case "context_edit": return `${entry.id} [model context ${entry.replacement === null ? "omitted" : "edited"} → ${entry.targetId}]`;
    case "usage": return `${entry.id} [${entry.kind} usage ${entry.provider}/${entry.model}: ${entry.usage.totalTokens} tokens]`;
    case "message": return `${entry.id} ${formatMessage(entry.message)}`;
    case "custom_message": return `${entry.id} [${entry.customType}]\n${textParts(entry.content)}`;
    case "compaction": return `${entry.id} [compaction]\n${entry.summary}`;
    case "branch_summary": return `${entry.id} [branch summary]\n${entry.summary}`;
    case "model_change": return `${entry.id} [model ${entry.provider}/${entry.modelId}]`;
    case "thinking_level_change": return `${entry.id} [thinking level ${entry.thinkingLevel}]`;
    case "label": return `${entry.id} [label ${entry.label ?? ""} → ${entry.targetId}]`;
    case "session_info": return `${entry.id} [session ${entry.name ?? ""}]`;
    case "custom": return `${entry.id} [${entry.customType}]`;
    case "unknown": return `${entry.id} [unknown entry: ${entry.originalType}]`;
  }
};

const branchTo = (entries: readonly PiSessionEntry[], leafId: string): PiSessionEntry[] => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reversed: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current) {
    if (seen.has(current.id)) throw new HarnessServiceError("failed", "Transcript branch contains a cycle");
    seen.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  if (reversed.length === 0) throw new HarnessServiceError("not-found", `Transcript leaf not found: ${leafId}`);
  return reversed.reverse();
};

export function createThreadTranscriptReader(options: ThreadTranscriptReaderOptions): ThreadTranscriptReader {
  return {
    async read(ref, since = 0) {
      if (ref.runtimeId !== "pi") {
        throw new HarnessServiceError("unavailable", `Unsupported transcript runtime: ${ref.runtimeId}`);
      }
      const result = await options.readSessionEntries(ref.sessionId);
      const leafId = ref.branchLeafId ?? ref.toEntryId ?? result.leafId;
      if (!leafId) return "[entries 0–0 of 0]\n(no transcript entries)";
      const branch = branchTo(result.entries, leafId);
      const from = ref.fromEntryId === null ? 0 : branch.findIndex((entry) => entry.id === ref.fromEntryId);
      const to = ref.toEntryId === null ? branch.length - 1 : branch.findIndex((entry) => entry.id === ref.toEntryId);
      if (from < 0 || to < from) {
        throw new HarnessServiceError("not-found", "Transcript range no longer exists in the referenced session");
      }
      const range = branch.slice(from, to + 1);
      const start = Math.min(range.length, Math.max(0, Math.floor(since)));
      const selected = range.slice(start);
      const header = `[entries ${start + 1}–${range.length} of ${range.length}]`;
      return selected.length === 0
        ? `${header}\n(no new transcript entries)`
        : `${header}\n${selected.map(formatTranscriptEntry).join("\n\n")}`;
    },
  };
}
