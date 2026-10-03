import { describe, expect, test } from 'vitest';

import { DEFAULT_FILE_EDITOR_SETTINGS } from '@/lib/file-editor-settings';
import { createMonacoEditorOptions, fileEditorPresentationForProfile } from './editor-options';

describe('Monaco editor option projection', () => {
  test('uses compact and full official presentation presets without changing document state', () => {
    expect(fileEditorPresentationForProfile('default')).toBe('agent-compact');
    expect(fileEditorPresentationForProfile('varin.ide')).toBe('ide-full');
    const agent = createMonacoEditorOptions({
      ariaLabel: 'Editor',
      fontSize: 13,
      profileId: 'default',
      settings: { ...DEFAULT_FILE_EDITOR_SETTINGS },
    });
    const ide = createMonacoEditorOptions({
      ariaLabel: 'Editor',
      fontSize: 13,
      profileId: 'varin.ide',
      settings: { ...DEFAULT_FILE_EDITOR_SETTINGS },
    });
    expect(agent.wordWrap).toBe('on');
    expect(agent.minimap?.enabled).toBe(false);
    expect(agent.stickyScroll?.enabled).toBe(false);
    expect(ide.wordWrap).toBe('off');
    expect(ide.minimap?.enabled).toBe(true);
    expect(ide.stickyScroll?.enabled).toBe(true);
  });

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
