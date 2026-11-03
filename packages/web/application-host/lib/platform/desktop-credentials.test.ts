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
