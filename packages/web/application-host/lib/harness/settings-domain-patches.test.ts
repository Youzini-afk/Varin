import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelChannel } from '@varin/application-client';
import { ModelsService } from '../models/service.js';
import { patchMcpServerDocument } from '../mcp/configuration-patch.js';
import { applyModelChannelPatch, patchModelChannel, sanitizeMcpDocument, sanitizeModelConnections } from './settings-domain-patches.js';

const fixtures: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
const channel = (): ModelChannel => ({ id: 'fixture', name: 'Fixture', type: 'local', enabled: true,
  baseUrl: 'http://localhost:1234/v1', authentication: { kind: 'none' }, parameters: {},
  connection: { headers: { 'x-account': 'private-header', 'x-remove': 'remove-me' }, proxy: { mode: 'direct' } },
  models: [{ id: 'chat', name: 'Chat', enabled: true, operations: ['chat'] }],
});

test('channel patches preserve omitted secrets, support explicit removal and do not mutate the input', () => {
  const current = channel();
  const next = applyModelChannelPatch(current, { set: { name: 'Changed', 'connection.headers.x-added': 'new-value' }, reset: ['connection.headers.x-remove'] });
  expect(next.connection?.headers).toEqual({ 'x-account': 'private-header', 'x-added': 'new-value' });
  expect(next.name).toBe('Changed');
  expect(current.name).toBe('Fixture');
  expect(current.connection?.headers?.['x-remove']).toBe('remove-me');
  expect(() => applyModelChannelPatch(current, { set: { id: 'other' } })).toThrow('declared channel');
  expect(() => applyModelChannelPatch(current, { set: { 'connection.headers': {} }, reset: ['connection.headers.x-account'] })).toThrow('overlap');
  expect(() => applyModelChannelPatch(current, { set: { name: undefined } })).toThrow('declared channel');
  const noConnection = channel(); delete noConnection.connection;
  expect(applyModelChannelPatch(noConnection, { reset: ['connection.headers.absent'] })).toEqual(noConnection);
});

test('description paths address literal model IDs, preserve overrides and reject overlapping or absent targets', () => {
  const current = channel();
  current.models = ['org/model.v1:custom', 'org/model.v1:custom.description.extra', '__proto__'].map(id => ({
    id, name: id, enabled: true, operations: ['chat'], description: 'Inherited', catalog: { source: 'service', overrides: ['name'] },
  }));
  const set = Object.fromEntries(current.models.map(model => [`models.${model.id}.description`, '']));
  const next = applyModelChannelPatch(current, { set });
  expect(next.models.map(model => [model.description, model.catalog])).toEqual(current.models.map(() => ['', { source: 'service', overrides: ['name', 'description'] }]));
  expect(current.models.every(model => model.description === 'Inherited')).toBe(true);
  const restored = applyModelChannelPatch(next, { reset: Object.keys(set) });
  expect(restored.models.every(model => model.description === undefined && !model.catalog?.overrides.includes('description'))).toBe(true);
  expect(() => applyModelChannelPatch(current, { set: { models: [], ...set } })).toThrow('overlap');
  expect(() => applyModelChannelPatch(current, { set, reset: [Object.keys(set)[0]!] })).toThrow('overlap');
  expect(() => applyModelChannelPatch(current, { set: { 'models.absent.description': 'No' } })).toThrow('missing');
  expect(() => applyModelChannelPatch(current, { set: { 'models.__proto__.parameters': {} } })).toThrow('declared channel');
});

test('real model owner patches the stored channel with CAS and returns the committed revision without rereading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-settings-patch-')); fixtures.push(directory);
  const owner = new ModelsService(directory, { projectTrusted: () => false, fetch: async () => { throw new Error('Unexpected test network'); } });
  const initial = await owner.save(channel(), (await owner.read()).revision);
  const rawBefore = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8')).channels[0];
  const read = vi.spyOn(owner.file, 'read').mockRejectedValue(new Error('Post-save observation unavailable'));
  const changed = await patchModelChannel(owner, { id: 'fixture', expectedRevision: initial.revision, set: { name: 'Patched' } });
  expect(changed.channels[0]?.name).toBe('Patched');
  expect(changed.revision).not.toBe(initial.revision);
  expect(read).not.toHaveBeenCalled();
  const rawAfter = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8')).channels[0];
  expect(rawAfter).toEqual({ ...rawBefore, name: 'Patched' });
  await expect(patchModelChannel(owner, { id: 'fixture', expectedRevision: initial.revision, set: { name: 'Stale' } })).rejects.toMatchObject({ code: 'config_conflict' });
  read.mockRestore();
  const concurrent = await Promise.allSettled([
    patchModelChannel(owner, { id: 'fixture', expectedRevision: changed.revision, set: { name: 'First' } }),
    patchModelChannel(owner, { id: 'fixture', expectedRevision: changed.revision, set: { name: 'Second' } }),
  ]);
  expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(concurrent.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'config_conflict' } }]);
  vi.spyOn(owner.modelDirectory, 'forget').mockRejectedValueOnce(new Error('Cleanup temporarily unavailable'));
  const removed = await owner.remove('fixture', (await owner.read()).revision);
  expect(removed.channels).toEqual([]);
  expect(removed.issues).toEqual([{ channelId: 'fixture', code: 'model-directory-cleanup-unavailable', message: 'Channel removed; cached model directory cleanup could not be confirmed.' }]);
  expect(JSON.parse(await readFile(join(directory, 'models.json'), 'utf8')).channels).toEqual([]);
});

test('model projection preserves editable shape without returning hidden headers or URL credentials', () => {
  const current = channel();
  current.baseUrl = 'https://user:url-password@example.test/v1?opaque=query-secret#fragment-secret';
  current.parameters = { apiKey: 'parameter-secret', region: 'local' };
  Object.assign(current, { legacyApiKey: 'legacy-channel-secret' });
  Object.assign(current.authentication, { legacyToken: 'legacy-auth-secret' });
  Object.assign(current.models[0]!, { legacyToken: 'legacy-model-secret' });
  const result = sanitizeModelConnections({ revision: 'r1', types: [], channels: [current] });
  const serialized = JSON.stringify(result);
  for (const secret of ['private-header', 'remove-me', 'url-password', 'query-secret', 'fragment-secret', 'parameter-secret', 'legacy-channel-secret', 'legacy-auth-secret', 'legacy-model-secret']) expect(serialized).not.toContain(secret);
  expect(result.channels[0]?.connection?.headers).toEqual({ 'x-account': { isSet: true }, 'x-remove': { isSet: true } });
  expect(result.channels[0]?.parameters).toEqual({ apiKey: { isSet: true }, region: 'local' });
});

test('MCP patch preserves JSONC comments, literal field names and omitted secret values', () => {
  const content = '{\n  // Keep this owner comment\n  "mcpServers": { "test": { "url": "https://example.test/mcp", "headers": { "x.secret": "hidden" }, "oauth": { "clientSecret": "oauth-secret", "clientId": "old" } } },\n  "otherOwner": { "unchanged": true }\n}\n';
  const patched = patchMcpServerDocument(content, { name: 'test', set: { enabled: false, 'oauth.clientId': 'new' } });
  expect(patched).toContain('// Keep this owner comment');
  expect(patched).toContain('"x.secret": "hidden"');
  expect(patched).toContain('"clientSecret": "oauth-secret"');
  expect(patched).toContain('"otherOwner": { "unchanged": true }');
  const removed = patchMcpServerDocument(patched, { name: 'test', reset: ['headers.x.secret'] });
  expect(removed).not.toContain('"hidden"');
  expect(() => patchMcpServerDocument(content, { name: 'test', set: { headers: {} }, reset: ['headers.x.secret'] })).toThrow('overlap');
  expect(() => patchMcpServerDocument('{malformed', { name: 'test', set: { enabled: false } })).toThrow('malformed');
});

test('MCP safe document shows real structure and revision while secrets are presence facts', () => {
  const value = { path: '/fixture/mcp.json', exists: true, revision: 'r1', activation: { state: 'ready' }, content: JSON.stringify({
    mcpServers: {
      web: { url: 'https://user:password@example.test/mcp?custom=opaque-secret', headers: { Authorization: 'bearer-secret' }, oauth: { clientId: 'public-id', clientSecret: 'oauth-secret' } },
      local: { command: 'node', args: ['server.js', '--token=argument-secret'], env: { CUSTOM: 'environment-secret' } },
    }, mcpPolicies: { web: { enabled: false } }, unrelatedSecret: 'not-an-mcp-field',
  }) };
  const safe = sanitizeMcpDocument(value);
  expect(safe).toMatchObject({ revision: 'r1', activation: { state: 'ready' }, document: { mcpServers: {
    web: { headers: { Authorization: { isSet: true } }, oauth: { clientId: 'public-id', clientSecret: { isSet: true } } },
    local: { command: 'node', args: { isSet: true, count: 2 }, env: { CUSTOM: { isSet: true } } },
  }, mcpPolicies: { web: { enabled: false } } } });
  for (const secret of ['password', 'opaque-secret', 'bearer-secret', 'oauth-secret', 'argument-secret', 'environment-secret', 'not-an-mcp-field']) expect(JSON.stringify(safe)).not.toContain(secret);
  expect(sanitizeMcpDocument({ ...value, content: '{ broken secret' })).toMatchObject({ revision: 'r1', documentState: 'malformed' });
  const malformed = sanitizeMcpDocument({ ...value, content: JSON.stringify({
    mcpServers: { bad: { url: 'https://example.test', auth: { provider: 'public', secret: 'malformed-secret' } } },
    mcpPolicies: { bad: { enabled: 'invalid-policy-secret' } },
  }) });
  expect(malformed).toMatchObject({ document: { mcpServers: { bad: { malformed: true } }, mcpPolicies: { bad: { malformed: true } } } });
  expect(JSON.stringify(malformed)).not.toContain('malformed-secret');
  expect(JSON.stringify(malformed)).not.toContain('invalid-policy-secret');
});
