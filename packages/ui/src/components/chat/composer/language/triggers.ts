/**
 * Select one picker for the caret: leading command, inline skill, then file/agent mention.
 */

import {
    getFileMentionAutocompleteQuery,
    type FileMentionAutocompleteInputSource,
} from '../../fileMentionAutocompleteState';

export type AutocompleteKind = 'command' | 'skill' | 'mention';

export interface AutocompleteTrigger {
    kind: AutocompleteKind;
    /** Text typed after the sigil, used to filter the picker. */
    query: string;
}

export interface TriggerContext {
    /** Shell mode (`!cmd`) disables every picker. */
    inputMode: 'normal' | 'shell';
    /** Whether the change that moved the caret came from a paste. */
    inputSource?: FileMentionAutocompleteInputSource;
    /** The text that change inserted, when known. */
    insertedText?: string;
}

/**
 * A sigil opens a picker only at a word boundary — the start of the text or
 * directly after whitespace. This mirrors `scanSlashTokens`, but works
 * backwards from the caret because the token is still being typed.
 */
const isWordBoundaryBefore = (text: string, index: number): boolean =>
    index <= 0 || /\s/.test(text[index - 1]);

/**
 * The command palette is reserved for a `/` in the very first column, with the
 * caret still inside the command word and no argument typed yet. Once a space
 * appears the message is a command invocation, not a search.
 */
function matchCommandPalette(value: string, cursorPosition: number): AutocompleteTrigger | null {
    if (!value.startsWith('/')) return null;

    const firstSpace = value.indexOf(' ');
    if (firstSpace !== -1) return null;

    const firstNewline = value.indexOf('\n');
    const commandEnd = firstNewline === -1 ? value.length : firstNewline;
    if (cursorPosition > commandEnd) return null;

    return { kind: 'command', query: value.substring(1, commandEnd) };
}

/**
 * An inline `/skill` still being typed: the nearest slash before
 * the caret, at a word boundary, with no separator between it and the caret.
 */
function matchInlineSkill(
    value: string,
    cursorPosition: number,
): AutocompleteTrigger | null {
    const textBeforeCursor = value.substring(0, cursorPosition);
    const sigilIndex = textBeforeCursor.lastIndexOf('/');
    if (sigilIndex === -1) return null;
    if (!isWordBoundaryBefore(textBeforeCursor, sigilIndex)) return null;

    const query = textBeforeCursor.substring(sigilIndex + 1);
    if (query.includes(' ') || query.includes('\n')) return null;

    return { kind: 'skill', query };
}

/**
 * Resolve the single autocomplete that the caret asks for, or null when none
 * applies. Pure: the caller supplies the text and caret, and decides what to
 * do with the answer.
 */
export function resolveAutocompleteTrigger(
    value: string,
    cursorPosition: number,
    context: TriggerContext,
): AutocompleteTrigger | null {
    if (context.inputMode === 'shell') return null;

    return matchCommandPalette(value, cursorPosition)
        ?? matchInlineSkill(value, cursorPosition)
        ?? matchMention(value, cursorPosition, context);
}

function matchMention(
    value: string,
    cursorPosition: number,
    context: TriggerContext,
): AutocompleteTrigger | null {
    const query = getFileMentionAutocompleteQuery({
        value,
        cursorPosition,
        inputSource: context.inputSource,
        insertedText: context.insertedText,
    });
    return query === null ? null : { kind: 'mention', query };
}

export type { FileMentionAutocompleteInputSource };
