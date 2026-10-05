import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
    NATIVE_SELECTION_THEME_SPEC,
    composerEditorTheme,
    composerNativeSelectionExtension,
} from '../theme';

describe('composer themes', () => {
    // Invalid CodeMirror theme scopes throw at runtime despite passing tsc.
    test('the installed editor themes compile together', () => {
        expect(() => EditorState.create({
            extensions: [composerEditorTheme, composerNativeSelectionExtension],
        })).not.toThrow();
    });

    // Retain the known WebKit input-lag regression until a real iOS check
    // can verify it. A visible native caret must be scoped to range selection.
    test('native caret rules apply only while a range is selected', () => {
        const caretRules = Object.entries(NATIVE_SELECTION_THEME_SPEC)
            .filter(([, rule]) => 'caretColor' in rule);
        expect(caretRules.length).toBeGreaterThan(0);
        for (const [selector] of caretRules) {
            expect(selector).toContain('.oc-native-range');
        }
    });
});
