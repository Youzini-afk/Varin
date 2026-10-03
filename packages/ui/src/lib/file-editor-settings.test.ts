import { describe, expect, test } from 'vitest';

import {
  DEFAULT_FILE_EDITOR_SETTINGS,
  normalizeFileEditorSettings,
  sanitizeFileEditorSettingsPatch,
} from './file-editor-settings';

describe('file editor settings', () => {
  test('keeps the last valid value for malformed or missing fields', () => {
    const fallback = { ...DEFAULT_FILE_EDITOR_SETTINGS, tabSize: 7, wordWrap: 'off' as const };
    const normalized = normalizeFileEditorSettings({ tabSize: 0, wordWrap: 'sometimes', minimap: 'on' }, fallback);
    expect(normalized.tabSize).toBe(7);
    expect(normalized.wordWrap).toBe('off');
    expect(normalized.minimap).toBe('on');
  });

  test('does not invent an arbitrary upper bound for valid indentation sizes', () => {
    expect(sanitizeFileEditorSettingsPatch({ tabSize: 32 })).toEqual({ tabSize: 32 });
  });

  test('drops unknown settings instead of turning them into persistent authority', () => {
    expect(sanitizeFileEditorSettingsPatch({ futureSetting: true, folding: false })).toEqual({ folding: false });
  });
});
