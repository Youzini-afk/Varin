import { describe, expect, test } from 'vitest';
import { insertPiComposerMention } from './piComposerMentions';

describe('Pi composer mentions', () => {
  test('replaces the active mention query and preserves following text', () => {
    expect(insertPiComposerMention('review @src/re later', 14, 'src/runtime.ts')).toEqual({
      cursor: 23,
      text: 'review @src/runtime.ts later',
    });
  });

  test('inserts at the caret when there is no active mention', () => {
    expect(insertPiComposerMention('review later', 7, '@scout')).toEqual({
      cursor: 14,
      text: 'review @scout later',
    });
  });
});
