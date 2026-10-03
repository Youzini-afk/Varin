import { describe, expect, test } from 'vitest';
import type { ModelDescriptor, SessionSnapshot, ThinkingLevel } from '@varin/protocol';
import { configurePiComposerSession } from './piComposerSessionConfig';

const model = (
  provider: string,
  id: string,
  supportedThinkingLevels: ThinkingLevel[],
): ModelDescriptor => ({
  api: 'test',
  available: true,
  baseUrl: '',
  contextWindow: 100_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ['text'],
  maxTokens: 10_000,
  name: id,
  provider,
  supportedThinkingLevels,
});

const snapshot = (selectedModel = model('default', 'default', ['off'])): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: '/repo',
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  model: selectedModel,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'session-1',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'off',
});

describe('Pi composer session configuration', () => {
  test('applies the selected model before thinking and before the caller sends', async () => {
    const calls: string[] = [];
    const chosen = model('openai', 'gpt-5', ['low', 'high']);
    const result = await configurePiComposerSession(
      snapshot(),
      { model: { id: chosen.id, provider: chosen.provider }, thinkingLevel: 'high' },
      undefined,
      {
        selectModel: async () => {
          calls.push('model');
          return { ...snapshot(chosen), thinkingLevel: 'low' };
        },
        selectThinking: async (_sessionId, level) => {
          calls.push(`thinking:${level}`);
          return { ...snapshot(chosen), thinkingLevel: level };
        },
      },
    );

    expect(calls).toEqual(['model', 'thinking:high']);
    expect(result.model).toEqual(chosen);
    expect(result.thinkingLevel).toBe('high');
  });

  test('uses the Varin project model when the draft inherits', async () => {
    const calls: string[] = [];
    await configurePiComposerSession(
      snapshot(),
      {},
      { id: 'project-model', provider: 'anthropic' },
      {
        selectModel: async (_sessionId, selected) => {
          calls.push(`${selected.provider}/${selected.id}`);
          return snapshot(model(selected.provider, selected.id, ['off']));
        },
        selectThinking: async () => { throw new Error('not expected'); },
      },
    );
    expect(calls).toEqual(['anthropic/project-model']);
  });

  test('does not append model or thinking history for unchanged defaults', async () => {
    const calls: string[] = [];
    const current = model('openai', 'gpt-5', ['low', 'high']);
    const result = await configurePiComposerSession(
      { ...snapshot(current), thinkingLevel: 'high' },
      { thinkingLevel: 'high' },
      { id: current.id, provider: current.provider },
      {
        selectModel: async () => { calls.push('model'); return snapshot(current); },
        selectThinking: async () => { calls.push('thinking'); return snapshot(current); },
      },
    );

    expect(calls).toEqual([]);
    expect(result.model).toEqual(current);
    expect(result.thinkingLevel).toBe('high');
  });

  test('rejects an explicit thinking level unsupported by the selected model', async () => {
    await expect(configurePiComposerSession(
      snapshot(model('openai', 'small', ['off', 'low'])),
      { thinkingLevel: 'max' },
      undefined,
      {
        selectModel: async () => { throw new Error('not expected'); },
        selectThinking: async () => { throw new Error('not expected'); },
      },
    )).rejects.toThrow('does not support max thinking');
  });
});
