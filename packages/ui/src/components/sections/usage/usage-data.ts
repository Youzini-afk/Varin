import type { UsageDay, UsageSummaryRow, UsageTokenCount } from '@varin/protocol';
import type { UsageQuery } from '@varin/application-client';

export type UsageRange = '7d' | '30d' | 'month' | 'lastMonth' | '90d';
export const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/** Calendar arithmetic deliberately uses local midnights, including 23/25-hour DST days. */
export function usageWindow(range: UsageRange, now = new Date()) {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  let start = midnight(now), end = shift(start, 1);
  if (range === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (range === 'lastMonth') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); }
  else start = shift(start, -(Number.parseInt(range) - 1));
  const days: UsageDay[] = [];
  for (let date = start; date < end; date = shift(date, 1)) days.push({ day: dayKey(date), fromMs: +date, toMs: +shift(date, 1) });
  const previousStart = shift(start, -days.length), previousDays: UsageDay[] = [];
  for (let date = previousStart; date < start; date = shift(date, 1)) previousDays.push({ day: dayKey(date), fromMs: +date, toMs: +shift(date, 1) });
  const query: UsageQuery = { fromMs: +previousStart, toMs: +end, utcOffsetMinutes: -now.getTimezoneOffset(), days: [...previousDays, ...days] };
  return { query, days, start: +start, end: +end, firstDay: days[0]!.day, previousDays, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
export function addCounts(values: readonly UsageTokenCount[]): UsageTokenCount {
  let known: bigint | null = null, missing = 0;
  for (const value of values) { if (value.known !== null) known = (known ?? 0n) + BigInt(value.known); missing += value.missing; }
  return { known: known?.toString() ?? null, missing };
}
export const knownCount = (value: UsageTokenCount) => BigInt(value.known ?? '0');
export const tokensOf = (row: UsageSummaryRow) => addCounts([row.completeInputTokens, row.outputTokens]);
export const uncachedOf = (rows: readonly UsageSummaryRow[]) => addCounts(rows.map(row => {
  const values = [row.completeInputTokens, row.cachedInputTokens, row.cacheWriteTokens];
  if (values.some(value => value.known === null || value.missing > 0)) return { known: null, missing: row.requests };
  const result = knownCount(values[0]!) - knownCount(values[1]!) - knownCount(values[2]!);
  return result < 0n ? { known: null, missing: row.requests } : { known: result.toString(), missing: 0 };
}));
export const modelKey = (row: UsageSummaryRow) => JSON.stringify([row.providerId, row.modelId]);
export function summarize(rows: readonly UsageSummaryRow[]) {
  const metered = rows.filter(row => row.billing !== 'subscription' && row.billing !== 'local');
  const tokens = addCounts(rows.map(tokensOf));
  return {
    tokens, input: addCounts(rows.map(row => row.completeInputTokens)), output: addCounts(rows.map(row => row.outputTokens)),
    cached: addCounts(rows.map(row => row.cachedInputTokens)), written: addCounts(rows.map(row => row.cacheWriteTokens)), reasoning: addCounts(rows.map(row => row.reasoningTokens)),
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    missing: rows.filter(row => row.measurement === 'missing').reduce((sum, row) => sum + row.requests, 0),
    estimated: rows.filter(row => row.measurement === 'estimated').reduce((sum, row) => sum + row.requests, 0),
    cost: metered.reduce((sum, row) => sum + row.costUsd, 0),
    costMissing: metered.reduce((sum, row) => sum + (row.priced ? row.costUnknownRequests : row.requests), 0),
    unpriced: metered.filter(row => !row.priced).reduce((sum, row) => sum + row.requests, 0),
    costUnknown: metered.reduce((sum, row) => sum + row.costUnknownRequests, 0),
    saved: metered.reduce((sum, row) => sum + row.cacheSavedUsd, 0),
    currentPrice: rows.reduce((sum, row) => sum + row.currentPriceRequests, 0),
    background: rows.filter(row => row.kind !== 'conversation').reduce((sum, row) => sum + row.costUsd, 0),
  };
}
export function grouped(rows: readonly UsageSummaryRow[], dimension: 'model' | 'channel' | 'purpose') {
  const groups = new Map<string, UsageSummaryRow[]>();
  for (const row of rows) {
    const key = dimension === 'model' ? modelKey(row) : dimension === 'channel' ? row.providerId ?? '' : row.purpose ?? row.kind;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => ({ key, rows, totals: summarize(rows) }));
}
export function seriesColor(key: string) {
  let hash = 0; for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `var(--usage-c${Math.abs(hash) % 6})`;
}
/** CSV uses quoted text and neutralizes spreadsheet formulas from user-owned labels. */
export function usageCsv(header: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => `"${String(typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
