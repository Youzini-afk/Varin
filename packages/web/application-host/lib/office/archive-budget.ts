/** OOXML expansion budgets belong to the format owner, not the HTTP download limit. */
import AdmZip from 'adm-zip';
import path from 'node:path';

export interface OfficeArchiveLimits {
  maxEntryBytes: number;
  maxInflatedBytes: number;
  maxEntries: number;
}
/** XML DOMs retain substantially more memory than their input bytes. These are Host resource
 * defaults, not Office format limits; trusted Host operators can raise them for large workbooks. */
export const DEFAULT_OFFICE_ARCHIVE_LIMITS: Readonly<OfficeArchiveLimits> = Object.freeze({
  maxEntryBytes: 32 * 1024 * 1024,
  maxInflatedBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
});
const environmentNames: Record<keyof OfficeArchiveLimits, string> = {
  maxEntryBytes: 'VARIN_OFFICE_MAX_ENTRY_BYTES',
  maxInflatedBytes: 'VARIN_OFFICE_MAX_INFLATED_BYTES',
  maxEntries: 'VARIN_OFFICE_MAX_ENTRIES',
};
export class OfficeArchiveLimitError extends Error {
  readonly code = 'office-archive-budget-exceeded';
  constructor(readonly resource: keyof OfficeArchiveLimits, readonly limit: number, part?: string) {
    super(`Office package ${part ? `part ${part} ` : ''}exceeds the Host ${resource} budget (${limit}). Configure ${environmentNames[resource]} for a larger trusted document.`);
  }
}
export function resolveOfficeArchiveLimits(overrides: Partial<OfficeArchiveLimits> = {}, environment: NodeJS.ProcessEnv = process.env): OfficeArchiveLimits {
  const resolved = { ...DEFAULT_OFFICE_ARCHIVE_LIMITS };
  for (const key of Object.keys(environmentNames) as Array<keyof OfficeArchiveLimits>) {
    const raw = overrides[key] ?? environment[environmentNames[key]];
    if (raw === undefined) continue;
    const value = typeof raw === 'number' ? raw : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${environmentNames[key]} must be a positive safe integer`);
    resolved[key] = value;
  }
  return resolved;
}
const invalid = (message: string): never => { throw new Error(`Invalid Office package: ${message}`); };

export function openOfficeArchive(source: Uint8Array, overrides?: Partial<OfficeArchiveLimits>) {
  const limits = resolveOfficeArchiveLimits(overrides);
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  let zip: AdmZip;
  try { zip = new AdmZip(bytes, { readEntries: false }); }
  catch { throw new Error('The document is not a readable Office Open XML package; encrypted or legacy binary files need an Office application'); }
  // AdmZip is deliberately lazy here. Check its central-directory count before allocating entries.
  const count = zip.getEntryCount();
  if (!Number.isSafeInteger(count) || count < 0) invalid('invalid entry count');
  if (count > limits.maxEntries) throw new OfficeArchiveLimitError('maxEntries', limits.maxEntries);
  const entries = zip.getEntries();
  if (entries.length > limits.maxEntries) throw new OfficeArchiveLimitError('maxEntries', limits.maxEntries);
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    const canonical = entry.isDirectory ? name.slice(0, -1) : name;
    if (!canonical || canonical.includes('\\') || canonical.includes('\0') || canonical.startsWith('/')
      || canonical.split('/').some(segment => !segment || segment === '.' || segment === '..')
      || path.posix.normalize(canonical) !== canonical) invalid('non-canonical part name');
    if (names.has(canonical)) invalid(`duplicate part ${canonical}`);
    names.add(canonical);
    const header = entry.header;
    if (![header.size, header.compressedSize, header.offset].every(value => Number.isSafeInteger(value) && value >= 0)
      || header.offset > bytes.length - 30) invalid(`invalid size or offset for ${name}`);
    const offset = header.offset;
    if (bytes.readUInt32LE(offset) !== 0x04034b50) invalid(`missing local header for ${name}`);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    if (dataOffset > bytes.length || header.compressedSize > bytes.length - dataOffset
      || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(entry.rawEntryName)
      || bytes.readUInt16LE(offset + 8) !== header.method) invalid(`inconsistent local header for ${name}`);
    if (header.method === 0 && header.compressedSize !== header.size) invalid(`stored size mismatch for ${name}`);
    if (entry.isDirectory && header.size) invalid(`directory contains data: ${name}`);
  }
  let expandedBytes = 0;
  const expanded = new Map<string, number>();
  const declared = (entry: AdmZip.IZipEntry, remaining: number) => {
    if (entry.header.encrypted) invalid(`encrypted part ${entry.entryName}`);
    if (entry.header.method !== 0 && entry.header.method !== 8) invalid(`unsupported compression for ${entry.entryName}`);
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0) invalid(`invalid size for ${entry.entryName}`);
    if (entry.header.size > limits.maxEntryBytes) throw new OfficeArchiveLimitError('maxEntryBytes', limits.maxEntryBytes, entry.entryName);
    if (entry.header.size > remaining) throw new OfficeArchiveLimitError('maxInflatedBytes', limits.maxInflatedBytes, entry.entryName);
  };
  const read = (entry: AdmZip.IZipEntry): Buffer => {
    const previous = expanded.get(entry.entryName) ?? 0;
    const remaining = limits.maxInflatedBytes - expandedBytes + previous;
    declared(entry, remaining);
    // Locked adm-zip 0.6.1 uses zlib maxOutputLength = max(1, declared size), so a false
    // small declaration cannot allocate the real bomb before this actual-byte check.
    // STORED input has already proved compressedSize === size in the original header.
    let result: Buffer;
    try { result = entry.getData(); }
    catch (cause) { throw new Error(`Invalid Office package: bounded decompression or checksum validation failed for ${entry.entryName}`, { cause }); }
    if (result.length > limits.maxEntryBytes) throw new OfficeArchiveLimitError('maxEntryBytes', limits.maxEntryBytes, entry.entryName);
    if (result.length > remaining) throw new OfficeArchiveLimitError('maxInflatedBytes', limits.maxInflatedBytes, entry.entryName);
    if (result.length !== entry.header.size) invalid(`declared and actual sizes differ for ${entry.entryName}`);
    expandedBytes += result.length - previous;
    expanded.set(entry.entryName, result.length);
    return result;
  };
  return { zip, read,
    /** External Office rendering can expand parts that structural reads never touch. Validate
     * the entire archive before dispatching it to that process, without retaining inflated bytes. */
    validateAll() {
      let total = 0;
      for (const entry of entries) if (!entry.isDirectory) { declared(entry, limits.maxInflatedBytes - total); total += entry.header.size; }
      for (const entry of entries) if (!entry.isDirectory) read(entry);
    },
  };
}
