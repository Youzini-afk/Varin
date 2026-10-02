import { marked } from 'marked';
import type { ChatMemoryPassage } from '@varin/application-client';

interface TextMap { text: string; starts: number[]; ends: number[] }
type Token = { type: string; raw?: string; text?: string; tokens?: Token[]; items?: Token[];
  header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };

/** Map visible Markdown text back to exact source positions, skipping link destinations and syntax. */
export function markdownSourceMap(source: string): TextMap {
  const result: TextMap = { text: '', starts: [], ends: [] };
  const append = (raw: string, start: number, decodeEntities = true) => {
    if (!decodeEntities) {
      result.text += raw;
      for (let index = 0; index < raw.length; index += 1) {
        result.starts.push(start + index); result.ends.push(start + index + 1);
      }
      return;
    }
    const parts = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[\s\S]/giu;
    for (const match of raw.matchAll(parts)) {
      let text = match[0];
      if (decodeEntities && text.startsWith('&')) {
        const decoder = document.createElement('span');
        decoder.innerHTML = text;
        text = decoder.textContent ?? text;
      }
      for (let index = 0; index < text.length; index += 1) {
        result.text += text[index];
        result.starts.push(start + match.index!);
        result.ends.push(start + match.index! + match[0].length);
      }
    }
  };
  const walk = (tokens: Token[], raw: string, base: number) => {
    let cursor = 0;
    for (const token of tokens) {
      const fragment = token.raw ?? '';
      const position = fragment ? raw.indexOf(fragment, cursor) : cursor;
      if (position < 0) continue; // Unmappable rendered math/custom syntax stays unavailable for extraction.
      const start = base + position;
      cursor = position + fragment.length;
      if (token.type === 'space' || token.type === 'def' || token.type === 'image') continue;
      if (token.type === 'blockquote') {
        let clean = '';
        const positions: number[] = [];
        let lineStart = 0;
        for (const line of fragment.split('\n')) {
          const prefix = line.match(/^ {0,3}> ?/u)?.[0].length ?? 0;
          for (let at = prefix; at < line.length; at += 1) { clean += line[at]; positions.push(lineStart + at); }
          if (lineStart + line.length < fragment.length) { clean += '\n'; positions.push(lineStart + line.length); }
          lineStart += line.length + 1;
        }
        const nested = markdownSourceMap(clean);
        result.text += nested.text;
        result.starts.push(...nested.starts.map((offset) => start + positions[offset]!));
        result.ends.push(...nested.ends.map((offset) => start + positions[offset - 1]! + 1));
      } else if (token.type === 'table') {
        const inline = [...(token.header ?? []), ...(token.rows ?? []).flat()].flatMap((cell) => cell.tokens);
        walk(inline, fragment, start);
      } else if (token.items) walk(token.items, fragment, start);
      else if (token.tokens) walk(token.tokens, fragment, start);
      else if (token.type === 'escape') {
        append(fragment.slice(1), start + 1);
      } else if (token.type === 'code' || token.type === 'codespan') {
        const code = token.text ?? '';
        const offset = fragment.indexOf(code);
        if (offset >= 0) append(code, start + offset, false);
      } else if (token.type === 'text' || token.type === 'html') append(fragment, start);
    }
  };
  walk(marked.lexer(source) as Token[], source, 0);
  return result;
}

export interface ChatTextSource { entryId?: string; text: string; offset: number; contentIndex?: number }
const IGNORED = 'button, summary, [aria-hidden="true"], [data-md-code-line-number], .katex-mathml';

/** Freeze a selection without relying on selection focus after a menu opens. */
export function captureChatSelection(range: Range, sources: ReadonlyMap<HTMLElement, ChatTextSource>, visibleText = range.toString()) {
  const passages: ChatMemoryPassage[] = [];
  let complete = true;
  let selectedText = '';
  const visibleSource = (element: HTMLElement) => {
    if (!element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')
        && !parent.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return range.intersectsNode(element);
  };
  const roots = [...sources].filter(([element]) => visibleSource(element))
    .sort(([left], [right]) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  for (const [element, source] of roots) {
    const map = markdownSourceMap(source.text);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let start: number | undefined;
    let end: number | undefined;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest(IGNORED) || !node.data) continue;
      const mapped = map.text.indexOf(node.data, cursor);
      if (mapped >= 0) cursor = mapped + node.data.length;
      if (!range.intersectsNode(node)) continue;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.data.length;
      if (to <= from || !node.data.slice(from, to).trim()) continue;
      selectedText += node.data.slice(from, to);
      if (mapped < 0 || !source.entryId) { complete = false; continue; }
      start ??= map.starts[mapped + from];
      end = map.ends[mapped + to - 1];
    }
    if (start !== undefined && end !== undefined && source.entryId) {
      passages.push({ entryId: source.entryId, start: source.offset + start, text: source.text.slice(start, end) });
    }
  }
  const text = visibleText.trim();
  return { text, passages, complete: complete && passages.length > 0
    && selectedText.replace(/\s/gu, '') === text.replace(/\s/gu, '') };
}
