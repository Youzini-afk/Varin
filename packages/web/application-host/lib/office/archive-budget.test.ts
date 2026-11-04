import { afterEach, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { OfficePackage } from './package.js';
import { DEFAULT_OFFICE_ARCHIVE_LIMITS, OfficeArchiveLimitError, openOfficeArchive, resolveOfficeArchiveLimits } from './archive-budget.js';
import { createOfficeRenderer } from './renderer.js';

afterEach(() => vi.unstubAllEnvs());
function archive(text: string, extras: Record<string, string> = {}) {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  for (const [name, value] of Object.entries(extras)) zip.addFile(name, Buffer.from(value));
  return zip.toBuffer();
}

it('rejects highly compressed oversized XML before reading it, while preserving a safe overview', () => {
  const bytes = archive('a'.repeat(512 * 1024));
  expect(bytes.length).toBeLessThan(2048);
  const document = new OfficePackage(bytes, { maxEntryBytes: 64 * 1024 });
  expect(document.read({ view: 'overview' })).toMatchObject({ status: 'ok', format: 'docx', sections: [{ id: 'word/document.xml' }] });
  expect(() => document.read({ view: 'content' })).toThrow(OfficeArchiveLimitError);
  expect(new OfficePackage(bytes, { maxEntryBytes: 1024 * 1024 }).read({ view: 'content' }).objects?.[0]?.text).toHaveLength(512 * 1024);
});

it('enforces a cumulative actual-byte budget across separate parts without counting cached source twice', () => {
  const original = openOfficeArchive(archive('first', { 'word/header1.xml': 'x'.repeat(200), 'word/footer1.xml': 'y'.repeat(200) }),
    { maxEntryBytes: 1024, maxInflatedBytes: 500 });
  const main = original.zip.getEntry('word/document.xml')!, header = original.zip.getEntry('word/header1.xml')!, footer = original.zip.getEntry('word/footer1.xml')!;
  expect(original.read(main).length).toBeLessThan(200);
  expect(original.read(main)).toEqual(original.read(main));
  expect(original.read(header).length).toBe(200);
  expect(() => original.read(footer)).toThrow('maxInflatedBytes');
});

it('bounds actual inflation even when both headers falsely declare one uncompressed byte', () => {
  const bytes = archive('z'.repeat(256 * 1024));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(1, central + 24);
  bytes.writeUInt32LE(1, 22);
  const original = openOfficeArchive(bytes, { maxEntryBytes: 1024, maxInflatedBytes: 1024 });
  expect(() => original.read(original.zip.getEntry('word/document.xml')!)).toThrow('bounded decompression');
});

it('rejects duplicate and non-canonical names and inconsistent local header identity', () => {
  const duplicate = archive('safe', { 'word/duplicat.xml': 'other' });
  const name = Buffer.from('word/duplicat.xml'), target = Buffer.from('word/document.xml');
  for (let offset = duplicate.indexOf(name); offset >= 0; offset = duplicate.indexOf(name, offset + target.length)) target.copy(duplicate, offset);
  expect(() => openOfficeArchive(duplicate)).toThrow(/duplicate/i);
  const traversal = archive('safe', { 'word/xx/hidden.xml': 'other' });
  const safeName = Buffer.from('word/xx/hidden.xml'), traversalName = Buffer.from('word/../hidden.xml');
  for (let offset = traversal.indexOf(safeName); offset >= 0; offset = traversal.indexOf(safeName, offset + traversalName.length)) traversalName.copy(traversal, offset);
  expect(() => openOfficeArchive(traversal)).toThrow('non-canonical');
  const mismatched = archive('safe'); mismatched[30] = 'X'.charCodeAt(0);
  expect(() => openOfficeArchive(mismatched)).toThrow('inconsistent local header');
});

it('caps entry-table allocation and validates configured budgets instead of accepting invalid overrides', () => {
  expect(() => openOfficeArchive(archive('safe', { 'customXml/one.xml': '1', 'customXml/two.xml': '2' }), { maxEntries: 2 })).toThrow('maxEntries');
  expect(resolveOfficeArchiveLimits({}, {})).toEqual(DEFAULT_OFFICE_ARCHIVE_LIMITS);
  expect(resolveOfficeArchiveLimits({}, { VARIN_OFFICE_MAX_ENTRY_BYTES: '4096' }).maxEntryBytes).toBe(4096);
  expect(() => resolveOfficeArchiveLimits({ maxInflatedBytes: Infinity }, {})).toThrow('positive safe integer');
  expect(() => resolveOfficeArchiveLimits({}, { VARIN_OFFICE_MAX_ENTRIES: '-1' })).toThrow('positive safe integer');
});

it('does not reject high compression ratios within the byte budget, but checks all hidden parts before external rendering', async () => {
  const bytes = archive('safe', { 'customXml/hidden.xml': 'a'.repeat(256 * 1024) });
  const document = new OfficePackage(bytes, { maxEntryBytes: 1024 });
  expect(document.read({ view: 'content' }).objects?.[0]?.text).toBe('safe');
  expect(() => openOfficeArchive(bytes, { maxEntryBytes: 512 * 1024 }).validateAll()).not.toThrow();
  vi.stubEnv('VARIN_OFFICE_MAX_ENTRY_BYTES', '1024');
  const spawn = vi.fn();
  const renderer = createOfficeRenderer({ spawn, temporaryRoot: '/tmp' });
  await expect(renderer.convert(bytes, 'docx', 'pdf')).rejects.toBeInstanceOf(OfficeArchiveLimitError);
  expect(spawn).not.toHaveBeenCalled();
});
