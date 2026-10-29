/** Preserve the actual reading line inside a long virtual row, not only its row top. */
export class ChatReadingAnchor {
  private element: Element | null = null;
  private range: Range | null = null;
  private offset = 0;

  constructor(private readonly viewport: HTMLElement) {}

  clear(): void { this.element = null; this.range = null; }

  pin(element: Element): void {
    this.element = element;
    this.range = null;
    this.offset = element.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top;
  }

  capture(): void {
    this.clear();
    const viewport = this.viewport;
    const bounds = viewport.getBoundingClientRect();
    const doc = viewport.ownerDocument;
    // Sample a readable line near the top, below the sticky turn label.
    const x = bounds.left + bounds.width * 0.5;
    const y = bounds.top + Math.min(80, bounds.height * 0.2);
    const hit = doc.elementFromPoint?.(x, y);
    if (!hit || !viewport.contains(hit) || hit.closest('[data-conversation-tool-scroll]')) return;
    const caretDoc = doc as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const caret = caretDoc.caretPositionFromPoint?.(x, y);
    const range = caret ? doc.createRange() : caretDoc.caretRangeFromPoint?.(x, y);
    if (range && caret) range.setStart(caret.offsetNode, caret.offset);
    if (range?.startContainer.nodeType === 3 && viewport.contains(range.startContainer)) {
      const length = range.startContainer.textContent?.length ?? 0;
      if (length) {
        const start = Math.min(range.startOffset, length - 1);
        range.setStart(range.startContainer, start);
        range.setEnd(range.startContainer, start + 1);
        this.range = range;
        this.element = range.startContainer.parentElement;
        this.offset = range.getBoundingClientRect().top - bounds.top;
        return;
      }
    }
    this.pin(hit.closest('p, li, pre, blockquote, tr, h1, h2, h3, h4, [data-turn-entry]') ?? hit);
  }

  restore(): void {
    if (!this.element?.isConnected || !this.viewport.contains(this.element)) { this.clear(); return; }
    // A removed text node invalidates its live Range; never anchor the parent at offset zero.
    if (this.range && (this.range.startContainer.nodeType !== 3 || !this.element.contains(this.range.startContainer))) { this.clear(); return; }
    const box = this.range ? this.range.getBoundingClientRect() : this.element.getBoundingClientRect();
    if (!box.height) return;
    const delta = box.top - this.viewport.getBoundingClientRect().top - this.offset;
    if (Math.abs(delta) > 0.5) this.viewport.scrollTop += delta;
  }
}
