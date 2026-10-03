import { describe, expect, test } from 'vitest';

import {
  estimateChatEntryHeight,
  estimateVirtualizedChatItemSize,
  type EstimateRenderEntry,
} from './chatItemSizeEstimate';

const textPart = (text: string) => ({ type: 'text', text });

const message = (role: 'user' | 'assistant', text: string) => ({
  info: { role },
  parts: [textPart(text)],
});

describe('chat virtual item size estimate', () => {
  test('uses a chat-sized default instead of virtua 40px rows', () => {
    expect(estimateVirtualizedChatItemSize([], 'standard')).toBeGreaterThan(180);
    expect(estimateVirtualizedChatItemSize([], 'wide')).toBeGreaterThan(160);
  });

  test('wide layout estimates long markdown rows lower because fewer lines wrap', () => {
    const longText = 'A long assistant paragraph '.repeat(80);
    const entry: EstimateRenderEntry = {
      kind: 'turn',
      turn: {
        userMessage: message('user', 'please review this'),
        assistantMessages: [message('assistant', longText)],
      },
    };

    expect(estimateChatEntryHeight(entry, 'wide')).toBeLessThan(estimateChatEntryHeight(entry, 'standard'));
  });

  test('uses median-biased sizing so one huge row does not dominate a long history', () => {
    const smallEntries: EstimateRenderEntry[] = Array.from({ length: 9 }, (_, index) => ({
      kind: 'turn',
      turn: {
        userMessage: message('user', `question ${index}`),
        assistantMessages: [message('assistant', 'short answer')],
      },
    }));
    const hugeEntry: EstimateRenderEntry = {
      kind: 'turn',
      turn: {
        userMessage: message('user', 'summarize this file'),
        assistantMessages: [message('assistant', 'very large markdown '.repeat(1000))],
      },
    };

    const estimate = estimateVirtualizedChatItemSize([...smallEntries, hugeEntry], 'standard');
    expect(estimate).toBeGreaterThan(112);
    expect(estimate).toBeLessThan(640);
    expect(estimate).toBeLessThan(estimateChatEntryHeight(hugeEntry, 'standard'));
  });

  test('accounts for tool and activity rows when estimating turn height', () => {
    const simple: EstimateRenderEntry = {
      kind: 'turn',
      turn: {
        userMessage: message('user', 'run tests'),
        assistantMessages: [message('assistant', 'done')],
      },
    };
    const withActivity: EstimateRenderEntry = {
      kind: 'turn',
      turn: {
        userMessage: message('user', 'run tests'),
        assistantMessages: [
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'tool', state: { input: { command: 'bun test' }, output: 'pass\n'.repeat(40) } },
              textPart('done'),
            ],
          },
        ],
        activityParts: [{}, {}, {}],
        changedFiles: [{}, {}],
        hasTools: true,
      },
    };

    expect(estimateChatEntryHeight(withActivity, 'standard')).toBeGreaterThan(estimateChatEntryHeight(simple, 'standard'));
  });
});
