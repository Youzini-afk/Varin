import { afterEach, expect, test, vi } from 'vitest';
import type { UsageSummaryRow } from '@varin/protocol';
import { addCounts, summarize, usageCsv, usageWindow } from './usage-data';

afterEach(() => vi.unstubAllEnvs());
test('date ranges use the actual user calendar across DST and non-hour offsets', () => {
  vi.stubEnv('TZ', 'America/New_York');
  const spring = usageWindow('7d', new Date(2026, 2, 10, 14));
  expect(spring.days).toHaveLength(7);
  expect(spring.days.find(day => day.day === '2026-03-08')!.toMs - spring.days.find(day => day.day === '2026-03-08')!.fromMs).toBe(23 * 3600000);
  vi.stubEnv('TZ', 'Asia/Kathmandu');
  const month = usageWindow('lastMonth', new Date(2026, 2, 10));
  expect(month.days[0]!.day).toBe('2026-02-01'); expect(month.days).toHaveLength(28);
  expect(month.query.utcOffsetMinutes).toBe(345);
});
test('aggregation keeps exact token counts and distinguishes subscription, missing prices and missing measurements', () => {
  const value = { known: '18446744073709551616', missing: 0 };
  expect(addCounts([value, { known: '1', missing: 1 }])).toEqual({ known: '18446744073709551617', missing: 1 });
  const row = { billing: 'metered', measurement: 'actual', priced: true, requests: 1, kind: 'conversation', costUsd: 2, costUnknownRequests: 0, cacheSavedUsd: 0.5,
    currentPriceRequests: 0, completeInputTokens: value, outputTokens: { known: '0', missing: 0 }, cachedInputTokens: value, cacheWriteTokens: value, reasoningTokens: value } as UsageSummaryRow;
  const totals = summarize([row, { ...row, billing: 'subscription', costUsd: 0, referenceUsd: 100 }, { ...row, priced: false, costUsd: 0 }, { ...row, costUsd: 0, costUnknownRequests: 1 }]);
  expect(totals.cost).toBe(2); expect(totals.unpriced).toBe(1); expect(totals.costUnknown).toBe(1); expect(totals.costMissing).toBe(2);
  expect(totals.requests).toBe(4); expect(totals.tokens.known).toBe((BigInt(value.known) * 4n).toString());
});
test('CSV preserves commas, quotes and unknown fields without turning model names into formulas', () => {
  const csv = usageCsv(['model', 'USD'], [['=HYPERLINK("x")', ''], ['model,one', 0]]);
  expect(csv).toContain('"\'=HYPERLINK(""x"")",""'); expect(csv).toContain('"model,one","0"');
});
