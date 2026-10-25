import { marked, type Tokens } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { pdfMaterialMarkdownHref } from '@/lib/materials/pdfMaterialCitation';
import { highlightCodeInWorker } from './markdown-worker';
import { liveFenceLines, parseOpenFence, renderOpenFence } from './liveFence';
import { MarkdownBlockStream, type MarkdownBlockSource } from './markdownBlocks';
import { escapeRawMarkdownHtml, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Streaming block segmentation (port of OpenCode's markdown-stream)
// ---------------------------------------------------------------------------

export { MarkdownBlockStream } from './markdownBlocks';

// ---------------------------------------------------------------------------
// marked parser (HTML string output) with safe external links
// ---------------------------------------------------------------------------

// Math delimiters that use backslashes — `\(...\)` (inline) and `\[...\]`
// (display) — must be caught during lexing: marked treats `\(`/`\[` as
// backslash escapes and strips the slash before any HTML post-process can see
// them. Registering them as tokenizers also makes them code-safe for free
// (marked tokenizes code spans/fences first, so these never fire inside code).
// Single-dollar `$...$` is intentionally NOT supported — it collides with
// currency text ($50, US$ 680); only `$$...$$` survives as display math (see
// renderMathExpressions). This mirrors KaTeX auto-render's default delimiters.
type MathToken = { type: string; raw: string; text: string };

const renderKatex = (math: string, raw: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: false });
  } catch {
    return raw;
  }
};

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    const index = src.indexOf('\\(');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, false);
  },
};

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const index = src.indexOf('\\[');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, true);
  },
};

const parser = marked.use({
  gfm: true,
  breaks: false,
  extensions: [inlineMathExtension, blockMathExtension],
  renderer: {
    // Model output is untrusted. Markdown constructs still render normally,
    // while raw HTML remains visible text instead of becoming application DOM.
    html({ text }) {
      return escapeRawMarkdownHtml(text);
    },
    link({ href, title, text, tokens, autolink }) {
      // Link text is raw Markdown, not rendered HTML. Parse its inline tokens
      // so nested HTML uses the same escaping boundary as the rest of a message.
      const label = autolink ? escapeRawMarkdownHtml(text) : this.parser.parseInline(tokens);
      const target = href ?? '';
      if (target.startsWith('varin-material://')) {
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return `<a href="${escapeAttr(pdfMaterialMarkdownHref(target))}" data-varin-material-link="true"${titleAttr} class="text-primary hover:underline">${label}</a>`;
      }
      const agentName = parseAgentHref(target);
      if (agentName) {
        return `<a href="${escapeAttr(buildAgentMentionUrl(agentName))}" data-varin-agent-mention="true" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      const skillName = parseSkillHref(target);
      if (skillName) {
        return `<a href="${escapeAttr(target)}" data-skill-name="${escapeAttr(skillName)}" class="text-primary hover:underline">${label}</a>`;
      }
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(target)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

// ---------------------------------------------------------------------------
// Math (KaTeX) — post-process the parsed HTML, skipping code/pre/kbd content
// ---------------------------------------------------------------------------

// Only `$$...$$` (display) is handled here. Single-dollar `$...$` inline math is
// deliberately omitted: it parses currency text ($50, US$ 680, "$50M to $72M")
// as math and corrupts it. Inline math is supported via `\(...\)` (see the
// marked extensions above). `$$` survives marked untouched (no backslash), so
// post-processing the parsed HTML — skipping code via renderMathExpressions —
// stays correct and code-safe.
const renderMathInText = (text: string): string =>
  text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: true, throwOnError: false });
    } catch {
      return `$$${math}$$`;
    }
  });

const renderMathExpressions = (html: string): string => {
  // No `$` anywhere means no math to render — skip the split + regex passes on
  // the hot streaming path (the overwhelming majority of blocks have no math).
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  return html
    .split(codeBlockPattern)
    .map((part, index) => (index % 2 === 1 ? part : renderMathInText(part)))
    .join('');
};

// ---------------------------------------------------------------------------
// Syntax highlighting (Shiki via @pierre/diffs shared highlighter)
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

// Skip syntax highlighting for very large blocks — tokenizing thousands of
// lines blocks the main thread. Plain (escaped) code is shown instead.
const CODE_HIGHLIGHT_LINE_LIMIT = 1200;

const exceedsLineLimit = (value: string, limit: number): boolean => {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10 && ++lines > limit) return true;
  }
  return false;
};

const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const highlightCodeBlocks = async (html: string): Promise<string> => {
  const matches = [...html.matchAll(CODE_BLOCK_RE)];
  if (matches.length === 0) return html;

  let result = html;
  for (const match of matches) {
    const [full, rawLang, escapedCode] = match;
    const requested = (rawLang || 'text').toLowerCase();
    // Leave mermaid fences untouched so the decorate pass can render them as
    // diagrams (highlighting would strip the `language-mermaid` class).
    if (requested === 'mermaid') continue;

    const code = unescapeHtml(escapedCode ?? '');

    // Oversized block: skip highlight, keep plain code but stamp the language.
    if (exceedsLineLimit(code, CODE_HIGHLIGHT_LINE_LIMIT)) {
      result = result.replace(full, () => full.replace('<pre', `<pre data-md-lang="${requested}"`));
      continue;
    }

    // Tokenize off the main thread. On failure the worker resolves to null and
    // we keep the original escaped <pre><code> (no main-thread highlight).
    const highlighted = await highlightCodeInWorker(code, requested);
    if (highlighted) {
      // Stamp the language so the decorate pass can show a header label.
      const stamped = highlighted.replace(/^<pre/, `<pre data-md-lang="${requested}"`);
      result = result.replace(full, () => stamped);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Sanitization (DOMPurify) — allow Shiki/KaTeX/SVG output
// ---------------------------------------------------------------------------

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['svg', 'path', 'g', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'marker'],
  ADD_ATTR: ['d', 'viewBox', 'preserveAspectRatio', 'xmlns', 'target', 'fill', 'stroke', 'stroke-width', 'transform', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'style'],
  FORBID_TAGS: [...MARKDOWN_FORBIDDEN_TAGS],
  FORBID_CONTENTS: [...MARKDOWN_FORBIDDEN_TAGS],
};

let sanitizeHookInstalled = false;

const ensureSanitizeHook = (): void => {
  if (sanitizeHookInstalled) return;
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return;
  sanitizeHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== '_blank') return;
    node.setAttribute('rel', 'noopener noreferrer');
  });
};

const sanitize = (html: string): string => {
  if (!DOMPurify.isSupported) return '';
  ensureSanitizeHook();
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
};


// ---------------------------------------------------------------------------
// Per-block HTML cache (LRU, mirrors OpenCode's checksum cache)
// ---------------------------------------------------------------------------

const CACHE_MAX = 240;
const htmlCache = new Map<string, { hash: string; html: string }>();

// FNV-1a 32-bit hash of the block content.
const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const touch = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.delete(key);
  htmlCache.set(key, entry);
  if (htmlCache.size <= CACHE_MAX) return;
  const oldest = htmlCache.keys().next().value;
  if (oldest) htmlCache.delete(oldest);
};

const parseBlock = async (block: MarkdownBlockSource): Promise<string> => {
  const parsed = await Promise.resolve(parser.parse(block.src));
  const withMath = renderMathExpressions(parsed);
  const highlighted = block.highlight ? await highlightCodeBlocks(withMath) : withMath;
  return sanitize(highlighted);
};

/**
 * Synchronous styled render for the first paint, before the async pipeline
 * (Shiki-in-worker highlight) resolves. Produces the SAME structural HTML as
 * `renderMarkdownBlocks` minus syntax coloring: paragraphs, lists, code blocks
 * and bold all render at their final width, so the async pass only upgrades
 * code-block colors — no flash of full-width raw markdown source. `parser.parse`
 * is synchronous (marked is not configured `async`), so this never blocks on a
 * worker round-trip.
 */
export const renderMarkdownSync = (text: string): string => {
  if (!text) return '';
  const parsed = parser.parse(text) as string;
  const withMath = renderMathExpressions(parsed);
  return sanitize(withMath);
};

export type RenderedBlock = {
  // Stable identity across renders for per-block DOM reconciliation. Encodes
  // content + mode + highlight so any change forces that block (and only that
  // block) to re-morph; unchanged leading blocks are skipped entirely.
  id: string;
  html: string;
};

// Weak ownership: stable blocks and in-flight parses are reused without adding
// a second permanent message cache. Discarding a renderer releases its sources.
const renderedSources = new WeakMap<MarkdownBlockSource, { coloured?: number; result: Promise<RenderedBlock> }>();

/**
 * Render markdown into an array of per-block sanitized HTML. Streaming-aware:
 * splits into blocks, caches per-block, heals incomplete syntax. Returning
 * blocks (instead of one joined string) lets the renderer re-morph only the
 * block that changed, keeping per-step streaming cost ~O(last block).
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  cacheKey: string,
  stream: MarkdownBlockStream,
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = stream.read(text, streaming);
  return Promise.all(
    blocks.map(async (block, index) => {
      // An open fence's HTML also depends on how many of its lines have colour.
      const parsedFence = !block.highlight ? parseOpenFence(block.raw) : null;
      const fence = parsedFence?.lang === 'mermaid' ? null : parsedFence;
      const coloured = fence ? liveFenceLines(`${cacheKey}:${index}`, cacheKey, fence) : undefined;
      const previous = renderedSources.get(block);
      if (previous && previous.coloured === coloured?.length) return previous.result;
      const contentHash = coloured ? `${hash(block.raw)}.${coloured.length}` : hash(block.raw);
      const id = `${contentHash}:${block.mode}:${block.highlight ? 1 : 0}`;
      const key = `${cacheKey}:${index}:${block.mode}`;
      const cached = htmlCache.get(key);
      if (cached && cached.hash === contentHash) {
        touch(key, cached);
        const result = Promise.resolve({ id, html: cached.html });
        renderedSources.set(block, { coloured: coloured?.length, result });
        return result;
      }
      const result = (async () => {
        const html = fence && coloured ? sanitize(renderOpenFence(fence, coloured)) : await parseBlock(block);
        touch(key, { hash: contentHash, html });
        return { id, html };
      })();
      renderedSources.set(block, { coloured: coloured?.length, result });
      return result;
    }),
  );
};
