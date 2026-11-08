import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const revisionFromBytes = (bytes: Buffer | Uint8Array): string => (
  `d1_${createHash('sha256').update(bytes).digest('base64url')}`
);

export type InspectedDocument =
  | { kind: 'binary'; byteLength: number }
  | { kind: 'unsupported-encoding'; byteLength: number; candidates: string[] }
  | { kind: 'text'; encoding: string; bom: boolean; content: string; byteLength: number };

export type InspectedDocumentMetadata =
  | Exclude<InspectedDocument, { kind: 'text' }>
  | Omit<Extract<InspectedDocument, { kind: 'text' }>, 'content'>;

export function inspectDocumentBytes(input: Buffer | Uint8Array): InspectedDocument;
export function inspectDocumentBytes(input: Buffer | Uint8Array, includeContent: false): InspectedDocumentMetadata;
export function inspectDocumentBytes(input: Buffer | Uint8Array, includeContent = true): InspectedDocument | InspectedDocumentMetadata {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { kind: 'unsupported-encoding', byteLength: bytes.length, candidates: ['utf-16le'] };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { kind: 'unsupported-encoding', byteLength: bytes.length, candidates: ['utf-16be'] };
  }

  let bom = false;
  let payload: Buffer = bytes;
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM)) {
    bom = true;
    payload = bytes.subarray(3);
  }

  if (payload.subarray(0, Math.min(payload.length, 4096)).includes(0)) {
    return { kind: 'binary', byteLength: bytes.length };
  }

  // Save/conflict receipts need classification and byte metadata, not another
  // allocation of the complete editor text. Validate the same UTF-8 bytes natively.
  if (!includeContent) return isUtf8(payload)
    ? { kind: 'text', encoding: 'utf-8', bom, byteLength: bytes.length }
    : { kind: 'unsupported-encoding', byteLength: bytes.length, candidates: ['utf-8'] };

  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return { kind: 'text', encoding: 'utf-8', bom, content, byteLength: bytes.length };
  } catch {
    return { kind: 'unsupported-encoding', byteLength: bytes.length, candidates: ['utf-8'] };
  }
}

export interface EncodeDocumentTextOptions {
  content: unknown;
  encoding: string;
  bom: boolean;
}

export const encodeDocumentText = ({ content, encoding, bom }: EncodeDocumentTextOptions): Buffer => {
  if (encoding !== 'utf-8') {
    throw new Error('Unsupported document encoding');
  }
  const body = Buffer.from(String(content ?? ''), 'utf8');
  if (!bom) return body;
  return Buffer.concat([UTF8_BOM, body]);
};
