import { describe, expect, test } from 'bun:test';
import type { ModelDescriptor, SessionSnapshot } from '@varin/protocol';
import { nextPiFavoriteModel, nextPiThinkingLevel } from './keyboardActions';

const model = (
  provider: string,
  id: string,
  patch: Partial<ModelDescriptor> = {},
): ModelDescriptor => ({
  api: 'test',
  available: true,
  baseUrl: '',
  contextWindow: 100_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ['text'],
  maxTokens: 8_000,
  name: id,
  provider,
  supportedThinkingLevels: ['off', 'low', 'high'],
  ...patch,
});

const snapshot = (currentModel?: ModelDescriptor): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: 'C:/repo',
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  ...(currentModel ? { model: currentModel } : {}),
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'session-1',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'low',
});

describe('nextPiThinkingLevel', () => {
  test('cycles only through levels supported by the current Pi model', () => {
    expect(nextPiThinkingLevel(snapshot(model('p', 'm')))).toBe('high');
    expect(nextPiThinkingLevel({ ...snapshot(model('p', 'm')), thinkingLevel: 'high' })).toBe('off');
  });

  test('does not send a redundant selection when there is no alternative', () => {
    expect(nextPiThinkingLevel(snapshot(model('p', 'm', { supportedThinkingLevels: ['low'] })))).toBeNull();
    expect(nextPiThinkingLevel(snapshot())).toBeNull();
  });
});

describe('nextPiFavoriteModel', () => {
  const models = [model('one', 'a'), model('two', 'b'), model('three', 'c', { available: false })];
  const favorites = [
    { providerID: 'one', modelID: 'a' },
    { providerID: 'missing', modelID: 'missing' },
    { providerID: 'three', modelID: 'c' },
    { providerID: 'two', modelID: 'b' },
  ];

  test('filters stale and unavailable favorites and wraps in both directions', () => {
    expect(nextPiFavoriteModel(favorites, models, models[0], 1)?.id).toBe('b');
    expect(nextPiFavoriteModel(favorites, models, models[0], -1)?.id).toBe('b');
  });

  test('starts at the first or last available favorite when current is absent', () => {
    expect(nextPiFavoriteModel(favorites, models, undefined, 1)?.id).toBe('a');
    expect(nextPiFavoriteModel(favorites, models, undefined, -1)?.id).toBe('b');
  });
});
