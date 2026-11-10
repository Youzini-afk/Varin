import { EditorState, type TransactionSpec } from '@codemirror/state';
import { history, undo, redo, undoDepth, isolateHistory } from '@codemirror/commands';
import { expect, test } from 'vitest';
import { composerReferences, referenceHistory } from '../references';
import { atomicMarkerEditing, composerMarkerObjects, insertComposerMarker, markerObjectHistory, moveComposerMarker, replaceComposerMarkerObjects, snapMarkerPosition, type ComposerMarkerObject } from '../markers';

const quote = (id = 'quote'): ComposerMarkerObject => ({ id, kind: 'quote', number: 1, label: '[引用点1]', host: 0, sourceLabel: 'Varin', excerpt: '固定原文',
  payload: { kind: 'quote', reference: { ref: id, title: 'Varin', text: '固定原文', source: { kind: 'ui', snapshotRef: 'snapshot' } } } });
const image = (id = 'image'): ComposerMarkerObject => ({ id, kind: 'image', number: 1, label: '[图片1]', host: 0, payload: { kind: 'image', image: { mimeType: 'image/png', data: 'YQ==' } } });
function editor(doc = '') {
  let state = EditorState.create({ doc, extensions: [history(), composerReferences, referenceHistory, composerMarkerObjects, markerObjectHistory, atomicMarkerEditing] });
  const dispatch = (transaction: ReturnType<EditorState['update']>) => { state = transaction.state; };
  return { get state() { return state; }, dispatch, edit(spec: TransactionSpec) { dispatch(state.update(spec)); } };
}
test('literal marker text has no binding; insertion keeps selected user text and distinct occurrence identities', () => {
  const view = editor('[引用点1]自己的文字');
  view.edit({ selection: { anchor: 6, head: 11 } });
  view.edit(insertComposerMarker(view.state, quote(), undefined, 'first'));
  expect(view.state.doc.toString()).toBe('[引用点1]自己的文字[引用点1]');
  view.edit(insertComposerMarker(view.state, quote(), 0, 'second'));
  expect(view.state.field(composerReferences).map(reference => reference.id)).toEqual(['second', 'first']);
  expect(view.state.field(composerMarkerObjects)).toHaveLength(1);
  expect(view.state.field(composerReferences).map(reference => reference.target)).toEqual([{ kind: 'quote', quoteId: 'quote' }, { kind: 'quote', quoteId: 'quote' }]);
});
test('moves across lines in one undo step and no-op moves add no history', () => {
  const view = editor('甲\n乙');
  view.edit(insertComposerMarker(view.state, quote(), 1, 'occurrence'));
  const before = view.state.doc.toString(), depth = undoDepth(view.state);
  expect(moveComposerMarker(view.state, 'occurrence', 3)).toBeNull();
  expect(undoDepth(view.state)).toBe(depth);
  view.edit(moveComposerMarker(view.state, 'occurrence', view.state.doc.length)!);
  expect(view.state.doc.toString()).toBe('甲\n乙[引用点1]');
  expect(undoDepth(view.state)).toBe(depth + 1);
  undo(view); expect(view.state.doc.toString()).toBe(before);
  expect(view.state.field(composerReferences)[0]).toMatchObject({ id: 'occurrence', from: 1, target: { quoteId: 'quote' } });
  redo(view); expect(view.state.doc.toString()).toBe('甲\n乙[引用点1]');
});
test('partial deletion is atomic but deleting an occurrence retains its attachment and undo restores its binding', () => {
  const view = editor('前后');
  view.edit(insertComposerMarker(view.state, image(), 1, 'occurrence'));
  view.edit({ changes: { from: 3, to: 4, insert: '' }, annotations: isolateHistory.of('full'), userEvent: 'delete.backward' });
  expect(view.state.doc.toString()).toBe('前后');
  expect(view.state.field(composerReferences)).toEqual([]);
  expect(view.state.field(composerMarkerObjects)).toHaveLength(1);
  undo(view);
  expect(view.state.doc.toString()).toBe('前[图片1]后');
  expect(view.state.field(composerReferences)[0].id).toBe('occurrence');
});
test('attachment removal renumbers only bound occurrences and undo restores objects, bytes, ranges and cursor together', () => {
  const view = editor('[图片2] example ');
  view.edit(insertComposerMarker(view.state, image('a'), view.state.doc.length, 'a1'));
  view.edit(insertComposerMarker(view.state, image('b'), view.state.doc.length, 'b1'));
  view.edit(insertComposerMarker(view.state, image('b'), view.state.doc.length, 'b2'));
  const before = view.state.doc.toString(), selection = view.state.selection;
  view.edit(replaceComposerMarkerObjects(view.state, view.state.field(composerMarkerObjects).filter(object => object.id !== 'a'))!);
  expect(view.state.doc.toString()).toBe('[图片2] example [图片1][图片1]');
  expect(view.state.field(composerReferences).map(reference => reference.target)).toEqual([{ kind: 'image', imageId: 'b' }, { kind: 'image', imageId: 'b' }]);
  expect(view.state.field(composerMarkerObjects).map(object => object.id)).toEqual(['b']);
  undo(view);
  expect(view.state.doc.toString()).toBe(before);
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(view.state.field(composerMarkerObjects).map(object => object.id)).toEqual(['a', 'b']);
  expect(view.state.field(composerMarkerObjects)[0].payload).toMatchObject({ image: { data: 'YQ==' } });
  redo(view); expect(view.state.doc.toString()).toBe('[图片2] example [图片1][图片1]');
});
test('grapheme and marker snapping never splits emoji, combining accents, or another marker', () => {
  const view = editor('a👩🏽‍💻e\u0301中文');
  for (let pos = 2; pos < 8; pos++) expect([1, 8]).toContain(snapMarkerPosition(view.state, pos));
  expect([8, 10]).toContain(snapMarkerPosition(view.state, 9));
  view.edit(insertComposerMarker(view.state, quote(), view.state.doc.length, 'q'));
  const reference = view.state.field(composerReferences)[0];
  for (let pos = reference.from + 1; pos < reference.to; pos++) expect([reference.from, reference.to]).toContain(snapMarkerPosition(view.state, pos));
});
test('two-digit renumber preserves intervening file references and ordinary marker-like examples', () => {
  const view = editor('[引用点10]');
  for (let i = 1; i <= 12; i++) view.edit(insertComposerMarker(view.state, quote(String(i)), view.state.doc.length, `q${i}`));
  view.edit(replaceComposerMarkerObjects(view.state, view.state.field(composerMarkerObjects).filter(object => object.id !== '1'))!);
  expect(view.state.doc.toString()).toBe('[引用点10]' + Array.from({ length: 11 }, (_, index) => `[引用点${index + 1}]`).join(''));
  expect(view.state.field(composerReferences).at(-1)).toMatchObject({ id: 'q12', text: '[引用点11]', target: { quoteId: '12' } });
  undo(view); expect(view.state.field(composerReferences).at(-1)).toMatchObject({ text: '[引用点12]' });
});

test('resource enumeration preserves live history, includes redo, and drops roots after actual pruning', async () => {
  const { composerHistoryReferences } = await import('../markerHistory');
  let state = EditorState.create({ extensions: [history({ minDepth: 2 }), composerReferences, referenceHistory, composerMarkerObjects, markerObjectHistory, atomicMarkerEditing] });
  const view = { get state() { return state; }, dispatch(transaction: ReturnType<EditorState['update']>) { state = transaction.state; } };
  state = state.update(insertComposerMarker(state, quote(), 0, 'q')).state;
  undo(view);
  const original = state;
  expect(composerHistoryReferences(state).map(reference => reference.ref)).toEqual(['quote']);
  expect(state).toBe(original); expect(state.doc.toString()).toBe('');
  state = state.update({ changes: { from: 0, insert: 'New branch' }, annotations: isolateHistory.of('full'), userEvent: 'input.type' }).state;
  expect(composerHistoryReferences(state)).toEqual([]);
  state = state.update(insertComposerMarker(state, quote(), 0, 'second')).state;
  state = state.update(replaceComposerMarkerObjects(state, [])!).state;
  expect(composerHistoryReferences(state).map(reference => reference.ref)).toEqual(['quote']);
  for (let i = 0; i < 30; i++) state = state.update({ changes: { from: state.doc.length, insert: String(i) }, annotations: isolateHistory.of('full'), userEvent: 'input.type' }).state;
  expect(composerHistoryReferences(state)).toEqual([]);
});
