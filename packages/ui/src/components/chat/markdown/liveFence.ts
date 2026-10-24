import { highlightLinesInWorker } from './markdown-worker';

/**
 * Line-by-line colour for a code fence that is still streaming.
 *
 * Re-tokenizing the whole growing block every paced frame is O(n²), so the open
 * fence used to stay plain until it closed. Instead, each completed line is
 * coloured shortly after it completes: the completed prefix goes to the worker
 * once per change (debounced 90ms, one request in flight per fence), and every
 * render reuses the newest result that is still a prefix of the code. The line
 * being written stays plain until it completes.
 */
export interface OpenFence {
  lang: string;
  /** Completed lines, without the newline after the last one. */
  completed: string;
  /** The line being written. */
  partial: string;
}

/** Let a completed line settle (and its ink develop) before it changes colour. */
export const LIVE_FENCE_HIGHLIGHT_DELAY_MS = 90;
/** Past this many lines the fence stays plain until it closes. */
const LIVE_FENCE_LINE_LIMIT = 400;
const LIVE_FENCE_LIMIT = 24;

interface Highlight { lang: string; code: string; lines: string[] }
interface Pending { owner: string; next: { lang: string; code: string } | null; timer: ReturnType<typeof setTimeout> | null; inflight: boolean }

const highlights = new Map<string, Highlight>();
const pending = new Map<string, Pending>();
const listeners = new Set<(owner: string) => void>();

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value: string): string => escapeHtml(value).replace(/"/g, '&quot;');

const lineCount = (code: string): number => {
  let lines = 1;
  for (let index = 0; index < code.length; index += 1) if (code.charCodeAt(index) === 10) lines += 1;
  return lines;
};

/** Split an open top-level fence's raw source; `null` until its first line break. */
export const parseOpenFence = (raw: string): OpenFence | null => {
  const newline = raw.indexOf('\n');
  if (newline < 0) return null;
  const info = raw.slice(0, newline).match(/^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([^\s`]*)/);
  const lang = (info?.[1] || 'text').toLowerCase();
  const body = raw.slice(newline + 1);
  const lastBreak = body.lastIndexOf('\n');
  return lastBreak < 0
    ? { lang, completed: '', partial: body }
    : { lang, completed: body.slice(0, lastBreak), partial: body.slice(lastBreak + 1) };
};

/** Be told when a fence owned by `owner` (a renderer cache key) gains colour. */
export const subscribeLiveFence = (listener: (owner: string) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const remember = (key: string, highlight: Highlight): void => {
  highlights.delete(key);
  highlights.set(key, highlight);
  while (highlights.size > LIVE_FENCE_LIMIT) highlights.delete(highlights.keys().next().value!);
};

const run = async (key: string): Promise<void> => {
  const state = pending.get(key);
  if (!state) return;
  state.timer = null;
  const job = state.next;
  state.next = null;
  if (!job) { pending.delete(key); return; }
  state.inflight = true;
  const lines = await highlightLinesInWorker(job.code, job.lang);
  state.inflight = false;
  if (lines) {
    remember(key, { ...job, lines: lines.slice(0, lineCount(job.code)) });
    for (const listener of listeners) listener(state.owner);
  }
  // Renders during the request may have queued newer code.
  const next = state.next as Pending['next'];
  if (next && next.code !== job.code) state.timer = setTimeout(() => void run(key), LIVE_FENCE_HIGHLIGHT_DELAY_MS);
  else pending.delete(key);
};

const request = (key: string, owner: string, lang: string, code: string): void => {
  const state = pending.get(key) ?? { owner, next: null, timer: null, inflight: false };
  state.next = { lang, code };
  pending.set(key, state);
  if (state.timer || state.inflight) return;
  state.timer = setTimeout(() => void run(key), LIVE_FENCE_HIGHLIGHT_DELAY_MS);
};

/**
 * Coloured HTML for the completed lines that have a result, newest first
 * valid. Requests colour for lines that have none yet.
 */
export const liveFenceLines = (key: string, owner: string, fence: OpenFence): string[] => {
  if (!fence.completed || fence.lang === 'mermaid' || lineCount(fence.completed) > LIVE_FENCE_LINE_LIMIT) return [];
  const known = highlights.get(key);
  const usable = known && known.lang === fence.lang
    && (known.code === fence.completed || fence.completed.startsWith(`${known.code}\n`));
  if (!known || known.code !== fence.completed) request(key, owner, fence.lang, fence.completed);
  return usable ? known.lines : [];
};

/**
 * The open fence as `<pre><code>` with one `.line` per source line, the same
 * shape the closed block's highlighted HTML has, so closing it only recolours.
 */
export const renderOpenFence = (fence: OpenFence, coloured: readonly string[]): string => {
  const lines = fence.completed ? fence.completed.split('\n') : [];
  const rows = lines.map((line, index) => `<span class="line">${coloured[index] ?? escapeHtml(line)}</span>`);
  rows.push(`<span class="line">${escapeHtml(fence.partial)}</span>`);
  return `<pre><code class="language-${escapeAttr(fence.lang)}">${rows.join('\n')}</code></pre>`;
};

/** For tests. */
export const resetLiveFences = (): void => {
  for (const state of pending.values()) if (state.timer) clearTimeout(state.timer);
  pending.clear();
  highlights.clear();
};
