import { createSettingsFileStore } from '@varin/settings-store';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const firstClient = <Client>(clients: Client[]): Client => {
  const client = clients[0];
  if (!client) throw new Error('Expected a remote client');
  return client;
};

const createRuntime = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-remote-clients-test-'));
  const storePath = path.join(dir, 'remote-clients.json');
  const runtime = createRemoteClientAuthRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath,
  });
  return { dir, runtime, storePath };
};

describe('remote client auth runtime', () => {
  it('does not open credential stores or create a principal before the first consumer', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(await fs.readdir(dir)).toEqual([]);
      await runtime.dispose();
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await runtime.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('creates, authenticates, lists, and revokes client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      expect(created.token.startsWith('varin_client_')).toBe(true);
      expect(created.client.label).toBe('Laptop');

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(firstClient(listed).id).toBe(created.client.id);
      expect('tokenHash' in firstClient(listed)).toBe(false);

      const authenticated = await runtime.authenticateBearerToken(created.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(created.client.id);

      const afterUse = await runtime.listClients();
      expect(typeof firstClient(afterUse).lastUsedAt).toBe('string');

      const revoked = await runtime.revokeClient(created.client.id);
      expect(revoked.revoked).toBe(true);
      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);

      const purged = await runtime.purgeRevokedClients();
      expect(purged.purged).toBe(1);
      expect(await runtime.listClients()).toHaveLength(0);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects expired client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const expired = await runtime.createClient({ label: 'Expired', expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(expired.client.expiresAt).toBe('2000-01-01T00:00:00.000Z');
      expect(await runtime.authenticateBearerToken(expired.token)).toBe(null);

      const active = await runtime.createClient({ label: 'Active', expiresAt: '2999-01-01T00:00:00.000Z' });
      const authenticated = await runtime.authenticateBearerToken(active.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(active.client.id);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one client per dedupe key', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const first = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
      const second = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });

      expect(await runtime.authenticateBearerToken(first.token)).toBe(null);
      const authenticated = await runtime.authenticateBearerToken(second.token);
      expect(authenticated?.ok).toBe(true);

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(firstClient(listed).id).toBe(second.client.id);
      expect(firstClient(listed).clientKind).toBe('desktop-local');
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('assigns external access profiles and capabilities', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Repair agent', profile: 'full-control' });
      expect(created.client.profile).toBe('full-control');
      expect(created.client.capabilities).toContain('filesystem:read');
      expect(created.client.capabilities).toContain('filesystem:write');
      expect(created.client.capabilities).toContain('terminal:use');

      const authenticated = await runtime.authenticateBearerToken(created.token);
      expect(authenticated?.client?.profile).toBe('full-control');
      expect(authenticated?.client?.capabilities).toContain('process:control');
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the token store private on disk', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      await runtime.createClient({ label: 'Laptop' });
      const stat = await fs.stat(path.join(dir, 'remote-clients.json'));
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      } else {
        expect(stat.isFile()).toBe(true);
      }
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps relay demand after a client is observed using the relay', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Phone' });
      expect(created.client.usesRelay).toBe(false);
      expect(await runtime.hasActiveRelayClients()).toBe(false);

      const relayed = await runtime.authenticateBearerToken(created.token, {
        headers: { 'x-varin-relay-connection': 'connection-1' },
      });
      expect(relayed?.client.usesRelay).toBe(true);
      expect(await runtime.hasActiveRelayClients()).toBe(true);

      await runtime.authenticateBearerToken(created.token, { headers: {} });
      const client = firstClient(await runtime.listClients());
      expect(client.usesRelay).toBe(true);
      expect(client.lastTransport).toBe('direct');
      expect(await runtime.hasActiveRelayClients()).toBe(true);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not resurrect revoked clients after concurrent auth traffic', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      await Promise.all([
        ...Array.from({ length: 20 }, () => runtime.authenticateBearerToken(created.token)),
        runtime.revokeClient(created.client.id),
      ]);

      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);
      const clients = await runtime.listClients();
      expect(clients).toHaveLength(1);
      expect(typeof firstClient(clients).revokedAt).toBe('string');
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes independent runtime writers without dropping either client', async () => {
    const { dir, runtime, storePath } = await createRuntime();
    try {
      const second = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath });
      await Promise.all([
        runtime.createClient({ label: 'Laptop A' }),
        second.createClient({ label: 'Laptop B' }),
      ]);

      expect((await runtime.listClients()).map((client) => client.label).sort())
        .toEqual(['Laptop A', 'Laptop B']);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves malformed token state instead of replacing it', async () => {
    const { dir, runtime, storePath } = await createRuntime();
    try {
      const malformed = '{"version":2,"clients":';
      await fs.writeFile(storePath, malformed, 'utf8');
      await expect(runtime.createClient({ label: 'Laptop' })).rejects.toBeInstanceOf(SyntaxError);
      expect(await fs.readFile(storePath, 'utf8')).toBe(malformed);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});


describe('cached credential authority', () => {
  it('authenticates repeatedly without store reads or writes after usage has been flushed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-auth-cache-'));
    const storePath = path.join(dir, 'clients.json');
    const clientStore = createSettingsFileStore({ filePath: storePath, defaultValue: { version: 3, clients: [] } });
    const reads = vi.spyOn(clientStore, 'read'), writes = vi.spyOn(clientStore, 'transact');
    const runtime = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath, clientStore });
    try {
      const created = await runtime.createClient({ label: 'Phone' });
      await runtime.authenticateBearerToken(created.token);
      await runtime.flushUsage();
      reads.mockClear(); writes.mockClear();
      for (let count = 0; count < 50; count++) {
        const authenticated = await runtime.authenticateBearerToken(created.token);
        expect(authenticated?.principalId).toBe(created.client.principalId);
        authenticated!.client.capabilities.push('forged');
        expect((await runtime.listClients())[0]!.capabilities).not.toContain('forged');
      }
      expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('does not publish failed credential mutations and retains revocation after reopen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-auth-commit-'));
    const storePath = path.join(dir, 'clients.json');
    const clientStore = createSettingsFileStore({ filePath: storePath, defaultValue: { version: 3, clients: [] } });
    let runtime = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath, clientStore });
    try {
      const created = await runtime.createClient({ label: 'Phone' });
      vi.spyOn(clientStore, 'transact').mockRejectedValueOnce(new Error('Disk unavailable'));
      await expect(runtime.revokeClient(created.client.id)).rejects.toThrow('Disk unavailable');
      expect((await runtime.authenticateBearerToken(created.token))?.ok).toBe(true);
      await runtime.revokeClient(created.client.id);
      await runtime.dispose();
      runtime = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath });
      expect(await runtime.authenticateBearerToken(created.token)).toBeNull();
    } finally { await runtime.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
