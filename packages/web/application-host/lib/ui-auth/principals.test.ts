import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPrincipalStore } from './principals.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createClientPairingRuntime } from '../client-auth/pairing.js';
const roots: string[] = [];
const clientsToClose: ReturnType<typeof createRemoteClientAuthRuntime>[] = [];
afterEach(async () => { for (const clients of clientsToClose.splice(0)) await clients.dispose().catch(() => undefined); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-principals-')); roots.push(root);
  const principals = createPrincipalStore(path.join(root, 'ui-principals.json'));
  const clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path, storePath: path.join(root, 'clients.json'), principals });
  clientsToClose.push(clients);
  return { root, principals, clients };
}
describe('persistent authenticated principals', () => {
  it('persists a single owner before exposure, preserves it on reopen, and rejects malformed data', async () => {
    const { root, principals } = await fixture();
    const parallel = createPrincipalStore(path.join(root, 'ui-principals.json'));
    const [owner, sameOwner] = await Promise.all([principals.ownerId(), parallel.ownerId()]);
    expect(sameOwner).toBe(owner);
    expect(await createPrincipalStore(path.join(root, 'ui-principals.json')).ownerId()).toBe(owner);
    await fs.writeFile(path.join(root, 'ui-principals.json'), '{"version":99}');
    expect(await principals.ownerId()).toBe(owner); // Running subjects are immutable.
    await expect(createPrincipalStore(path.join(root, 'ui-principals.json')).ownerId()).rejects.toThrow('malformed');
    expect(await fs.readFile(path.join(root, 'ui-principals.json'), 'utf8')).toBe('{"version":99}');
  });
  it('migrates old owner devices, binds pairing to its issuer and isolates token rotation between people', async () => {
    const { root, ...runtime } = await fixture();
    let { principals, clients } = runtime;
    const owner = await principals.ownerId();
    const old = await clients.createClient({ dedupeKey: 'same-device', reuseDedupeIdentity: true });
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'clients.json'), 'utf8'));
    await clients.dispose();
    persisted.version = 2; delete persisted.clients[0].principalId;
    await fs.writeFile(path.join(root, 'clients.json'), JSON.stringify(persisted));
    clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path, storePath: path.join(root, 'clients.json'), principals });
    clientsToClose.push(clients);
    expect((await clients.authenticateBearerToken(old.token))?.principalId).toBe(owner);
    expect(JSON.parse(await fs.readFile(path.join(root, 'clients.json'), 'utf8')).version).toBe(3);
    // Independent subjects are supplied by the trusted authentication owner, not plugin input.
    const member = 'trusted-member';
    const subjectsPath = path.join(root, 'ui-principals.json');
    const subjects = JSON.parse(await fs.readFile(subjectsPath, 'utf8'));
    subjects.principals.push({ id: member, disabled: false });
    await fs.writeFile(subjectsPath, JSON.stringify(subjects));
    await clients.dispose();
    principals = createPrincipalStore(subjectsPath);
    clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path, storePath: path.join(root, 'clients.json'), principals });
    clientsToClose.push(clients);
    const other = await clients.createClient({ principalId: member, dedupeKey: 'same-device', reuseDedupeIdentity: true });
    expect(other.client.id).not.toBe(old.client.id);
    expect((await clients.authenticateBearerToken(old.token))?.principalId).toBe(owner);
    const pairing = createClientPairingRuntime({ crypto, storePath: path.join(root, 'pairing.json'), remoteClientAuthRuntime: clients, principals });
    const pending = await pairing.createPairingSession({ principalId: member });
    const paired = await pairing.redeemPairingSession({ pairingId: pending.pairing.id, secret: pending.pairing.secret, clientKind: 'mobile' });
    expect((await clients.authenticateBearerToken(paired.token))?.principalId).toBe(member);
    await clients.revokeClient(paired.client.id);
    expect(await clients.authenticateBearerToken(paired.token)).toBeNull();
    expect((await clients.authenticateBearerToken(other.token))?.principalId).toBe(member);
  });
});


it('resolves established principals without filesystem calls', async () => {
  const { principals, clients } = await fixture();
  const owner = await principals.ownerId(); await clients.listClients();
  const spies = [vi.spyOn(fs, 'readFile'), vi.spyOn(fs, 'open'), vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'stat')];
  try {
    for (let index = 0; index < 30; index++) {
      expect(await principals.ownerId()).toBe(owner);
      expect(await principals.resolve(owner)).toBe(owner);
      expect(await principals.isOwner(owner)).toBe(true);
      expect(await principals.resolve('unknown')).toBeNull();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});
