import type {
  JsonValue,
  PiAssistantContent,
  PiMessage,
  PiSessionEntry,
  PiUserContent,
} from '@varin/protocol';

export interface PiSessionExportMetadata {
  cwd?: string | null;
  sessionId?: string | null;
  title?: string | null;
}

const asIsoTimestamp = (value: string | number | undefined): string => {
  if (value === undefined) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const fenced = (value: string, language = ''): string => {
  const longestRun = Math.max(0, ...(value.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
};

const jsonBlock = (value: JsonValue): string => fenced(JSON.stringify(value, null, 2), 'json');

const contentMarkdown = (content: string | PiUserContent[]): string => {
  if (typeof content === 'string') return content.trim();
  return content.map((part) => {
    if (part.type === 'text') return part.text.trim();
    return `*[Image attachment: ${part.mimeType}]*`;
  }).filter(Boolean).join('\n\n');
};

const detailLine = (...parts: Array<string | undefined>): string => {
  const text = parts.filter((part): part is string => Boolean(part)).join(' · ');
  return text ? `\n\n*${text}*` : '';
};

const assistantContentMarkdown = (content: PiAssistantContent): string => {
  switch (content.type) {
    case 'text':
      return content.text.trim();
    case 'thinking':
      return content.redacted
        ? '<details>\n<summary>Thinking</summary>\n\n*Redacted thinking omitted.*\n\n</details>'
        : `<details>\n<summary>Thinking</summary>\n\n${content.thinking.trim()}\n\n</details>`;
    case 'toolCall':
      return [
        `**Tool call: ${content.name}** \`${content.id}\``,
        jsonBlock(content.arguments),
      ].join('\n\n');
  }
};

const formatMessage = (message: PiMessage, timestamp: string): string => {
  const time = asIsoTimestamp(message.timestamp) || timestamp;
  switch (message.role) {
    case 'system':
      return `**System instructions**${detailLine(time)}\n\n${message.content ?? ''}${message.sections ? `\n\n${jsonBlock(message.sections)}` : ''}`;
    case 'user':
      return `**User**${detailLine(time)}\n\n${contentMarkdown(message.content) || '*Empty message*'}`;
    case 'assistant': {
      const model = [message.provider, message.responseModel || message.model].filter(Boolean).join('/');
      const content = message.content.map(assistantContentMarkdown).filter(Boolean).join('\n\n');
      const status = message.errorMessage
        ? `\n\n**Error:** ${message.errorMessage}`
        : message.stopReason === 'stop' || message.stopReason === 'toolUse'
          ? ''
          : `\n\n*Stop reason: ${message.stopReason}*`;
      return `**Assistant**${detailLine(time, model)}\n\n${content || '*Empty response*'}${status}`;
    }
    case 'toolResult': {
      const content = contentMarkdown(message.content);
      const details = message.details === undefined ? '' : `\n\n**Details**\n\n${jsonBlock(message.details)}`;
      return `**Tool result: ${message.toolName}** \`${message.toolCallId}\`${detailLine(time, message.isError ? 'error' : 'success')}\n\n${content || '*No textual output*'}${details}`;
    }
    case 'bashExecution': {
      const state = message.cancelled
        ? 'cancelled'
        : message.exitCode === undefined
          ? undefined
          : `exit ${message.exitCode}`;
      const output = message.output.trim() || '(no output)';
      const notes = [
        message.truncated ? '*Output was truncated.*' : '',
        message.fullOutputPath ? `*Full output: \`${message.fullOutputPath}\`*` : '',
      ].filter(Boolean).join('\n\n');
      return [
        `**Bash execution**${detailLine(time, state)}`,
        fenced(message.command, 'shell'),
        fenced(output, 'text'),
        notes,
      ].filter(Boolean).join('\n\n');
    }
    case 'custom': {
      if (!message.display) return '';
      const content = contentMarkdown(message.content);
      const details = message.details === undefined ? '' : `\n\n${jsonBlock(message.details)}`;
      return `**Custom message: ${message.customType}**${detailLine(time)}\n\n${content || '*No textual content*'}${details}`;
    }
    case 'branchSummary':
      return `**Branch summary**${detailLine(time, message.fromId === null ? undefined : `from ${message.fromId}`)}\n\n${message.summary}`;
    case 'compactionSummary':
      return `**Compaction summary**${detailLine(time, `${message.tokensBefore} tokens before compaction`)}\n\n${message.summary}`;
    case 'unknown':
      return `**Unknown message: ${message.originalRole}**${detailLine(time)}\n\n${jsonBlock(message.data)}`;
  }
};

const formatEntry = (entry: PiSessionEntry): string => {
  const timestamp = asIsoTimestamp(entry.timestamp);
  switch (entry.type) {
    case 'context_edit':
      return `**Model context changed**${detailLine(timestamp, `target ${entry.targetId}`)}\n\n${entry.replacement === null ? '*Omitted from model context*' : jsonBlock(entry.replacement)}`;
    case 'usage':
      return `**${entry.kind} usage**${detailLine(timestamp, `${entry.provider}/${entry.model}`)}\n\n${jsonBlock({ ...entry.usage, cost: { ...entry.usage.cost } })}${entry.note ? `\n\n${entry.note}` : ''}`;
    case 'message':
      return formatMessage(entry.message, timestamp);
    case 'thinking_level_change':
      return `**Thinking level changed**${detailLine(timestamp)}\n\n${entry.thinkingLevel}`;
    case 'model_change':
      return `**Model changed**${detailLine(timestamp)}\n\n${entry.provider}/${entry.modelId}`;
    case 'compaction': {
      const details = entry.details === undefined ? '' : `\n\n${jsonBlock(entry.details)}`;
      return `**Compaction**${detailLine(timestamp, `${entry.tokensBefore} tokens before compaction`)}\n\n${entry.summary}${details}`;
    }
    case 'branch_summary': {
      const details = entry.details === undefined ? '' : `\n\n${jsonBlock(entry.details)}`;
      return `**Branch summary**${detailLine(timestamp, `from ${entry.fromId}`)}\n\n${entry.summary}${details}`;
    }
    case 'custom':
      return `**Custom entry: ${entry.customType}**${detailLine(timestamp)}${entry.data === undefined ? '' : `\n\n${jsonBlock(entry.data)}`}`;
    case 'custom_message': {
      if (!entry.display) return '';
      const content = contentMarkdown(entry.content);
      const details = entry.details === undefined ? '' : `\n\n${jsonBlock(entry.details)}`;
      return `**Custom message: ${entry.customType}**${detailLine(timestamp)}\n\n${content || '*No textual content*'}${details}`;
    }
    case 'label':
      return `**Label changed**${detailLine(timestamp, `target ${entry.targetId}`)}\n\n${entry.label?.trim() || '*Label removed*'}`;
    case 'session_info':
      return `**Session renamed**${detailLine(timestamp)}\n\n${entry.name?.trim() || '*Name cleared*'}`;
    case 'unknown':
      return `**Unknown entry: ${entry.originalType}**${detailLine(timestamp)}\n\n${jsonBlock(entry.data)}`;
  }
};

export const formatPiSessionAsMarkdown = (
  entries: PiSessionEntry[],
  metadata: PiSessionExportMetadata = {},
  exportedAt = new Date(),
): string => {
  const title = metadata.title?.trim() || 'Session';
  const date = Number.isNaN(exportedAt.getTime())
    ? new Date().toISOString().slice(0, 10)
    : exportedAt.toISOString().slice(0, 10);
  const metadataLines = [
    `*Exported on ${date}*`,
    metadata.sessionId?.trim() ? `- Session ID: \`${metadata.sessionId.trim()}\`` : '',
    metadata.cwd?.trim() ? `- Working directory: \`${metadata.cwd.trim()}\`` : '',
  ].filter(Boolean);
  const body = entries.map(formatEntry).filter(Boolean).join('\n\n---\n\n');
  return [`# ${title}`, metadataLines.join('\n'), '---', body].filter(Boolean).join('\n\n');
};
