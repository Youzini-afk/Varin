import { describe, expect, it, vi } from 'vitest';
import { getSettingsCatalogEntry } from '@varin/application-client';
import { createSettingsActionRegistry, type SettingsActionDeps } from './settings-actions.js';

const ctx = { caller: { threadId: 'thread', branchId: 'branch', workspaceId: null }, workspaceRoot: null };
describe('native settings action owners', () => {
  it('opens MCP without a project and keeps document revisions and credential redaction', async () => {
    const invoke = vi.fn(async (action: string, args: Record<string, unknown>) => {
      if (action === 'open' || action === 'read') return { view: 'view', servers: [{ name: 'native' }], sources: [{ path: '/data/mcp.json' }], issues: [] };
      return { exists: true, revision: 'r1', path: args.path, content: 'secret-config' };
    });
    const adapter = createSettingsActionRegistry({ mcpSettings: () => ({ invoke }) } as unknown as SettingsActionDeps).adapterFor('runtime:mcp')!;
    const entry = getSettingsCatalogEntry('mcp.configuration')!;
    expect((await adapter.describe(ctx, entry)).summary).toBe('1 native MCP servers');
    expect(invoke).toHaveBeenCalledWith('open', {}, undefined);
    const read = await adapter.invoke(ctx, entry, 'read', { path: '/data/mcp.json' });
    expect(JSON.stringify(read)).not.toContain('secret-config');
    const noRevision = await adapter.invoke(ctx, entry, 'write', { path: '/data/mcp.json', content: '{}' });
    expect(noRevision.status).toBe('failed');
    expect(invoke.mock.calls.some(([action]) => action === 'document/save')).toBe(false);
    await adapter.invoke(ctx, entry, 'write', { path: '/data/mcp.json', content: '{}', expectedRevision: 'r1' });
    expect(invoke).toHaveBeenLastCalledWith('document/save', { view: 'view', path: '/data/mcp.json', content: '{}', expectedRevision: 'r1' }, undefined);
  });
  it('saves native profiles with explicit revision and runtime without a source workspace', async () => {
    const save = vi.fn(async () => ({ profileId: 'varin:custom:new' }));
    const owner = { read: async () => ({ profiles: [] }), save, remove: vi.fn() };
    const adapter = createSettingsActionRegistry({ agentProfiles: () => owner } as unknown as SettingsActionDeps).adapterFor('service:agents')!;
    const entry = getSettingsCatalogEntry('agents.catalog')!;
    const config = { kind: 'custom', key: '', agent: { name: 'reader' } };
    expect((await adapter.invoke(ctx, entry, 'create', { expectedRevision: 'r', config, tools: [] })).status).toBe('applied');
    expect(save).toHaveBeenCalledWith({ runtime: 'agent', expectedRevision: 'r', config, tools: [] }, undefined);
    expect((await adapter.invoke(ctx, entry, 'delete', { id: 'varin:custom:new' })).status).toBe('failed');
    expect(owner.remove).not.toHaveBeenCalled();
  });
  it('uses original model OAuth references and redacts connection header secrets', async () => {
    let status = 'pending';
    const signIn = vi.fn(() => ({ id: 'auth', status }));
    const owner = { read: async () => ({ revision: 'r', types: [], channels: [{ id: 'channel', baseUrl: 'https://example.test', connection: { headers: { authorization: 'secret' } } }] }),
      signIn, authorizations: { read: () => ({ id: 'auth', status }), cancel: () => { status = 'cancelled'; } } };
    const adapter = createSettingsActionRegistry({ models: () => owner } as unknown as SettingsActionDeps).adapterFor('runtime:providers')!;
    const entry = getSettingsCatalogEntry('providers.auth')!;
    expect(JSON.stringify(await adapter.describe(ctx, entry))).not.toContain('secret');
    expect(await adapter.invoke(ctx, entry, 'login', { provider: 'oauth-owner', reference: 'account' })).toMatchObject({ status: 'pending', operation: { id: 'auth', state: 'running' } });
    expect(signIn).toHaveBeenCalledWith('oauth-owner', 'account');
    expect(await adapter.cancelOperation!(ctx, entry, 'auth', {})).toMatchObject({ operation: { id: 'auth', state: 'cancelled' } });
  });
});
