import type { EditorState } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import type { ContentReference } from '@varin/application-client';
import { composerMarkerObjects } from './markers';

/** Enumerate reachable resources through the supported state-command API. CodeMirror's public
 * history JSON deliberately omits effects; reading its private event arrays would couple resource
 * lifetime to an undocumented representation. These detached immutable transactions invoke no
 * EditorView listeners or external actions and never mutate the live editor/history.
 *
 * Run at an idle/pruning boundary, not on every input frame or keystroke. */
export function composerHistoryReferences(original: EditorState): ContentReference[] {
  const references = new Map<string, ContentReference>();
  const collect = (state: EditorState) => {
    for (const object of state.field(composerMarkerObjects, false) ?? []) {
      const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference;
      if (reference) references.set(reference.ref, reference);
    }
  };
  collect(original);
  for (const command of [undo, redo]) {
    let state = original;
    const cursor = { get state() { return state; }, dispatch: (transaction: ReturnType<EditorState['update']>) => { state = transaction.state; collect(state); } };
    while (command(cursor)) { /* The existing history owner determines its finite reachable steps. */ }
  }
  return [...references.values()];
}
