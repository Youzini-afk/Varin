import { describe, expect, test } from 'vitest';
import type { PiAssistantMessage, PiSessionMessageEntry } from '@varin/protocol';
import { PI_SORTED_LIVE_ASSISTANT_ID, projectPiSortedTurn } from './piSortedTurnProjection';

const assistant = (
  content: PiAssistantMessage['content'],
  stopReason: PiAssistantMessage['stopReason'],
  timestamp: number,
): PiAssistantMessage => ({
  api: 'messages',
  content,
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason,
  timestamp,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const entry = (id: string, message: PiAssistantMessage): PiSessionMessageEntry => ({
  id,
  message,
  parentId: null,
  timestamp: String(message.timestamp),
  type: 'message',
});

describe('Pi sorted turn projection', () => {
  test('keeps live thinking and tools in activity while withholding unfinished answer text', () => {
    const live = assistant([
      { thinking: 'checking the repository', type: 'thinking' },
      { text: 'I am still composing the answer', type: 'text' },
    ], 'pending', 2);
    const projection = projectPiSortedTurn([], live);

    expect(projection.activityAnchorId).toBe(PI_SORTED_LIVE_ASSISTANT_ID);
    expect(projection.activity.map((item) => item.kind)).toEqual(['thinking']);
    expect(projection.activity[0]?.streaming).toBe(false);
    expect(projection.answersBySourceId.size).toBe(0);
  });

  test('only the trailing thinking block remains live while reasoning arrives', () => {
    const live = assistant([
      { thinking: 'first thought', type: 'thinking' },
      { thinking: 'second thought', type: 'thinking' },
    ], 'pending', 2);
    const projection = projectPiSortedTurn([], live);

    expect(projection.activity.map((item) => item.streaming)).toEqual([false, true]);
  });

  test('classifies tool-use text as justification and preserves source order', () => {
    const toolUse = assistant([
      { text: 'I will inspect the file first.', type: 'text' },
      { arguments: { path: 'README.md' }, id: 'read-1', name: 'read', type: 'toolCall' },
    ], 'toolUse', 2);
    const projection = projectPiSortedTurn([entry('assistant-tool', toolUse)]);

    expect(projection.activityAnchorId).toBe('assistant-tool');
    expect(projection.activity.map((item) => item.kind)).toEqual(['justification', 'tool']);
    expect(projection.answersBySourceId.size).toBe(0);
  });

  test('separates the terminal answer from earlier activity', () => {
    const toolUse = assistant([
      { thinking: 'locating the problem', type: 'thinking' },
      { arguments: {}, id: 'tool-1', name: 'grep', type: 'toolCall' },
    ], 'toolUse', 2);
    const final = assistant([
      { thinking: 'the evidence is sufficient', type: 'thinking' },
      { text: 'The setting is now implemented.', type: 'text' },
    ], 'stop', 3);
    const projection = projectPiSortedTurn([
      entry('assistant-tool', toolUse),
      entry('assistant-final', final),
    ]);

    expect(projection.activity.map((item) => item.kind)).toEqual(['thinking', 'tool', 'thinking']);
    expect(projection.answersBySourceId.get('assistant-final')?.content).toEqual([
      { text: 'The setting is now implemented.', type: 'text' },
    ]);
  });
});
