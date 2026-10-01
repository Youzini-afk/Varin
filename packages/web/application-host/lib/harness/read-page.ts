import type { DocumentReadPage, DocumentReadPageRequest } from '@varin/protocol';
import fs from 'node:fs';

export const READ_PAGE_CHUNK_BYTES = 64 * 1024;
type ReadAt = (offset: number, length: number) => Promise<Buffer>;

/** Keep one admitted handle and verify both replacement and in-place changes. */
export async function readStableFile<T>(
  canonicalPath: string,
  read: (handle: fs.promises.FileHandle, stat: fs.BigIntStats) => Promise<T>,
  signal?: AbortSignal,
  validateAfter?: () => Promise<void>,
  fsApi: Pick<typeof fs.promises, 'open' | 'stat'> = fs.promises,
): Promise<{ value: T; revision: string }> {
  signal?.throwIfAborted();
  const handle = await fsApi.open(canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino === 0n) throw new Error('Document path is not a readable regular file');
    signal?.throwIfAborted();
    const value = await read(handle, opened);
    signal?.throwIfAborted();
    await validateAfter?.();
    const current = await fsApi.stat(canonicalPath, { bigint: true });
    const finished = await handle.stat({ bigint: true });
    if (!current.isFile() || [current, finished].some(stat => stat.dev !== opened.dev || stat.ino !== opened.ino
      || stat.size !== opened.size || stat.mtimeNs !== opened.mtimeNs || stat.ctimeNs !== opened.ctimeNs)) {
      throw new Error('Document path changed while reading');
    }
    return { value, revision: `disk-page:${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}` };
  } finally { await handle.close(); }
}

export const readHandlePage = (handle: fs.promises.FileHandle, byteLength: number, page: DocumentReadPageRequest, signal?: AbortSignal) =>
  readContentPage(async (offset, length) => {
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, offset);
    return bytes.subarray(0, result.bytesRead);
  }, byteLength, page, signal);

const signature = (bytes: Buffer, value: number[]) =>
  value.length <= bytes.length && value.every((value, index) => bytes[index] === value);
const ascii = (bytes: Buffer, value: string, offset = 0) =>
  bytes.subarray(offset, offset + value.length).equals(Buffer.from(value));

/** Inspect content, not extensions: a misleading filename cannot trigger text decoding. */
const contentKind = (bytes: Buffer): 'image' | string | null => {
  const png = signature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && bytes.length >= 29 && bytes.readUInt32BE(8) === 13 && ascii(bytes, 'IHDR', 12);
  const bmp = ascii(bytes, 'BM') && bytes.length >= 30
    && [12, 40, 52, 56, 64, 108, 124].includes(bytes.readUInt32LE(14));
  if ((signature(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0xf7) || png || bmp
    || ascii(bytes, 'GIF87a') || ascii(bytes, 'GIF89a') || (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8))) return 'image';
  for (const [magic, format] of [['PAR1', 'parquet'], ['ARROW1', 'arrow'], ['SQLite format 3', 'sqlite'],
    ['%PDF-', 'pdf'], ['PK\x03\x04', 'zip'], ['\x7fELF', 'elf']] as const) {
    if (ascii(bytes, magic)) return format;
  }
  if (signature(bytes, [0x1f, 0x8b])) return 'gzip';
  if (signature(bytes, [0xff, 0xfe]) || signature(bytes, [0xfe, 0xff])) return 'unsupported-encoding';
  if (bytes.includes(0)) return 'binary';
  return null;
};

export async function readContentPage(
  readAt: ReadAt, byteLength: number, request: DocumentReadPageRequest, signal?: AbortSignal, knownText = false,
): Promise<DocumentReadPage> {
  signal?.throwIfAborted();
  const prefix = await readAt(0, Math.min(READ_PAGE_CHUNK_BYTES, byteLength));
  signal?.throwIfAborted();
  const kind = knownText ? null : contentKind(prefix);
  if (kind === 'image') {
    const chunks = [prefix];
    let cursor = prefix.length;
    while (cursor < byteLength) {
      signal?.throwIfAborted();
      const bytes = await readAt(cursor, Math.min(READ_PAGE_CHUNK_BYTES, byteLength - cursor));
      signal?.throwIfAborted();
      if (bytes.length === 0) throw new Error('Image source ended before its recorded length');
      chunks.push(bytes); cursor += bytes.length;
    }
    signal?.throwIfAborted();
    return { kind: 'image', base64: Buffer.concat(chunks).toString('base64') };
  }
  if (kind) return { kind: 'binary', format: kind, byteLength };

  let line = 1;
  let cursor = 0;
  let pendingBytes = 0;
  let outputBytes = 0;
  let pending: Buffer[] = [];
  const lines: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const finish = (eof: boolean, truncatedBy: 'lines' | 'bytes' | null, firstLineExceedsLimit = false): DocumentReadPage => ({
    kind: 'text', text: lines.join('\n'), startLine: request.offset, lineCount: lines.length, eof, truncatedBy,
    ...(eof ? { totalLines: line } : { nextOffset: request.offset + lines.length }),
    ...(firstLineExceedsLimit ? { firstLineExceedsLimit: true } : {}),
  });
  const emitLine = (): boolean => {
    if (line < request.offset) return true;
    try { lines.push(decoder.decode(Buffer.concat(pending, pendingBytes))); }
    catch { return false; }
    outputBytes += pendingBytes + (lines.length > 1 ? 1 : 0);
    pending = []; pendingBytes = 0;
    return true;
  };
  while (cursor < byteLength) {
    signal?.throwIfAborted();
    const bytes = cursor === 0 ? prefix : await readAt(cursor, Math.min(READ_PAGE_CHUNK_BYTES, byteLength - cursor));
    signal?.throwIfAborted();
    if (bytes.length === 0) throw new Error('Text source ended before its recorded length');
    if (bytes.includes(0)) return { kind: 'binary', format: 'binary', byteLength };
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      if (line >= request.offset) {
        const piece = bytes.subarray(start, end);
        const separatorBytes = lines.length > 0 ? 1 : 0;
        if (outputBytes + pendingBytes + piece.length + separatorBytes > request.maxBytes) {
          return finish(false, 'bytes', lines.length === 0);
        }
        pending.push(piece); pendingBytes += piece.length;
      }
      if (newline === -1) break;
      if (!emitLine()) return { kind: 'binary', format: 'unsupported-encoding', byteLength };
      line++;
      start = newline + 1;
      if (lines.length >= request.limit) {
        const eof = cursor + start === byteLength;
        return finish(eof, eof ? null : 'lines');
      }
    }
    cursor += bytes.length;
  }
  signal?.throwIfAborted();
  if (line < request.offset) throw new Error(`Offset ${request.offset} is beyond end of file (${line} lines total)`);
  if (!emitLine()) return { kind: 'binary', format: 'unsupported-encoding', byteLength };
  return finish(true, null);
}

/** Page an existing immutable draft without encoding or splitting its whole body. */
export async function readTextPage(text: string, request: DocumentReadPageRequest, signal?: AbortSignal): Promise<DocumentReadPage> {
  // Documents already owns the full immutable draft. Encode only small slices,
  // using the same byte reader as disk and branch objects.
  let characterOffset = 0;
  let byteOffset = 0;
  let last: { offset: number; bytes: Buffer } | undefined;
  return readContentPage(async (offset, length) => {
    if (last?.offset === offset) return last.bytes;
    if (offset !== byteOffset) throw new Error('Draft page reader must advance in order');
    let end = Math.min(text.length, characterOffset + length);
    if (end < text.length && end > characterOffset && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
    const storage = Buffer.alloc(length);
    const encoded = new TextEncoder().encodeInto(text.slice(characterOffset, end), storage);
    const bytes = storage.subarray(0, encoded.written);
    last = { offset, bytes }; characterOffset += encoded.read; byteOffset += bytes.length;
    return bytes;
  }, Buffer.byteLength(text, 'utf8'), request, signal, true);
}
