import { describe, expect, test } from 'vitest';
import type { PiSettingsSnapshot } from '@varin/protocol';
import { resolvePiComposerDefaults } from './usePiComposerDefaults';

const snapshot = (global: PiSettingsSnapshot['global'], project: PiSettingsSnapshot['project']): PiSettingsSnapshot => ({
  global,
  globalRevision: 'global',
  project,
  projectRevision: 'project',
  projectTrusted: true,
});

describe('Pi composer defaults', () => {
  test('projects override global Pi defaults', () => {
    expect(resolvePiComposerDefaults(snapshot(
      { defaultModel: 'global-model', defaultProvider: 'global', defaultThinkingLevel: 'low' },
      { defaultModel: 'project-model', defaultProvider: 'project', defaultThinkingLevel: 'high' },
    ))).toEqual({
      model: { id: 'project-model', provider: 'project' },
      thinkingLevel: 'high',
    });
  });

  test('Varin project metadata wins only for the model', () => {
    expect(resolvePiComposerDefaults(snapshot(
      { defaultModel: 'global-model', defaultProvider: 'global', defaultThinkingLevel: 'medium' },
      {},
    ), 'anthropic/claude-sonnet')).toEqual({
      model: { id: 'claude-sonnet', provider: 'anthropic' },
      thinkingLevel: 'medium',
    });
  });

  test('ignores malformed defaults instead of inventing a model or thinking level', () => {
    expect(resolvePiComposerDefaults(snapshot(
      { defaultModel: 'model-only', defaultThinkingLevel: 'turbo' },
      {},
    ), 'missing-separator')).toEqual({});
  });
});
