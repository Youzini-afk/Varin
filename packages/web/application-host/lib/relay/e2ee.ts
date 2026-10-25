// E2EE primitives + responder handshake for the private relay (Layer 2).
// JS mirror of the normative TS implementation in
// packages/ui/src/lib/relay/{protocol,crypto,handshake}.ts — the web server is
// plain JS and cannot import from packages/ui, so the logic is copied verbatim
// (converted to JSDoc'd JS) and MUST stay byte-compatible with those modules.
// WebCrypto only: `globalThis.crypto.subtle` (Node >= 22).
// Spec: relay/DOCUMENTATION.md (Layer 2); shared contract in packages/ui/src/lib/relay/protocol.ts.

import type { webcrypto } from 'node:crypto';

const subtle = globalThis.crypto.subtle;

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_HKDF_INFO = 'varin-relay-v1';

// Encrypted frame layout: [1 byte version][12 byte IV][ciphertext + 16 byte GCM tag].
export const ENCRYPTED_FRAME_VERSION = 1;
export const ENCRYPTED_FRAME_IV_BYTES = 12;
export const ENCRYPTED_FRAME_HEADER_BYTES = 1 + ENCRYPTED_FRAME_IV_BYTES;
export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;

// Relay-assigned WebSocket close codes (subset the host needs).
export const RelayCloseCode = {
  RekeyMismatch: 1008,
  ChannelFailure: 1011,
};

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
const HANDSHAKE_NONCE_BYTES = 16;
const SESSION_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
// IV = 4-byte random per-direction prefix || 8-byte big-endian frame counter.
const IV_PREFIX_BYTES = 4;
const IV_COUNTER_BYTES = 8;

export class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCryptoError';
  }
}

/** @returns {Promise<webcrypto.CryptoKeyPair>} */
export const generateEcdhKeyPair = async (): Promise<webcrypto.CryptoKeyPair> => (
  await subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']) as webcrypto.CryptoKeyPair
);

/**
 * @param {webcrypto.CryptoKey} key
 * @returns {Promise<webcrypto.JsonWebKey>} public JWK reduced to the fields that define the point
 */
export const exportPublicKeyJwk = async (key: webcrypto.CryptoKey): Promise<webcrypto.JsonWebKey> => {
  const jwk = await subtle.exportKey('jwk', key);
  if (typeof jwk.kty !== 'string' || typeof jwk.crv !== 'string'
    || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new RelayCryptoError('ECDH public key export returned incomplete JWK');
  }
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
};

/** @param {webcrypto.JsonWebKey} jwk */
export const importEcdhPublicKey = async (jwk: webcrypto.JsonWebKey): Promise<webcrypto.CryptoKey> => {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new RelayCryptoError('invalid ECDH public key JWK');
  }
  try {
    return await subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      ECDH_PARAMS,
      true,
      [],
    );
  } catch {
    throw new RelayCryptoError('invalid ECDH public key JWK');
  }
};

/** @param {webcrypto.JsonWebKey} jwk private ECDH JWK (d + point) */
export const importEcdhPrivateKey = async (jwk: webcrypto.JsonWebKey): Promise<webcrypto.CryptoKey> => {
  try {
    return await subtle.importKey('jwk', jwk, ECDH_PARAMS, false, ['deriveBits']);
  } catch {
    throw new RelayCryptoError('invalid ECDH private key JWK');
  }
};

// Stable fingerprint of a public key, used to detect rekey attempts on re-hello.
/** @param {webcrypto.JsonWebKey} jwk */
export const publicKeyJwkFingerprint = (jwk: webcrypto.JsonWebKey): string =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

export const generateHandshakeNonce = (): Uint8Array => {
  const nonce = new Uint8Array(HANDSHAKE_NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
};

/**
 * Both sides call this with their own private key and the peer's public key;
 * ECDH yields the same shared secret, so the derived key pair matches.
 * @param {webcrypto.CryptoKey} ownPrivateKey
 * @param {webcrypto.CryptoKey} peerPublicKey
 * @param {Uint8Array} handshakeNonce
 * @returns {Promise<{ clientToHost: webcrypto.CryptoKey, hostToClient: webcrypto.CryptoKey }>}
 */
export const deriveSessionKeys = async (
  ownPrivateKey: webcrypto.CryptoKey,
  peerPublicKey: webcrypto.CryptoKey,
  handshakeNonce: Uint8Array,
): Promise<{ clientToHost: webcrypto.CryptoKey; hostToClient: webcrypto.CryptoKey }> => {
  if (handshakeNonce.length !== HANDSHAKE_NONCE_BYTES) {
    throw new RelayCryptoError('invalid handshake nonce length');
  }
  const sharedSecret = await subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, ownPrivateKey, 256);
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const keyMaterial = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: handshakeNonce,
        info: new TextEncoder().encode(RELAY_HKDF_INFO),
      },
      hkdfKey,
      SESSION_KEY_BYTES * 2 * 8,
    ),
  );
  const importAesKey = (bytes: Uint8Array, usage: webcrypto.KeyUsage[]) => subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usage);
  return {
    clientToHost: await importAesKey(keyMaterial.slice(0, SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
    hostToClient: await importAesKey(keyMaterial.slice(SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
  };
};

const writeCounter = (target: Uint8Array, offset: number, counter: bigint): void => {
  for (let i = IV_COUNTER_BYTES - 1; i >= 0; i -= 1) {
    target[offset + i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
};

const readCounter = (source: Uint8Array, offset: number): bigint => {
  let value = 0n;
  for (let i = 0; i < IV_COUNTER_BYTES; i += 1) {
    value = (value << 8n) | BigInt(source[offset + i] ?? 0);
  }
  return value;
};

/** @param {webcrypto.CryptoKey} key AES-256-GCM key for this direction */
export const createFrameEncryptor = (key: webcrypto.CryptoKey) => {
  const ivPrefix = new Uint8Array(IV_PREFIX_BYTES);
  globalThis.crypto.getRandomValues(ivPrefix);
  let counter = 0n;
  return {
    /** @param {Uint8Array} plaintext */
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
        throw new RelayCryptoError('plaintext frame exceeds maximum size');
      }
      counter += 1n;
      const iv = new Uint8Array(ENCRYPTED_FRAME_IV_BYTES);
      iv.set(ivPrefix, 0);
      writeCounter(iv, IV_PREFIX_BYTES, counter);
      const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
      const frame = new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES + ciphertext.length);
      frame[0] = ENCRYPTED_FRAME_VERSION;
      frame.set(iv, 1);
      frame.set(ciphertext, ENCRYPTED_FRAME_HEADER_BYTES);
      return frame;
    },
  };
};

// Enforces strictly increasing per-direction counters: the relay WS preserves
// ordering, so any regression or replay means tampering and must fail closed.
/** @param {webcrypto.CryptoKey} key AES-256-GCM key for this direction */
export const createFrameDecryptor = (key: webcrypto.CryptoKey) => {
  let lastCounter = 0n;
  return {
    /** @param {Uint8Array} frame */
    async decrypt(frame: Uint8Array): Promise<Uint8Array> {
      if (frame.length < ENCRYPTED_FRAME_HEADER_BYTES + GCM_TAG_BYTES) {
        throw new RelayCryptoError('encrypted frame too short');
      }
      if (frame[0] !== ENCRYPTED_FRAME_VERSION) {
        throw new RelayCryptoError('unsupported encrypted frame version');
      }
      const iv = frame.slice(1, ENCRYPTED_FRAME_HEADER_BYTES);
      const counter = readCounter(iv, IV_PREFIX_BYTES);
      if (counter <= lastCounter) {
        throw new RelayCryptoError('frame counter regression');
      }
      let plaintext;
      try {
        plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, frame.slice(ENCRYPTED_FRAME_HEADER_BYTES));
      } catch {
        throw new RelayCryptoError('frame decryption failed');
      }
      lastCounter = counter;
      return new Uint8Array(plaintext);
    },
  };
};

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** @param {Uint8Array} bytes */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    if (b0 === undefined) break;
    out += BASE64URL_ALPHABET[b0 >> 2] ?? '';
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    if (b1 !== undefined) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '';
    if (b2 !== undefined) out += BASE64URL_ALPHABET[b2 & 0x3f] ?? '';
  }
  return out;
};

/** @param {string} value */
export const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new RelayCryptoError('invalid base64url input');
  }
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Responder handshake state machine (host side). Mirror of createHostHandshake
// in packages/ui/src/lib/relay/handshake.ts.
//
// Fail-closed rules (from the spec):
// - a repeated identical `hello` re-sends `ready` (client retry race);
// - a `hello` with a DIFFERENT key on an established channel is a rekey
//   attack -> close 1008, never rekey in place;
// - plaintext after `ready`, or any decrypt failure -> close 1011.
// ---------------------------------------------------------------------------

type HandshakeMessage =
  | { batch: boolean; t: 'hello'; v: 1; clientPubJwk: webcrypto.JsonWebKey; nonce: string }
  | { batch: boolean; t: 'ready'; v: 1 };

export interface RelayFrameChannel {
  decryptor: ReturnType<typeof createFrameDecryptor>;
  encryptor: ReturnType<typeof createFrameEncryptor>;
}

export type HostHandshakeAction =
  | { closeCode: number; reason: string; type: 'fail' }
  | { type: 'ignore' }
  | { text: string; type: 'send-text' }
  | { batch: boolean; channel: RelayFrameChannel; replyText: string; type: 'established' };

const parseHandshakeMessage = (raw: string): HandshakeMessage | null => {
  let parsed: Record<string, unknown> | null;
  try {
    const value = JSON.parse(raw) as unknown;
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.v !== RELAY_PROTOCOL_VERSION) return null;
  // Unknown/missing capability flag = false = legacy behavior.
  const batch = parsed.batch === true;
  if (parsed.t === 'ready') {
    return { t: 'ready', v: RELAY_PROTOCOL_VERSION, batch };
  }
  if (parsed.t === 'hello' && typeof parsed.nonce === 'string' && typeof parsed.clientPubJwk === 'object' && parsed.clientPubJwk !== null) {
    return { t: 'hello', v: RELAY_PROTOCOL_VERSION, clientPubJwk: parsed.clientPubJwk as webcrypto.JsonWebKey, nonce: parsed.nonce, batch };
  }
  return null;
};

const failClosed = (reason: string): HostHandshakeAction => ({
  type: 'fail',
  closeCode: RelayCloseCode.ChannelFailure,
  reason,
});

/**
 * Host (responder) handshake. Feed every inbound text frame to `handleText`;
 * it returns one of:
 *   { type: 'send-text', text }                       — send this plaintext frame
 *   { type: 'established', channel, replyText }       — send replyText first, then switch to encrypted frames
 *   { type: 'ignore' }                                — drop the frame
 *   { type: 'fail', closeCode, reason }               — close the socket with closeCode
 * @param {webcrypto.CryptoKey} hostEncPrivateKey long-lived ECDH private key
 * @param {{ batch?: boolean }} [options] `batch` defaults true; set false to force legacy behavior
 */
export const createHostHandshake = (hostEncPrivateKey: webcrypto.CryptoKey, options: { batch?: boolean } = {}) => {
  const localBatch = options.batch !== false;
  let established = false;
  let acceptedClientKeyFingerprint: string | null = null;
  let readyText: string | null = null;
  let negotiatedBatch = false;
  return {
    get established() {
      return established;
    },
    /** @param {string} raw */
    async handleText(raw: string): Promise<HostHandshakeAction> {
      const message = parseHandshakeMessage(raw);
      if (message?.t !== 'hello') {
        if (established) {
          return failClosed('plaintext frame on established channel');
        }
        return { type: 'ignore' };
      }
      const fingerprint = publicKeyJwkFingerprint(message.clientPubJwk);
      if (acceptedClientKeyFingerprint !== null) {
        if (fingerprint === acceptedClientKeyFingerprint && readyText !== null) {
          // Client retried `hello` before our `ready` arrived — answer again.
          return { type: 'send-text', text: readyText };
        }
        return { type: 'fail', closeCode: RelayCloseCode.RekeyMismatch, reason: 'rekey mismatch' };
      }
      let clientPublicKey;
      let nonce;
      try {
        clientPublicKey = await importEcdhPublicKey(message.clientPubJwk);
        nonce = base64UrlToBytes(message.nonce);
      } catch {
        return failClosed('malformed hello');
      }
      let keys;
      try {
        keys = await deriveSessionKeys(hostEncPrivateKey, clientPublicKey, nonce);
      } catch {
        return failClosed('key derivation failed');
      }
      acceptedClientKeyFingerprint = fingerprint;
      // Batching runs only if both peers advertised it.
      negotiatedBatch = localBatch && message.batch === true;
      readyText = JSON.stringify(
        negotiatedBatch
          ? { t: 'ready', v: RELAY_PROTOCOL_VERSION, batch: true }
          : { t: 'ready', v: RELAY_PROTOCOL_VERSION },
      );
      established = true;
      return {
        type: 'established',
        batch: negotiatedBatch,
        replyText: readyText,
        channel: {
          encryptor: createFrameEncryptor(keys.hostToClient),
          decryptor: createFrameDecryptor(keys.clientToHost),
        },
      };
    },
  };
};
