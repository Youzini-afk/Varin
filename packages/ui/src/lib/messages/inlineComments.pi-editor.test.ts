import { describe, expect, test } from 'vitest';
import { appendInlineComments } from './inlineComments';

const base = {
  createdAt: 1,
  id: 'context-1',
  sessionKey: 'session-a',
  text: '',
};

describe('Pi editor inline contexts', () => {
  test('serializes an active editor selection with its relative path and lines', () => {
    expect(appendInlineComments('Review this', [{
      ...base,
      code: 'const value = 1;',
      endLine: 4,
      fileLabel: 'src/example.ts',
      language: 'ts',
      source: 'editor-selection',
      startLine: 3,
    }])).toBe(
      'Review this\n\nContext from `src/example.ts` lines 3-4:\n```ts\nconst value = 1;\n```',
    );
  });

  test('serializes an active editor file as readable Pi path context', () => {
    expect(appendInlineComments('', [{
      ...base,
      code: 'D:/work/src/example.ts',
      endLine: 0,
      fileLabel: 'src/example.ts',
      language: '',
      source: 'editor-file',
      startLine: 0,
    }])).toBe(
      'Use the active editor file as context:\n- Relative path: src/example.ts\n- Absolute path: D:/work/src/example.ts',
    );
  });

  test('uses a collision-safe fence for editor selections containing Markdown fences', () => {
    expect(appendInlineComments('', [{
      ...base,
      code: '```ts\nconst nested = true;\n```',
      endLine: 4,
      fileLabel: 'README.md',
      language: 'md',
      source: 'editor-selection',
      startLine: 2,
    }])).toContain('````md\n```ts\nconst nested = true;\n```\n````');
  });
});
