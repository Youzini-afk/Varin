import { describe, expect, test } from 'vitest';
import {
  createCustomProviderFormStateFromConfig,
  createEmptyCustomProviderState,
  createPiProviderConfigFromForm,
  ensureExtendedThinkingLevels,
  isCustomProviderThinkingLevelEnabled,
  mergeCustomProviderModelRows,
  normalizeCustomProviderModelRows,
  resolveCustomProviderApiKey,
  setCustomProviderThinkingLevelEnabled,
  setCustomProviderThinkingLevelMapping,
} from './customProviderForm';

describe('Pi custom provider form', () => {
  test('saves a pure decision provider and preserves connection overrides through editing', () => {
    const state = createEmptyCustomProviderState();
    state.id = 'typesafe';
    state.baseURL = 'https://shared.example';
    state.chatEnabled = false;
    state.inference.decision.enabled = true;
    state.inference.decision.baseURL = 'https://decision.example';
    state.inference.decision.endpoint = '/systemone';
    state.inference.decision.credentialRef = 'decision-auth';
    state.inference.decision.models = [{ ...state.models[0]!, id: 'jev-1.13', name: 'Jev' }];
    const config = createPiProviderConfigFromForm(state);
    expect(config.api).toBeUndefined();
    expect(config.models).toEqual([]);
    expect(config.capabilities?.chat).toBe(false);
    expect(config.capabilities?.decision).toEqual({
      protocol: 'pi-classifier', baseUrl: 'https://decision.example', endpoint: '/systemone', credentialRef: 'decision-auth',
      models: [{ id: 'jev-1.13', name: 'Jev', input: ['text'], reasoning: false }],
    });
    expect(createPiProviderConfigFromForm(createCustomProviderFormStateFromConfig(config))).toEqual(config);
    const paused = createCustomProviderFormStateFromConfig(config);
    paused.inference.decision.enabled = false;
    paused.inference.decision.disabled = true;
    const savedPaused = createPiProviderConfigFromForm(paused);
    expect(savedPaused.capabilities?.decision?.enabled).toBe(false);
    expect(savedPaused.capabilities?.decision?.models).toEqual(config.capabilities?.decision?.models);
    expect(savedPaused.capabilities?.decision?.credentialRef).toBe('decision-auth');
  });

  test('uses controlled credentials and supports password-manager autofill', () => {
    expect(resolveCustomProviderApiKey(' sk-state ', { value: 'sk-dom' })).toBe('sk-state');
    expect(resolveCustomProviderApiKey('', { value: ' sk-autofill ' })).toBe('sk-autofill');
    expect(resolveCustomProviderApiKey(' ', { value: ' ' })).toBe('');
  });

  test('projects editable rows into native Pi model definitions', () => {
    expect(normalizeCustomProviderModelRows([
      {
        api: 'openai-responses',
        attachment: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        context: '200,000',
        id: ' model-a ',
        name: ' Model A ',
        output: '32,000',
        reasoning: true,
        thinkingLevelMap: { high: 'high', off: null },
      },
      {
        attachment: false,
        context: '',
        id: '',
        name: 'blank row',
        output: '',
        reasoning: false,
      },
    ])).toEqual([
      {
        api: 'openai-responses',
        baseUrl: 'http://127.0.0.1:11434/v1',
        contextWindow: 200000,
        id: 'model-a',
        input: ['text', 'image'],
        maxTokens: 32000,
        name: 'Model A',
        reasoning: true,
        thinkingLevelMap: { high: 'high', max: 'max', off: null, xhigh: 'xhigh' },
      },
    ]);
  });

  test('round-trips native provider fields without a legacy-shaped payload', () => {
    const state = createCustomProviderFormStateFromConfig({
      api: 'anthropic-messages',
      authHeader: false,
      baseUrl: 'http://lan-host:9000/api',
      id: 'lan-provider',
      models: [{
        contextWindow: 1000000,
        cost: { input: 1, output: 2 },
        id: 'large-model',
        input: ['text', 'image'],
        maxTokens: 64000,
        reasoning: true,
      }],
      name: 'LAN Provider',
      scope: 'project',
    });

    expect(state.api).toBe('anthropic-messages');
    expect(state.authHeader).toBe(false);
    expect(state.scope).toBe('project');
    expect(state.models[0]?.attachment).toBe(true);
    expect(state.models[0]?.context).toBe('1000000');
    expect(state.models[0]?.cost).toEqual({ input: 1, output: 2 });
    expect(state.models[0]?.id).toBe('large-model');
    expect(state.models[0]?.output).toBe('64000');
    expect(state.models[0]?.reasoning).toBe(true);
    expect(createPiProviderConfigFromForm(state)).toEqual({
      api: 'anthropic-messages',
      authHeader: false,
      baseUrl: 'http://lan-host:9000/api',
      id: 'lan-provider',
      models: [{
        contextWindow: 1000000,
        cost: { input: 1, output: 2 },
        id: 'large-model',
        input: ['text', 'image'],
        maxTokens: 64000,
        reasoning: true,
        thinkingLevelMap: { max: 'max', xhigh: 'xhigh' },
      }],
      name: 'LAN Provider',
    });
  });

  test('merges discovered models by id and keeps Pi-only metadata', () => {
    const existing = createEmptyCustomProviderState().models;
    existing[0] = {
      attachment: false,
      context: '128000',
      id: 'shared',
      name: 'Old name',
      output: '8192',
      reasoning: false,
      thinkingLevelMap: { high: 'high' },
    };
    const merged = mergeCustomProviderModelRows(existing, [
      {
        contextWindow: 256000,
        id: 'shared',
        input: ['text', 'image'],
        maxTokens: 16384,
        name: 'New name',
        reasoning: true,
      },
      { id: 'new-model', name: 'New model' },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.attachment).toBe(true);
    expect(merged[0]?.context).toBe('256000');
    expect(merged[0]?.id).toBe('shared');
    expect(merged[0]?.name).toBe('New name');
    expect(merged[0]?.output).toBe('16384');
    expect(merged[0]?.reasoning).toBe(true);
    expect(merged[0]?.thinkingLevelMap).toEqual({ high: 'high' });
    expect(merged[1]?.id).toBe('new-model');
    expect(merged[1]?.name).toBe('New model');
  });

  test('does not restrict custom Pi API identifiers', () => {
    const state = createEmptyCustomProviderState();
    state.id = 'custom-stream';
    state.api = 'my-extension-stream-api';
    expect(createPiProviderConfigFromForm(state).api).toBe('my-extension-stream-api');
  });

  test('preserves a partial native override without inventing fields', () => {
    const state = createCustomProviderFormStateFromConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      id: 'inherited-provider',
      scope: 'project',
    });
    expect(state.api).toBe('');
    expect(state.authHeader).toBeUndefined();
    expect(state.modelsDefined).toBe(false);
    expect(createPiProviderConfigFromForm(state)).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      id: 'inherited-provider',
    });
  });

  test('exposes every Pi thinking level for a reasoning-capable custom model', () => {
    expect(ensureExtendedThinkingLevels(undefined)).toEqual({
      max: 'max',
      xhigh: 'xhigh',
    });
    expect(ensureExtendedThinkingLevels({ high: null, max: null })).toEqual({
      high: null,
      max: null,
      xhigh: 'xhigh',
    });
  });

  test('persists level exclusions and provider-native effort mappings', () => {
    const disabled = setCustomProviderThinkingLevelEnabled(
      { max: 'max', xhigh: 'xhigh' },
      'medium',
      false,
    );
    expect(disabled).toEqual({ max: 'max', medium: null, xhigh: 'xhigh' });
    expect(isCustomProviderThinkingLevelEnabled(disabled, 'medium')).toBe(false);

    const reenabled = setCustomProviderThinkingLevelEnabled(disabled, 'medium', true);
    expect(reenabled).toEqual({ max: 'max', xhigh: 'xhigh' });
    expect(isCustomProviderThinkingLevelEnabled(reenabled, 'medium')).toBe(true);

    expect(setCustomProviderThinkingLevelMapping(reenabled, 'max', 'ultra')).toEqual({
      max: 'ultra',
      xhigh: 'xhigh',
    });
    expect(setCustomProviderThinkingLevelMapping({ high: 'very-high' }, 'high', '')).toBeUndefined();
  });
});
