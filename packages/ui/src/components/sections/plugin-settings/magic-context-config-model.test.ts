import { describe, expect, test } from 'vitest';
import {
  MAGIC_CONTEXT_THINKING_LEVELS,
  isValidMagicContextSchedule,
  magicContextAgentExecutionFieldPath,
  magicContextDraftIssue,
  magicContextHasHarnessScopedModels,
  magicContextProjectIgnoredPaths,
  magicContextTaskExecutionFieldPath,
  magicContextUsesHarnessScopedModels,
} from './magic-context-config-model';

describe('Magic Context config model', () => {
  test('matches the plugin numeric five-field cron surface', () => {
    expect(isValidMagicContextSchedule('')).toBe(true);
    expect(isValidMagicContextSchedule('0 3 * * *')).toBe(true);
    expect(isValidMagicContextSchedule('*/15 1-5/2 * * 0,7')).toBe(true);
    expect(isValidMagicContextSchedule('0 3 * *')).toBe(false);
    expect(isValidMagicContextSchedule('0 24 * * *')).toBe(false);
    expect(isValidMagicContextSchedule('0 3 * JAN *')).toBe(false);
  });

  test('reports fields that the plugin strips from project configuration', () => {
    expect(magicContextProjectIgnoredPaths({
      language: 'zh',
      embedding: { endpoint: 'https://example.test', model: 'embed' },
      mural: { enabled: true, model: 'provider/model' },
      historian: {
        model: 'provider/model',
        pi: { model: 'provider/pi-model', thinking_level: 'max' },
        temperature: 0.2,
      },
      dreamer: { prompt: 'unsafe', tasks: {} },
      pi: { subagent_extensions: ['extension.ts'] },
    })).toEqual([
      'language',
      'pi.subagent_extensions',
      'embedding.endpoint',
      'mural.model',
      'historian.model',
      'historian.pi.model',
      'historian.pi.thinking_level',
      'dreamer.prompt',
    ]);
  });

  test('selects the 0.39 Pi harness paths without hiding accepted legacy fields', () => {
    expect(magicContextUsesHarnessScopedModels('0.38.1')).toBe(false);
    expect(magicContextUsesHarnessScopedModels('0.39.0')).toBe(true);
    expect(magicContextUsesHarnessScopedModels('1.0.0')).toBe(true);
    expect(magicContextHasHarnessScopedModels({ historian: { opencode: { model: 'provider/model' } } }))
      .toBe(true);
    expect(MAGIC_CONTEXT_THINKING_LEVELS).toContain('max');

    expect(magicContextAgentExecutionFieldPath({}, 'historian', 'model', true))
      .toEqual(['historian', 'pi', 'model']);
    expect(magicContextAgentExecutionFieldPath({ historian: { model: 'legacy/model' } }, 'historian', 'model', true))
      .toEqual(['historian', 'model']);
    expect(magicContextAgentExecutionFieldPath({
      historian: { model: 'legacy/model', pi: { model: 'provider/model' } },
    }, 'historian', 'model', true)).toEqual(['historian', 'pi', 'model']);
    expect(magicContextAgentExecutionFieldPath({}, 'sidekick', 'model', true))
      .toEqual(['sidekick', 'model']);
    expect(magicContextTaskExecutionFieldPath({}, 'verify', 'model', true))
      .toEqual(['dreamer', 'pi', 'tasks', 'verify', 'model']);
    expect(magicContextTaskExecutionFieldPath({
      dreamer: { tasks: { verify: { model: 'legacy/model' } } },
    }, 'verify', 'model', true)).toEqual(['dreamer', 'tasks', 'verify', 'model']);
    expect(magicContextTaskExecutionFieldPath({
      dreamer: {
        pi: { tasks: { verify: { model: 'provider/model' } } },
        tasks: { verify: { model: 'legacy/model' } },
      },
    }, 'verify', 'model', true)).toEqual(['dreamer', 'pi', 'tasks', 'verify', 'model']);
    expect(magicContextAgentExecutionFieldPath({
      dreamer: { model: 'legacy/model', pi: { fallback_models: ['provider/fallback'] } },
    }, 'dreamer', 'model', true)).toEqual(['dreamer', 'model']);
  });

  test('guards plugin failure cases without rejecting future unknown keys', () => {
    expect(magicContextDraftIssue({
      future_plugin_field: { enabled: true },
      dreamer: { tasks: { verify: { schedule: '0 3 * * *' } } },
    }, 'user')).toBeNull();

    expect(magicContextDraftIssue({
      dreamer: { tasks: { verify: { schedule: 'nightly' } } },
    }, 'user')).toEqual({
      code: 'invalid-schedule',
      field: 'dreamer.tasks.verify.schedule',
    });

    expect(magicContextDraftIssue({
      embedding: { provider: 'openai-compatible', model: 'embed-v1' },
    }, 'user')).toEqual({
      code: 'embedding-required',
      field: 'embedding.endpoint',
    });

    expect(magicContextDraftIssue({
      embedding: { provider: 'openai-compatible' },
      historian: { model: 42, fallback_models: [42] },
      language: 'repository-owned-value-is-ignored',
    }, 'project')).toBeNull();
  });

  test('rejects invalid values for structured fields exposed by the editor', () => {
    expect(magicContextDraftIssue({
      memory: { enabled: 'yes' },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'memory.enabled',
    });
    expect(magicContextDraftIssue({
      mural: { model: '  ' },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'mural.model',
    });
    expect(magicContextDraftIssue({
      system_prompt_injection: { skip_signatures: [42] },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'system_prompt_injection.skip_signatures',
    });
    expect(magicContextDraftIssue({
      embedding: { provider: 42 },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'embedding.provider',
    });
  });

  test('rejects malformed polymorphic maps while allowing valid model overrides', () => {
    expect(magicContextDraftIssue({
      cache_ttl: { default: '5m', 'provider/model': '10m' },
      execute_threshold_percentage: { default: 65, 'provider/model': 70 },
      execute_threshold_tokens: { 'provider/model': 120000 },
    }, 'user')).toBeNull();

    expect(magicContextDraftIssue({ cache_ttl: { 'provider/model': '10m' } }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'cache_ttl',
    });
    expect(magicContextDraftIssue({
      execute_threshold_percentage: { default: 65, 'provider/model': 91 },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'execute_threshold_percentage',
    });
  });

  test('catches invalid known agent fields because the plugin drops that whole block', () => {
    expect(magicContextDraftIssue({
      dreamer: { fallback_models: [42], tasks: {} },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'dreamer.fallback_models',
    });
    expect(magicContextDraftIssue({
      sidekick: { permission: { bash: { 'git *': 'sometimes' } } },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'sidekick.permission.bash',
    });

    expect(magicContextDraftIssue({
      historian: {
        pi: {
          model: { model: 'provider/model', thinking_level: 'max' },
          fallback_models: ['provider/fallback'],
          thinking_level: 'high',
        },
      },
      dreamer: {
        pi: { tasks: { verify: { timeout_minutes: 15 } } },
        tasks: { verify: { schedule: '0 3 * * *' } },
      },
    }, 'user')).toBeNull();
    expect(magicContextDraftIssue({
      dreamer: { pi: { fallback_models: 'provider/fallback' } },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'dreamer.pi.fallback_models',
    });
  });
});
