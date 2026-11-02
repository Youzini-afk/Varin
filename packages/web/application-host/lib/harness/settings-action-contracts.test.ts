import { describe, expect, it, vi } from 'vitest';
import { SETTINGS_CATALOG, getSettingsCatalogEntry } from '@varin/application-client';
import { parseHarnessModelSlots, parseHarnessAgent, parseModelRetrySettings, resolveHarnessDelegationModelSelectionSettings } from '@varin/protocol';
import { compileToolJsonSchema } from '../models/schema.js';
import { parseCompactionSettings } from '../models/compaction-settings.js';
import { getSettingsActionContracts } from './settings-action-contracts.js';
import { createSettingsActionRegistry, type SettingsActionDeps } from './settings-actions.js';
import { settingsDocumentRevision } from './settings-service.js';

const ctx = { caller: { threadId: 'thread', branchId: 'branch', workspaceId: null }, workspaceRoot: null };
describe('settings owner action contracts', () => {
  it('compiles every disclosed action and structured value schema, without accepting target injection', () => {
    for (const entry of SETTINGS_CATALOG) {
      for (const contract of Object.values(getSettingsActionContracts(entry))) expect(() => compileToolJsonSchema(contract.inputSchema)).not.toThrow();
      for (const field of [entry.field, ...(entry.fields ?? [])]) if (field?.schema) expect(() => compileToolJsonSchema(field.schema)).not.toThrow();
    }
    const self = getSettingsActionContracts(getSettingsCatalogEntry('self.conversation-model')!)['select-model']!;
    const validate = compileToolJsonSchema(self.inputSchema);
    expect(validate({ model: { providerId: 'p', modelId: 'm', thinkingLevel: 'high', temperature: 0 } })).toBe(true);
    expect(validate({ model: { providerId: 'p', modelId: 'm' }, threadId: 'foreign' })).toBe(false);
  });
  it('uses real native shapes rather than opaque JSON suggestions', () => {
    const byPath = new Map(SETTINGS_CATALOG.flatMap(entry => [entry.field, ...(entry.fields ?? [])]).filter(field => field?.schema).map(field => [field!.path, field!.schema!]));
    const accept = (path: string, value: unknown) => expect(compileToolJsonSchema(byPath.get(path)!)(value)).toBe(true);
    const binding = { enabled: true, inherit: false, providerId: 'p', modelId: 'm', agent: { modelSettings: { temperature: 0.4, thinkingLevel: 'high' } } };
    accept('harness.models.worker', binding); expect(parseHarnessModelSlots({ worker: binding }).worker).toEqual(binding);
    const agent = { name: 'Researcher', description: '', instructions: 'Investigate', enabled: true, workFocus: ['research'], tools: ['read'] };
    accept('harness.agents', { researcher: agent }); expect(parseHarnessAgent(agent)).toEqual(agent);
    const context = getSettingsCatalogEntry('harness.context')!;
    expect(context.fields?.map(field => field.path)).toEqual(['harness.context.backgroundPreparation', 'harness.context.preparationWaterline']);
    expect(getSettingsCatalogEntry('harness.context.compactionRecovery')).toMatchObject({ writable: false, apply: 'unsupported' });
    const retry = { maxRetries: 4, rules: [{ field: 'status', match: 'exact', pattern: '429', action: 'retry' }] };
    accept('retry', retry); expect(parseModelRetrySettings(retry).maxRetries).toBe(4);
    const overrides = { 'p/m': { reserveRatio: 0.2, keepRecentTokens: 0 } };
    accept('compaction.modelOverrides', overrides); expect(parseCompactionSettings({ modelOverrides: overrides }).modelOverrides).toEqual(overrides);
    expect(compileToolJsonSchema(byPath.get('favoriteModels')!)({ malformed: true })).toBe(false);
    expect(compileToolJsonSchema(byPath.get('favoriteModels')!)([{ providerID: 'p', modelID: 'm' }])).toBe(true);
    expect(compileToolJsonSchema(byPath.get('harness.permissions.rules')!)([{ tool: 'settings_update', decision: 'allow', authority: 'permission-policy', match: { param: 'id', pattern: '^harness\\.permissions' } }])).toBe(true);
  });
  it('discloses the strict native delegation selector shape, including disabled and configured-default thinking', () => {
    const entry = getSettingsCatalogEntry('harness.delegationModelSelection')!;
    const validate = compileToolJsonSchema(entry.field!.schema!);
    for (const value of [{}, { enabled: false }, { enabled: true, model: { providerId: 'account', modelId: 'selector' } },
      { enabled: false, model: { providerId: 'account', modelId: 'selector' }, thinkingLevel: 'high' }]) {
      expect(validate(value)).toBe(true);
      expect(() => resolveHarnessDelegationModelSelectionSettings(value)).not.toThrow();
    }
    for (const value of [{ enabled: true }, { enabled: 'true' }, { model: { providerId: ' ', modelId: 'selector' } },
      { model: { providerId: 'account', modelId: 'selector', endpoint: 'https://foreign.example' } },
      { thinkingLevel: 'invented' }, { enabled: false, fallback: 'parent' }]) {
      expect(validate(value)).toBe(false);
      expect(() => resolveHarnessDelegationModelSelectionSettings(value)).toThrow();
    }
    expect(entry).toMatchObject({ apply: 'next-request', field: { scope: 'user' } });
  });
  it('requires the read project document revision and reports the actual saved owner value', async () => {
    let document: Record<string, unknown> = { projects: [{ id: 'p', path: '/p', label: 'Old' }] };
    const persist = vi.fn(async (changes, _removals, expectedRevision) => {
      if (expectedRevision !== settingsDocumentRevision(document)) return { conflict: true, revision: settingsDocumentRevision(document), document };
      document = { ...document, ...changes };
      return { conflict: false, revision: settingsDocumentRevision(document), document };
    });
    const registry = createSettingsActionRegistry({ readAppSettings: async () => document, persistAppSettings: persist, resolveWorkspaceRoot: async () => null } as SettingsActionDeps);
    const adapter = registry.adapterFor('service:projects')!, entry = getSettingsCatalogEntry('projects.name')!;
    const first = await adapter.describe(ctx, entry);
    const revision = (first.data as { revision: string }).revision;
    expect(await adapter.invoke(ctx, entry, 'rename', { projectId: 'p', name: 'Changed' })).toMatchObject({ status: 'failed', mutation: 'none' });
    expect(persist).not.toHaveBeenCalled();
    const saved = await adapter.invoke(ctx, entry, 'rename', { projectId: 'p', name: 'Changed', expectedRevision: revision });
    expect(saved).toMatchObject({ status: 'applied', mutation: 'applied', data: { project: { label: 'Changed' }, revision: settingsDocumentRevision(document) } });
    expect(await adapter.invoke(ctx, entry, 'rename', { projectId: 'p', name: 'Stale', expectedRevision: revision })).toMatchObject({ status: 'failed', mutation: 'none' });
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown action args and real stale extension revision before dispatch', async () => {
    const setEnabled = vi.fn(async () => ({})), selectWorkbenchProfile = vi.fn(async () => ({}));
    const runtime = { state: async () => ({ workbench: { document: { revision: 8, profiles: [{ id: 'default' }] } } }), setEnabled, selectWorkbenchProfile };
    const adapter = createSettingsActionRegistry({ extensionRuntime: () => runtime } as unknown as SettingsActionDeps).adapterFor('service:extensions')!;
    const entry = getSettingsCatalogEntry('extensions.workbench.profile')!;
    expect(await adapter.invoke(ctx, entry, 'select', { profileId: 'default', expectedRevision: 7 })).toMatchObject({ mutation: 'none', status: 'failed' });
    expect(selectWorkbenchProfile).not.toHaveBeenCalled();
    expect(await adapter.invoke(ctx, entry, 'select', { profileId: 'default', expectedRevision: 8 })).toMatchObject({ mutation: 'applied', status: 'applied' });
    expect(selectWorkbenchProfile).toHaveBeenCalledWith({ profileId: 'default', expectedRevision: 8, scope: 'user', scopeId: 'default' });
    const enable = getSettingsCatalogEntry('extensions.workbench.extensionSet')!;
    expect(await adapter.invoke(ctx, enable, 'enable', { id: 'wrong-argument', expectedRevision: 8 })).toMatchObject({ mutation: 'none', status: 'failed' });
    expect(setEnabled).not.toHaveBeenCalled();
  });
});
