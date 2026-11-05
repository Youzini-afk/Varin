import { expect, it } from 'vitest';
import type { ExternalTurn } from '@varin/application-client';
import { externalCacheRate, externalUsageSummary } from './externalUsage';
const turn = (id: string, usage?: ExternalTurn['usage']): ExternalTurn => ({
  id, conversationId: 'session', key: id, status: 'completed', createdAt: 1, updatedAt: 1, usage,
});
const usage = (input: number, scope: NonNullable<ExternalTurn['usage']>['scope'] = 'turn') => ({
  input, output: input / 10, cachedInput: input / 2, cacheCreated: 0, inputIncludesCache: true, scope,
});

it('replaces cumulative snapshots, adds only later turn totals and never adds last-request snapshots', () => {
  const turns = [turn('a', usage(100)), turn('b', usage(400, 'conversation')),
    turn('c', usage(50)), turn('d', usage(500, 'conversation')), turn('e', usage(20)),
    turn('f', usage(10, 'last_request')), turn('g', usage(30, 'last_request'))];
  expect(externalUsageSummary(turns)).toEqual({ total: usage(520, 'conversation'),
    lastRequest: usage(30, 'last_request'), complete: false });
  expect(externalUsageSummary([...turns, turn('h', usage(600, 'conversation'))])).toEqual({
    total: usage(600, 'conversation'), lastRequest: undefined, complete: true,
  });
});

it('does not double-count repeated receipt identity or hide missing reporting behind zero', () => {
  expect(externalUsageSummary([turn('a', usage(20)), turn('a', usage(30))]).total?.input).toBe(30);
  const partial = externalUsageSummary([turn('unknown'), turn('a', usage(30))]);
  expect(partial.complete).toBe(false);
  expect(partial.total?.input).toBe(30);
  expect(externalUsageSummary([turn('unknown', { input: 100 })]).total).toBeUndefined();
  expect(externalUsageSummary([turn('zero', usage(0))]).total?.input).toBe(0);
  const missingCache = externalUsageSummary([turn('a', usage(20)), turn('b', { input: 20, scope: 'turn', inputIncludesCache: true })]);
  expect(missingCache.total?.input).toBe(40);
  expect(missingCache.total?.cachedInput).toBeUndefined();
});

it('never combines incompatible input conventions or fabricates cache rates', () => {
  const summary = externalUsageSummary([turn('a', usage(100)), turn('b', { ...usage(100), inputIncludesCache: false })]);
  expect(summary.total?.input).toBeUndefined();
  expect(summary.total?.output).toBe(20);
  expect(externalCacheRate(summary.total!)).toBeUndefined();
  expect(externalCacheRate(usage(100))).toBe(50);
  expect(externalCacheRate({ input: 100, cachedInput: 0, inputIncludesCache: true })).toBe(0);
  expect(externalCacheRate({ input: 100, cachedInput: 0, inputIncludesCache: false })).toBeUndefined();
  expect(externalCacheRate({ input: 100, cachedInput: 50, cacheCreated: 50, inputIncludesCache: false })).toBe(25);
  expect(externalCacheRate({ input: 100, cachedInput: 110, inputIncludesCache: true })).toBeUndefined();
  expect(externalUsageSummary([turn('invalid', { ...usage(10), input: -1, output: Number.NaN })]).total?.input).toBeUndefined();
});

it('omits imprecise sums and empty aggregates rather than manufacturing counters', () => {
  expect(externalUsageSummary([turn('empty', { scope: 'conversation' })]).total).toBeUndefined();
  const result = externalUsageSummary([turn('huge', { input: Number.MAX_SAFE_INTEGER, scope: 'turn' }),
    turn('extra', { input: 1, scope: 'turn' })]);
  expect(result.total).toBeUndefined();
  expect(externalCacheRate({ input: Number.MAX_SAFE_INTEGER, cachedInput: 1, cacheCreated: 0, inputIncludesCache: false })).toBeUndefined();
});
