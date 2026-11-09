import { describe, expect, test } from 'vitest';
import { applyTextChanges, composeDocumentEdits, documentBaseEdits, invertTextChanges } from '@varin/application-client';
import type { VarinTextEdit } from '@varin/application-client';

describe('document edit provenance', () => {
  test('composes disjoint edits and edits inside inserted text without claiming matching base text', () => {
    const base = 'old\nkeep\nlast\n';
    let buffer = base;
    let edits: VarinTextEdit[] = [];
    for (const changes of [[{ from: 0, to: 3, insert: 'newer' }], [{ from: 11, to: 15, insert: 'tail' }], [{ from: 1, to: 3, insert: 'EW' }]]) {
      edits = composeDocumentEdits(base, buffer, edits, changes);
      buffer = applyTextChanges(buffer, changes);
      expect(documentBaseEdits(base, buffer, edits)).toEqual(edits);
    }
    expect(edits).toEqual([{ start: 0, end: 3, text: 'nEWer' }, { start: 9, end: 13, text: 'tail' }]);
    expect(composeDocumentEdits(base, buffer, edits, [{ from: 0, to: buffer.length, insert: 'new\nkeep\ntail\n' }]))
      .toEqual([{ start: 0, end: base.length, text: 'new\nkeep\ntail\n' }]);
  });

  test('keeps UTF-16 offsets and simultaneous same-position inserts in editor order', () => {
    const base = '🙂keep';
    const changes = [{ from: 2, to: 2, insert: 'B' }, { from: 2, to: 2, insert: 'A' }];
    const next = applyTextChanges(base, changes);
    expect(next).toBe('🙂ABkeep');
    expect(composeDocumentEdits(base, base, [], changes)).toEqual([{ start: 2, end: 2, text: 'AB' }]);
    expect(applyTextChanges(next, invertTextChanges(base, changes))).toBe(base);
  });

  test('composes long deterministic edit sequences with correct inverses', () => {
    const base = 'a\nkeep\nb\nkeep\nc';
    let buffer = base;
    let edits: VarinTextEdit[] = [];
    let seed = 17;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let index = 0; index < 500; index += 1) {
      const from = random(buffer.length + 1), to = from + random(buffer.length - from + 1);
      const changes = [{ from, to, insert: ['x', '\n', '', 'keep', '🙂'][random(5)]! }];
      const next = applyTextChanges(buffer, changes);
      expect(applyTextChanges(next, invertTextChanges(buffer, changes))).toBe(buffer);
      edits = composeDocumentEdits(base, buffer, edits, changes);
      expect(applyTextChanges(base, edits.map(edit => ({ from: edit.start, to: edit.end, insert: edit.text })).reverse())).toBe(next);
      buffer = next;
    }
  });
});
