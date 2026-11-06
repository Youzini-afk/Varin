import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConversationModel } from '../src/default-conversation-model.js';
import type { ThreadModelInfo } from '../src/threads.js';

const models: ThreadModelInfo[] = [
  { providerId: 'first', modelId: 'fast', thinkingLevels: ['off', 'low'] },
  { providerId: 'preferred', modelId: 'strong', thinkingLevels: ['low', 'high'] },
];

test('inherits the configured conversation model and its supported thinking level', () => {
  assert.deepEqual(defaultConversationModel({ defaultProvider: 'preferred', defaultModel: 'strong', defaultThinkingLevel: 'high' }, models),
    { providerId: 'preferred', modelId: 'strong', thinkingLevel: 'high' });
});

test('chooses the first available chat model without inventing a selection for an empty catalog', () => {
  assert.deepEqual(defaultConversationModel({ defaultThinkingLevel: 'low' }, models),
    { providerId: 'first', modelId: 'fast', thinkingLevel: 'low' });
  assert.equal(defaultConversationModel({}, []), null);
});

test('keeps the configured provider when possible and adapts thinking to the chosen model', () => {
  assert.deepEqual(defaultConversationModel({ defaultProvider: 'preferred', defaultModel: 'removed', defaultThinkingLevel: 'off' }, models),
    { providerId: 'preferred', modelId: 'strong', thinkingLevel: 'low' });
});
