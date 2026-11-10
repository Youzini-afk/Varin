import type { VarinTextEdit } from './types.js';

/** One transaction's range edits; equal-position insertions are in execution order. */
export type VarinDocumentTextChange = { from: number; to: number; insert: string };

type Piece = { start: number; end: number } | { text: string };
const length = (piece: Piece): number => 'text' in piece ? piece.text.length : piece.end - piece.start;
const slice = (piece: Piece, from: number, to: number): Piece => 'text' in piece
  ? { text: piece.text.slice(from, to) } : { start: piece.start + from, end: piece.start + to };

export const applyTextChanges = (buffer: string, changes: readonly VarinDocumentTextChange[]): string => {
  for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
    buffer = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to);
  }
  return buffer;
};

/** No diff inference: absent/invalid provenance means the entire buffer was replaced. */
export const documentBaseEdits = (
  base: string, buffer: string, edits?: readonly VarinTextEdit[],
): VarinTextEdit[] => {
  if (edits) {
    let cursor = 0;
    let text = '';
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
        || edit.start < cursor || edit.end < edit.start || edit.end > base.length) {
        return [{ start: 0, end: base.length, text: buffer }];
      }
      text += base.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
    if (text + base.slice(cursor) === buffer) return [...edits];
  }
  return base === buffer ? [] : [{ start: 0, end: base.length, text: buffer }];
};

/** Compose real UTF-16 edits with sparse base/inserted spans, never per-character maps. */
export const composeDocumentEdits = (
  base: string,
  before: string,
  edits: readonly VarinTextEdit[] | undefined,
  changes: readonly VarinDocumentTextChange[],
): VarinTextEdit[] => {
  let cursor = 0;
  let pieces: Piece[] = [];
  for (const edit of documentBaseEdits(base, before, edits)) {
    if (cursor < edit.start) pieces.push({ start: cursor, end: edit.start });
    if (edit.text) pieces.push({ text: edit.text });
    cursor = edit.end;
  }
  if (cursor < base.length) pieces.push({ start: cursor, end: base.length });
  // Stable same-position ordering matches the editor transaction contract.
  const descending = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
  for (const change of descending) {
    const left: Piece[] = [];
    const right: Piece[] = [];
    let offset = 0;
    for (const piece of pieces) {
      const end = offset + length(piece);
      if (offset < change.from) left.push(slice(piece, 0, Math.min(length(piece), change.from - offset)));
      if (end > change.to) right.push(slice(piece, Math.max(0, change.to - offset), length(piece)));
      offset = end;
    }
    pieces = [...left, ...(change.insert ? [{ text: change.insert }] : []), ...right];
  }
  const result: VarinTextEdit[] = [];
  cursor = 0;
  let inserted = '';
  for (const piece of pieces) {
    if ('text' in piece) { inserted += piece.text; continue; }
    if (cursor < piece.start || inserted) result.push({ start: cursor, end: piece.start, text: inserted });
    cursor = piece.end;
    inserted = '';
  }
  if (cursor < base.length || inserted) result.push({ start: cursor, end: base.length, text: inserted });
  return result;
};

export const invertTextChanges = (buffer: string, changes: readonly VarinDocumentTextChange[]): VarinDocumentTextChange[] => {
  let delta = 0;
  return changes.map((change, index) => ({ ...change, index }))
    .sort((a, b) => a.from - b.from || a.to - b.to || b.index - a.index)
    .map(change => {
      const inverse = { from: change.from + delta, to: change.from + delta + change.insert.length,
        insert: buffer.slice(change.from, change.to) };
      delta += change.insert.length - (change.to - change.from);
      return inverse;
    });
};
