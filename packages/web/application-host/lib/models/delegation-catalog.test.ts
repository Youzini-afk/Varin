import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ModelChannel } from '@varin/application-client';
import { ModelsService } from './service.js';
import { readDelegationModelCatalog } from './delegation-catalog.js';
import { createModelAuthority } from '../kernel/model-authority.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const channel = (id: string): ModelChannel => ({ id, name: `Account ${id}`, enabled: true, type: 'openai-compatible',
  baseUrl: `https://${id}.private.example/v1`, authentication: { kind: 'credential', reference: 'private-credential-reference' },
  connection: { headers: { 'X-Private-Header': 'private-header-value' } }, parameters: {}, models: [
    { id: 'shared-model', name: 'Same display name', description: `Experience on ${id}`, enabled: true, operations: ['chat'],
      reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: false },
      input: ['text', 'image'], contextWindow: 32768, maxOutputTokens: 8192, pricing: { inputPerMillion: 0, outputPerMillion: 2 } },
  ] });
async function fixture(channels: ModelChannel[]) {
  const root = await mkdtemp(join(tmpdir(), 'varin-delegation-model-catalog-')); roots.push(root);
  const models = new ModelsService(root, { projectTrusted: () => false, fetch: async () => { throw new Error('Unexpected network'); } });
  for (const configured of channels) await models.save(configured, (await models.read()).revision);
  return models;
}

test('catalog is metadata-only, identifies channel configurations independently, and matches actual native thinking options', async () => {
  const first = channel('first'), second = channel('second');
  second.models.push({ id: 'budget', name: 'Budget', enabled: true, operations: ['chat'], reasoning: true,
    thinking: { mode: 'budget', tokens: 1536, allowOff: true }, compat: { thinkingTokenBudgetField: 'thinking_token_budget' }, maxOutputTokens: 8192 });
  second.models.push({ id: 'decision', name: 'Decision only', enabled: true, operations: ['decision'] });
  second.models.push({ id: 'disabled', name: 'Disabled', enabled: false, operations: ['chat'] });
  const models = await fixture([second, first, { ...channel('disabled-channel'), enabled: false }]);
  const guards = [vi.spyOn(models, 'captureModel'), vi.spyOn(models, 'getAuth'), vi.spyOn(models, 'resolveDecisionBinding'),
    vi.spyOn(models, 'acquireTokenizer'), vi.spyOn(models.credentials, 'captureResolver'), vi.spyOn(models.credentials, 'resolve')];
  const snapshot = await readDelegationModelCatalog(models);
  expect(snapshot.selector).toBeNull(); expect(snapshot.candidates).toHaveLength(3);
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  const sameModel = snapshot.candidates.filter(candidate => candidate.modelId === 'shared-model');
  expect(new Set(sameModel.map(candidate => candidate.id)).size).toBe(2);
  expect(sameModel.map(candidate => candidate.description).sort()).toEqual(['Experience on first', 'Experience on second']);
  const authority = createModelAuthority(models);
  for (const candidate of snapshot.candidates) {
    const described = await authority.describeModel({ providerId: candidate.providerId, modelId: candidate.modelId });
    expect(candidate.defaultThinkingLevel).toBe(described.thinkingLevel);
    for (const thinkingLevel of candidate.thinkingLevels) {
      expect((await authority.describeModel({ providerId: candidate.providerId, modelId: candidate.modelId, thinkingLevel })).thinkingLevel).toBe(thinkingLevel);
    }
  }
  expect(snapshot.candidates.find(candidate => candidate.modelId === 'budget')).toMatchObject({ thinking: { mode: 'budget', tokens: 1536 }, thinkingLevels: ['off', 'budget'], defaultThinkingLevel: 'off' });
  expect(sameModel[0]).toMatchObject({ input: ['text', 'image'], contextWindow: 32768, maxOutputTokens: 8192,
    pricing: { inputPerMillion: 0, outputPerMillion: 2 }, billing: 'metered' });
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private.example', 'private-credential-reference', 'private-header-value', 'authentication', 'baseUrl']) expect(serialized).not.toContain(secret);
  expect(snapshot.candidates.map(candidate => candidate.id)).toEqual(snapshot.candidates.map(candidate => candidate.id).sort());
});

test('stable IDs survive presentation edits, while execution fingerprints detect changed configuration without exposing it', async () => {
  const configured = channel('first'); const models = await fixture([configured]);
  const before = (await readDelegationModelCatalog(models)).candidates[0]!;
  configured.name = 'Renamed account'; configured.models[0]!.name = 'Renamed model'; configured.models[0]!.description = 'Updated experience';
  await models.save(configured, (await models.read()).revision);
  const renamed = (await readDelegationModelCatalog(models)).candidates[0]!;
  expect(renamed).toMatchObject({ id: before.id, configurationFingerprint: before.configurationFingerprint, description: 'Updated experience' });
  expect(before.description).toBe('Experience on first');
  configured.baseUrl = 'https://changed.private.example/v1';
  await models.save(configured, (await models.read()).revision);
  const changed = (await readDelegationModelCatalog(models)).candidates[0]!;
  expect(changed.id).toBe(before.id); expect(changed.configurationFingerprint).not.toBe(before.configurationFingerprint);
  expect(JSON.stringify(changed)).not.toContain('changed.private.example');
});

test('selector is opt-in, uses its own thinking default, and prefers decision operation without chat thinking', async () => {
  const configured = channel('first');
  configured.models.push({ id: 'selector', name: 'Selector', enabled: true, operations: ['chat', 'decision'], contextWindow: 16384 });
  const models = await fixture([configured]);
  expect((await readDelegationModelCatalog(models)).selector).toBeNull();
  const model = { providerId: 'first', modelId: 'shared-model' };
  expect((await readDelegationModelCatalog(models, { enabled: true, model })).selector).toMatchObject({ ...model, operation: 'chat', thinkingLevel: 'low', contextWindow: 32768 });
  expect((await readDelegationModelCatalog(models, { enabled: true, model, thinkingLevel: 'high' })).selector?.thinkingLevel).toBe('high');
  const decision = await readDelegationModelCatalog(models, { enabled: true, model: { providerId: 'first', modelId: 'selector' } });
  expect(decision.selector).toMatchObject({ providerId: 'first', modelId: 'selector', operation: 'decision', contextWindow: 16384 });
  expect(decision.selector?.thinkingLevel).toBeUndefined();
  await expect(readDelegationModelCatalog(models, { enabled: true, model: { providerId: 'first', modelId: 'selector' }, thinkingLevel: 'off' })).rejects.toMatchObject({ code: 'delegation-selector-thinking-unavailable' });
  await expect(readDelegationModelCatalog(models, { enabled: true, model, thinkingLevel: 'max' })).rejects.toMatchObject({ code: 'model-thinking-level-unavailable' });
  await expect(readDelegationModelCatalog(models, { enabled: true, model: { providerId: 'missing', modelId: 'selector' } })).rejects.toMatchObject({ code: 'delegation-selector-channel-unavailable' });
});

test('does not silently remove models whose declared thinking cannot produce a valid native request', async () => {
  const configured = channel('first');
  configured.models[0]!.thinking = { mode: 'budget', tokens: 1536, allowOff: false };
  const models = await fixture([configured]);
  await expect(readDelegationModelCatalog(models)).rejects.toMatchObject({ code: 'model-thinking-budget-field-required' });
});

test('selected bindings validate the frozen fingerprint on their captured snapshot before acquiring credentials', async () => {
  const configured = channel('first'); configured.authentication = { kind: 'none' };
  configured.models.push({ id: 'decision', name: 'Decision', enabled: true, operations: ['decision'], decision: { api: 'typesafe-system-one' } });
  const models = await fixture([configured]);
  const catalog = await readDelegationModelCatalog(models, { enabled: true, model: { providerId: 'first', modelId: 'decision' } });
  const candidate = catalog.candidates[0]!;
  const capture = vi.spyOn(models.credentials, 'captureResolver');
  configured.models[0]!.description = 'A description-only edit';
  await models.save(configured, (await models.read()).revision);
  const accepted = await models.captureModel(candidate.providerId, candidate.modelId, undefined, candidate.configurationFingerprint);
  accepted.release();
  expect(capture).toHaveBeenCalledTimes(1);
  const decision = await models.resolveDecisionBinding('first', 'decision', undefined, catalog.selector!.configurationFingerprint);
  decision.release?.(); expect(capture).toHaveBeenCalledTimes(2);
  capture.mockClear();
  configured.models[0]!.maxOutputTokens = 4096;
  configured.models[1]!.decision!.paths = { classify: '/changed' };
  await models.save(configured, (await models.read()).revision);
  await expect(models.captureModel(candidate.providerId, candidate.modelId, undefined, candidate.configurationFingerprint)).rejects.toMatchObject({ code: 'delegation-model-configuration-changed' });
  await expect(models.resolveDecisionBinding('first', 'decision', undefined, catalog.selector!.configurationFingerprint)).rejects.toMatchObject({ code: 'delegation-model-configuration-changed' });
  expect(capture).not.toHaveBeenCalled();
});


test('fixed model eligibility excludes unrelated invalid options before validation and unknown IDs remain empty', async () => {
  const configured = channel('first'), models = await fixture([configured]);
  const chosen = (await readDelegationModelCatalog(models)).candidates[0]!;
  configured.models.push({ id: 'invalid-unrelated', name: 'Invalid unrelated model', enabled: true, operations: ['chat'], reasoning: true,
    thinking: { mode: 'budget', tokens: 1536, allowOff: false }, maxOutputTokens: 8192 });
  await models.save(configured, (await models.read()).revision);
  const describe = vi.spyOn(models, 'describeConfiguredModel');
  const fixed = await readDelegationModelCatalog(models, { enabled: false }, chosen.id);
  expect(fixed.candidates).toEqual([chosen]);
  expect(describe.mock.calls.every(([, model]) => model.id === chosen.modelId)).toBe(true); describe.mockClear();
  expect(await readDelegationModelCatalog(models, { enabled: false }, 'unknown-fixed-id')).toEqual({ candidates: [], selector: null });
  expect(describe).not.toHaveBeenCalled();
  await expect(readDelegationModelCatalog(models)).rejects.toMatchObject({ code: 'model-thinking-budget-field-required' });
});
