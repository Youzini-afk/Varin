import { expect, test } from 'vitest';
import { ChannelTypes } from './channel-types.js';
import { ModelMetadataIndex, modelDirectoryDefaults } from './metadata-match.js';
import { applyModelDirectoryDefaults } from '@varin/application-client';

const types = new ChannelTypes();
const generic = types.get('openai-compatible')!;
const language = { type: 'language', modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }, { type: 'toggle' }] };
const index = new ModelMetadataIndex({
  openai: { npm: '@ai-sdk/openai', models: {
    'gpt-4': { ...language, limit: { context: 8000, output: 4000 } },
    'gpt-4.1': { ...language, limit: { context: 1000000, output: 32000 } },
    'gpt-4.1-mini': { ...language, limit: { context: 200000, output: 16000 } },
  } },
  deepseek: { npm: '@ai-sdk/openai-compatible', models: {
    'deepseek-flash': { ...language, canonical_model_id: 'deepseek/deepseek-v4.1-flash', limit: { context: 1000000, output: 390000 } },
  } },
  reseller: { npm: '@ai-sdk/openai-compatible', models: {
    'gpt-4.1': { ...language, canonical_model_id: 'openai/gpt-4.1', limit: { context: 10000, output: 1000 } },
  } },
}, types);

test.each(['GPT-4.1', 'proxy/openai/GPT-4.1', 'team_GPT-4.1_fast', 'gpt-4.1.preview', 'gpt-4.1-2026-01-01', 'ft:GPT-4.1:org:deepseek-flash'])('matches decorated ID %s without reseller capacity contamination', id => {
  expect(index.lookup(generic, { id })).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 32000, thinking: { mode: 'levels', levels: ['low', 'high'] } });
});

test('keeps variants and version boundaries, and leaves multi-model routing expressions unresolved', () => {
  expect(index.lookup(generic, { id: 'team-GPT-4.1-mini-fast' })?.contextWindow).toBe(200000);
  for (const id of ['gpt-4.2', 'mygpt-4.1', 'gpt-4.1+deepseek-flash', 'unknown']) expect(index.lookup(generic, { id })).toBeUndefined();
  expect(index.lookup({ ...generic, id: 'reseller' }, { id: 'GPT-4.1' })?.contextWindow).toBe(10000);
  expect(index.lookup(generic, { id: 'relay/DeepSeek-V4.1-Flash-fast' })?.maxOutputTokens).toBe(390000);
});

test('uses the actual upstream ID and preserves routing, explicit values and explicit clearing', () => {
  const model = { id: 'my-alias', requestModelId: 'relay/DEEPSEEK-FLASH-fast', name: 'My model', enabled: true,
    operations: ['chat' as const], contextWindow: 222, parameters: { temperature: 0.2 } };
  const defaults = modelDirectoryDefaults(index, generic, model, [])!;
  const resolved = applyModelDirectoryDefaults(model, defaults);
  expect(resolved).toMatchObject({ ...model, maxOutputTokens: 390000, thinking: { mode: 'levels', levels: ['low', 'high'] }, compat: { thinkingFormat: 'deepseek' } });
  expect(resolved.protocol).toBeUndefined();
  expect(resolved.catalog?.overrides).toContain('contextWindow');
  const cleared = { ...resolved, catalog: { overrides: [...resolved.catalog!.overrides, 'maxOutputTokens' as const] } };
  // Saved configuration omits a cleared optional value but keeps its explicit override.
  delete cleared.maxOutputTokens;
  const clearedResult = applyModelDirectoryDefaults(cleared, defaults);
  expect(clearedResult.maxOutputTokens).toBeUndefined();
  expect(Object.hasOwn(clearedResult, 'maxOutputTokens')).toBe(false);
  // A JavaScript caller can still supply an own undefined value before JSON serialization.
  Object.defineProperty(cleared, 'maxOutputTokens', { value: undefined, enumerable: true });
  expect(applyModelDirectoryDefaults(cleared, defaults).maxOutputTokens).toBeUndefined();
  expect(modelDirectoryDefaults(index, generic, { id: 'gpt-4.1', requestModelId: 'opaque-deployment' }, [])).toBeUndefined();
  const changed = applyModelDirectoryDefaults({ ...resolved, requestModelId: 'unknown-deployment' });
  expect(changed.contextWindow).toBe(222);
  expect(changed.maxOutputTokens).toBeUndefined();
  expect(changed.thinking).toBeUndefined();
  expect(changed.parameters).toEqual(model.parameters);
});
