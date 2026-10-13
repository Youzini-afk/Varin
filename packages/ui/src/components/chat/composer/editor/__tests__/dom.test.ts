import { parseHTML } from 'linkedom';
import { afterEach, expect, test, vi } from 'vitest';

import { focusChatInput } from '../dom';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: unknown }).document;
});

for (const attributes of [
    'data-chat-input="true" data-pi-chat-input="true"',
    'data-chat-input="true"',
]) {
    test(`focuses the editable content inside the composer (${attributes})`, () => {
        const { document } = parseHTML(`<html><body>
            <div ${attributes}><div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div></div>
        </body></html>`);
        const content = document.querySelector('.cm-content')!;
        const host = document.body.firstElementChild!;
        const focusContent = vi.fn();
        const focusHost = vi.fn();
        // Linkedom owns DOM parsing and selector evaluation. Only the browser's
        // focus side effect is observed here; this is not native focus acceptance.
        Object.assign(content, { focus: focusContent });
        Object.assign(host, { focus: focusHost });
        Object.defineProperty(globalThis, 'document', { configurable: true, value: document });

        focusChatInput();

        expect(focusContent).toHaveBeenCalledOnce();
        expect(focusHost).not.toHaveBeenCalled();
    });
}

test('does nothing when no composer is mounted', () => {
    const { document } = parseHTML('<html><body></body></html>');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    expect(() => focusChatInput()).not.toThrow();
});
