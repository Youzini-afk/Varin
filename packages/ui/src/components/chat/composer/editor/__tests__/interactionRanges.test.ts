import { EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { expect, it } from 'vitest';
import { interactionHistory, interactionInsertion, interactionRanges } from '../interactionRanges';

it('undo and redo restore source binding; deletion permits a new insertion', () => {
  let state = EditorState.create({ doc: 'note', extensions: [history(), interactionRanges, interactionHistory] });
  const dispatch = (transaction: import('@codemirror/state').Transaction) => { state = transaction.state; };
  const fill = (text: string) => { state = state.update(interactionInsertion(state.doc.toString(), state.field(interactionRanges), 'choice', text).spec).state; };
  fill('first'); fill('second');
  expect(state.doc.toString()).toBe('note\n\nsecond');
  undo({ state, dispatch });
  expect(state.doc.toString()).toBe('note\n\nfirst');
  expect(state.field(interactionRanges)[0]?.text).toBe('first');
  redo({ state, dispatch });
  expect(state.field(interactionRanges)[0]?.text).toBe('second');
  state = state.update({ changes: { from: 6, to: state.doc.length, insert: '' } }).state;
  expect(state.field(interactionRanges)).toEqual([]);
  fill('third');
  expect(state.doc.toString()).toBe('note\n\nthird');
});
