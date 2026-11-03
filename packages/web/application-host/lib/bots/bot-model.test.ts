import { expect, it } from 'vitest';
import type { ThreadModelInfo } from '@varin/application-client';
import { botModelMatches, resolveBotModelSelection } from './bot-model.js';

const models: ThreadModelInfo[] = [{ providerId: 'channel', modelId: 'alias', thinkingLevels: ['off', 'high'] }];
it('resolves profile thinking and inherited defaults, and detects thinking-only changes with model aliases', () => {
  const high = resolveBotModelSelection({ providerId: 'channel', modelId: 'alias', thinkingLevel: 'high' }, {}, models)!;
  expect(high.thinkingLevel).toBe('high');
  expect(botModelMatches({ providerId: 'channel', model: 'upstream', catalogModelId: 'alias', thinkingLevel: 'off' }, high)).toBe(false);
  expect(botModelMatches({ providerId: 'channel', model: 'upstream', catalogModelId: 'alias', thinkingLevel: 'high' }, high)).toBe(true);
  expect(resolveBotModelSelection({ providerId: 'channel', modelId: 'alias' }, {}, models)?.thinkingLevel).toBe('off');
  expect(resolveBotModelSelection(null, { defaultProvider: 'channel', defaultModel: 'alias', defaultThinkingLevel: 'high' }, models)).toEqual(high);
  expect(() => resolveBotModelSelection({ ...high, thinkingLevel: 'max' }, {}, models)).toThrow('thinking level is unavailable');
});
