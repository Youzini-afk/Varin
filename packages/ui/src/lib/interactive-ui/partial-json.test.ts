import { expect, it } from 'vitest';
import { PartialJson } from './partial-json';
it('exposes growing file text across fragmented JSON escapes without requiring field order', () => {
  const reader = new PartialJson();
  reader.feed('{"changes":[{"text":"<h1>');
  expect(reader.value).toEqual({ changes: [{ text: '<h1>' }] });
  reader.feed('Hello\\u4');
  expect((reader.value as { changes: { text: string }[] }).changes[0]!.text).toBe('<h1>Hello');
  reader.feed('f60\\n\\"world\\"</h1>","op":"write","file":"index.html"}],"ref":"ui:a');
  expect(reader.completeFields.has('ref')).toBe(false);
  reader.feed('@1"}');
  expect(reader.completeFields.has('ref')).toBe(true);
  expect(reader.value).toEqual({ changes: [{ text: '<h1>Hello你\n"world"</h1>', op: 'write', file: 'index.html' }], ref: 'ui:a@1' });
});
