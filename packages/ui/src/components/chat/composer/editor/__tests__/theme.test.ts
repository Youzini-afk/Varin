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

    // This is the object installed by EditorView.theme, not a source-text scan.
    // Keep the WebKit input-lag guard: typing must not expose a native caret.
    // This checks the rule's scope, not WebKit rendering or input latency.
    test('native caret rules apply only while a range is selected', () => {
        const caretRules = Object.entries(NATIVE_SELECTION_THEME_SPEC)
            .filter(([, rule]) => 'caretColor' in rule);
        expect(caretRules.length).toBeGreaterThan(0);
        for (const [selectors] of caretRules) {
            for (const selector of selectors.split(',')) {
                expect(selector).toContain('.varin-native-range');
            }
        }
    });
});
