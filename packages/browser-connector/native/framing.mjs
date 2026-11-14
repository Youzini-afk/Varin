import { endianness } from 'node:os';
const little = endianness() === 'LE';
export const MAX_FROM_BROWSER = 64 * 1024 * 1024;
export const MAX_TO_BROWSER = 1024 * 1024;
export function encodeNativeMessage(value, max = MAX_TO_BROWSER) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > max) throw new Error('Native message exceeds browser limit');
  const header = Buffer.alloc(4);
  if (little) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function createNativeDecoder(onMessage, max = MAX_FROM_BROWSER) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = little ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (!size || size > max) throw new Error('Invalid native message length');
        if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        buffer = buffer.subarray(size + 4); onMessage(value);
      }
    },
    end() { if (buffer.length) throw new Error('Truncated native message'); },
  };
}
