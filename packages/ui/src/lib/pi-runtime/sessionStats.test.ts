import { describe, expect, test } from 'vitest';
import type { SessionSnapshot, SessionStats } from '@varin/protocol';
import { piSessionContextUsage } from './sessionStats';

const snapshot: SessionSnapshot = {
  activeTools: [],
  busy: false,
  cwd: 'D:/work',
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: 'entry-a',
  model: {
    api: 'messages',
    available: true,
    baseUrl: 'https://example.com',
    contextWindow: 200000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'model',
    input: ['text'],
    maxTokens: 32000,
    name: 'Model',
    provider: 'provider',
    supportedThinkingLevels: ['medium'],
  },
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'session-a',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'medium',
};

const stats = (contextUsage: SessionStats['contextUsage']): SessionStats => ({
  assistantMessages: 1,
  contextUsage,
  cost: 0,
  sessionId: 'session-a',
  tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  userMessages: 1,
});

describe('piSessionContextUsage', () => {
  test('projects Pi context stats with model output metadata', () => {
    expect(piSessionContextUsage(stats({
      contextWindow: 200000,
      percent: 6.25,
      tokens: 12500,
    }), snapshot)).toEqual({
      contextLimit: 200000,
      lastMessageId: 'entry-a',
      outputLimit: 32000,
      percentage: 6.25,
      thresholdLimit: 200000,
      totalTokens: 12500,
    });
  });

  test('falls back to the selected model window and computes a missing percentage', () => {
    expect(piSessionContextUsage(stats({ percent: null, tokens: 10000 }), snapshot)?.percentage).toBe(5);
  });

  test('does not invent usage while Pi reports unknown tokens', () => {
    expect(piSessionContextUsage(stats({ contextWindow: 200000, percent: null, tokens: null }), snapshot)).toBeNull();
    expect(piSessionContextUsage(stats(null), snapshot)).toBeNull();
  });
});
