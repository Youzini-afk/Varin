import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { getSettingsCatalogEntry, type ModelChannel, type ModelConnectionsSnapshot } from '@varin/application-client';
import { ModelsService } from '../models/service.js';
import { readDelegationModelCatalog } from '../models/delegation-catalog.js';
import { createSettingsActionRegistry, type SettingsActionDeps } from './settings-actions.js';
import { createSettingsPermissionSubjects } from './settings-authority.js';
import { createSettingsService } from './settings-service.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const caller = { threadId: 'thread', branchId: 'branch', workspaceId: 'workspace' };
const channel = (): ModelChannel => ({ id: 'account', name: 'Account', type: 'openai-compatible', enabled: true,
  baseUrl: 'https://provider.example/v1', authentication: { kind: 'none' }, parameters: {},
  connection: { headers: { 'X-Account-Context': 'private-channel-header' } },
  models: [{ id: 'org/model.v1:custom', name: 'Executor', description: 'Original description', enabled: true, operations: ['chat'],
    reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: false }, contextWindow: 32768, maxOutputTokens: 8192,
    parameters: { apiKey: 'private-model-parameter' } }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-delegation-settings-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.varin'), { recursive: true });
  const models = new ModelsService(root, { projectTrusted: cwd => cwd === project, fetch: async () => { throw new Error('Unexpected network'); } });
  const actions = createSettingsActionRegistry({ models: () => models } as SettingsActionDeps);
  const service = createSettingsService({ agentSettings: () => models.settings, actions, resolveWorkspaceRoot: async () => project,
    readAppSettings: async () => ({}), persistAppSettings: async () => { throw new Error('Unexpected app settings mutation'); } });
  return { root, project, models, actions, service };
}

test('settings facade writes the global selector for the next preparation with strict shape and original CAS receipts', async () => {
  const { project, models, service } = await fixture();
  await models.save(channel(), (await models.read()).revision);
  const id = 'harness.delegationModelSelection';
  expect(await service.read(caller, { id })).toMatchObject({ appliedAt: 'next-request', effective: { value: { enabled: false }, basis: 'configured' } });
  const snapshot = await models.settings.snapshot();
  for (const value of [{ enabled: true }, { enabled: false, thinkingLevel: 'invented' }, { enabled: false, fallback: true },
    { enabled: true, model: { providerId: 'account', modelId: 'org/model.v1:custom', endpoint: 'https://foreign.example' } }]) {
    expect(await service.update(caller, { id, set: { [id]: value } })).toMatchObject({ status: 'failed', mutation: 'none' });
  }
  expect((await models.settings.snapshot()).globalRevision).toBe(snapshot.globalRevision);
  const configured = { enabled: true, model: { providerId: 'account', modelId: 'org/model.v1:custom' }, thinkingLevel: 'high' };
  expect(await service.update(caller, { id, scope: 'project', set: { [id]: configured } })).toMatchObject({ status: 'failed', mutation: 'none' });
  const saved = await service.update(caller, { id, scope: 'global', expectedRevision: snapshot.globalRevision, set: { [id]: configured } });
  expect(saved).toMatchObject({ status: 'applied', mutation: 'applied', appliedAt: 'next-request', scope: 'global',
    fields: [{ path: id, saved: configured, effective: { value: configured, basis: 'configured', source: 'user' } }] });
  expect(saved.revision).toBe((await models.settings.read()).revision);
  const frozen = await readDelegationModelCatalog(models);
  expect(frozen.selector).toMatchObject({ ...configured.model, operation: 'chat', thinkingLevel: 'high' });
  await writeFile(join(project, '.varin', 'settings.json'), JSON.stringify({ harness: { delegationModelSelection: { enabled: false } } }));
  expect((await service.read(caller, { id })).effective?.value).toEqual(configured);
  expect(await service.update(caller, { id, expectedRevision: snapshot.globalRevision, set: { [id]: { enabled: false } } })).toMatchObject({ status: 'failed', mutation: 'none' });
  const disabled = await service.update(caller, { id, expectedRevision: saved.revision!, set: { [id]: { enabled: false } } });
  expect(disabled).toMatchObject({ status: 'applied', appliedAt: 'next-request' });
  expect((await readDelegationModelCatalog(models)).selector).toBeNull();
  expect(frozen.selector).toMatchObject({ thinkingLevel: 'high' });
});

test('provider actions retain hidden original fields, description overrides and execution fingerprints under real owner CAS', async () => {
  const { root, models, actions } = await fixture();
  const configured = channel();
  await models.save({ ...configured, models: [] }, (await models.read()).revision);
  const discover = (description: string) => models.discover(configured.id, async () => Response.json({ data: [{ id: configured.models[0]!.id, description }] }));
  await discover('Directory introduction');
  configured.models[0]!.catalog = { source: 'service', overrides: ['name', 'reasoning', 'thinking', 'contextWindow', 'maxOutputTokens', 'parameters', 'description'] };
  const entry = getSettingsCatalogEntry('providers.connect')!, ctx = { caller, workspaceRoot: null };
  const adapter = actions.adapterFor('runtime:providers')!;
  const saved = await adapter.invoke(ctx, entry, 'save', { channel: configured, expectedRevision: (await models.read()).revision });
  expect(saved).toMatchObject({ status: 'applied', mutation: 'applied', data: { channels: [{ models: [{ description: 'Original description' }] }] } });
  const revision = (saved.data as ModelConnectionsSnapshot).revision;
  const original = (await readDelegationModelCatalog(models)).candidates[0]!;
  const path = `models.${configured.models[0]!.id}.description`;
  const args = { id: configured.id, expectedRevision: revision, set: { [path]: 'Experience on this account' } };
  const resolve = createSettingsPermissionSubjects({ models: () => models });
  const subjects = await resolve('settings_action', { id: entry.id, verb: 'patch', args }, new AbortController().signal);
  expect(subjects?.[0]?.authority).toBeUndefined();
  const guards = [vi.spyOn(models, 'getAuth'), vi.spyOn(models.credentials, 'captureResolver')];
  const read = vi.spyOn(models.file, 'read').mockRejectedValue(new Error('Postcommit observation unavailable'));
  const patched = await adapter.invoke(ctx, entry, 'patch', args);
  expect(patched).toMatchObject({ status: 'applied', mutation: 'applied', data: { channels: [{ models: [{ description: 'Experience on this account' }] }] } });
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  const committed = await models.file.read();
  expect((patched.data as ModelConnectionsSnapshot).revision).toBe(committed.revision);
  expect(committed.document.channels[0]!.connection).toEqual(configured.connection);
  expect(committed.document.channels[0]!.models[0]!.parameters).toEqual(configured.models[0]!.parameters);
  expect(committed.document.channels[0]!.models[0]!.catalog?.overrides.filter(field => field === 'description')).toEqual(['description']);
  for (const secret of ['private-channel-header', 'private-model-parameter']) expect(JSON.stringify(patched)).not.toContain(secret);
  const edited = (await readDelegationModelCatalog(models)).candidates[0]!;
  expect(edited).toMatchObject({ id: original.id, configurationFingerprint: original.configurationFingerprint, description: 'Experience on this account' });
  const selected = await models.captureModel(edited.providerId, edited.modelId, undefined, original.configurationFingerprint); selected.release();
  expect(await adapter.invoke(ctx, entry, 'patch', { ...args, set: { [path]: 'Stale edit' } })).toMatchObject({ status: 'failed', mutation: 'none' });
  expect((await models.file.read()).revision).toBe(committed.revision);
  await discover('New directory introduction');
  expect((await models.read()).channels[0]!.models[0]!.description).toBe('Experience on this account');
  const cleared = await adapter.invoke(ctx, entry, 'patch', { id: configured.id, expectedRevision: committed.revision, set: { [path]: '' } });
  expect(cleared).toMatchObject({ status: 'applied', data: { channels: [{ models: [{ description: '' }] }] } });
  await discover('Latest directory introduction');
  const reset = await adapter.invoke(ctx, entry, 'patch', { id: configured.id, expectedRevision: (cleared.data as ModelConnectionsSnapshot).revision, reset: [path] });
  expect(reset).toMatchObject({ status: 'applied', data: { channels: [{ models: [{ description: 'Latest directory introduction' }] }] } });
  const stored = JSON.parse(await readFile(join(root, 'models.json'), 'utf8')).channels[0];
  expect(stored.models[0].description).toBeUndefined();
  expect(stored.models[0].catalog.overrides).not.toContain('description');
  expect(stored.models[0].parameters).toEqual(configured.models[0]!.parameters);
});
