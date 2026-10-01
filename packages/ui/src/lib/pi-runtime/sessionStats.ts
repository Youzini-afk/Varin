import type { JsonValue, SessionSnapshot, SessionStats } from '@varin/protocol';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';

const finiteNumber = (value: JsonValue | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const piSessionContextUsage = (
  stats: SessionStats | undefined,
  snapshot: SessionSnapshot | undefined,
): SessionContextUsage | null => {
  const raw = stats?.contextUsage;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const record = raw as Record<string, JsonValue>;
  const tokens = finiteNumber(record.tokens);
  const reportedWindow = finiteNumber(record.contextWindow);
  const contextLimit = reportedWindow && reportedWindow > 0
    ? reportedWindow
    : (snapshot?.routedModel?.model.contextWindow ?? snapshot?.model?.contextWindow ?? 0);
  if (tokens === null || tokens < 0 || contextLimit <= 0) return null;

  const reportedPercent = finiteNumber(record.percent);
  const percentage = reportedPercent === null
    ? (tokens / contextLimit) * 100
    : Math.max(0, reportedPercent);
  const outputLimit = snapshot?.routedModel?.model.maxTokens ?? snapshot?.model?.maxTokens;

  return {
    contextLimit,
    ...(snapshot?.leafId ? { lastMessageId: snapshot.leafId } : {}),
    ...(outputLimit === undefined ? {} : { outputLimit }),
    percentage,
    thresholdLimit: contextLimit,
    totalTokens: tokens,
  };
};
