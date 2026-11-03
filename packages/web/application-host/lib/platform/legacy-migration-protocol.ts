/** Private inherited pipes only. One bounded record at a time, with explicit
 * acknowledgement before the source sends another secret-bearing record. */
export const LEGACY_MIGRATION_PROTOCOL = 'varin-legacy-migration';
export const LEGACY_MIGRATION_VERSION = 1;
export const LEGACY_MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
export function createLegacyMigrationReader(source: AsyncIterable<Uint8Array>) {
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(), offset = 0;
  const exact = async (length: number): Promise<Buffer> => {
    const bytes = Buffer.alloc(length); let written = 0;
    while (written < length) {
      if (offset === chunk.byteLength) {
        const next = await iterator.next();
        if (next.done) throw new Error('Legacy migration pipe ended before its receipt');
        chunk = next.value; offset = 0;
      }
      const count = Math.min(length - written, chunk.byteLength - offset);
      bytes.set(chunk.subarray(offset, offset + count), written); offset += count; written += count;
    }
    return bytes;
  };
  return async (): Promise<Record<string, unknown>> => {
    const length = (await exact(4)).readUInt32BE();
    if (!length || length > LEGACY_MIGRATION_MAX_BYTES) throw new Error('Legacy migration record exceeds its native pipe budget');
    const raw = await exact(length);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw new Error('Legacy migration record is malformed'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy migration record must be an object');
    return value as Record<string, unknown>;
  };
}
export async function writeLegacyMigrationRecord(write: (bytes: Uint8Array) => Promise<void>, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > LEGACY_MIGRATION_MAX_BYTES) throw new Error('Legacy migration record exceeds its native pipe budget');
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); await write(length);
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) await write(bytes.subarray(offset, offset + 64 * 1024));
}
