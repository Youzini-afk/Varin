import { describe, expect, test } from 'vitest';

import { splitDynamicTailEntries } from './splitDynamicTailEntries';

describe('splitDynamicTailEntries', () => {
  test('renders a short active streaming entry through the dynamic tail', () => {
    const entries = ['old-turn', 'streaming-turn'];
    const result = splitDynamicTailEntries({
      allEntries: entries,
      staticRenderEntries: ['old-turn'],
      trailingStreamingEntry: 'streaming-turn',
      activeStreamingMessageId: 'assistant_1',
      shouldSplitDynamicTail: false,
      dynamicTailCount: 12,
    });

    expect(result.historyEntries).toEqual(['old-turn']);
    expect(result.dynamicTailEntries).toEqual(['streaming-turn']);
  });

  test('keeps short non-streaming lists static', () => {
    const entries = ['old-turn', 'last-turn'];
    const result = splitDynamicTailEntries({
      allEntries: entries,
      staticRenderEntries: ['old-turn'],
      trailingStreamingEntry: 'last-turn',
      activeStreamingMessageId: null,
      shouldSplitDynamicTail: false,
      dynamicTailCount: 12,
    });

    expect(result.historyEntries).toBe(entries);
    expect(result.dynamicTailEntries).toEqual([]);
  });

  test('uses the configured tail window for long lists', () => {
    const entries = Array.from({ length: 20 }, (_, index) => `turn-${index}`);
    const result = splitDynamicTailEntries({
      allEntries: entries,
      staticRenderEntries: entries.slice(0, -1),
      trailingStreamingEntry: entries[19],
      activeStreamingMessageId: 'assistant_1',
      shouldSplitDynamicTail: true,
      dynamicTailCount: 5,
    });

    expect(result.historyEntries).toEqual(entries.slice(0, -5));
    expect(result.dynamicTailEntries).toEqual(entries.slice(-5));
  });
});
