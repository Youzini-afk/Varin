import { expect, it } from 'vitest';
import { decodeManagedSourceResponse } from './managed-source-response.js';

it('validates the selected original attachment receipt and bounded read page', () => {
  const capture = { kind: 'attachment_capture' as const, operationId: 'op', ref: 'attachment:one', path: 'a.txt' };
  const value = { attachment: { ref: 'attachment:one', filename: 'a.txt', mimeType: 'text/plain', byteLength: 3 }, contentHash: 'sha256-123' };
  expect(decodeManagedSourceResponse(capture, value)).toEqual(value);
  expect(() => decodeManagedSourceResponse(capture, { ...value, attachment: { ...value.attachment, ref: 'attachment:other' } })).toThrow();
  expect(() => decodeManagedSourceResponse(capture, { ...value, attachment: { ...value.attachment, byteLength: -1 } })).toThrow();
  const read = { kind: 'attachment_read' as const, ref: 'attachment:one', offset: 0, length: 3 };
  const page = { hash: 'sha256-123', bytesBase64: 'YWJj', byteLength: 3, offset: 0, nextOffset: 3, eof: true };
  expect(decodeManagedSourceResponse(read, page)).toEqual(page);
  expect(() => decodeManagedSourceResponse(read, { ...page, offset: 1 })).toThrow();
});
