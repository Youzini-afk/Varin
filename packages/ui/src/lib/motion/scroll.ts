import { currentMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { SpringDriver, omegaSpring } from './spring';

export const SCROLL_INTENT = 'varin:viewport-scroll-intent';
export const SCROLL_SETTLED = 'varin:viewport-scroll-settled';
export const SCROLL_PAINT = 'varin:viewport-scroll-paint';
export interface ScrollIntent {
  input: 'wheel' | 'key' | 'touch' | 'pointer' | 'scrollbar';
  direction: -1 | 0 | 1;
}

const controllers = new WeakMap<HTMLElement, ScrollMotion>();
const WHEEL_SPRING = omegaSpring(32);
const PAGE_SPRING = omegaSpring(22);
const maxOffset = (node: HTMLElement) => Math.max(0, node.scrollHeight - node.clientHeight);
const clamp = (node: HTMLElement, value: number) => Math.max(0, Math.min(maxOffset(node), value));
const direction = (value: number): -1 | 0 | 1 => value < 0 ? -1 : value > 0 ? 1 : 0;

export function announceScrollIntent(viewport: HTMLElement, intent: ScrollIntent): void {
  viewport.dispatchEvent(new CustomEvent<ScrollIntent>(SCROLL_INTENT, { bubbles: true, detail: intent }));
}

/** A nested scroller owns its whole gesture, including its last movement at an edge. */
export function ownsScrollTarget(viewport: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (node.matches('textarea, input, select, canvas, iframe, [role="application"], [contenteditable]:not([contenteditable="false"]), .cm-editor, .monaco-editor, .xterm, [data-scroll-native]')) return false;
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    if (node.hasAttribute('data-conversation-tool-scroll')) return false;
    const overflow = node.ownerDocument.defaultView?.getComputedStyle?.(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return false;
  }
  return viewport.contains(target);
}

/**
 * Line/page events are discrete. Chromium's Windows mouse detents also carry
 * wheelDelta multiples of 120, independently of the user's pixel distance.
 * Continuous pixel input (including the legacy 3x pixel mapping on trackpads)
 * stays native. Ambiguous devices retain their platform's behaviour.
 */
export function isDiscreteWheel(event: WheelEvent): boolean {
  if (event.deltaMode === 1 || event.deltaMode === 2) return true;
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  return typeof legacy === 'number' && legacy !== 0 && Math.abs(legacy) % 120 === 0
    && Number.isInteger(event.deltaY) && Math.abs(legacy) !== Math.abs(event.deltaY) * 3;
}

function lineHeight(viewport: HTMLElement): number {
  const style = viewport.ownerDocument.defaultView?.getComputedStyle?.(viewport);
  return Number.parseFloat(style?.lineHeight ?? '') || (Number.parseFloat(style?.fontSize ?? '') || 16) * 1.5;
}

export function scrollKeyOffset(viewport: HTMLElement, key: string, shift = false, from = viewport.scrollTop): number | undefined {
  const line = lineHeight(viewport);
  // Keep two lines of context when paging; short panes still move forward.
  const page = Math.max(line, viewport.clientHeight - line * 2);
  switch (key) {
    case 'ArrowUp': return from - line * 2;
    case 'ArrowDown': return from + line * 2;
    case 'PageUp': return from - page;
    case 'PageDown': return from + page;
    case ' ': return from + page * (shift ? -1 : 1);
    case 'Home': return 0;
    case 'End': return maxOffset(viewport);
    default: return undefined;
  }
}

class ScrollMotion {
  private written: number | undefined;
  private sign = 0;
  private readonly spring: SpringDriver;

  constructor(readonly viewport: HTMLElement) {
    this.spring = new SpringDriver({ spring: WHEEL_SPRING, restDelta: 0.25, restSpeed: 4,
      onUpdate: value => {
        this.adoptLayoutShift();
        const next = clamp(viewport, this.spring.value);
        viewport.scrollTop = next;
        this.written = viewport.scrollTop;
        viewport.dispatchEvent(new Event(SCROLL_PAINT));
        if (next !== value && (this.spring.target < 0 || this.spring.target > maxOffset(viewport))) {
          this.spring.to(clamp(viewport, this.spring.target));
        }
      },
      onRest: () => { this.written = undefined; viewport.dispatchEvent(new Event(SCROLL_SETTLED, { bubbles: true })); },
    });
  }

  get active(): boolean { return this.spring.active; }
  get target(): number { this.adoptLayoutShift(); return this.active ? this.spring.target : this.viewport.scrollTop; }

  private adoptLayoutShift(): void {
    if (this.written === undefined) return;
    const drift = this.viewport.scrollTop - this.written;
    if (Math.abs(drift) > 1) this.spring.shift(drift);
    this.written = this.viewport.scrollTop;
  }

  stop(): void { this.spring.stop(); this.written = undefined; this.sign = 0; }

  by(delta: number, page = false): void {
    this.adoptLayoutShift();
    if (this.sign && this.sign !== Math.sign(delta)) this.stop();
    this.sign = Math.sign(delta);
    this.to(this.target + delta, page);
  }

  to(offset: number, page = true): void {
    this.adoptLayoutShift();
    const target = clamp(this.viewport, offset);
    if (this.active && (target - this.viewport.scrollTop) * this.spring.velocity < 0) this.stop();
    if (currentMotionLevel() !== 'full') {
      this.stop(); this.viewport.scrollTop = target;
      this.viewport.dispatchEvent(new Event(SCROLL_PAINT));
      this.viewport.dispatchEvent(new Event(SCROLL_SETTLED, { bubbles: true }));
      return;
    }
    if (!this.active) this.spring.sync(this.viewport.scrollTop);
    this.spring.configure(page ? PAGE_SPRING : WHEEL_SPRING);
    this.spring.to(target);
  }
}

export function stopViewportScroll(viewport: HTMLElement | null): void { if (viewport) controllers.get(viewport)?.stop(); }
export function isViewportScrolling(viewport: HTMLElement | null): boolean { return !!viewport && controllers.get(viewport)?.active === true; }
export function viewportScrollTarget(viewport: HTMLElement): number { return controllers.get(viewport)?.target ?? viewport.scrollTop; }
export function moveViewport(viewport: HTMLElement, offset: number, animated = true): void {
  const controller = controllers.get(viewport);
  if (animated && controller) controller.to(offset);
  else { controller?.stop(); viewport.scrollTop = clamp(viewport, offset); viewport.dispatchEvent(new Event(SCROLL_PAINT)); }
}

/** Install only on product reading panes; editors/terminals keep their input owners. */
export function installScrollMotion(viewport: HTMLElement): () => void {
  const controller = new ScrollMotion(viewport);
  controllers.set(viewport, controller);
  const intent = (input: ScrollIntent['input'], delta: number) => announceScrollIntent(viewport, { input, direction: direction(delta) });
  const wheel = (event: WheelEvent) => {
    if (maxOffset(viewport) <= 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || !event.deltaY || !ownsScrollTarget(viewport, event.target)) { controller.stop(); return; }
    intent('wheel', event.deltaY);
    if (!event.cancelable || currentMotionLevel() !== 'full' || !isDiscreteWheel(event)) { controller.stop(); return; }
    const delta = event.deltaY * (event.deltaMode === 1 ? lineHeight(viewport) : event.deltaMode === 2 ? viewport.clientHeight : 1);
    event.preventDefault();
    controller.by(delta);
  };
  const key = (event: KeyboardEvent) => {
    if (maxOffset(viewport) <= 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !ownsScrollTarget(viewport, event.target)
      || event.target instanceof Element && event.target.closest('button, a, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], [role="textbox"], [role="slider"], [role="spinbutton"], [role="separator"], [role="tablist"], [role="listbox"], [role="menu"], [role="tree"], [role="grid"]')) return;
    const offset = scrollKeyOffset(viewport, event.key, event.shiftKey, controller.target);
    if (offset === undefined) return;
    event.preventDefault();
    intent('key', offset - controller.target);
    if (event.key === 'Home' || event.key === 'End') controller.to(offset);
    else controller.by(offset - controller.target, true);
  };
  let touchY: number | undefined;
  const touchStart = (event: TouchEvent) => { controller.stop(); touchY = event.touches[0]?.clientY; };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && ownsScrollTarget(viewport, event.target) && y !== touchY) intent('touch', touchY - y);
    touchY = y;
  };
  const pointer = (event: PointerEvent) => {
    controller.stop();
    if (event.button === 0 && event.pointerType !== 'touch' && ownsScrollTarget(viewport, event.target)) intent('pointer', 0);
  };
  const blur = () => controller.stop();
  const visibility = () => { if (viewport.ownerDocument.hidden) controller.stop(); };
  viewport.addEventListener('wheel', wheel, { passive: false });
  viewport.addEventListener('keydown', key);
  viewport.addEventListener('touchstart', touchStart, { passive: true });
  viewport.addEventListener('touchmove', touchMove, { passive: true });
  viewport.addEventListener('pointerdown', pointer, { passive: true });
  viewport.ownerDocument.defaultView?.addEventListener('blur', blur);
  viewport.ownerDocument.addEventListener('visibilitychange', visibility);
  return () => {
    controller.stop();
    if (controllers.get(viewport) === controller) controllers.delete(viewport);
    viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('keydown', key);
    viewport.removeEventListener('touchstart', touchStart); viewport.removeEventListener('touchmove', touchMove);
    viewport.removeEventListener('pointerdown', pointer);
    viewport.ownerDocument.defaultView?.removeEventListener('blur', blur);
    viewport.ownerDocument.removeEventListener('visibilitychange', visibility);
  };
}
