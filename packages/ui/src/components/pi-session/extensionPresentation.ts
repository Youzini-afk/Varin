import type { JsonValue, PiToolResultMessage, PiUserContent } from '@varin/protocol';

type JsonObject = Record<string, JsonValue>;

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'detached' | 'paused' | 'stopped';

export interface SubagentRecentToolPresentation {
  args?: string;
  endMs?: number;
  tool: string;
}

export interface SubagentAgentPresentation {
  agent: string;
  currentPath?: string;
  currentTool?: string;
  currentToolArgs?: string;
  durationMs?: number;
  error?: string;
  finalOutput?: string;
  index: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  recentOutput: string[];
  recentTools: SubagentRecentToolPresentation[];
  sessionFile?: string;
  skills: string[];
  status: SubagentStatus;
  task: string;
  thinking?: string;
  tokens?: number;
  toolCount?: number;
  turnCount?: number;
}

export interface SubagentRunPresentation {
  agents: SubagentAgentPresentation[];
  durationMs?: number;
  mode: 'single' | 'parallel' | 'chain' | 'management';
  raw: JsonValue;
  runId?: string;
  tokens?: number;
  toolCount?: number;
}

export interface SubagentNotificationPresentation {
  agent: string;
  durationMs?: number;
  handoffPath?: string;
  resultPreview: string;
  sessionLabel?: string;
  sessionValue?: string;
  source?: 'async' | 'foreground';
  status: Extract<SubagentStatus, 'completed' | 'failed' | 'paused' | 'stopped'>;
  taskInfo?: string;
}

export interface ExtensionStatusPresentation {
  details?: JsonValue;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  title: string;
}

const isObject = (value: JsonValue | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stringValue = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' ? value : undefined
);

const numberValue = (value: JsonValue | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

export interface ToolCallPresentation {
  id: string;
  name: string;
  status: 'ok' | 'error' | 'unfinished' | 'running' | 'cancelled';
  model?: string;
  durationMs?: number;
  error?: string;
  cost?: number;
}

/** Native nested tool receipts and codemode's model rows describe different calls. */
export function projectToolCalls(result: Pick<PiToolResultMessage, 'toolName' | 'nestedCalls' | 'details'>, live = false): { calls: ToolCallPresentation[]; complete: boolean } | undefined {
  const native = new Map<string, ToolCallPresentation>(result.nestedCalls?.calls.map(call => [call.id, { ...call }]));
  const calls = new Map<string, ToolCallPresentation>();
  // Progress events contain the native ToolResult envelope; final messages carry its details directly.
  const details = isObject(result.details) && !Array.isArray(result.details.calls) && isObject(result.details.details)
    ? result.details.details : result.details;
  if (result.toolName === 'codemode' && isObject(details) && Array.isArray(details.calls)) {
    for (const value of details.calls) {
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
        || typeof value.status !== 'string' || !['running', 'ok', 'error', 'cancelled'].includes(value.status)) continue;
      const previous = native.get(value.id);
      if (previous && previous.name !== value.name) continue;
      const duration = numberValue(value.durationMs);
      const cost = numberValue(value.cost);
      const model = (value.name === 'models.classify' || value.name === 'models.generateImages')
        ? stringValue(value.args) : undefined;
      calls.set(value.id, {
        id: value.id, name: value.name,
        status: previous?.status ?? (value.status === 'running' && !live
          ? 'unfinished' : value.status as ToolCallPresentation['status']),
        ...(model === undefined ? {} : { model }),
        ...(cost === undefined || cost < 0 ? {} : { cost }),
        ...(duration === undefined || duration < 0 ? {} : { durationMs: duration }),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...previous,
      });
    }
  }
  for (const [id, call] of native) if (!calls.has(id)) calls.set(id, call);
  if (!calls.size && !result.nestedCalls) return undefined;
  const rows = [...calls.values()];
  return { calls: rows, complete: (result.nestedCalls?.complete ?? true)
    && rows.every(call => call.status !== 'running' && call.status !== 'unfinished') };
}

const stringArray = (value: JsonValue | undefined): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

const SUBAGENT_MODES = new Set(['single', 'parallel', 'chain', 'management']);
const SUBAGENT_STATUSES = new Set<SubagentStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'detached',
  'paused',
  'stopped',
]);

const subagentDetailsObject = (value: JsonValue): JsonObject | undefined => {
  const queue: JsonValue[] = [value];
  const seen = new Set<JsonValue>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate === undefined || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isObject(candidate)) continue;
    if (
      typeof candidate.mode === 'string'
      && SUBAGENT_MODES.has(candidate.mode)
      && Array.isArray(candidate.results)
    ) return candidate;
    if (candidate.details !== undefined) queue.push(candidate.details);
    if (candidate.result !== undefined) queue.push(candidate.result);
  }
  return undefined;
};

const resultStatus = (result: JsonObject | undefined): SubagentStatus | undefined => {
  if (!result) return undefined;
  if (result.detached === true) return 'detached';
  if (result.stopped === true) return 'stopped';
  if (result.interrupted === true || result.timedOut === true) return 'failed';
  const exitCode = numberValue(result.exitCode);
  if (exitCode !== undefined) return exitCode === 0 && !stringValue(result.error) ? 'completed' : 'failed';
  return undefined;
};

const parseRecentTools = (value: JsonValue | undefined): SubagentRecentToolPresentation[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.tool !== 'string') return [];
    return [{
      tool: item.tool,
      ...(stringValue(item.args) !== undefined ? { args: stringValue(item.args) } : {}),
      ...(numberValue(item.endMs) !== undefined ? { endMs: numberValue(item.endMs) } : {}),
    }];
  });
};

const usageTokens = (result: JsonObject | undefined): {
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
} => {
  if (!result || !isObject(result.usage)) return {};
  const usage = result.usage;
  const inputTokens = numberValue(usage.input) ?? numberValue(usage.inputTokens);
  const outputTokens = numberValue(usage.output) ?? numberValue(usage.outputTokens);
  const tokens = numberValue(usage.totalTokens)
    ?? (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
};

export const parseSubagentRun = (value: JsonValue): SubagentRunPresentation | undefined => {
  const details = subagentDetailsObject(value);
  if (!details || typeof details.mode !== 'string' || !SUBAGENT_MODES.has(details.mode)) return undefined;
  const progress = Array.isArray(details.progress) ? details.progress : [];
  const results = Array.isArray(details.results) ? details.results : [];
  const itemCount = Math.max(progress.length, results.length);
  const agents: SubagentAgentPresentation[] = [];

  for (let index = 0; index < itemCount; index += 1) {
    const progressCandidate = progress[index];
    const resultCandidate = results[index];
    const progressItem = isObject(progressCandidate) ? progressCandidate : undefined;
    const resultItem = isObject(resultCandidate) ? resultCandidate : undefined;
    const nestedProgressCandidate = resultItem?.progress;
    const nestedProgress = isObject(nestedProgressCandidate) ? nestedProgressCandidate : undefined;
    const activeProgress = progressItem ?? nestedProgress;
    const agent = stringValue(activeProgress?.agent) ?? stringValue(resultItem?.agent) ?? `Agent ${index + 1}`;
    const task = stringValue(activeProgress?.task) ?? stringValue(resultItem?.task) ?? '';
    const progressStatus = stringValue(activeProgress?.status);
    const status = progressStatus && SUBAGENT_STATUSES.has(progressStatus as SubagentStatus)
      ? progressStatus as SubagentStatus
      : resultStatus(resultItem) ?? 'pending';
    const usage = usageTokens(resultItem);
    agents.push({
      agent,
      index: numberValue(activeProgress?.index) ?? index,
      recentOutput: stringArray(activeProgress?.recentOutput),
      recentTools: parseRecentTools(activeProgress?.recentTools),
      skills: stringArray(activeProgress?.skills).length > 0
        ? stringArray(activeProgress?.skills)
        : stringArray(resultItem?.skills),
      status,
      task,
      ...(stringValue(activeProgress?.currentPath) !== undefined ? { currentPath: stringValue(activeProgress?.currentPath) } : {}),
      ...(stringValue(activeProgress?.currentTool) !== undefined ? { currentTool: stringValue(activeProgress?.currentTool) } : {}),
      ...(stringValue(activeProgress?.currentToolArgs) !== undefined ? { currentToolArgs: stringValue(activeProgress?.currentToolArgs) } : {}),
      ...(numberValue(activeProgress?.durationMs) ?? numberValue(resultItem?.durationMs)) !== undefined
        ? { durationMs: numberValue(activeProgress?.durationMs) ?? numberValue(resultItem?.durationMs) }
        : {},
      ...(stringValue(activeProgress?.error) ?? stringValue(resultItem?.error)) !== undefined
        ? { error: stringValue(activeProgress?.error) ?? stringValue(resultItem?.error) }
        : {},
      ...(stringValue(resultItem?.finalOutput) !== undefined ? { finalOutput: stringValue(resultItem?.finalOutput) } : {}),
      ...(numberValue(activeProgress?.inputTokens) ?? usage.inputTokens) !== undefined
        ? { inputTokens: numberValue(activeProgress?.inputTokens) ?? usage.inputTokens }
        : {},
      ...(stringValue(activeProgress?.model) ?? stringValue(resultItem?.model)) !== undefined
        ? { model: stringValue(activeProgress?.model) ?? stringValue(resultItem?.model) }
        : {},
      ...(numberValue(activeProgress?.outputTokens) ?? usage.outputTokens) !== undefined
        ? { outputTokens: numberValue(activeProgress?.outputTokens) ?? usage.outputTokens }
        : {},
      ...(stringValue(resultItem?.sessionFile) !== undefined ? { sessionFile: stringValue(resultItem?.sessionFile) } : {}),
      ...(stringValue(activeProgress?.thinking) ?? stringValue(resultItem?.thinking)) !== undefined
        ? { thinking: stringValue(activeProgress?.thinking) ?? stringValue(resultItem?.thinking) }
        : {},
      ...(numberValue(activeProgress?.tokens) ?? usage.tokens) !== undefined
        ? { tokens: numberValue(activeProgress?.tokens) ?? usage.tokens }
        : {},
      ...(numberValue(activeProgress?.toolCount) !== undefined ? { toolCount: numberValue(activeProgress?.toolCount) } : {}),
      ...(numberValue(activeProgress?.turnCount) !== undefined ? { turnCount: numberValue(activeProgress?.turnCount) } : {}),
    });
  }

  const progressSummary = isObject(details.progressSummary) ? details.progressSummary : undefined;
  return {
    agents,
    mode: details.mode as SubagentRunPresentation['mode'],
    raw: details,
    ...(numberValue(progressSummary?.durationMs) !== undefined ? { durationMs: numberValue(progressSummary?.durationMs) } : {}),
    ...(stringValue(details.runId) !== undefined ? { runId: stringValue(details.runId) } : {}),
    ...(numberValue(progressSummary?.tokens) !== undefined ? { tokens: numberValue(progressSummary?.tokens) } : {}),
    ...(numberValue(progressSummary?.toolCount) !== undefined ? { toolCount: numberValue(progressSummary?.toolCount) } : {}),
  };
};

const NOTIFY_STATUSES = new Set<SubagentNotificationPresentation['status']>([
  'completed',
  'failed',
  'paused',
  'stopped',
]);

const notificationFromObject = (value: JsonValue): SubagentNotificationPresentation | undefined => {
  if (!isObject(value)) return undefined;
  const agent = stringValue(value.agent);
  const status = stringValue(value.status);
  const resultPreview = stringValue(value.resultPreview);
  if (!agent || !status || !NOTIFY_STATUSES.has(status as SubagentNotificationPresentation['status']) || resultPreview === undefined) {
    return undefined;
  }
  return {
    agent,
    resultPreview,
    status: status as SubagentNotificationPresentation['status'],
    ...(numberValue(value.durationMs) !== undefined ? { durationMs: numberValue(value.durationMs) } : {}),
    ...(stringValue(value.handoffPath) !== undefined ? { handoffPath: stringValue(value.handoffPath) } : {}),
    ...(stringValue(value.sessionLabel) !== undefined ? { sessionLabel: stringValue(value.sessionLabel) } : {}),
    ...(stringValue(value.sessionValue) !== undefined ? { sessionValue: stringValue(value.sessionValue) } : {}),
    ...(value.source === 'foreground' || value.source === 'async' ? { source: value.source } : {}),
    ...(stringValue(value.taskInfo) !== undefined ? { taskInfo: stringValue(value.taskInfo) } : {}),
  };
};

const parseNotificationBody = (
  lines: string[],
  base: Omit<SubagentNotificationPresentation, 'resultPreview'>,
): SubagentNotificationPresentation => {
  const contentLines: string[] = [];
  let handoffPath: string | undefined;
  let sessionLabel: string | undefined;
  let sessionValue: string | undefined;
  for (const line of lines) {
    if (line.startsWith('Parallel handoff: ')) {
      handoffPath = line.slice('Parallel handoff: '.length).trim();
      continue;
    }
    const session = line.match(/^(Session|Session file|Session share error):\s+(.+)$/);
    if (session) {
      sessionLabel = session[1]?.toLowerCase();
      sessionValue = session[2]?.trim();
      continue;
    }
    contentLines.push(line);
  }
  while (contentLines[0]?.trim() === '') contentLines.shift();
  while (contentLines.at(-1)?.trim() === '') contentLines.pop();
  return {
    ...base,
    resultPreview: contentLines.join('\n').trim() || '(no output)',
    ...(handoffPath ? { handoffPath } : {}),
    ...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
  };
};

const parseSingleNotification = (content: string): SubagentNotificationPresentation | undefined => {
  const lines = content.split('\n');
  const match = (lines[0] ?? '').match(
    /^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/,
  );
  if (!match) return undefined;
  return parseNotificationBody(lines.slice(1), {
    agent: match[3] ?? 'unknown',
    status: match[2] as SubagentNotificationPresentation['status'],
    ...(match[1] === 'Detached foreground task' ? { source: 'foreground' as const } : { source: 'async' as const }),
    ...(match[4] ? { taskInfo: match[4] } : {}),
  });
};

const parseGroupedNotifications = (content: string): SubagentNotificationPresentation[] | undefined => {
  const lines = content.split('\n');
  if (!/^Background tasks completed \(\d+\):/.test(lines[0] ?? '')) return undefined;
  const starts: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\d+\.\s+/.test(lines[index] ?? '')) starts.push(index);
  }
  if (starts.length === 0) return undefined;
  return starts.map((start, position) => {
    const heading = (lines[start] ?? '').replace(/^\d+\.\s+/, '');
    const headingMatch = heading.match(/^(.+?)(\s+\(\d+\/\d+\))?$/);
    const end = starts[position + 1] ?? lines.length;
    return parseNotificationBody(lines.slice(start + 1, end), {
      agent: headingMatch?.[1] ?? heading,
      source: 'async',
      status: 'completed',
      ...(headingMatch?.[2] ? { taskInfo: headingMatch[2].trim() } : {}),
    });
  });
};

export const piContentText = (content: string | PiUserContent[]): string => (
  typeof content === 'string'
    ? content
    : content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
);

export const parseSubagentNotifications = (
  content: string,
  details?: JsonValue,
): SubagentNotificationPresentation[] | undefined => {
  if (details !== undefined) {
    const detailItems = Array.isArray(details) ? details : [details];
    const parsed = detailItems.map(notificationFromObject);
    if (parsed.length > 0 && parsed.every((item) => item !== undefined)) {
      return parsed as SubagentNotificationPresentation[];
    }
  }
  const grouped = parseGroupedNotifications(content);
  if (grouped) return grouped;
  const single = parseSingleNotification(content);
  return single ? [single] : undefined;
};

export const parseExtensionStatus = (
  customType: string,
  value: JsonValue | undefined,
): ExtensionStatusPresentation | undefined => {
  if (customType !== 'ctx-status' || !isObject(value)) return undefined;
  const title = stringValue(value.title);
  const text = stringValue(value.text);
  if (!title || text === undefined) return undefined;
  const level = value.level === 'success' || value.level === 'warning' || value.level === 'error'
    ? value.level
    : 'info';
  return {
    level,
    text,
    title,
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
};
