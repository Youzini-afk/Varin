import { documentMotionLevel, type MotionLevel } from '@/lib/motion/preference';

/**
 * The ink front of streamed Markdown.
 *
 * Text revealed in each frame develops from a faint secondary grey to its own
 * colour over 300ms, and a small dot sits at the end of the text while it is
 * being written. The renderer morphs the tail block on every paced step, which
 * replaces any extra nodes in it; so after each morph the live ink is wrapped
 * again with a negative animation delay that resumes it at its current age.
 * Spans older than the animation are merged back into plain text.
 *
 * Offsets are positions in the rendered text (`textContent`), so Markdown
 * syntax never counts as revealed text. Full motion shows ink and the dot;
 * reduced motion keeps a still dot; off shows neither.
 */
export const INK_MS = 300;
const MERGE_MS = 420;
const CARET_IDLE_MS = 280;
const CARET_LEAVE_MS = 160;
/** A renderer that joins a stream already showing more than this starts without ink. */
const JOIN_BASELINE_CHARS = 64;
const INK_CLASS = 'markdown-ink';
const CARET_CLASS = 'markdown-caret';
// Text inside these is rendered by something other than the text itself.
const OPAQUE = 'svg, math, .katex, button, [aria-hidden="true"]';

interface InkRun { start: number; end: number; born: number }

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const deepestLast = (node: Node): Node => {
  let current = node;
  while (current.lastChild) current = current.lastChild;
  return current;
};

/**
 * Text nodes from the end backwards. The next node is found only when the
 * caller resumes, so splitting or wrapping the current node is safe.
 */
const lastTextNodes = function* (root: HTMLElement): Generator<Text> {
  let node: Node | null = root.lastChild ? deepestLast(root) : null;
  while (node && node !== root) {
    if (node.nodeType === 3) yield node as Text;
    node = node.previousSibling ? deepestLast(node.previousSibling) : node.parentNode === root ? null : node.parentNode;
  }
};

/** `Text.splitText` without relying on it (some DOM shims lack it). */
const split = (node: Text, offset: number): Text => {
  const rest = node.ownerDocument.createTextNode(node.data.slice(offset));
  node.data = node.data.slice(0, offset);
  node.after(rest);
  return rest;
};

/** Merge adjacent text children back together, as `normalize()` would. */
const mergeText = (parent: Node): void => {
  let child = parent.firstChild;
  while (child) {
    const next: ChildNode | null = child.nextSibling;
    if (child.nodeType === 3 && next?.nodeType === 3) {
      (child as Text).data += (next as Text).data;
      next.remove();
      continue;
    }
    child = next;
  }
};

const isOpaque = (node: Text, root: HTMLElement): boolean => {
  const parent = node.parentElement;
  const opaque = parent?.closest(OPAQUE);
  return Boolean(opaque && root.contains(opaque));
};

export class MarkdownInk {
  private length: number | null = null;
  private runs: InkRun[] = [];
  private readonly spans = new Set<HTMLElement>();
  private caret: HTMLElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** True once this renderer has shown streamed text; history never engages. */
  get engaged(): boolean {
    return this.length !== null;
  }

  /**
   * Call right before the renderer morphs `target`. Morphing must never see
   * these nodes: it would reuse an ink span or the dot as a content element.
   */
  prepare(): void {
    this.unwrap();
    this.caret?.remove();
  }

  /** Call after every morph of `target`; `revealing` is the paced reveal state. */
  update(target: HTMLElement, revealing: boolean, level: MotionLevel = documentMotionLevel()): void {
    if (level === 'off') {
      this.clear();
      return;
    }
    const now = clock();
    this.unwrap();
    const length = target.textContent?.length ?? 0;
    if (this.length === null) this.length = revealing && length <= JOIN_BASELINE_CHARS ? 0 : length;
    const grew = length > this.length;
    if (grew) this.runs.push({ start: this.length, end: length, born: now });
    else if (length < this.length) {
      this.runs = this.runs.map(run => ({ ...run, end: Math.min(run.end, length) })).filter(run => run.start < run.end);
    }
    this.length = length;
    this.runs = this.runs.filter(run => now - run.born < INK_MS);
    if (level === 'full' && this.runs.length) this.wrap(target, length, now);
    this.placeCaret(target, revealing, level, grew);
    this.scheduleMerge();
  }

  /** Remove every node this instance added and forget its state. */
  clear(): void {
    this.unwrap();
    this.runs = [];
    this.caret?.remove();
    this.caret = null;
    for (const timer of [this.idleTimer, this.mergeTimer, this.leaveTimer]) if (timer) clearTimeout(timer);
    this.idleTimer = this.mergeTimer = this.leaveTimer = null;
  }

  dispose(): void {
    this.clear();
    this.length = null;
  }

  private wrap(target: HTMLElement, length: number, now: number): void {
    const oldest = Math.min(...this.runs.map(run => run.start));
    let end = length;
    for (const node of lastTextNodes(target)) {
      const start = end - node.length;
      if (end <= oldest) break;
      const nodeEnd = end;
      end = start;
      if (!node.length || isOpaque(node, target)) continue;
      // Rightmost first, so earlier offsets in the same node stay valid.
      const pieces = this.runs
        .map(run => ({ from: Math.max(run.start, start) - start, to: Math.min(run.end, nodeEnd) - start, age: now - run.born }))
        .filter(piece => piece.from < piece.to)
        .sort((left, right) => right.from - left.from);
      // `split` keeps the left part in `text`, so it stays the node to cut next.
      const text = node;
      for (const piece of pieces) {
        if (piece.to < text.length) split(text, piece.to);
        const inked = piece.from > 0 ? split(text, piece.from) : text;
        const span = target.ownerDocument.createElement('span');
        span.className = INK_CLASS;
        span.style.animationDelay = `${-Math.round(piece.age)}ms`;
        inked.replaceWith(span);
        span.append(inked);
        this.spans.add(span);
        if (inked === text) break;
      }
    }
  }

  private unwrap(): void {
    const parents = new Set<Node>();
    for (const span of this.spans) {
      const parent = span.parentNode;
      if (parent) {
        span.replaceWith(...span.childNodes);
        parents.add(parent);
      }
    }
    this.spans.clear();
    for (const parent of parents) mergeText(parent);
  }

  private placeCaret(target: HTMLElement, revealing: boolean, level: MotionLevel, grew: boolean): void {
    if (!revealing && !this.caret) return;
    let last: Text | null = null;
    for (const node of lastTextNodes(target)) {
      // After trailing whitespace the dot would open a line of its own (in code,
      // after the newline being written) and that line would vanish with it.
      if (node.data.trim() && !isOpaque(node, target)) { last = node; break; }
    }
    if (!last) return;
    const caret = this.caret ?? target.ownerDocument.createElement('span');
    if (!this.caret) {
      caret.className = CARET_CLASS;
      caret.setAttribute('aria-hidden', 'true');
      this.caret = caret;
    }
    const anchor = last.parentElement?.classList.contains(INK_CLASS) ? last.parentElement : last;
    if (anchor.nextSibling !== caret) anchor.after(caret);
    if (!revealing) {
      // The reply is complete: the dot shrinks away instead of vanishing.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      caret.dataset.state = 'leaving';
      this.leaveTimer ??= setTimeout(() => {
        this.leaveTimer = null;
        this.caret?.remove();
        this.caret = null;
      }, CARET_LEAVE_MS);
      return;
    }
    if (!grew && caret.dataset.state === 'waiting') return;
    caret.dataset.state = 'writing';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Waiting longer than a beat: the dot starts to breathe.
    this.idleTimer = level === 'full'
      ? setTimeout(() => { this.idleTimer = null; if (this.caret) this.caret.dataset.state = 'waiting'; }, CARET_IDLE_MS)
      : null;
  }

  private scheduleMerge(): void {
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = this.spans.size ? setTimeout(() => {
      this.mergeTimer = null;
      this.unwrap();
    }, MERGE_MS) : null;
  }
}
