import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { ComposerLanguageContext } from '../../language/tokenize';
import { composerLanguage, setLanguageContext } from '../composerLanguage';

const context = (overrides: Partial<ComposerLanguageContext> = {}): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: new Set(['build']),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(['review']),
    attachmentFilenames: [],
    ...overrides,
});

const stateWith = (doc: string, ctx = context()) =>
    EditorState.create({ doc, extensions: composerLanguage(ctx) });

/** Read the installed editor decorations, without binding tests to CSS classes. */
const decoratedText = (state: EditorState) => {
    const found: string[] = [];
    const set = state.facet(EditorView.decorations)
        .map((source) => (typeof source === 'function' ? null : source))
        .find(Boolean);
    if (!set) return found;
    const iterator = set.iter();
    while (iterator.value) {
        found.push(state.doc.sliceString(iterator.from, iterator.to));
        iterator.next();
    }
    return found;
};


describe('composerLanguage — updates', () => {
    test('editing the document retokenizes', () => {
        const state = stateWith('hello');
        const next = state.update({
            changes: { from: 5, insert: ' @build' },
        }).state;
        expect(decoratedText(next)).toEqual(['@build']);
    });

    test('deleting a reference removes its decoration', () => {
        const state = stateWith('@build hi');
        expect(decoratedText(state)).toEqual(['@build']);
        const next = state.update({ changes: { from: 0, to: 7 } }).state;
        expect(decoratedText(next)).toEqual([]);
    });

    test('a new registry repaints without touching the document', () => {
        const state = stateWith('ask @deploy');
        expect(decoratedText(state)).toEqual([]);

        const next = state.update({
            effects: setLanguageContext.of(context({ knownAgentNames: new Set(['deploy']) })),
        }).state;
        expect(decoratedText(next)).toEqual(['@deploy']);
        expect(next.doc.toString()).toBe('ask @deploy');
        const disabled = next.update({ effects: setLanguageContext.of(context({ inputMode: 'shell' })) }).state;
        expect(decoratedText(disabled)).toEqual([]);
        expect(disabled.doc.toString()).toBe(next.doc.toString());
    });
});
