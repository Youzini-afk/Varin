import { describe, expect, test } from 'vitest';
import {
  parsePluginTextObjectDraft,
  isPluginDraftActionCurrent,
  pluginTextDraftSourceKey,
  preservePluginDraftOnFailure,
  reconcilePluginDraftExternalChange,
  shouldApplyPluginDraftReload,
} from './usePluginConfigDraft';

describe('plugin text draft recovery', () => {
  test('includes the declared authority format in the draft source identity', () => {
    const common = {
      authority: 'aft-user' as const,
      runtimeTarget: { cwd: '/workspace' } as const,
      targetKey: 'aft:user',
    };

    expect(pluginTextDraftSourceKey({ ...common, format: 'jsonc' })).toBe('authority:jsonc:aft-user');
    expect(pluginTextDraftSourceKey({ ...common, format: 'json' })).toBe('authority:json:aft-user');
  });

  test('keeps an invalid JSONC document repairable instead of treating it as a load failure', () => {
    const result = parsePluginTextObjectDraft('{\n  // keep me\n  "enabled": true,,\n}\n', 'jsonc');

    expect(result.draft).toEqual({});
    expect(result.rawError).toContain('at offset');
  });

  test('returns the repaired object after the raw editor becomes valid', () => {
    const result = parsePluginTextObjectDraft('{\n  // keep me\n  "enabled": true,\n}\n', 'jsonc');

    expect(result).toEqual({ draft: { enabled: true }, rawError: null });
  });

  test('rejects a strict JSON BOM on load and keeps save blocked until the BOM is edited out', () => {
    const bomDocument = `\uFEFF{\n  "enabled": true\n}\n`;
    const loaded = parsePluginTextObjectDraft(bomDocument, 'json');
    const edited = parsePluginTextObjectDraft(bomDocument.replace(/^\uFEFF/, ''), 'json');
    const jsoncWithBom = parsePluginTextObjectDraft(bomDocument, 'jsonc');

    expect(loaded.rawError).not.toBeNull();
    expect(loaded.draft).toEqual({});
    expect(edited).toEqual({ draft: { enabled: true }, rawError: null });
    expect(jsoncWithBom).toEqual({ draft: { enabled: true }, rawError: null });
  });
});

describe('plugin draft refresh reconciliation', () => {
  test('does not apply an automatic reload after the draft changes in flight', () => {
    expect(shouldApplyPluginDraftReload({ preserveNewerDraft: true }, 3, 4)).toBe(false);
    expect(shouldApplyPluginDraftReload({ preserveNewerDraft: true }, 3, 3)).toBe(true);
  });

  test('rejects every load response when the draft changes in flight', () => {
    expect(shouldApplyPluginDraftReload({}, 3, 4)).toBe(false);
    expect(shouldApplyPluginDraftReload({}, 3, 3)).toBe(true);
  });

  test('reloads a clean draft but preserves a dirty draft on external invalidation', () => {
    expect(reconcilePluginDraftExternalChange(false, 'rename')).toBe('reload');
    expect(reconcilePluginDraftExternalChange(true, 'change')).toBe('preserve-dirty');
    expect(reconcilePluginDraftExternalChange(false, 'error')).toBe('preserve-watch-error');
  });

  test('rejects stale runtime, target, and watch generations', () => {
    const action = { generation: 4, runtimeKey: 'runtime-a', targetKey: 'project-a' };
    expect(isPluginDraftActionCurrent(action, action)).toBe(true);
    expect(isPluginDraftActionCurrent(action, { ...action, generation: 5 })).toBe(false);
    expect(isPluginDraftActionCurrent(action, { ...action, runtimeKey: 'runtime-b' })).toBe(false);
    expect(isPluginDraftActionCurrent(action, { ...action, targetKey: 'project-b' })).toBe(false);
  });

  test('preserves the last valid draft and source when an authoritative read fails', () => {
    const previous = {
      draft: { enabled: true },
      error: null,
      loaded: true,
      loading: true,
      source: { enabled: true },
    };
    expect(preservePluginDraftOnFailure(previous, 'read failed')).toEqual({
      ...previous,
      error: 'read failed',
      loading: false,
    });
  });
});
