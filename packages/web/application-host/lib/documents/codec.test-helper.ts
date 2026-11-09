import { isUtf8 } from 'node:buffer';
import { bindDocumentTextCodec, type DocumentTextCodec } from './inspect.js';
import { detectLineEnding } from './line-ending.js';

/** UTF-8-only coordination seam. It proves Host routing/CAS, never native codec behavior. */
export const utf8CoordinationCodec: DocumentTextCodec = {
  async textDecode(input) {
    const bytes = Buffer.from(input.bytesBase64, 'base64');
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = bom ? bytes.subarray(3) : bytes;
    if (body.includes(0)) return { kind: 'binary', byteLength: bytes.length };
    if (!isUtf8(body)) return { kind: 'unsupported-encoding', byteLength: bytes.length, candidates: ['utf-8'] };
    const content = body.toString('utf8'), lineEnding = detectLineEnding(content);
    return { kind: 'text', byteLength: bytes.length,
      ...(input.includeContent === false ? {} : { content }),
      format: { encoding: 'utf-8', bom, lineEnding, defaultLineEnding: lineEnding, source: 'utf8' } };
  },
  async textSerialize(input) {
    if (input.targetFormat?.encoding && input.targetFormat.encoding !== 'utf-8') return { kind: 'invalid', message: 'This coordination test port supports only UTF-8' };
    const bom = input.targetFormat?.bom ?? false;
    const lineEnding = input.targetFormat?.lineEnding && input.targetFormat.lineEnding !== 'mixed'
      ? input.targetFormat.lineEnding : input.sourceFormat?.defaultLineEnding ?? detectLineEnding(input.content);
    const text = input.normalizeLineEndings ? input.content.replace(/\r\n|\r/g, '\n').replace(/\n/g, lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : '\n') : input.content;
    const bytes = Buffer.from(`${bom ? '\ufeff' : ''}${text}`, 'utf8');
    return { kind: 'serialized', bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
      format: { encoding: 'utf-8', bom, lineEnding, defaultLineEnding: lineEnding, source: 'explicit' } };
  },
};
export const bindUtf8CoordinationCodec = () => bindDocumentTextCodec(utf8CoordinationCodec);
