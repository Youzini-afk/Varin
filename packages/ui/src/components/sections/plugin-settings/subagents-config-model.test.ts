import { describe, expect, test } from 'vitest';
import {
  subagentsRuntimeDraftIssue,
  subagentsSettingsDraftIssue,
} from './subagents-config-model';

describe('subagents config model', () => {
  test('requires an allow list when model scope enforcement is enabled', () => {
    expect(subagentsSettingsDraftIssue({ modelScope: { enforce: true } })).toEqual({
      code: 'model-scope-allow-required',
      field: 'modelScope.allow',
    });
    expect(subagentsSettingsDraftIssue({
      modelScope: { allow: ['openai/*'], enforce: true },
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({ modelScope: { allow: [] } })).toEqual({
      code: 'model-scope-allow-required',
      field: 'modelScope.allow',
    });
    expect(subagentsSettingsDraftIssue({
      modelScope: {
        agents: { reviewer: { allow: ['openai/*'], enforce: true, strict: true } },
        enforce: true,
      },
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({
      modelScope: { agents: { reviewer: { allow: [] } } },
    })).toEqual({
      code: 'model-scope-allow-required',
      field: 'modelScope.agents.reviewer.allow',
    });
  });

  test('accepts the current pi-subagents override contract and rejects malformed known fields', () => {
    expect(subagentsSettingsDraftIssue({
      agentOverrides: {
        reviewer: {
          acceptanceRole: false,
          completionGuard: true,
          defaultContext: 'fork',
          defaultProvider: 'openai',
          defaultReads: ['brief.md'],
          extensions: false,
          fallbackModels: ['anthropic/claude-sonnet-4-5'],
          inheritProjectContext: true,
          model: 'openai/gpt-5.2',
          output: 'review.md',
          outputMode: 'file-only',
          systemPromptMode: 'append',
          thinking: false,
          toolBudget: { block: ['read', 'grep'], hard: 20, soft: 10 },
          tools: 'inherit',
          unknownFutureField: { preserved: true },
        },
      },
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { fallbackModels: 'not-an-array' } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.fallbackModels',
    });
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { defaultContext: 'ambient' } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.defaultContext',
    });
    expect(subagentsSettingsDraftIssue({
      defaultProvider: 'openai',
      maxThinking: 'high',
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({ maxThinking: 'ultra' })).toEqual({
      code: 'invalid-value',
      field: 'maxThinking',
    });
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { outputMode: 'stream' } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.outputMode',
    });
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { toolBudget: { hard: 5, block: [] } } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.toolBudget.block',
    });
  });

  test('requires complete turn and tool budget objects', () => {
    expect(subagentsRuntimeDraftIssue({ turnBudget: { graceTurns: 1 } })).toEqual({
      code: 'required',
      field: 'turnBudget.maxTurns',
    });
    expect(subagentsRuntimeDraftIssue({ toolBudget: { hard: 10, soft: 11 } })).toEqual({
      code: 'soft-exceeds-hard',
      field: 'toolBudget.soft',
    });
    expect(subagentsRuntimeDraftIssue({ toolBudget: false })).toEqual({
      code: 'invalid-value',
      field: 'toolBudget',
    });
    expect(subagentsRuntimeDraftIssue({ toolBudget: { hard: 10, block: '*' } })).toBeNull();
    expect(subagentsRuntimeDraftIssue({ turnBudget: { graceTurns: 0, maxTurns: 1 } })).toBeNull();
  });

  test('validates independently optional usage budget metrics', () => {
    expect(subagentsRuntimeDraftIssue({ usageBudget: {} })).toEqual({
      code: 'required',
      field: 'usageBudget.tokens / usageBudget.costUsd',
    });
    expect(subagentsRuntimeDraftIssue({ usageBudget: { tokens: { hard: 1000 } } })).toBeNull();
    expect(subagentsRuntimeDraftIssue({
      usageBudget: { costUsd: { hard: 1, soft: 2 } },
    })).toEqual({
      code: 'soft-exceeds-hard',
      field: 'usageBudget.costUsd.soft',
    });
  });
});
