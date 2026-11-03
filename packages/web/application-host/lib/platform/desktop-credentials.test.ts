import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSettingsFileStore } from '@varin/settings-store';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createDesktopLocalCredentials } from './desktop-credentials.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-desktop-credentials-')); roots.push(root);
  const store = createSettingsFileStore({ filePath: path.join(root, 'settings.json') });
  const auth = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(root, 'remote-clients.json') });
  const credentials = createDesktopLocalCredentials({ read: store.read, update: store.update, auth });
  return { root, store, auth, credentials };
}
it('reuses the exact pre-existing desktop subject and token while preserving unrelated assets', async () => {
  const f = await fixture();
  const old = await f.auth.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
  await f.store.update(settings => { settings.desktopLocalClientToken = old.token; settings.projects = [{ id: 'original-workspace', path: '/original' }]; });
  expect(await f.credentials()).toEqual({ clientToken: old.token });
  expect((await f.auth.listClients()).map(client => client.id)).toEqual([old.client.id]);
  expect((await f.store.read()).projects).toEqual([{ id: 'original-workspace', path: '/original' }]);
});
for (const dedupeKey of ['desktop-local', 'custom-local-key']) {
  for (const status of ['active', 'revoked', 'expired']) {
    it.each([
      { profile: 'client', capabilities: ['ui:access'], allowedDirectories: [] },
      { profile: 'readonly', capabilities: ['config:read'], allowedDirectories: ['/explicitly-scoped'] },
    ])(`preserves ${status} ${dedupeKey} subject and policy during private retrieval: %j`, async policy => {
      const f = await fixture();
      const other = await f.auth.createClient({ label: 'Other connection', clientKind: 'desktop', dedupeKey: 'other-connection', profile: 'readonly' });
      const reserved = dedupeKey !== 'desktop-local'
        ? await f.auth.createClient({ clientKind: 'desktop-local', dedupeKey: 'desktop-local', profile: 'full-control' }) : null;
      const old = await f.auth.createClient({ label: 'Original desktop', clientKind: 'desktop-local', dedupeKey,
        authMethod: 'password', deviceName: 'Original device', pairingId: 'retained-metadata', ...policy,
        ...(status === 'expired' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : {}) });
      await f.store.update(settings => { settings.desktopLocalClientToken = old.token; });
      if (status === 'revoked') await f.auth.revokeClient(old.client.id);
      const [first, second] = await Promise.all([f.credentials(), f.credentials()]);
      expect(first).toEqual(second);
      if (status === 'active') expect(first.clientToken).toBe(old.token);
      else {
        expect(first.clientToken).not.toBe(old.token);
        expect(await f.auth.authenticateBearerToken(old.token)).toBeNull();
      }
      const current = await f.auth.authenticateBearerToken(first.clientToken);
      expect(current?.client).toMatchObject({ id: old.client.id, createdAt: old.client.createdAt,
        label: old.client.label, authMethod: 'password', deviceName: 'Original device', pairingId: 'retained-metadata',
        profile: old.client.profile, capabilities: old.client.capabilities, allowedDirectories: old.client.allowedDirectories,
        revokedAt: null, expiresAt: null });
      expect((await f.auth.authenticateBearerToken(other.token))?.client).toMatchObject({ id: other.client.id, profile: 'readonly' });
      if (reserved) expect((await f.auth.authenticateBearerToken(reserved.token))?.clientId).toBe(reserved.client.id);
      expect((await f.auth.listClients())).toHaveLength(reserved ? 3 : 2);
      expect((await f.store.read()).desktopLocalClientToken).toBe(first.clientToken);
      const records = JSON.parse(await fs.readFile(path.join(f.root, 'remote-clients.json'), 'utf8')).clients as Array<{ id: string; dedupeKey: string }>;
      expect(records.find(record => record.id === old.client.id)?.dedupeKey).toBe(dedupeKey);
    });
  }
}

it('grants full control only to a genuinely new private identity', async () => {
  const f = await fixture();
  const { clientToken } = await f.credentials();
  const client = (await f.auth.authenticateBearerToken(clientToken))!.client;
  expect(client).toMatchObject({ clientKind: 'desktop-local', profile: 'full-control' });
  expect(client.capabilities).toContain('filesystem:delete');
  expect(await f.credentials()).toEqual({ clientToken });
  expect(await f.auth.listClients()).toHaveLength(1);
});

it('recovers a reserved identity with missing saved token without broadening its policy', async () => {
  const f = await fixture();
  const old = await f.auth.createClient({ clientKind: 'desktop-local', dedupeKey: 'desktop-local', profile: 'client' });
  const { clientToken } = await f.credentials();
  expect(clientToken).not.toBe(old.token);
  expect((await f.auth.authenticateBearerToken(clientToken))?.client).toMatchObject({ id: old.client.id, profile: 'client', capabilities: ['ui:access'] });
});

it.each(['missing-record', 'remote-record', 'orphaned-custom', 'wrong-reserved-kind', 'malformed-setting'])('fails closed for an unverifiable private identity: %s', async scenario => {
  const f = await fixture();
  const remote = await f.auth.createClient({ clientKind: 'desktop', dedupeKey: scenario === 'wrong-reserved-kind' ? 'desktop-local' : 'remote' });
  if (scenario === 'missing-record' || scenario === 'remote-record') {
    await f.auth.createClient({ clientKind: 'desktop-local', dedupeKey: 'desktop-local', profile: 'full-control' });
  }
  if (scenario === 'orphaned-custom') await f.auth.createClient({ clientKind: 'desktop-local', dedupeKey: 'custom' });
  if (scenario === 'missing-record') await f.store.update(settings => { settings.desktopLocalClientToken = 'varin_client_unrecognized_test_token'; });
  if (scenario === 'remote-record') await f.store.update(settings => { settings.desktopLocalClientToken = remote.token; });
  if (scenario === 'malformed-setting') await f.store.update(settings => { settings.desktopLocalClientToken = { invalid: true }; });
  const before = await fs.readFile(path.join(f.root, 'remote-clients.json'), 'utf8');
  const settingsBefore = await f.store.read();
  await expect(f.credentials()).rejects.toThrow(/Existing desktop local/);
  expect(await fs.readFile(path.join(f.root, 'remote-clients.json'), 'utf8')).toBe(before);
  expect(await f.store.read()).toEqual(settingsBefore);
});
it('preserves malformed original settings instead of initializing an empty profile', async () => {
  const f = await fixture();
  await fs.writeFile(f.store.filePath, '{invalid');
  await expect(f.credentials()).rejects.toThrow();
  expect(await fs.readFile(f.store.filePath, 'utf8')).toBe('{invalid');
  expect(await f.auth.listClients()).toEqual([]);
});

it('preserves ambiguous historical desktop policy without changing its token, subject or metadata', async () => {
  const f = await fixture();
  const old = await f.auth.createClient({ label: 'Original Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local', deviceName: 'Original name' });
  const paired = await f.auth.createClient({ label: 'Paired phone', clientKind: 'mobile' });
  await f.store.update(settings => { settings.desktopLocalClientToken = old.token; });
  expect(await f.credentials()).toEqual({ clientToken: old.token });
  const current = await f.auth.authenticateBearerToken(old.token);
  expect(current?.client).toMatchObject({ id: old.client.id, createdAt: old.client.createdAt, deviceName: 'Original name', profile: 'client', capabilities: ['ui:access'] });
  expect((await f.auth.authenticateBearerToken(paired.token))?.client).toMatchObject({ profile: 'client', capabilities: ['ui:access'] });
});

it.each([
  { profile: 'readonly' },
  { profile: 'client', allowedDirectories: ['/explicitly-scoped'] },
  { profile: 'client', capabilities: ['config:read'] },
  { profile: 'client', capabilities: ['ui:access'], allowedDirectories: [] },
])('does not silently broaden explicitly restricted desktop policy: %j', async policy => {
  const f = await fixture();
  const old = await f.auth.createClient({ clientKind: 'desktop-local', dedupeKey: 'desktop-local', ...policy });
  await f.store.update(settings => { settings.desktopLocalClientToken = old.token; });
  expect(await f.credentials()).toEqual({ clientToken: old.token });
  const current = (await f.auth.authenticateBearerToken(old.token))!.client;
  expect(current.profile).toBe(old.client.profile);
  expect(current.capabilities).toEqual(old.client.capabilities);
  expect(current.allowedDirectories).toEqual(old.client.allowedDirectories);
});
