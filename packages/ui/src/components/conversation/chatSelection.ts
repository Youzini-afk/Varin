import { marked } from 'marked';
import { renderedMarkdownSource, renderedSourceRange } from '@/components/chat/markdown/sourceBlocks';
import { parseConversationContent, type ChatMemoryPassage } from '@varin/application-client';

interface TextMap { text: string; starts: number[]; ends: number[] }
type Token = { type: string; raw?: string; text?: string; tokens?: Token[]; items?: Token[];
  header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };

/** Map visible Markdown text back to exact source positions, skipping link destinations and syntax. */
export function markdownSourceMap(source: string): TextMap {
  if (source.includes('\r')) {
    const positions: number[] = [], ends: number[] = [];
    let normalized = '';
    for (let index = 0; index < source.length; index++) {
      positions.push(index);
      normalized += source[index] === '\r' ? '\n' : source[index];
      if (source[index] === '\r' && source[index + 1] === '\n') index++;
      ends.push(index + 1);
    }
    const map = markdownSourceMap(normalized);
    return { text: map.text, starts: map.starts.map(index => positions[index]!), ends: map.ends.map(index => ends[index - 1]!) };
  }
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

export interface ChatTextSource { entryId?: string; text: string; offset: number; contentIndex?: number; role?: string; contentIdentity?: string; streaming?: boolean }
/** Resolve original body indices through the projection, never use them as array indices. */
export function chatTextSourceOffset(source: ChatTextSource, content?: readonly { type: string; text?: string; id?: string; contentIndex?: number }[]): number {
  if (!content) return source.offset;
  const position = source.contentIdentity ? content.findIndex(part => part.type === 'text' && part.id === source.contentIdentity)
    : source.contentIndex === undefined ? -1 : content.findIndex(part => part.type === 'text' && part.contentIndex === source.contentIndex);
  if (position < 0) return source.offset;
  return content.slice(0, position).reduce((total, part) => total + (part.type === 'text' ? (part.text?.length ?? 0) + 1 : 0), 0);
}
function conversationSourceMap(source: ChatTextSource): TextMap & { segments: number[] } {
  const result = { text: '', starts: [] as number[], ends: [] as number[], segments: [] as number[] };
  for (const [segment, part] of parseConversationContent(source.text, { role: source.role ?? 'text' }).entries()) {
    if (part.kind !== 'markdown' && part.kind !== 'invalid') continue;
    const map = part.kind === 'markdown' ? markdownSourceMap(part.text) : { text: part.raw,
      starts: Array.from({ length: part.raw.length }, (_, index) => index), ends: Array.from({ length: part.raw.length }, (_, index) => index + 1) };
    result.text += map.text;
    result.starts.push(...map.starts.map(offset => part.start + offset));
    result.ends.push(...map.ends.map(offset => part.start + offset));
    result.segments.push(...Array(map.text.length).fill(segment));
  }
  return result;
}
const IGNORED = 'button:not([data-bound-reference]), summary, [aria-hidden="true"], [data-md-code-line-number], .katex-mathml, [data-conversation-ui-fragment]';

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
    const fallback = { map: conversationSourceMap(source), text: source.text, offset: source.offset, cursor: 0 };
    const renderedMaps = new Map<NonNullable<ReturnType<typeof renderedMarkdownSource>>, typeof fallback>();
    let active = fallback;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let start: number | undefined;
    let end: number | undefined;
    let segment: number | undefined;
    const flushPassage = () => {
      if (start !== undefined && end !== undefined && source.entryId) passages.push({ entryId: source.entryId, start: active.offset + start, text: active.text.slice(start, end) });
      start = undefined; end = undefined;
    };
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest(IGNORED) || !node.data) continue;
      // The rendered generation can lag React's streaming source. Each painted
      // Markdown block carries its own immutable source, including repeated text.
      const rendered = node.parentElement && renderedMarkdownSource(node.parentElement);
      let mappedSource = fallback;
      if (rendered) {
        let cached = renderedMaps.get(rendered);
        if (!cached) {
          const map = rendered.plain ? { text: rendered.text, starts: Array.from({ length: rendered.text.length }, (_, index) => index), ends: Array.from({ length: rendered.text.length }, (_, index) => index + 1) } : markdownSourceMap(rendered.text);
          const first = renderedSourceRange(rendered, 0, 0).start - rendered.offset;
          cached = { map: { ...map, segments: Array(map.text.length).fill(0) }, text: rendered.text,
            offset: source.offset + rendered.offset, cursor: Math.max(0, map.starts.findIndex(offset => offset >= first)) };
          renderedMaps.set(rendered, cached);
        }
        mappedSource = cached;
      }
      if (active !== mappedSource) { flushPassage(); segment = undefined; active = mappedSource; }
      const map = active.map;
      const mapped = map.text.indexOf(node.data, active.cursor);
      if (mapped >= 0) active.cursor = mapped + node.data.length;
      if (!range.intersectsNode(node)) continue;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.data.length;
      if (to <= from || !node.data.slice(from, to).trim()) continue;
      selectedText += node.data.slice(from, to);
      if (mapped < 0 || !source.entryId) { complete = false; continue; }
      const nextSegment = map.segments[mapped + from];
      if (segment !== nextSegment) { flushPassage(); segment = nextSegment; }
      start ??= map.starts[mapped + from];
      end = map.ends[mapped + to - 1];
    }
    flushPassage();
  }
  const text = visibleText.trim() ? visibleText : '';
  return { text, passages, complete: complete && passages.length > 0
    && selectedText.replace(/\s/gu, '') === text.replace(/\s/gu, '') };
}

/** Find the precise rendered source block, without guessing from DOM text. */
export function captureChatSourceBlock(element: Element, sources: ReadonlyMap<HTMLElement, ChatTextSource>) {
  let block = element.closest<HTMLElement>('[data-chat-source-start][data-chat-source-end]');
  if (block && !['code', 'table'].includes(block.dataset.chatSourceKind ?? '')) block = block.closest<HTMLElement>('li[data-chat-source-start]') ?? block;
  if (!block) return undefined;
  const owner = [...sources].find(([root]) => root.contains(block));
  if (!owner) return undefined;
  const [, source] = owner;
  const rendered = renderedMarkdownSource(block);
  if (!rendered) return undefined;
  const start = Math.max(0, Number(block.dataset.chatSourceStart));
  const end = Number(block.dataset.chatSourceEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return undefined;
  const mapped = renderedSourceRange(rendered, start, end);
  const text = mapped.text.trimEnd();
  if (!text.trim()) return undefined;
  const offset = source.offset + mapped.start;
  return { text, kind: block.dataset.chatSourceKind === 'code' ? 'code' as const : 'block' as const,
    source, passages: source.entryId ? [{ entryId: source.entryId, start: offset, text }] : [] };
}

export function findChatSourceElement(container: Element, entryId: string, start?: number, end?: number): HTMLElement | undefined {
  for (const root of container.querySelectorAll<HTMLElement>('[data-conversation-source-id]')) {
    if (root.dataset.conversationSourceId !== entryId) continue;
    if (start === undefined) return root;
    const offset = Number(root.dataset.conversationSourceOffset ?? 0);
    for (const block of root.querySelectorAll<HTMLElement>('[data-chat-source-start][data-chat-source-end]')) {
      const rendered = renderedMarkdownSource(block);
      if (!rendered) continue;
      const mapped = renderedSourceRange(rendered, Number(block.dataset.chatSourceStart), Number(block.dataset.chatSourceEnd));
      const from = offset + mapped.start;
      const to = offset + mapped.end;
      if (from <= start && to >= (end ?? start)) return block;
    }
  }
}
