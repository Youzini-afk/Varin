import { describe, expect, it, vi } from 'vitest';
import { getSettingsCatalogEntry, type BotSummary } from '@varin/application-client';
import type { RunModelSelection } from '@varin/protocol';
import { BotProfileMutationError, BotProfileConflictError } from '../bots/bot-service.js';
import { createSettingsActionRegistry, type SettingsActionDeps } from './settings-actions.js';
import type { SelfSettingsDeps } from './settings-self-actions.js';

const caller = { threadId: 'admitted-thread', branchId: 'admitted-branch', runId: 'admitted-run', operationId: 'original-operation', workspaceId: null };
const ctx = { caller, workspaceRoot: null };
const bot: BotSummary = { id: 'bound-bot', revision: 7, name: 'Varin', instructions: null, model: null, archived: false,
  entry: { runtime: 'agent', threadId: caller.threadId, branchId: caller.branchId }, coordinatorHostId: 'host', homeDir: '/bot', createdAt: '', updatedAt: '' };
const configuration = { providerId: 'provider', catalogModelId: 'catalog-model', model: 'request-model', thinkingLevel: 'high',
  endpoint: 'https://user:secret@example.test', credentialEnvironment: 'API_SECRET', connection: { headers: { authorization: 'secret' } }, modelOptions: { temperature: 0.4 } };
const selected = { id: 'selection', run_id: caller.runId, revision: 2, binding_id: 'binding', configuration, credential_scope: null, status: 'ready', failure: null } as unknown as RunModelSelection;
function setup() {
  const owner = {
    runtime: {
      thread: vi.fn(async () => ({ thread_id: caller.threadId, bot_id: bot.id, branches: [{ branch_id: caller.branchId }] })),
      run: vi.fn(async () => ({ id: caller.runId, thread_id: caller.threadId, branch_id: caller.branchId, state: 'executing', configuration })),
      modelSelections: vi.fn(async () => ({ active: selected, desired: { ...selected, status: 'preparing' } })),
    },
    bots: { get: vi.fn(async () => bot), update: vi.fn(async () => ({ ...bot, revision: 8, name: 'Renamed' })) },
    threads: { selectModel: vi.fn(async () => selected) },
    resolveBotModel: vi.fn(async () => ({ providerId: 'default-provider', modelId: 'default-model' })),
  };
  const registry = createSettingsActionRegistry({ self: () => owner as unknown as SelfSettingsDeps } as SettingsActionDeps);
  return { owner, registry, botEntry: getSettingsCatalogEntry('self.bot-profile')!, runEntry: getSettingsCatalogEntry('self.conversation-model')! };
}
describe('admitted self settings', () => {
  it('resolves the Bot from the original Thread and refuses supplied target identities before owner calls', async () => {
    const { owner, registry, botEntry } = setup();
    const adapter = registry.adapterFor('service:self-bot')!;
    const status = await adapter.describe(ctx, botEntry);
    expect(status).toMatchObject({ data: { botId: bot.id, revision: 7, saved: { model: null }, effective: { model: { modelId: 'default-model' } } }, actions: { update: { mutation: 'owner' } } });
    const rejected = await adapter.invoke(ctx, botEntry, 'update', { botId: 'another-bot', expectedRevision: 7, name: 'Hijack' });
    expect(rejected).toMatchObject({ status: 'failed', mutation: 'none' });
    expect(owner.bots.update).not.toHaveBeenCalled();
    expect(await adapter.invoke(ctx, botEntry, 'update', { expectedRevision: 7, name: 'Renamed' })).toMatchObject({ status: 'applied', mutation: 'applied', data: { revision: 8 } });
    expect(owner.bots.update).toHaveBeenCalledWith('bound-bot', { expectedRevision: 7, name: 'Renamed' });
    expect(owner.runtime.thread).toHaveBeenCalledWith(caller.threadId, undefined);
  });
  it('reports saved propagation failures separately from CAS failures', async () => {
    const { owner, registry, botEntry } = setup();
    const adapter = registry.adapterFor('service:self-bot')!;
    owner.bots.update.mockRejectedValueOnce(new BotProfileMutationError({ ...bot, revision: 8 }, 'profile-propagation', new Error('Offline')));
    expect(await adapter.invoke(ctx, botEntry, 'update', { expectedRevision: 7, model: null })).toMatchObject({ status: 'failed', mutation: 'applied', data: { revision: 8, propagation: { state: 'unavailable' } } });
    owner.bots.update.mockRejectedValueOnce(new BotProfileConflictError(8));
    expect(await adapter.invoke(ctx, botEntry, 'update', { expectedRevision: 7, model: null })).toMatchObject({ status: 'failed', mutation: 'none' });
  });
  it('uses the admitted Run and original operation key, while preserving distinct active/desired facts', async () => {
    const { owner, registry, runEntry } = setup();
    const adapter = registry.adapterFor('service:self-conversation')!;
    const read = await adapter.invoke(ctx, runEntry, 'read', {});
    expect(read).toMatchObject({ mutation: 'none', data: { active: { status: 'ready', model: { modelId: 'catalog-model' } }, desired: { status: 'preparing' } } });
    expect(JSON.stringify(read)).not.toMatch(/secret|API_SECRET|endpoint|headers/);
    const model = { providerId: 'next-provider', modelId: 'next-model', thinkingLevel: 'high', temperature: 0.2 };
    const request = { model };
    expect(await adapter.invoke(ctx, runEntry, 'select-model', request)).toMatchObject({ status: 'applied', mutation: 'applied', data: { selection: { status: 'ready' } } });
    await adapter.invoke(ctx, runEntry, 'select-model', request);
    expect(owner.threads.selectModel).toHaveBeenNthCalledWith(1, { runtime: 'agent', threadId: caller.threadId, branchId: caller.branchId,
      runId: caller.runId, key: 'settings:original-operation', model });
    expect(owner.threads.selectModel.mock.calls[1]).toEqual(owner.threads.selectModel.mock.calls[0]);
    expect(owner.bots.update).not.toHaveBeenCalled();
  });
  it('does not address another Run or invent a target without original admission', async () => {
    const { owner, registry, runEntry } = setup();
    const adapter = registry.adapterFor('service:self-conversation')!;
    const args = { model: { providerId: 'p', modelId: 'm' } };
    expect(await adapter.invoke(ctx, runEntry, 'select-model', { ...args, runId: 'foreign' })).toMatchObject({ mutation: 'none', status: 'failed' });
    const { operationId: _operationId, ...withoutOperation } = caller;
    expect(await adapter.invoke({ ...ctx, caller: withoutOperation }, runEntry, 'select-model', args)).toMatchObject({ mutation: 'none', status: 'unavailable' });
    owner.runtime.run.mockResolvedValueOnce({ id: caller.runId, thread_id: 'foreign-thread', branch_id: caller.branchId, state: 'executing', configuration });
    expect(await adapter.invoke(ctx, runEntry, 'select-model', args)).toMatchObject({ status: 'failed', mutation: 'none' });
    expect(owner.threads.selectModel).not.toHaveBeenCalled();
  });
});

it('keeps the saved Bot and CAS revision available when optional effective-model resolution fails', async () => {
  const { owner, registry, botEntry } = setup();
  owner.resolveBotModel.mockRejectedValue(new Error('Default model settings are malformed'));
  const adapter = registry.adapterFor('service:self-bot')!;
  expect(await adapter.describe(ctx, botEntry)).toMatchObject({ data: { revision: 7, saved: { model: null }, effectiveUnavailable: 'Default model settings are malformed' } });
  const read = await adapter.invoke(ctx, botEntry, 'read', {});
  expect(read).toMatchObject({ status: 'applied', mutation: 'none', data: { revision: 7, effectiveUnavailable: 'Default model settings are malformed' } });
  expect(read.data).not.toHaveProperty('effective');
});
