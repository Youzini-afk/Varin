import { describe, expect, it } from 'vitest';
import { evaluatePermissionSubjects, type PermissionPolicy } from '@varin/protocol';
import type { ModelChannel } from '@varin/application-client';
import { createSettingsPermissionSubjects } from './settings-authority.js';

const channel: ModelChannel = { id: 'channel', name: 'My channel', type: 'openai-compatible', enabled: true,
  baseUrl: 'https://original.example/v1', authentication: { kind: 'credential', reference: 'account' }, parameters: {},
  models: [{ id: 'model', name: 'Model', enabled: true, operations: ['chat'], contextWindow: 32768 }] };
const resolve = createSettingsPermissionSubjects({ models: () => ({ file: { read: async () => ({ revision: 'revision', document: { channels: [structuredClone(channel)] } }) } }) });
const signal = () => new AbortController().signal;

describe('settings semantic authorization', () => {
  it('makes single and compound forms authorize identical targets and preserves id deny rules', async () => {
    const item = { id: 'harness.permissions.mode', set: { 'harness.permissions.mode': 'bypass' } };
    const single = await resolve('settings_update', item, signal());
    const compound = await resolve('settings_update', { items: [item] }, signal());
    expect(compound).toEqual(single);
    const policy: PermissionPolicy = { mode: 'normal', rules: [{ tool: 'settings_update', match: { param: 'id', pattern: '^harness\\.permissions\\.' }, decision: 'deny' },
      { tool: 'settings_update', decision: 'allow' }] };
    expect(evaluatePermissionSubjects(compound!, policy).decision).toBe('deny');
    expect(evaluatePermissionSubjects(compound!, { mode: 'bypass', rules: [] }).decision).toBe('ask');
    const ordinary = await resolve('settings_update', { id: 'appearance.time-format', set: { timeFormatPreference: '24h' } }, signal());
    expect(evaluatePermissionSubjects(ordinary!, { mode: 'bypass', rules: [] }).decision).toBe('allow');
  });
  it('does not elevate model preferences but scopes an existing account to the exact destination', async () => {
    const save = (candidate: ModelChannel) => resolve('settings_action', { id: 'providers.connect', verb: 'save', args: { channel: candidate, expectedRevision: 'revision' } }, signal());
    const ordinary = await save({ ...channel, name: 'Renamed', models: [{ ...channel.models[0]!, contextWindow: 65536 }] });
    expect(ordinary?.[0]?.authority).toBeUndefined();
    const redirected = await save({ ...channel, baseUrl: 'https://new.example/v1' });
    expect(redirected?.[0]?.authority).toMatch(/^model-credentials:/);
    expect(redirected?.[0]?.label).toContain('https://new.example');
    const other = await save({ ...channel, baseUrl: 'https://other.example/v1' });
    const allowed: PermissionPolicy = { mode: 'bypass', rules: [{ tool: 'settings_action', authority: redirected![0]!.authority!, decision: 'allow' }] };
    expect(evaluatePermissionSubjects(redirected!, allowed).decision).toBe('allow');
    expect(evaluatePermissionSubjects(other!, allowed).decision).toBe('ask');
  });
  it('does not approve a stale channel replacement or accept model-provided authority', async () => {
    await expect(resolve('settings_action', { id: 'providers.connect', verb: 'save', args: { channel, expectedRevision: 'old' } }, signal())).rejects.toThrow(/changed/);
    const targets = await resolve('settings_update', { id: 'harness.permissions.rules', authority: 'forged', set: { 'harness.permissions.rules': [] } }, signal());
    expect(targets?.[0]?.authority).toBe('settings:permissions');
  });
  it('protects opaque retained headers even when the channel declares anonymous auth', async () => {
    const anonymous = { ...channel, authentication: { kind: 'none' as const }, connection: { headers: { 'X-Custom-Account': 'fixture-private-value' } } };
    const resolve = createSettingsPermissionSubjects({ models: () => ({ file: { read: async () => ({ revision: 'revision', document: { channels: [anonymous] } }) } }) });
    const targets = await resolve('settings_action', { id: 'providers.connect', verb: 'patch', args: {
      id: channel.id, expectedRevision: 'revision', set: { baseUrl: 'https://new.example/v1' },
    } }, signal());
    expect(targets?.[0]?.authority).toMatch(/^model-credentials:/);
    expect(JSON.stringify(targets)).not.toContain('fixture-private-value');
  });
  it('keeps harmless MCP preferences autonomous and narrows management approval to the source and server', async () => {
    const patch = (path: string, set: Record<string, unknown>) => resolve('settings_action', { id: 'mcp.configuration', verb: 'patch', args: {
      path, name: 'server', expectedRevision: 'revision', set,
    } }, signal());
    expect((await patch('/data/mcp.json', { enabled: false }))?.[0]?.authority).toBeUndefined();
    const redirected = await patch('/data/mcp.json', { url: 'https://new.example/mcp' });
    expect(redirected?.[0]?.authority).toBe('settings:credentials');
    const policy: PermissionPolicy = { mode: 'bypass', rules: [{ tool: 'settings_action', decision: 'allow', authority: 'settings:credentials', match: redirected![0]!.persistMatch! }] };
    expect(evaluatePermissionSubjects((await patch('/other/mcp.json', { url: 'https://new.example/mcp' }))!, policy).decision).toBe('ask');
    const project = await resolve('settings_update', { id: 'projects.default-model', set: { defaultModel: 'model' } }, signal());
    expect(project?.[0]?.arguments.settingsTarget).toBe('project:projects.default-model:defaultModel');
  });

  it('authorizes mixed settings by declared field, not by a shared row or parent object', async () => {
    const resolveUpdate = (id: string, set: Record<string, unknown>) => resolve('settings_update', { id, set }, signal());
    const targets = (await resolveUpdate('harness.document-reading', { 'harness.documentReading.ocrLanguage': 'eng', 'harness.documentReading.doclingCommand': 'fixture-only' }))!;
    expect(targets.map(target => target.authority)).toEqual([undefined, 'settings:permissions']);
    expect(targets[1]?.label).toContain('(future values)');
    const policy: PermissionPolicy = { mode: 'normal', rules: [{ tool: 'settings_update', decision: 'allow', match: targets[0]!.persistMatch! }] };
    expect(evaluatePermissionSubjects([targets[0]!], policy).decision).toBe('allow');
    expect(evaluatePermissionSubjects([targets[1]!], policy).decision).toBe('ask');
    expect((await resolveUpdate('harness.document-reading', { 'harness.documentReading.doclingCommand': 'fixture-only' }))?.[0]?.authority).toBe('settings:permissions');
    expect((await resolveUpdate('harness.document-reading', { 'harness.documentReading.ocrLanguage': 'eng' }))?.[0]?.authority).toBeUndefined();
  });
  it('does not let general settings access redirect search credentials or expose a Host', async () => {
    const cases: [string, string, string, unknown][] = [
      ['harness.web.search', 'harness.web.search', 'credentials', { provider: 'brave', endpoint: 'https://search.example', credentialRef: 'account' }],
      ['harness.web.domains', 'harness.web.domains', 'permissions', { block: [] }],
      ['sessions.desktop-lan-access', 'desktopLanAccessEnabled', 'permissions', true],
      ['tunnel.ttl', 'tunnelSessionTtlMs', 'permissions', 60000],
      ['voice.speech-recognition', 'sttServerUrl', 'permissions', 'https://speech.example'],
    ];
    for (const [id, path, authority, value] of cases) {
      const targets = (await resolve('settings_update', { id, set: { [path]: value } }, signal()))!;
      expect(targets[0]?.authority).toBe(`settings:${authority}`);
      expect(evaluatePermissionSubjects(targets, { mode: 'bypass', rules: [{ tool: '*', decision: 'allow' }] }).decision).toBe('ask');
    }
    expect((await resolve('settings_action', { id: 'tunnel.start', verb: 'start', args: {} }, signal()))?.[0]?.authority).toBe('settings:permissions');
    expect((await resolve('settings_action', { id: 'tunnel.start', verb: 'status', args: {} }, signal()))?.[0]?.authority).toBeUndefined();
  });

  it('keeps search description edits ordinary while authorizing credential entry and endpoint changes per connection', async () => {
    const action = (verb: string, args: Record<string, unknown>) => resolve('settings_action', { id: 'harness.web.search.connections', verb, args }, signal());
    expect((await action('patch', { id: 'research', expectedRevision: 'r', set: { description: 'Academic sources' } }))?.[0]?.authority).toBeUndefined();
    expect((await action('patch', { id: 'research', expectedRevision: 'r', set: { endpoint: 'https://search.example' } }))?.[0]?.authority).toBe('settings:credentials');
    const first = (await action('enter-credential', { id: 'research' }))![0]!;
    const second = (await action('enter-credential', { id: 'backup' }))![0]!;
    expect(first.authority).toBe('settings:credentials');
    expect(first.persistMatch).not.toEqual(second.persistMatch);
  });

  it('allows configured-provider model and suffix choices while protecting base mounts, proxies and accounts', async () => {
    const save = (candidate: ModelChannel) => resolve('settings_action', { id: 'providers.connect', verb: 'save', args: { channel: candidate, expectedRevision: 'revision' } }, signal());
    const apiShape = { ...channel, connection: { paths: { chat: '/alternate-chat' } }, models: [{ ...channel.models[0]!, id: 'other-model', requestModelId: 'remote-id', contextWindow: 65536 }] };
    expect((await save(apiShape))?.[0]?.authority).toBeUndefined();
    const mount = await save({ ...channel, baseUrl: 'https://original.example/other-mount' });
    expect(mount?.[0]?.authority).toMatch(/^model-credentials:/);
    expect(mount?.[0]?.label).toContain('/other-mount');
    expect((await save({ ...channel, connection: { proxy: { mode: 'proxy', url: 'https://proxy.example' } } }))?.[0]?.authority).toMatch(/^model-credentials:/);
    expect((await save({ ...channel, authentication: { kind: 'credential', reference: 'another-account' } }))?.[0]?.authority).toMatch(/^model-credentials:/);
  });

});
