import { describe, expect, test } from 'vitest';

import { DEFAULT_FILE_EDITOR_SETTINGS } from '@/lib/file-editor-settings';
import { createMonacoEditorOptions } from './editor-options';

describe('Monaco editor option projection', () => {
  test('user settings override the profile presentation', () => {
    const options = createMonacoEditorOptions({
      ariaLabel: 'Editor',
      fontSize: 15,
      profileId: 'varin.ide',
      settings: {
        ...DEFAULT_FILE_EDITOR_SETTINGS,
        minimap: 'off',
        stickyScroll: 'off',
        wordWrap: 'on',
      },
    });
    expect(options.fontSize).toBe(15);
    expect(options.wordWrap).toBe('on');
    expect(options.minimap?.enabled).toBe(false);
    expect(options.stickyScroll?.enabled).toBe(false);
  });
});
