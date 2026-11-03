import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createClientPairingRuntime } from './pairing.js';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const roots: string[] = [];

type PairingRuntimeOptions = NonNullable<Parameters<typeof createClientPairingRuntime>[0]>;
type RemoteClientRuntime = NonNullable<PairingRuntimeOptions['remoteClientAuthRuntime']>;
type RemoteClientInput = Parameters<RemoteClientRuntime['createClient']>[0];

interface TestRuntimeOptions {
  remoteClientAuthRuntime?: RemoteClientRuntime;
  ttlMs?: number;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const makeRuntime = async (options: TestRuntimeOptions = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-pairing-test-'));
  roots.push(dir);
  const createdClients: Array<{ id: string } & Record<string, unknown>> = [];
  const remoteClientAuthRuntime = options.remoteClientAuthRuntime || {
    createClient: vi.fn(async (input: RemoteClientInput) => {
      const client = {
        id: `client-${createdClients.length + 1}`,
        label: input.label,
        clientKind: input.clientKind,
        authMethod: input.authMethod,
        pairingId: input.pairingId,
        deviceName: input.deviceName ?? null,
      };
      createdClients.push(client);
      return { client, token: `token-${createdClients.length}` };
    }),
  };
  const storePath = path.join(dir, 'pairing.json');
  const createRuntime = () => createClientPairingRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath,
    remoteClientAuthRuntime,
    ttlMs: options.ttlMs ?? 10 * 60 * 1000,
  });
  return { dir, runtime: createRuntime(), createRuntime, remoteClientAuthRuntime, createdClients, storePath };
};

describe('client auth pairing runtime', () => {
  it('redeems a pairing session once and propagates client metadata', async () => {
    const { runtime, remoteClientAuthRuntime } = await makeRuntime();
    const created = await runtime.createPairingSession({ allowedClientKinds: ['mobile'] });

    const result = await runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientLabel: 'Iryna iPhone',
      clientKind: 'mobile',
      deviceName: 'Iryna iPhone',
      dedupeKey: 'device-key',
    });

    expect(result.token).toBe('token-1');
    expect(result.client).toMatchObject({
      label: 'Iryna iPhone',
      clientKind: 'mobile',
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      deviceName: 'Iryna iPhone',
    });
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledWith(expect.objectContaining({
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      clientKind: 'mobile',
      dedupeKey: 'device-key',
    }));

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('rejects expired, cancelled, wrong-secret, and disallowed-kind redemption', async () => {
    const { runtime: expiredRuntime } = await makeRuntime({ ttlMs: -1000 });
    const expired = await expiredRuntime.createPairingSession();
    await expect(expiredRuntime.redeemPairingSession({
      pairingId: expired.pairing.id,
      secret: expired.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const { runtime } = await makeRuntime();
    const cancelled = await runtime.createPairingSession();
    await runtime.cancelPairingSession(cancelled.pairing.id);
    await expect(runtime.redeemPairingSession({
      pairingId: cancelled.pairing.id,
      secret: cancelled.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const wrongSecret = await runtime.createPairingSession();
    await expect(runtime.redeemPairingSession({
      pairingId: wrongSecret.pairing.id,
      secret: 'wrong',
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const desktopOnly = await runtime.createPairingSession({ allowedClientKinds: ['desktop'] });
    await expect(runtime.redeemPairingSession({
      pairingId: desktopOnly.pairing.id,
      secret: desktopOnly.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('does not consume the pairing session if client issuance fails', async () => {
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error('disk failed'))
      .mockResolvedValueOnce({ client: { id: 'client-1' }, token: 'token-1' });
    const { runtime } = await makeRuntime({ remoteClientAuthRuntime: { createClient } });
    const created = await runtime.createPairingSession();

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('disk failed');

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).resolves.toMatchObject({ token: 'token-1' });
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      dedupeKey: `pairing:${created.pairing.id}`,
    }));
  });

  it('sweeps expired never-used sessions from the store on the next create', async () => {
    const { dir, runtime } = await makeRuntime({ ttlMs: -1000 });
    // Immediately expired (negative TTL), never used or cancelled.
    const expired = await runtime.createPairingSession({ label: 'stale' });

    // The next create sweeps the store; only the fresh session should remain.
    const storePath = path.join(dir, 'pairing.json');
    await runtime.createPairingSession({ label: 'fresh' });
    const store = JSON.parse(await fs.readFile(storePath, 'utf8')) as { sessions: Array<{ id: string }> };
    const ids = store.sessions.map((session) => session.id);
    expect(ids).not.toContain(expired.pairing.id);
    expect(ids).toHaveLength(1);
  });

  it('allows exactly one redemption across independent runtime instances', async () => {
    const { runtime, createRuntime, remoteClientAuthRuntime } = await makeRuntime();
    const created = await runtime.createPairingSession();

    const attempts = await Promise.allSettled([
      runtime.redeemPairingSession({
        pairingId: created.pairing.id,
        secret: created.pairing.secret,
        clientKind: 'mobile',
      }),
      createRuntime().redeemPairingSession({
        pairingId: created.pairing.id,
        secret: created.pairing.secret,
        clientKind: 'mobile',
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledTimes(1);
  });

  it('preserves malformed pairing state instead of replacing it', async () => {
    const { runtime, storePath } = await makeRuntime();
    const malformed = '{"version":1,"sessions":';
    await fs.writeFile(storePath, malformed, 'utf8');

    await expect(runtime.createPairingSession()).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(storePath, 'utf8')).toBe(malformed);
  });
});


const makeRealClientFixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-pairing-clients-'));
  roots.push(directory);
  const storePath = path.join(directory, 'clients.json');
  const auth = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath });
  const { runtime } = await makeRuntime({ remoteClientAuthRuntime: auth });
  const local = await auth.createClient({ label: 'Original desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local', profile: 'full-control', deviceName: 'Original device' });
  const existing = await auth.createClient({ label: 'Existing phone', clientKind: 'mobile', dedupeKey: 'existing-phone' });
  return { auth, runtime, local, existing, storePath };
};

it.each(['mobile', 'desktop'])('public %s redemption cannot replace the reserved local desktop credential or subject', async clientKind => {
  const f = await makeRealClientFixture();
  const pairing = await f.runtime.createPairingSession({ allowedClientKinds: [clientKind] });
  const before = await fs.readFile(f.storePath, 'utf8');
  for (const dedupeKey of ['desktop-local', '  desktop-local\t']) {
    await expect(f.runtime.redeemPairingSession({ pairingId: pairing.pairing.id, secret: pairing.pairing.secret, clientKind, dedupeKey }))
      .rejects.toMatchObject({ message: 'Invalid or expired pairing session', statusCode: 400 });
    expect(await fs.readFile(f.storePath, 'utf8')).toBe(before);
    expect(await f.runtime.getPairingSession(pairing.pairing.id)).toMatchObject({ usedAt: null, clientId: null });
  }
  // A rejected collision did not consume the operator's one-time link.
  const paired = await f.runtime.redeemPairingSession({ pairingId: pairing.pairing.id, secret: pairing.pairing.secret, clientKind, dedupeKey: 'new-device' });
  expect((await f.auth.authenticateBearerToken(f.local.token))?.client).toMatchObject({ id: f.local.client.id,
    createdAt: f.local.client.createdAt, clientKind: 'desktop-local', profile: 'full-control', deviceName: 'Original device', revokedAt: null });
  expect((await f.auth.authenticateBearerToken(f.existing.token))?.clientId).toBe(f.existing.client.id);
  expect((await f.auth.authenticateBearerToken(paired.token))?.client.clientKind).toBe(clientKind);
  expect(await f.auth.listClients()).toHaveLength(3);
});

it.each(['mobile', 'desktop'])('preserves the existing %s re-pair replacement behavior and exact nonreserved device key', async clientKind => {
  const f = await makeRealClientFixture();
  const dedupeKey = 'Existing-Device:key/with-case';
  let previous = await f.auth.createClient({ label: 'Old paired device', clientKind, dedupeKey });
  for (const label of ['First re-pair', 'Second re-pair']) {
    const pairing = await f.runtime.createPairingSession({ label, allowedClientKinds: [clientKind], usesRelay: true });
    const paired = await f.runtime.redeemPairingSession({ pairingId: pairing.pairing.id, secret: pairing.pairing.secret,
      clientKind, dedupeKey: `  ${dedupeKey}  `, deviceName: 'Existing device', appVersion: 'test-version' });
    expect(await f.auth.authenticateBearerToken(previous.token)).toBeNull();
    const current = await f.auth.authenticateBearerToken(paired.token);
    expect(current?.client).toMatchObject({ label, clientKind, authMethod: 'pairing', usesRelay: true,
      deviceName: 'Existing device', appVersion: 'test-version', profile: clientKind === 'desktop' ? 'full-control' : 'client' });
    expect(current?.clientId).not.toBe(previous.client.id);
    const stored = JSON.parse(await fs.readFile(f.storePath, 'utf8')) as { clients: Array<{ id: string; dedupeKey: string }> };
    expect(stored.clients.filter(client => client.dedupeKey === dedupeKey).map(client => client.id)).toEqual([current!.clientId]);
    expect(stored.clients).toHaveLength(3);
    expect((await f.auth.authenticateBearerToken(f.local.token))?.clientId).toBe(f.local.client.id);
    expect((await f.auth.authenticateBearerToken(f.existing.token))?.clientId).toBe(f.existing.client.id);
    previous = { token: paired.token, client: current!.client };
  }
});


it('cannot self-assert the private desktop kind and still enforces desktop-only pairing restrictions', async () => {
  const f = await makeRealClientFixture();
  const mobile = await f.runtime.createPairingSession({ allowedClientKinds: ['mobile'] });
  const normalized = await f.runtime.redeemPairingSession({ pairingId: mobile.pairing.id, secret: mobile.pairing.secret,
    clientKind: '  desktop-local  ', dedupeKey: 'untrusted-device' });
  expect((await f.auth.authenticateBearerToken(normalized.token))?.client).toMatchObject({ clientKind: 'mobile', profile: 'client', capabilities: ['ui:access'] });
  expect(normalized.client.id).not.toBe(f.local.client.id);
  const desktop = await f.runtime.createPairingSession({ allowedClientKinds: ['desktop'] });
  const before = await fs.readFile(f.storePath, 'utf8');
  await expect(f.runtime.redeemPairingSession({ pairingId: desktop.pairing.id, secret: desktop.pairing.secret,
    clientKind: 'desktop-local', dedupeKey: 'another-device' })).rejects.toMatchObject({ statusCode: 400 });
  expect(await fs.readFile(f.storePath, 'utf8')).toBe(before);
  expect(await f.runtime.getPairingSession(desktop.pairing.id)).toMatchObject({ usedAt: null, clientId: null });
  expect((await f.auth.authenticateBearerToken(f.local.token))?.clientId).toBe(f.local.client.id);
  expect((await f.auth.authenticateBearerToken(f.existing.token))?.clientId).toBe(f.existing.client.id);
});
