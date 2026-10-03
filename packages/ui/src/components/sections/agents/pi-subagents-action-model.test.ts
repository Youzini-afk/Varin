import { describe, expect, test } from 'vitest';
import type { JsonValue, PiAgentDescriptor, RuntimeContextTarget } from '@varin/protocol';
import {
  buildPiSubagentsDefinitionConfig,
  createPiSubagentsDefinitionDraft,
  isSupportedPiSubagentsThinking,
  runPiSubagentsDefinitionAction,
} from './pi-subagents-action-model';

const AGENT: PiAgentDescriptor = {
  actions: [],
  definition: {
    config: {
      defaultContext: 'fork',
      description: 'Existing role',
      extensions: 'extension-a',
      fallbackModels: ['test/fallback'],
      futureOption: { enabled: true },
      inheritSkills: false,
      maxSubagentDepth: 1,
      model: 'test/model',
      name: 'existing',
      skills: 'review-skill',
      systemPrompt: 'Review carefully.',
      thinking: 'medium',
      timeoutMs: 30_000,
      toolBudget: { hard: 12, soft: 8 },
      tools: 'read, grep',
    },
  },
  description: 'Existing role',
  fallbackModels: ['test/fallback'],
  id: 'agent-id',
  kind: 'delegatable',
  model: 'test/model',
  name: 'existing',
  providerId: 'pi-subagents',
  source: { scope: 'user' },
  status: 'available',
  thinking: 'medium',
};


describe('pi-subagents action model', () => {
  test('builds a structured create-agent config without writing blank defaults', () => {
    const draft = createPiSubagentsDefinitionDraft();
    Object.assign(draft, {
      advancedJson: JSON.stringify({
        aliases: ['review'],
        inheritSkills: false,
        output: 'review.md',
        outputMode: 'file-only',
        reads: 'brief.md, requirements.md',
      }),
      description: 'Review changes',
      fallbackModels: 'test/fallback\ntest/fallback',
      maxSubagentDepth: '0',
      model: 'test/model',
      name: 'reviewer',
      tools: 'read, grep',
    });
    expect(buildPiSubagentsDefinitionConfig('create-agent', draft)).toEqual({
      config: {
        description: 'Review changes',
        aliases: ['review'],
        fallbackModels: ['test/fallback'],
        inheritSkills: false,
        maxSubagentDepth: 0,
        model: 'test/model',
        name: 'reviewer',
        output: 'review.md',
        outputMode: 'file-only',
        reads: 'brief.md, requirements.md',
        tools: 'read, grep',
      },
    });
  });

  test('builds only changed update fields and can clear inherited values', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    draft.description = 'Updated role';
    draft.model = '';
    draft.fallbackModels = '';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: {
        description: 'Updated role',
        fallbackModels: false,
        model: false,
      },
    });
  });

  test('loads every adapted agent field and shows only management-supported fields in advanced JSON', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    expect(draft.defaultContext).toBe('fork');
    expect(draft.description).toBe('Existing role');
    expect(draft.extensions).toBe('extension-a');
    expect(draft.fallbackModels).toBe('test/fallback');
    expect(draft.maxSubagentDepth).toBe('1');
    expect(draft.model).toBe('test/model');
    expect(draft.name).toBe('existing');
    expect(draft.skills).toBe('review-skill');
    expect(draft.systemPrompt).toBe('Review carefully.');
    expect(draft.thinking).toBe('medium');
    expect(draft.timeoutMs).toBe('30000');
    expect(draft.tools).toBe('read\ngrep');
    expect(JSON.parse(draft.advancedJson)).toEqual({
      inheritSkills: false,
      toolBudget: { hard: 12, soft: 8 },
    });
  });

  test('updates and clears management-supported advanced fields without exposing unknown native fields', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    draft.advancedJson = '{"inheritSkills":true}';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: {
        inheritSkills: true,
        toolBudget: false,
      },
    });

    draft.advancedJson = '{"futureOption":{"enabled":false}}';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      issue: { code: 'unsupported-advanced-field', field: 'futureOption' },
    });
  });

  test('builds update-agent payloads for the full adapted definition', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    Object.assign(draft, {
      defaultContext: 'fresh',
      extensions: 'extension-b',
      maxSubagentDepth: '2',
      skills: 'implementation-skill',
      systemPrompt: 'Implement carefully.',
      timeoutMs: '45000',
      tools: 'read, grep, edit',
    });
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: {
        defaultContext: 'fresh',
        extensions: 'extension-b',
        maxSubagentDepth: 2,
        skills: 'implementation-skill',
        systemPrompt: 'Implement carefully.',
        timeoutMs: 45_000,
        tools: 'read, grep, edit',
      },
    });
  });

  test('clears every adapted optional agent field using pi-subagents clear sentinels', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    Object.assign(draft, {
      defaultContext: '',
      extensions: '',
      fallbackModels: '',
      maxSubagentDepth: '',
      model: '',
      skills: '',
      systemPrompt: '',
      thinking: '',
      timeoutMs: '',
      tools: '',
    });
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: {
        defaultContext: false,
        extensions: false,
        fallbackModels: false,
        maxSubagentDepth: false,
        model: false,
        skills: false,
        systemPrompt: false,
        thinking: false,
        timeoutMs: false,
        tools: false,
      },
    });
  });

  test('reports no changes only when structured and supported advanced definition values are unchanged', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    draft.advancedJson = '{"toolBudget":{"soft":8,"hard":12},"inheritSkills":false}';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      issue: { code: 'no-changes' },
    });
    draft.advancedJson = '{"inheritSkills":true,"toolBudget":{"hard":12,"soft":8}}';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: { inheritSkills: true },
    });
  });

  test('preserves an unknown future thinking value until the user deliberately replaces it', () => {
    const future = structuredClone(AGENT);
    future.thinking = 'ultra';
    future.definition!.config.thinking = 'ultra';
    const draft = createPiSubagentsDefinitionDraft(future);
    expect(draft.thinking).toBe('ultra');
    expect(isSupportedPiSubagentsThinking(draft.thinking)).toBe(false);
    draft.description = 'Updated without touching thinking';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, future)).toEqual({
      config: { description: 'Updated without touching thinking' },
    });
  });

  test('sends create-agent provider payload and refreshes the catalog on success', async () => {
    const calls: unknown[][] = [];
    let refreshes = 0;
    const runtimeTarget: RuntimeContextTarget = { cwd: '/workspace' };
    const result = await runPiSubagentsDefinitionAction({
      config: { description: 'Reviews changes', model: 'test/model', name: 'reviewer' },
      mode: 'create-agent',
      runtimeTarget,
      scope: 'project',
    }, {
      refreshCatalog: async () => { refreshes += 1; },
      runAction: async (...args: [
        RuntimeContextTarget,
        string,
        string,
        string | undefined,
        JsonValue | undefined,
      ]) => {
        calls.push(args);
        return { message: 'created', success: true };
      },
    });

    expect(result).toEqual({ message: 'created', success: true });
    expect(calls).toEqual([[
      runtimeTarget,
      'pi-subagents',
      'create-agent',
      undefined,
      {
        config: { description: 'Reviews changes', model: 'test/model', name: 'reviewer' },
        scope: 'project',
      },
    ]]);
    expect(refreshes).toBe(1);
  });

  test('does not refresh the catalog after a rejected definition action', async () => {
    let refreshes = 0;
    const result = await runPiSubagentsDefinitionAction({
      config: { description: 'Reviews changes', name: 'reviewer' },
      mode: 'create-agent',
      runtimeTarget: { cwd: '/workspace' },
      scope: 'user',
    }, {
      refreshCatalog: async () => { refreshes += 1; },
      runAction: async () => ({ message: 'conflict', success: false }),
    });

    expect(result.success).toBe(false);
    expect(refreshes).toBe(0);
  });
});
