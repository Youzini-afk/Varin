/** The caret and its explicit fragment are the only autocomplete target. */
import type { FileMentionAutocompleteInputSource } from '../../fileMentionAutocompleteState';

export type AutocompleteKind = 'command' | 'mention';
export interface AutocompleteTrigger {
  kind: AutocompleteKind;
  query: string;
  from: number;
  to: number;
}
export interface TriggerContext {
  inputMode: 'normal' | 'shell';
  inputSource?: FileMentionAutocompleteInputSource;
  insertedText?: string;
  /** Only an already open query may absorb pasted keywords or spaces. */
  active?: AutocompleteTrigger | null;
}

/** Markdown literals are not application commands. Shared with slash token highlighting. */
export function isComposerLiteral(text: string, position: number): boolean {
  let fence: string | null = null;
  let inline = 0;
  for (const line of text.slice(0, position).split('\n')) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      inline = 0;
    } else if (!fence) {
      for (const match of line.matchAll(/`+/g)) {
        if (match.index > 0 && line[match.index - 1] === '\\') continue;
        if (!inline) inline = match[0].length;
        else if (inline === match[0].length) inline = 0;
      }
    }
  }
  return Boolean(fence || inline);
}

export function resolveAutocompleteTrigger(value: string, cursorPosition: number, context: TriggerContext): AutocompleteTrigger | null {
  if (context.inputMode === 'shell') return null;
  const cursor = Math.min(Math.max(0, cursorPosition), value.length);
  const prefix = value.slice(0, cursor);
  const mention = /(?:^|\s)@[^\s]*$/.exec(prefix);
  let from = mention ? prefix.lastIndexOf('@') : Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('@'));
  // A file query may itself contain slashes. Preserve its original sigil.
  const active = context.active;
  if (active && active.from < cursor && ['/', '@'].includes(value[active.from])
    && !/[\n\r]/.test(value.slice(active.from, cursor))) from = active.from;
  if (from < 0 || (from > 0 && !/\s/.test(value[from - 1])) || isComposerLiteral(value, from)) return null;
  const sigil = value[from];
  const query = value.slice(from + 1, cursor);
  if (/[\n\r`]/.test(query)) return null;
  if (!active && /\s/.test(query)) return null;
  if (context.inputSource === 'paste' && (!active || /[\n\r]/.test(context.insertedText ?? '') || (context.insertedText ?? '').includes(sigil))) return null;
  // Scoped packages, URLs and absolute path literals do not open an application picker.
  if (sigil === '@' && !active && /^[^/\\\s]+\/[^/\\\s]+$/.test(query)) return null;
  if (sigil === '/' && /[/\\.:]/.test(query.replace(/^(?:skill:|ext:[^:]+:)/, ''))) return null;
  let to = cursor;
  while (to < value.length && !/[\s`]/.test(value[to])) to++;
  return { kind: sigil === '/' ? 'command' : 'mention', query, from, to };
}
export type { FileMentionAutocompleteInputSource };
