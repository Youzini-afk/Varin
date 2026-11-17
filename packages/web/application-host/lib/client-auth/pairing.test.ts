import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createClientPairingRuntime } from './pairing.js';

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
  it('requires an explicit valid browser-device expiration policy before creating a link', async () => {
    const { runtime } = await makeRuntime();
    for (const input of [undefined, 'not-a-date', '2000-01-01T00:00:00.000Z']) {
      await expect(runtime.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: input })).rejects.toThrow('Pairing expiration');
    }
    expect(await runtime.listPendingSessions()).toEqual([]);
    const created = await runtime.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: null });
    expect(created.pairing.clientExpiresAt).toBeNull();
  });

  it('retains browser issuer expiration after reload and ignores redeemer expiration and dedupe choices', async () => {
    const { runtime, createRuntime, remoteClientAuthRuntime } = await makeRuntime();
    const clientExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await runtime.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt });
    const redemption = { pairingId: created.pairing.id, secret: created.pairing.secret,
      clientKind: 'browser', clientExpiresAt: null, expiresAt: null, dedupeKey: 'another-device' };
    await createRuntime().redeemPairingSession(redemption);
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: clientExpiresAt, profile: 'full-control', clientKind: 'browser', dedupeKey: `pairing:${created.pairing.id}`,
    }));
  });

  it('does not redeem a still-live link after its issuer device deadline', async () => {
    const { runtime } = await makeRuntime();
    const now = Date.now();
    const created = await runtime.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: new Date(now + 10_000).toISOString() });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 20_000);
    try {
      await expect(runtime.redeemPairingSession({ pairingId: created.pairing.id, secret: created.pairing.secret, clientKind: 'browser' }))
        .rejects.toThrow('Invalid or expired pairing session');
    } finally { clock.mockRestore(); }
  });

  it('upgrades legacy native pairing records without changing their allowed clients', async () => {
    const { runtime, createRuntime, storePath, remoteClientAuthRuntime } = await makeRuntime();
    const created = await runtime.createPairingSession();
    const legacy = JSON.parse(await fs.readFile(storePath, 'utf8'));
    legacy.version = 2;
    delete legacy.sessions[0].clientExpiresAt;
    await fs.writeFile(storePath, JSON.stringify(legacy));
    await createRuntime().redeemPairingSession({ pairingId: created.pairing.id, secret: created.pairing.secret, clientKind: 'desktop' });
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledWith(expect.objectContaining({ clientKind: 'desktop', profile: 'full-control', expiresAt: null }));
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).version).toBe(3);
  });

});
