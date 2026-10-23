import type { ChatAssistantMessage, ChatSessionEntry, ChatUsage } from './types';

export type ChatUsageMetricKey =
  | 'input'
  | 'output'
  | 'reasoning'
  | 'cacheRead'
  | 'cacheWrite'
  | 'cacheWrite1h';

export interface ChatUsageMetric {
  key: ChatUsageMetricKey;
  value: number;
}

export interface ChatUsagePresentation {
  cacheHitPercent?: number;
  metrics: ChatUsageMetric[];
  total?: number;
  values: {
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    input: number;
    output: number;
    reasoning: number;
    total: number;
  };
}

const positive = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

export const projectChatUsagePresentation = (
  usage: ChatUsage | undefined,
): ChatUsagePresentation | undefined => {
  if (!usage) return undefined;
  const values = {
    cacheRead: positive(usage.cacheRead),
    cacheWrite: positive(usage.cacheWrite),
    cacheWrite1h: positive(usage.cacheWrite1h),
    input: positive(usage.input),
    output: positive(usage.output),
    reasoning: positive(usage.reasoning),
    total: positive(usage.totalTokens),
  };
  const fields = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;
  const metrics: ChatUsageMetric[] = fields.flatMap(key => usage[key] === undefined || key.startsWith('cache') && positive(usage[key]) === 0 ? [] : [{ key, value: usage[key]! }]);
  const input = positive(usage.completeInput), cached = positive(usage.cacheRead);
  const cacheHitPercent = usage.unknownReceipts === 0 && input > 0 && cached > 0 && cached <= input ? cached / input * 100 : undefined;
  return { metrics, values, ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }), ...(usage.totalTokens === undefined ? {} : { total: usage.totalTokens }) };
};

export const aggregateChatUsage = (usages: readonly ChatUsage[]): ChatUsage | undefined => {
  if (!usages.length) return undefined;
  const measurement = usages[0].measurement;
  // Actual and estimated measurements have separate presentation rows.
  const seen = new Set<string>();
  const values = usages.filter(usage => {
    if (usage.measurement !== measurement || (usage.requestId && seen.has(usage.requestId))) return false;
    if (usage.requestId) seen.add(usage.requestId);
    return true;
  });
  const result: ChatUsage = { measurement, unknownReceipts: values.reduce((total, usage) => total + usage.unknownReceipts, 0) };
  for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'totalTokens'] as const) {
    const known = values.flatMap(usage => usage[key] === undefined ? [] : [usage[key]!]);
    if (known.length) result[key] = known.reduce((a, b) => a + b, 0);
  }
  // Do not turn absent cache reports into zero or average per-request rates.
  if (values.every(usage => Number.isFinite(usage.completeInput) && usage.completeInput! >= 0
    && Number.isFinite(usage.cacheRead) && usage.cacheRead! >= 0 && usage.cacheRead! <= usage.completeInput!)) {
    result.completeInput = values.reduce((total, usage) => total + usage.completeInput!, 0);
  }
  return result;
};

export const assistantMessagesForTurn = (
  entries: readonly ChatSessionEntry[],
  liveAssistant?: ChatAssistantMessage,
): ChatAssistantMessage[] => {
  const messages = entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
      ? [entry.message]
      : []
  ));
  if (liveAssistant) messages.push(liveAssistant);
  return messages;
};

export const assistantMessageKey = (message: Pick<ChatAssistantMessage, 'model' | 'provider' | 'timestamp'>): string => (
  `${message.timestamp}:${message.provider}:${message.model}`
);

export const aggregateAssistantUsage = (
  entries: readonly ChatSessionEntry[],
  liveAssistant?: ChatAssistantMessage,
): ChatUsage | undefined => aggregateChatUsage(
  assistantMessagesForTurn(entries, liveAssistant).flatMap((message) => message.usage ? [message.usage] : []),
);

export const assistantTokensPerSecond = (
  entries: readonly ChatSessionEntry[],
  liveAssistant?: ChatAssistantMessage,
  outputDurationsMs?: Readonly<Record<string, number>>,
): number | undefined => {
  const assistants = assistantMessagesForTurn(entries, liveAssistant);
  if (!outputDurationsMs) return undefined;
  const rates = assistants.flatMap((message) => {
    const outputTokens = positive(message.usage?.output);
    const durationMs = outputDurationsMs[assistantMessageKey(message)];
    if (outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return [];
    return [outputTokens / (durationMs / 1000)];
  });
  return rates.length > 0 ? rates.reduce((total, rate) => total + rate, 0) / rates.length : undefined;
};

export const latestAssistantTurnUsage = (
  entries: readonly ChatSessionEntry[],
): ChatUsage | undefined => {
  let turnStart = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === 'message' && entry.message.role === 'user') {
      turnStart = index + 1;
      break;
    }
  }
  return aggregateAssistantUsage(entries.slice(turnStart));
};
