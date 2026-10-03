import { afterEach, expect, test } from 'vitest';

import { focusChatInput } from '../dom';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: unknown }).document;
});

test('focuses the CodeMirror chat input content', () => {
    let selector = '';
    let focused = false;
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            querySelector: (value: string) => {
                selector = value;
                return { focus: () => { focused = true; } };
            },
        },
    });

    focusChatInput();

    expect(selector).toBe('[data-pi-chat-input="true"], [data-chat-input="true"] .cm-content');
    expect(focused).toBe(true);
});
