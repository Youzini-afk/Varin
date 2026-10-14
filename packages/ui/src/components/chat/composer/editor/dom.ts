const CHAT_INPUT_EDITOR_SELECTOR = '[data-chat-input="true"] .cm-content, textarea[data-chat-input="true"]';

export function focusChatInput(): void {
    document.querySelector<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)?.focus();
}
