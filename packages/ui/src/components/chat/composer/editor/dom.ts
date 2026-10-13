const CHAT_INPUT_EDITOR_SELECTOR = '[data-pi-chat-input="true"] .cm-content, [data-chat-input="true"] .cm-content';

export function focusChatInput(): void {
    document.querySelector<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)?.focus();
}
