import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, describe, expect, it } from 'vitest';

import { createUiPasskeys } from './ui-passkeys.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-passkeys-'));
  roots.push(root);
  return { storeFile: path.join(root, 'ui-passkeys.json') };
};

const requestForHost = (host: string) => ({
  headers: { host },
  socket: { encrypted: true },
});

const storedPasskey = (id: string) => ({
  id,
  publicKey: Buffer.from(`public-${id}`).toString('base64url'),
  counter: 0,
  transports: [],
  deviceType: 'singleDevice',
  backedUp: false,
  createdAt: Date.now(),
  lastUsedAt: null,
  label: id,
  rpID: 'example.com',
});

describe('passkey store', () => {
  it('reports passkeys disabled without creating invalid password state', async () => {
    const { storeFile } = await createHarness();
    const controller = createUiPasskeys({ storeFile });

    await expect(controller.getStatus(requestForHost('localhost'))).resolves.toMatchObject({
      enabled: false,
      hasPasskeys: false,
      passkeyCount: 0,
    });
  });

  it.each([
    ['PassKeys.Example:443', 'https://passkeys.example'],
    ['bücher.example:8443', 'https://xn--bcher-kva.example:8443'],
  ])('verifies a signed assertion behind the forwarded host %s', async (host, origin) => {
    const { storeFile } = await createHarness();
    const controller = createUiPasskeys({ passwordBinding: 'binding', storeFile });
    const req = { headers: { host: 'internal:3902', 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } };
    const rpID = new URL(origin).hostname;
    const registration = await controller.beginRegistration(req);
    expect(registration.optionsJSON.rp.id).toBe(rpID);

    // A registered ES256 test key. Sign the challenge the Host actually issued.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x!, 'base64url')], [-3, Buffer.from(y!, 'base64url')],
    ]));
    const id = crypto.randomBytes(16).toString('base64url');
    await fs.writeFile(storeFile, JSON.stringify({
      version: 2, passwordBinding: 'binding', userID: id,
      passkeys: [{ ...storedPasskey(id), publicKey: Buffer.from(cose).toString('base64url'), rpID }],
    }));
    const { optionsJSON, requestId } = await controller.beginAuthentication(req);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: optionsJSON.challenge, origin }));
    const hash = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest();
    const authData = Buffer.concat([hash(rpID), Buffer.from([0x05, 0, 0, 0, 1])]); // present, verified, counter = 1
    const signature = crypto.sign('sha256', Buffer.concat([authData, hash(clientData)]), privateKey);

    await expect(controller.finishAuthentication({ requestId, response: {
      id, rawId: id, type: 'public-key', clientExtensionResults: {},
      response: { authenticatorData: authData.toString('base64url'), clientDataJSON: clientData.toString('base64url'),
        signature: signature.toString('base64url') },
    } })).resolves.toMatchObject({ verified: true });
    const persisted = JSON.parse(await fs.readFile(storeFile, 'utf8'));
    expect(persisted.passkeys[0].counter).toBe(1);
  });

  it('serializes revocations from independent controllers', async () => {
    const { storeFile } = await createHarness();
    await fs.writeFile(storeFile, JSON.stringify({
      version: 1,
      userID: crypto.randomBytes(32).toString('base64url'),
      passwordBinding: 'binding',
      passkeys: [storedPasskey('key-a'), storedPasskey('key-b')],
    }), 'utf8');
    const first = createUiPasskeys({ passwordBinding: 'binding', storeFile });
    const second = createUiPasskeys({ passwordBinding: 'binding', storeFile });

    await Promise.all([
      first.revokePasskey(requestForHost('example.com'), 'key-a'),
      second.revokePasskey(requestForHost('example.com'), 'key-b'),
    ]);

    await expect(first.listPasskeys(requestForHost('example.com'))).resolves.toEqual([]);
  });

  it('preserves malformed credentials instead of replacing them', async () => {
    const { storeFile } = await createHarness();
    const malformed = '{"version":1,"passkeys":';
    await fs.writeFile(storeFile, malformed, 'utf8');
    const controller = createUiPasskeys({ passwordBinding: 'binding', storeFile });

    await expect(controller.getStatus(requestForHost('example.com'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(fs.readFile(storeFile, 'utf8')).resolves.toBe(malformed);
  });

  it('atomically invalidates credentials when the UI password changes', async () => {
    const { storeFile } = await createHarness();
    await fs.writeFile(storeFile, JSON.stringify({
      version: 1,
      userID: crypto.randomBytes(32).toString('base64url'),
      passwordBinding: 'old-binding',
      passkeys: [storedPasskey('key-a')],
    }), 'utf8');
    const controller = createUiPasskeys({ passwordBinding: 'new-binding', storeFile });

    await expect(controller.getStatus(requestForHost('example.com'))).resolves.toMatchObject({
      enabled: true,
      hasPasskeys: false,
      passkeyCount: 0,
    });
    const persisted = JSON.parse(await fs.readFile(storeFile, 'utf8'));
    expect(persisted.passwordBinding).toBe('new-binding');
    expect(persisted.passkeys).toEqual([]);
  });
});
