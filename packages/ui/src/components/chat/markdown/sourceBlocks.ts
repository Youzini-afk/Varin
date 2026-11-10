import { Renderer, type TokensList, type Token } from 'marked';

interface SourceRange { start: number; end: number; kind: string }
const ranges = new WeakMap<object, SourceRange>();
/** Positions belong to lexer tokens, not text recovered from rendered DOM. */
export function indexMarkdownSource(tokens: TokensList, text: string) {
  const walk = (items: readonly Token[], raw: string, positions: readonly number[]) => {
    let cursor = 0;
    for (const token of items) {
      const fragment = token.raw;
      const at = raw.indexOf(fragment, cursor);
      if (at < 0) continue;
      cursor = at + fragment.length;
      const local = positions.slice(at, cursor);
      const range = { start: local[0] ?? 0, end: (local.at(-1) ?? -1) + 1, kind: token.type };
      ranges.set(token, range);
      if (token.type === 'list') walk(token.items, fragment, local);
      else if (token.type === 'blockquote' || token.type === 'list_item') {
        // Marked removes indentation and quote/list prefixes. Retain their
        // original positions when indexing the nested block-token tree.
        const plain = token.text;
        const mapped: number[] = [];
        let offset = 0;
        for (let index = 0; index < plain.length; index++) {
          const found = fragment.indexOf(plain[index]!, offset);
          if (found < 0) break;
          mapped.push(local[found]!); offset = found + 1;
        }
        if (mapped.length === plain.length) walk(token.tokens ?? [], plain, mapped);
        if (token.type === 'list_item') {
          const nested = token.tokens?.find(part => part.type === 'list');
          const nestedStart = nested && ranges.get(nested)?.start;
          if (nestedStart !== undefined) range.end = nestedStart;
        }
      }
    }
  };
  const normalized = text.replace(/\r\n?/gu, '\n');
  walk(tokens, normalized, Array.from({ length: normalized.length }, (_, index) => index));
}
export function withMarkdownSource(html: string, token: object): string {
  const range = ranges.get(token);
  return !range ? html : html.replace(/^(<[a-z][\w-]*)/u, `$1 data-chat-source-start="${range.start}" data-chat-source-end="${range.end}" data-chat-source-kind="${range.kind}"`);
}
const defaults = new Renderer();
export const sourceBlockRenderer = {
  heading(this: Renderer, token: Parameters<Renderer['heading']>[0]) { return withMarkdownSource(defaults.heading.call(this, token), token); },
  code(this: Renderer, token: Parameters<Renderer['code']>[0]) { return withMarkdownSource(defaults.code.call(this, token), token); },
  table(this: Renderer, token: Parameters<Renderer['table']>[0]) { return withMarkdownSource(defaults.table.call(this, token), token); },
  listitem(this: Renderer, token: Parameters<Renderer['listitem']>[0]) { return withMarkdownSource(defaults.listitem.call(this, token), token); },
};

/** Bind attributes to the actual rendered generation, which can lag streaming. */
const renderedSources = new WeakMap<Element, { text: string; offset: number; blockOffset: number; plain?: boolean }>();
export function bindRenderedMarkdownSource(root: Element, text: string, offset = 0, blockOffset = 0, plain = false) {
  renderedSources.set(root, { text, offset, blockOffset, plain });
}
export function renderedMarkdownSource(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const source = renderedSources.get(node);
    if (source) return source;
  }
}

/** Marked normalizes CRLF; source snapshots and memory offsets remain original UTF-16. */
export function renderedSourceRange(source: { text: string; offset: number; blockOffset: number; plain?: boolean }, start: number, end: number) {
  const originalOffset = (normalized: number) => {
    if (source.plain) return normalized;
    let original = 0, at = 0;
    while (at < normalized && original < source.text.length) {
      if (source.text[original] === '\r' && source.text[original + 1] === '\n') original++;
      original++; at++;
    }
    return original;
  };
  const from = originalOffset(source.blockOffset + start), to = originalOffset(source.blockOffset + end);
  return { start: source.offset + from, end: source.offset + to, text: source.text.slice(from, to) };
}
