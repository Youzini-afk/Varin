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
it('rotates a revoked token through the original owner without changing desktop identity', async () => {
  const f = await fixture();
  const old = await f.auth.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
  await f.store.update(settings => { settings.desktopLocalClientToken = old.token; });
  await f.auth.revokeClient(old.client.id);
  const [first, second] = await Promise.all([f.credentials(), f.credentials()]);
  expect(first).toEqual(second); expect(first.clientToken).not.toBe(old.token);
  expect((await f.auth.authenticateBearerToken(first.clientToken))?.clientId).toBe(old.client.id);
  expect((await f.auth.listClients())).toHaveLength(1);
  expect((await f.store.read()).desktopLocalClientToken).toBe(first.clientToken);
});
it('preserves malformed original settings instead of initializing an empty profile', async () => {
  const f = await fixture();
  await fs.writeFile(f.store.filePath, '{invalid');
  await expect(f.credentials()).rejects.toThrow();
  expect(await fs.readFile(f.store.filePath, 'utf8')).toBe('{invalid');
  expect(await f.auth.listClients()).toEqual([]);
});

it('repairs only the private legacy desktop default without changing its token, subject or metadata', async () => {
  const f = await fixture();
  const old = await f.auth.createClient({ label: 'Original Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local', deviceName: 'Original name' });
  const paired = await f.auth.createClient({ label: 'Paired phone', clientKind: 'mobile' });
  await f.store.update(settings => { settings.desktopLocalClientToken = old.token; });
  expect(await f.credentials()).toEqual({ clientToken: old.token });
  const current = await f.auth.authenticateBearerToken(old.token);
  expect(current?.client).toMatchObject({ id: old.client.id, createdAt: old.client.createdAt, deviceName: 'Original name', profile: 'full-control' });
  expect(current?.client.capabilities).toContain('filesystem:delete');
  expect(current?.client.capabilities).toContain('process:control');
  expect((await f.auth.authenticateBearerToken(paired.token))?.client).toMatchObject({ profile: 'client', capabilities: ['ui:access'] });
  await expect(f.auth.ensureDesktopLocalClientAccess(paired.token)).rejects.toThrow('unavailable');
  await f.auth.revokeClient(old.client.id);
  await expect(f.auth.ensureDesktopLocalClientAccess(old.token)).rejects.toThrow('unavailable');
});

it.each([
  { profile: 'readonly' },
  { profile: 'client', allowedDirectories: ['/explicitly-scoped'] },
  { profile: 'client', capabilities: ['config:read'] },
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
