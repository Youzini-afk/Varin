import { expect, it } from 'vitest';
import { inspectDocumentBytes } from './inspect.js';

it('classifies metadata exactly like full document reads without returning text', () => {
  const inputs = [Buffer.alloc(0), Buffer.from('ordinary text\r\n中文🙂'), Buffer.from('\ufeffBOM\r\n'),
    Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from([0xfe, 0xff, 0, 65]), Buffer.from([0, 65]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xe2, 0x82]), Buffer.from([0xef, 0xbb, 0xbf, 0xff]), Buffer.from('a'.repeat(4096) + '\0')];
  // Exercise invalid leading/continuation bytes and boundary pairs deterministically.
  for (let first = 0; first < 256; first++) for (const second of [0x20, 0x7f, 0x80, 0xbf, 0xc2, 0xff]) inputs.push(Buffer.from([first, second]));
  for (const input of inputs) {
    const full = inspectDocumentBytes(input);
    const expected = full.kind === 'text' ? (() => { const { content: _content, ...metadata } = full; return metadata; })() : full;
    expect(inspectDocumentBytes(input, false)).toEqual(expected);
    expect(inspectDocumentBytes(new Uint8Array(input), false)).toEqual(expected);
  }
});
