import { expect, it } from 'vitest';
import { createChildProfilePreparer } from './child-profiles.js';
import { createModelAuthority } from './model-authority.js';
import type { ChildCapabilityDescriptor, ChildModelBinding } from './protocol.generated.js';

async function fixture() {
  let defaults = 0.8;
  const scope = { reference: 'profile-test', authority: 'fixture', account: 'opaque-test-account', generation: 3 };
  const descriptor = () => ({ providerId: 'provider', modelId: 'model', name: 'Fixture', api: 'openai-completions',
    baseUrl: 'https://model.invalid/v1', maxTokens: 32768, reasoning: true,
    samplingParams: { top_p: defaults }, samplingParamsByThinkingLevel: { high: { temperature: 0.5 } } });
  const models = createModelAuthority({ selectedModel: async () => descriptor(), listModels: async () => [descriptor()],
    currentScope: async () => scope, currentProviderAccount: async () => undefined, routingEnvironment: async () => ({}),
    getAuth: async () => ({ auth: { apiKey: 'fixture-unused' } }) });
  const resolved = await models.resolveModel({ providerId: 'provider', modelId: 'model', thinkingLevel: 'high' });
  const parent: ChildModelBinding = { configuration: resolved.configuration, credential_scope: await resolved.credentialOwner.scope() };
  const capabilities: ChildCapabilityDescriptor[] = [
    { name: 'file_read', version: '1', source_requirement: 'source' },
    { name: 'file_write', version: '1', source_requirement: 'physical' },
    { name: 'process_spawn', version: '1', source_requirement: 'physical' },
    { name: 'ask_user', version: '1', source_requirement: 'none' },
  ];
  return { parent, models, capabilities, changeDefaults() { defaults = 0.9; } };
}
const agent = (overrides: Record<string, unknown> = {}) => ({ name: 'Configured worker', description: 'User choice', instructions: 'Keep the original result.',
  enabled: true, tools: ['file_read'], worktree: 'none', workFocus: [], ...overrides });

it('compiles original configured profiles without losing unavailable choices, scope or inheritance provenance', async () => {
  const f = await fixture();
  const settings = { harness: { models: { worker: { enabled: false } }, agents: {
    reader: agent(), selected: agent({ model: { providerId: 'provider', modelId: 'model' } }),
    off: agent({ enabled: false }), research: agent({ workFocus: ['research'] }),
    unsupported: agent({ tools: ['file_read', 'computer'] }), physical: agent({ tools: ['process_spawn'] }),
    process: agent({ tools: ['file_read', 'process_spawn'], worktree: 'isolated' }),
  } } };
  const prepare = createChildProfilePreparer({ models: f.models, capabilities: async () => f.capabilities, settings: async () => settings });
  const frozen = await prepare({ parent: f.parent, workFocus: 'code' });
  const profile = (id: string) => frozen.presets.find(value => value.id === `custom:${id}`)!;
  expect(frozen.normal_unavailable?.code).toBe('child-worker-disabled');
  expect(profile('reader')).toMatchObject({ model_source: 'inherit', model: null, unavailable: null, tools: ['file_read'] });
  expect(profile('selected')).toMatchObject({ model_source: 'selected', model: { configuration: { model: 'model' } }, unavailable: null });
  expect(profile('off').unavailable?.code).toBe('child-profile-disabled');
  expect(profile('research').unavailable?.code).toBe('child-profile-scope_unavailable');
  expect(profile('unsupported')).toMatchObject({ tools: ['file_read', 'computer'], unavailable: null });
  expect(frozen.native_capabilities).toEqual(f.capabilities); // Actual request directory resolves non-native names, never a latest registry.
  expect(profile('physical').unavailable).toBeNull(); // Actual directory decides whether a same-named tool is native or a Host service.
  expect(profile('process')).toMatchObject({ work_mode: 'isolated_write', unavailable: null });
  settings.harness.agents.reader.instructions = 'Changed later.';
  expect(profile('reader').instructions).toBe('Keep the original result.');
  expect((await prepare({ parent: f.parent, workFocus: 'code' })).identity).not.toBe(frozen.identity);
  expect((await prepare({ parent: f.parent })).presets.find(value => value.id === 'custom:research')?.unavailable?.code).toBe('child-profile-scope_unavailable');
});

it('normalizes inherited overrides through the actual model owner, retaining original thinking and explicit zero', async () => {
  const f = await fixture();
  const prepare = createChildProfilePreparer({ models: f.models, capabilities: async () => f.capabilities,
    settings: async () => ({ harness: { agents: { precise: agent({ modelSettings: { temperature: 0 } }) } } }) });
  const prepared = await prepare({ parent: f.parent });
  const profile = prepared.presets.find(value => value.id === 'custom:precise')!;
  expect(profile.inherit_base).toEqual(f.parent);
  expect(profile.model?.configuration).toMatchObject({ thinkingLevel: 'high', modelOptions: { temperature: 0, samplingParams: { top_p: 0.8 } } });
  expect((profile.model?.configuration.modelOptions as { samplingParams: unknown }).samplingParams).not.toHaveProperty('temperature');
  expect(profile.model?.configuration.configurationGeneration).not.toBe(f.parent.configuration.configurationGeneration);
  f.changeDefaults();
  const changed = (await prepare({ parent: f.parent })).presets.find(value => value.id === 'custom:precise')!;
  expect(changed).toMatchObject({ model: null, inherit_base: null, unavailable: { code: 'child-model-unavailable' } });
});

it('keeps missing configuration defaults distinct from invalid or unreadable settings', async () => {
  const f = await fixture();
  const compiler = (settings: () => Promise<unknown>) => createChildProfilePreparer({ models: f.models, capabilities: async () => f.capabilities, settings });
  expect((await compiler(async () => ({}))({ parent: f.parent })).normal_unavailable).toBeNull();
  expect((await compiler(async () => ({ harness: { agents: { bad: { enabled: true } } } }))({ parent: f.parent })).normal_unavailable?.code).toBe('child-settings-invalid');
  expect((await compiler(async () => { throw new Error('source unavailable'); })({ parent: f.parent })).normal_unavailable?.code).toBe('child-settings-unavailable');
});
