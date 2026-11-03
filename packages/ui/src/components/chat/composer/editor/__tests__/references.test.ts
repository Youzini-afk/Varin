import { EditorState, type TransactionSpec } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { expect, test } from 'vitest';
import { addComposerReference, composerReferences, referenceHistory, type ComposerReference } from '../references';
const reference: ComposerReference = { id: 'one', host: 3, from: 3, to: 12, text: '@my file', target: { kind: 'file', path: '/work/my file', workspacePath: '/work' } };
function editor() {
  let state = EditorState.create({ doc: '前文 /fi 后文', extensions: [history(), composerReferences, referenceHistory] });
  const dispatch = (transaction: ReturnType<EditorState['update']>) => { state = transaction.state; };
  return { get state() { return state; }, dispatch, edit(spec: TransactionSpec) { dispatch(state.update(spec)); } };
}
test('completion is one range edit, and edits, undo and redo retain exact reference identities', () => {
  const view = editor();
  view.edit({ changes: { from: 3, to: 6, insert: '@my file' }, effects: addComposerReference.of({ ...reference, to: 11 }), annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
  expect(view.state.doc.toString()).toBe('前文 @my file 后文');
  expect(view.state.field(composerReferences)[0].target).toEqual(reference.target);
  view.edit({ changes: { from: 0, insert: 'new ' }, userEvent: 'input.type' });
  expect(view.state.field(composerReferences)[0].from).toBe(7);
  view.edit({ changes: { from: 8, to: 10, insert: 'other' }, userEvent: 'input.type' });
  expect(view.state.field(composerReferences)).toEqual([]);
  expect(undo(view)).toBe(true);
  // CodeMirror may group adjacent typing; undo must never leave a mismatched hidden binding.
  expect(view.state.field(composerReferences).every(item => view.state.doc.sliceString(item.from, item.to) === item.text)).toBe(true);
  expect(redo(view)).toBe(true);
  expect(view.state.field(composerReferences)).toEqual([]);
});
test('deleting a reference removes its binding and undo restores the exact object, not a name lookup', () => {
  const view = editor();
  view.edit({ changes: { from: 3, to: 6, insert: '@my file' }, effects: addComposerReference.of({ ...reference, to: 11 }), annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
  view.edit({ changes: { from: 3, to: 11, insert: '' }, userEvent: 'delete.selection' });
  expect(view.state.field(composerReferences)).toEqual([]);
  undo(view);
  expect(view.state.field(composerReferences)[0]).toMatchObject({ id: 'one', target: reference.target });
});
