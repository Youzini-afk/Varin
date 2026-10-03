import { describe, expect, test } from 'vitest';
import type { PiSessionEntry, PiUsage } from '@varin/protocol';
import {
  aggregatePiUsage,
  assistantMessageKey,
  assistantMessagesForTurn,
  assistantTokensPerSecond,
  latestAssistantTurnUsage,
  projectPiUsagePresentation,
} from './usagePresentation';

const usage = (update: Partial<PiUsage> = {}): PiUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
  ...update,
});

describe('Pi usage presentation', () => {
  test('shows only positive upstream fields and keeps the provider total authoritative', () => {
    const result = projectPiUsagePresentation(usage({
      cacheRead: 8_000,
      input: 2_000,
      output: 500,
      totalTokens: 10_500,
    }));
    expect(result?.metrics).toEqual([
      { key: 'input', value: 2_000 },
      { key: 'output', value: 500 },
      { key: 'cacheRead', value: 8_000 },
    ]);
    expect(result?.total).toBe(10_500);
    expect(result?.cacheHitPercent).toBe(80);
  });

  test('keeps optional reasoning and one-hour cache writes without inventing missing fields', () => {
    expect(projectPiUsagePresentation(usage({
      cacheWrite: 20,
      cacheWrite1h: 12,
      reasoning: 30,
      totalTokens: 50,
    }))?.metrics).toEqual([
      { key: 'reasoning', value: 30 },
      { key: 'cacheWrite', value: 20 },
      { key: 'cacheWrite1h', value: 12 },
    ]);
    expect(projectPiUsagePresentation(usage())).toBeUndefined();
  });

  test('sums every model call in one assistant response without losing cache or reasoning fields', () => {
    expect(aggregatePiUsage([
      usage({
        cacheRead: 1_000,
        cost: { cacheRead: 1, cacheWrite: 0, input: 2, output: 3, total: 6 },
        input: 9_000,
        output: 400,
        reasoning: 100,
        totalTokens: 10_400,
      }),
      usage({
        cacheRead: 9_900,
        cacheWrite: 50,
        cacheWrite1h: 20,
        cost: { cacheRead: 2, cacheWrite: 1, input: 1, output: 1, total: 5 },
        input: 100,
        output: 30,
        reasoning: 20,
        totalTokens: 10_080,
      }),
    ])).toEqual({
      cacheRead: 10_900,
      cacheWrite: 50,
      cacheWrite1h: 20,
      cost: { cacheRead: 3, cacheWrite: 1, input: 3, output: 4, total: 11 },
      input: 9_100,
      output: 430,
      reasoning: 120,
      totalTokens: 20_480,
    });
  });

  test('aggregates the latest user turn and ignores tool-result or summary usage', () => {
    const oldUsage = usage({ input: 999, totalTokens: 999 });
    const toolCallUsage = usage({ cacheRead: 5, input: 10, output: 4, totalTokens: 19 });
    const finalUsage = usage({ cacheRead: 7, input: 3, output: 2, totalTokens: 12 });
    const unrelatedUsage = usage({ input: 5_000, totalTokens: 5_000 });
    const entries: PiSessionEntry[] = [
      {
        id: 'old-assistant',
        message: {
          api: 'messages',
          content: [],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: 1,
          usage: oldUsage,
        },
        parentId: null,
        timestamp: '1',
        type: 'message',
      },
      {
        id: 'user',
        message: { content: [], role: 'user', timestamp: 2 },
        parentId: 'old-assistant',
        timestamp: '2',
        type: 'message',
      },
      {
        id: 'tool-call',
        message: {
          api: 'messages',
          content: [],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'toolUse',
          timestamp: 3,
          usage: toolCallUsage,
        },
        parentId: 'user',
        timestamp: '3',
        type: 'message',
      },
      {
        id: 'tool-result',
        message: {
          content: [],
          isError: false,
          role: 'toolResult',
          timestamp: 4,
          toolCallId: 'call',
          toolName: 'read',
          usage: unrelatedUsage,
        },
        parentId: 'tool-call',
        timestamp: '4',
        type: 'message',
      },
      {
        id: 'final-assistant',
        message: {
          api: 'messages',
          content: [],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: 5,
          usage: finalUsage,
        },
        parentId: 'tool-result',
        timestamp: '5',
        type: 'message',
      },
      {
        details: {},
        firstKeptEntryId: 'final-assistant',
        id: 'compaction',
        parentId: 'final-assistant',
        summary: 'summary',
        timestamp: '6',
        tokensBefore: 999,
        type: 'compaction',
        usage: unrelatedUsage,
      },
    ];
    expect(latestAssistantTurnUsage(entries)).toEqual({
      cacheRead: 12,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 13,
      output: 6,
      totalTokens: 31,
    });
    const calls = assistantMessagesForTurn(entries)
      .filter((message) => message.timestamp === 3 || message.timestamp === 5);
    expect(assistantTokensPerSecond(entries, undefined, {
      [assistantMessageKey(calls[0]!)]: 100,
      [assistantMessageKey(calls[1]!)]: 1000,
    })).toBe(21);
  });

  test('averages measured output rates across multiple model calls', () => {
    const first = {
      api: 'messages', content: [], model: 'model-a', provider: 'provider', role: 'assistant' as const,
      stopReason: 'toolUse' as const, timestamp: 10, usage: usage({ output: 100 }),
    };
    const second = {
      api: 'messages', content: [], model: 'model-b', provider: 'provider', role: 'assistant' as const,
      stopReason: 'stop' as const, timestamp: 20, usage: usage({ output: 50 }),
    };
    const entries: PiSessionEntry[] = [
      { id: 'first', message: first, parentId: null, timestamp: '10', type: 'message' },
      { id: 'second', message: second, parentId: 'first', timestamp: '20', type: 'message' },
    ];
    expect(assistantTokensPerSecond(entries, undefined, {
      [assistantMessageKey(first)]: 1_000,
      [assistantMessageKey(second)]: 2_000,
    })).toBe(62.5);
  });
});
