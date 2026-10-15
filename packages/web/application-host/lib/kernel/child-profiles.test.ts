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
    { name: 'file_read', version: '1', source_requirement: 'source', default_presets: ['worker', 'retrieval'] },
    { name: 'file_write', version: '1', source_requirement: 'physical', default_presets: ['worker'] },
    { name: 'process_spawn', version: '1', source_requirement: 'physical', default_presets: ['worker'] },
    { name: 'ask_user', version: '1', source_requirement: 'none', default_presets: ['worker'] },
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

it('prepares defaults and explicitly saved runtime profiles from the original settings file and retains the accepted snapshot', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { AgentSettingsService } = await import('../models/settings.js');
  const { createAgentProfilesAPI } = await import('./agent-profiles.js');
  const root = await mkdtemp(join(tmpdir(), 'profile-owner-'));
  try {
    const path = join(root, 'agent-settings.json');
    await writeFile(path, JSON.stringify({ unchanged: { keep: true }, harness: { unrelated: 'asset', agents: {
      custom: agent({ tools: ['extension_read'] }), native: agent({ tools: ['file_read'] }),
    } } }));
    const f = await fixture();
    const settings = new AgentSettingsService(root, () => false);
    const profiles = createAgentProfilesAPI({ settings, capabilities: async () => f.capabilities });
    const prepare = createChildProfilePreparer({ settings: async () => (await settings.read()).document,
      models: f.models, capabilities: async () => f.capabilities });
    let view = await profiles.read({ runtime: 'agent' });
    const retrieval = view.profiles.find(profile => profile.id === 'varin:builtin:retrievalAgent')!;
    expect(retrieval.config.kind).toBe('builtin');
    if (retrieval.config.kind !== 'builtin') throw new Error('fixture profile');
    view = (await profiles.save({ runtime: 'agent', expectedRevision: view.revision, id: retrieval.id,
      config: { ...retrieval.config, binding: { providerId: 'provider', modelId: 'model' } } })).snapshot;
    const frozen = await prepare({ parent: f.parent });
    expect(frozen.presets.find(p => p.id === 'worker')?.tools).toEqual(['file_read', 'file_write', 'process_spawn', 'ask_user']);
    expect(frozen.presets.find(p => p.id === 'retrieval')).toMatchObject({ tools: ['file_read'], unavailable: null });
    expect(frozen.presets.find(p => p.id === 'custom:custom')?.tools).toEqual(['extension_read']);
    expect(frozen.presets.find(p => p.id === 'custom:native')?.tools).toEqual(['file_read']);
    const custom = view.profiles.find(profile => profile.id === 'varin:custom:custom')!;
    await profiles.save({ runtime: 'agent', expectedRevision: view.revision, id: custom.id, config: custom.config, tools: ['file_read'] });
    expect(frozen.presets.find(p => p.id === 'custom:custom')?.tools).toEqual(['extension_read']);
    expect((await prepare({ parent: f.parent })).presets.find(p => p.id === 'custom:custom')?.tools).toEqual(['file_read']);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    expect(disk.harness.agents.custom.tools).toEqual(['file_read']);
    expect(disk.unchanged).toEqual({ keep: true });
    expect(disk.harness.unrelated).toBe('asset');
    expect(custom.config).not.toHaveProperty('agent.tools');
    await expect(profiles.save({ runtime: 'agent', expectedRevision: view.revision, id: custom.id, config: custom.config, tools: [] })).rejects.toMatchObject({ code: 'config_conflict' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('distinguishes runtime-unconfigured, explicit empty tools, invalid settings and unavailable settings', async () => {
  const f = await fixture();
  const compiler = (value: unknown) => createChildProfilePreparer({ models: f.models, capabilities: async () => f.capabilities,
    settings: async () => value });
  for (const field of ['models', 'agents']) {
    expect((await compiler({ harness: { [field]: [] } })({ parent: f.parent })).normal_unavailable?.code).toBe('child-settings-invalid');
  }
  const prepared = await compiler({ harness: { agents: { absent: agent({ tools: undefined }), empty: agent({ tools: [] }) } } })({ parent: f.parent });
  expect(prepared.presets.find(p => p.id === 'custom:absent')?.unavailable?.code).toBe('child-profile-runtime_unconfigured');
  expect(prepared.presets.find(p => p.id === 'custom:empty')).toMatchObject({ tools: [], tools_source: 'explicit', unavailable: null });
});

it('rejects unsupported settings without converting or rewriting the original asset', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { AgentSettingsService } = await import('../models/settings.js');
  const { createAgentProfilesAPI } = await import('./agent-profiles.js');
  const root = await mkdtemp(join(tmpdir(), 'profile-invalid-'));
  const path = join(root, 'agent-settings.json');
  try {
    const profiles = createAgentProfilesAPI({ settings: new AgentSettingsService(root, () => false), capabilities: async () => [] });
    for (const harness of [
      { models: { review: { agent: { instructions: 'Original instructions' } } } },
      { memory: { mode: 'off' } },
      { agents: { retained: agent({ tools: { pi: ['read'], agent: ['file_read'] } }) } },
    ]) {
      const original = JSON.stringify({ untouched: ['user asset'], harness });
      await writeFile(path, original);
      await expect(profiles.read({ runtime: 'agent' })).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains shipped-default provenance and explicit preset/custom arrays for exact Run-source resolution', async () => {
  const f = await fixture();
  let settings: unknown = {};
  const prepare = createChildProfilePreparer({ models: f.models, capabilities: async () => f.capabilities, settings: async () => settings });
  const absent = await prepare({ parent: f.parent });
  expect(absent.presets.find(preset => preset.id === 'worker')).toMatchObject({ tools: ['file_read', 'file_write', 'process_spawn', 'ask_user'], tools_source: 'default', work_mode: 'isolated_write', unavailable: null });
  expect(absent.presets.find(preset => preset.id === 'retrieval')).toMatchObject({ tools: ['file_read'], tools_source: 'default' });
  expect(absent.native_capabilities).toEqual(f.capabilities);
  settings = { harness: { models: { worker: { agent: { tools: ['file_read', 'process_spawn'] } } },
    agents: { explicit: agent({ tools: ['file_read'] }) } } };
  const explicit = await prepare({ parent: f.parent });
  expect(explicit.presets.find(preset => preset.id === 'worker')?.tools).toEqual(['file_read', 'process_spawn']);
  expect(explicit.presets.find(preset => preset.id === 'custom:explicit')?.tools).toEqual(['file_read']);
  expect(absent.presets.find(preset => preset.id === 'worker')?.tools_source).toBe('default');
  expect(explicit.presets.find(preset => preset.id === 'worker')?.tools_source).toBe('explicit');
  expect(explicit.presets.find(preset => preset.id === 'custom:explicit')?.tools_source).toBe('explicit');
});
