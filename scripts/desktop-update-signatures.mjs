/** Shared release/Electron verifier. Wire format is Tauri's base64-encoded
 * minisign, including the authenticated trusted comment, never OS code signing. */
import { createHash, createPublicKey, verify } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    if (keys.some(key => !/^[\x20-\x7e]+$/u.test(key))) throw new Error('Signed metadata keys must be ASCII');
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Signed metadata must contain only JSON and safe integer numbers');
}
export function metadataBytes(document) {
  const { varinSignature: _signature, ...payload } = document;
  return Buffer.from(canonicalJson(payload) + '\n');
}
function base64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) throw new Error('Invalid signature encoding');
  return Buffer.from(value, 'base64');
}
export function verifyMinisign(bytes, signature, publicKey, { version } = {}) {
  const keyLines = base64(publicKey).toString('utf8').trimEnd().split(/\r?\n/u);
  const signatureLines = base64(signature).toString('utf8').trimEnd().split(/\r?\n/u);
  if (keyLines.length !== 2 || signatureLines.length !== 4 || !signatureLines[2].startsWith('trusted comment: ')) throw new Error('Malformed minisign envelope');
  const key = base64(keyLines[1]), packet = base64(signatureLines[1]), global = base64(signatureLines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || packet.length !== 74 || global.length !== 64
    || !key.subarray(2, 10).equals(packet.subarray(2, 10)) || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString())) throw new Error('Unexpected minisign algorithm or key');
  const ed25519 = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const content = packet.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const comment = signatureLines[2].slice('trusted comment: '.length);
  if (!verify(null, content, ed25519, packet.subarray(10)) || !verify(null, Buffer.concat([packet.subarray(10), Buffer.from(comment)]), ed25519, global)) throw new Error('Update signature verification failed');
  if (version !== undefined) {
    const fields = comment.split('\t').filter(field => field.startsWith('version:'));
    if (fields.length !== 1 || fields[0] !== `version:${version}`) throw new Error('Update signature version does not match release');
  }
  return true;
}
export function verifySignedMetadata(document, publicKey) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid signed metadata');
  verifyMinisign(metadataBytes(document), document.varinSignature, publicKey, { version: document.version });
  return document;
}
