import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { AgentSettingsService } from '../models/settings.js';
import { createModelAuthority } from './model-authority.js';
import { createContextAgent } from './context-agent.js';
import { readContextPolicy } from './context-settings.js';

it('uses one persisted profile for manual and automatic work, inheriting the original binding until a model or parameter is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-context-agent-'));
  const settings = new AgentSettingsService(root, () => false);
  const scope = { reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 };
  const models = createModelAuthority({
    selectedModel: async (providerId, modelId) => ({ providerId, modelId, name: modelId, api: 'openai-completions',
      baseUrl: 'https://not-contacted.invalid/v1', maxTokens: 1000, contextWindow: 16000, reasoning: true,
      thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: true } }),
    listModels: async () => [], currentScope: async () => scope, currentProviderAccount: async () => undefined,
    routingEnvironment: async () => ({}), getAuth: async () => ({ auth: { apiKey: 'unused-fixture' } }),
  });
  const parent = await models.resolveModel({ providerId: 'main', modelId: 'conversation', thinkingLevel: 'high' });
  const resolve = vi.spyOn(models, 'resolveModel');
  const owner = createContextAgent({ settings, models });
  const signal = new AbortController().signal;
  const fallback = { configuration: parent.configuration, credentialScope: scope };
  try {
    const inherited = await owner.prepare({ threadId: 'thread' }, fallback, signal);
    expect(inherited.configuration).toBe(parent.configuration);
    expect(inherited.bind).toBeUndefined(); expect(resolve).not.toHaveBeenCalled(); inherited.release();
    await writeFile(join(root, 'agent-settings.json'), JSON.stringify({ harness: { models: { contextCompaction: {
      providerId: 'summary', modelId: 'organizer', agent: { instructions: 'Keep actionable evidence.', modelSettings: { thinkingLevel: 'low', temperature: 0.2 } },
    } } } }));
    for (const base of [fallback, { model: { providerId: 'main', modelId: 'conversation' } }]) {
      const selected = await owner.prepare({ threadId: 'thread' }, base, signal);
      try {
        const frozen = await selected.bind!();
        expect(frozen.configuration).toMatchObject({ providerId: 'summary', model: 'organizer', thinkingLevel: 'low', modelOptions: { temperature: 0.2 } });
        expect(selected.instructions).toBe('Keep actionable evidence.'); expect(frozen.credentialScope).toEqual(scope);
      } finally { selected.release(); }
    }
    await writeFile(join(root, 'agent-settings.json'), JSON.stringify({ harness: { models: { contextCompaction: {
      enabled: false, agent: { modelSettings: { temperature: 0.3 } },
    } } } }));
    const override = await owner.prepare({ threadId: 'thread' }, fallback, signal);
    try {
      expect((await override.bind!()).configuration).toMatchObject({ model: 'conversation', thinkingLevel: 'high', modelOptions: { temperature: 0.3 } });
      expect(readContextPolicy({ settings: await settings.snapshot(), modelId: 'conversation', contextWindowTokens: 16000 }).enabled).toBe(false);
    } finally { override.release(); }
  } finally { parent.credentialOwner.release(); await rm(root, { recursive: true, force: true }); }
});
