import { marked, type Tokens } from 'marked';
import remend from 'remend';

export interface MarkdownBlockSource {
  raw: string;
  src: string;
  mode: 'full' | 'live';
  highlight: boolean;
}

const documentSyntax = (text: string) => /^ {0,3}\[[^\]\n]+\]:/m.test(text) || text.includes('$$');
const heal = (text: string): string => {
  try { return remend(text, { linkMode: 'text-only' }); } catch { return text; }
};
const openFence = (raw: string): boolean => {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
  if (!mark) return false;
  const end = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${mark[0]}{${mark.length},}[\\t ]*$`).test(end);
};

/** Owned by one renderer. Only the last root token can still grow (a paragraph
 * can become a heading/table, a list can gain nested content, a fence can close).
 * Earlier tokens retain source identity through stream completion. Reference
 * definitions are document-wide, so those documents use the whole parser. */
export class MarkdownBlockStream {
  private text = '';
  private tailOffset = 0;
  private stable: MarkdownBlockSource[] = [];
  private blocks: MarkdownBlockSource[] = [];
  private hasReferences = false;
  private referenceScanFrom = 0;

  constructor(private readonly lex = (text: string): Tokens.Generic[] => marked.lexer(text) as Tokens.Generic[]) {}

  read(input: string, streaming: boolean): MarkdownBlockSource[] {
    const text = input.includes('\r') ? input.replace(/\r\n?/g, '\n') : input;
    if (!text.startsWith(this.text)) {
      this.tailOffset = 0;
      this.stable = [];
      this.blocks = [];
      this.hasReferences = false;
      this.referenceScanFrom = 0;
    }
    this.hasReferences ||= documentSyntax(text.slice(this.referenceScanFrom));
    this.referenceScanFrom = text.lastIndexOf('\n') + 1;
    this.text = text;
    if (!text) { this.blocks = []; return this.blocks; }

    const previous = this.blocks;
    const source = (raw: string, live: boolean, highlight: boolean, index: number): MarkdownBlockSource => {
      const mode = live ? 'live' : 'full';
      const before = previous[index];
      if (before?.raw === raw && before.mode === mode && before.highlight === highlight) return before;
      return { raw, src: live && highlight ? heal(raw) : raw, mode, highlight };
    };
    if (this.hasReferences) {
      this.stable = [];
      this.tailOffset = 0;
      return this.blocks = [source(text, streaming, true, 0)];
    }
    let tokens: Tokens.Generic[];
    try { tokens = this.lex(text.slice(this.tailOffset)); }
    catch {
      this.stable = [];
      this.tailOffset = 0;
      return this.blocks = [source(text, streaming, true, 0)];
    }
    // Definitions nested in a list/quote still affect earlier reference links.
    if (Object.keys((tokens as Tokens.Generic[] & { links?: object }).links ?? {}).length) {
      this.hasReferences = true;
      this.stable = [];
      this.tailOffset = 0;
      return this.blocks = [source(text, streaming, true, 0)];
    }

    let last = tokens.length - 1;
    while (last >= 0 && tokens[last]?.type === 'space') last--;
    const blocks = this.stable.slice();
    let offset = this.tailOffset;
    let tailOffset = offset;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const raw = token.raw ?? '';
      if (token.type !== 'space') {
        if (index === last) tailOffset = offset;
        blocks.push(source(raw, streaming && index === last, !streaming || !(token.type === 'code' && openFence(raw)), blocks.length));
      }
      offset += raw.length;
    }
    // Empty whitespace tails stay attached to the previous mutable token.
    if (last >= 0) {
      this.tailOffset = tailOffset;
      this.stable = blocks.slice(0, -1);
    }
    return this.blocks = blocks;
  }
}
