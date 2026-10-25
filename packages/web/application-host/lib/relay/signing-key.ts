// Per-server relay signing identity (ECDSA P-256), extracted from
// lib/notifications/apns-runtime.js so both the push relay and the private
// relay share the SAME keypair and thus the SAME serverId
// (base64url(SHA-256(canonical public JWK))). Storage format is unchanged:
// `settings.relaySigningKey = { privateJwk, publicJwk }` — existing installs'
// serverId must stay stable because push token binding depends on it.

import type cryptoModule from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

interface SigningKeySettings extends Record<string, unknown> {
  relaySigningKey?: unknown;
}

interface StoredSigningKeypair {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface RelaySigningKeypair {
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

const asStoredKeypair = (value: unknown): StoredSigningKeypair | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!record.privateJwk || typeof record.privateJwk !== 'object'
    || !record.publicJwk || typeof record.publicJwk !== 'object') return null;
  return { privateJwk: record.privateJwk as JsonWebKey, publicJwk: record.publicJwk as JsonWebKey };
};

export const getOrCreateRelaySigningKeypair = async ({ crypto, readSettingsFromDisk, updateSettingsOnDisk }: {
  crypto: typeof cryptoModule;
  readSettingsFromDisk: () => Promise<SigningKeySettings>;
  updateSettingsOnDisk: (
    mutator: (settings: SigningKeySettings) => SigningKeySettings,
  ) => Promise<SigningKeySettings>;
}): Promise<RelaySigningKeypair> => {
  const toKeypair = (stored: StoredSigningKeypair): RelaySigningKeypair => ({
    privateKey: crypto.createPrivateKey({ key: stored.privateJwk, format: 'jwk' }),
    publicJwk: stored.publicJwk,
  });
  const settings = await readSettingsFromDisk();
  const existing = asStoredKeypair(settings.relaySigningKey);
  if (existing) {
    return toKeypair(existing);
  }
  // Loud on purpose: a new signing key means a new serverId — every previously
  // paired device and push binding is orphaned. Expected exactly once, on first run.
  console.warn('[relay-identity] Generating NEW relay signing keypair (serverId changes; previously paired devices must re-pair)');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const updated = await updateSettingsOnDisk((current) => (
    asStoredKeypair(current.relaySigningKey)
      ? current
      : { ...current, relaySigningKey: { privateJwk, publicJwk } }
  ));
  const persisted = asStoredKeypair(updated.relaySigningKey);
  if (!persisted) throw new Error('Relay signing key persistence returned invalid data');
  return toKeypair(persisted);
};

// Fixed key order so the hash is stable regardless of stored JSON field order.
// A relay that checks `serverId = SHA-256(pk)` must serialise the JWK the same
// way, byte for byte (relay/DOCUMENTATION.md, host authentication).
/** @param {JsonWebKey} jwk */
export const canonicalPublicJwkString = (jwk: JsonWebKey): string =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

/**
 * serverId = base64url(SHA-256(canonical public JWK)). Must match the push
 * relay's deriveServerId — this id is the routing key for both relays.
 * @param {{ crypto: typeof import('node:crypto') }} deps
 * @param {JsonWebKey} publicJwk
 */
export const deriveServerId = ({ crypto }: { crypto: typeof cryptoModule }, publicJwk: JsonWebKey): string =>
  crypto.createHash('sha256').update(canonicalPublicJwkString(publicJwk)).digest('base64url');

/**
 * ECDSA-SHA256, IEEE P1363 (raw r||s) signature — the form WebCrypto verifies.
 * @param {{ crypto: typeof import('node:crypto') }} deps
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {string} message
 */
export const signRelayMessage = ({ crypto }: { crypto: typeof cryptoModule }, privateKey: KeyObject, message: string): string =>
  crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
