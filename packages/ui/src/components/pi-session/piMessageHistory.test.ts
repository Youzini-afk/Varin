import { describe, expect, test } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import { projectPiMessageHistory } from './piMessageHistory';

describe('Pi message history', () => {
  test('returns newest text prompts first and ignores image-only or non-user entries', () => {
    const entries: PiSessionEntry[] = [
      {
        id: 'older',
        message: { content: ' older ', role: 'user', timestamp: 1 },
        parentId: null,
        timestamp: '1',
        type: 'message',
      },
      {
        id: 'assistant',
        message: {
          api: 'messages',
          content: [{ text: 'answer', type: 'text' }],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
          },
        },
        parentId: 'older',
        timestamp: '2',
        type: 'message',
      },
      {
        id: 'image-only',
        message: {
          content: [{ data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' }],
          role: 'user',
          timestamp: 3,
        },
        parentId: 'assistant',
        timestamp: '3',
        type: 'message',
      },
      {
        id: 'newer',
        message: {
          content: [
            { text: 'newer', type: 'text' },
            { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
          ],
          role: 'user',
          timestamp: 4,
        },
        parentId: 'image-only',
        timestamp: '4',
        type: 'message',
      },
    ];

    expect(projectPiMessageHistory(entries)).toEqual(['newer', 'older']);
  });
});
