import { CHAT_TIMELINE_SCROLL_INTENT_EVENT } from '@/components/conversation/chatTimelineScrollState';
/** Portal views scroll their original conversation owner, not document.body. */
export function bindInlineScroll(layer: HTMLElement, anchor: HTMLElement) {
  const scroll = (target: EventTarget | null, delta: number, key?: string) => {
    if (!Number.isFinite(delta) || !delta) return false;
    for (let local = target instanceof Element ? target : null; local && local !== layer; local = local.parentElement) {
      if (local.matches('canvas,[role="application"],input[type="range"]')) return false;
      const style = getComputedStyle(local);
      if (/(auto|scroll)/.test(style.overflowY) && local.scrollHeight > local.clientHeight
        && ((delta < 0 ? local.scrollTop > 0 : local.scrollTop + local.clientHeight < local.scrollHeight)
          || style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none')) return false;
    }
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
      anchor.dispatchEvent(new CustomEvent(CHAT_TIMELINE_SCROLL_INTENT_EVENT, { bubbles: true, detail: delta < 0 ? 'away-from-end' : 'toward-end' }));
      if (key === 'Home' || key === 'End') parent.scrollTo({ top: key === 'Home' ? 0 : parent.scrollHeight });
      else parent.scrollBy({ top: key === 'PageUp' || key === 'PageDown' || key === ' ' ? Math.sign(delta) * parent.clientHeight * 0.9 : delta });
      return true;
    }
    return false;
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.defaultPrevented || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (scroll(event.target, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1))) event.preventDefault();
  };
  const keyboard = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target?.closest('input,textarea,select,button,a,[contenteditable="true"],[role="tab"],[role="application"]')) return;
    const direction = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey ? -1 : ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 1 : 0;
    if (direction && scroll(event.target, direction * 40, event.key)) event.preventDefault();
  };
  let touch: { x: number; y: number } | undefined;
  const start = (event: TouchEvent) => { const point = event.touches.length === 1 ? event.touches[0] : undefined; touch = point ? { x: point.clientX, y: point.clientY } : undefined; };
  const move = (event: TouchEvent) => {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!point || !touch) return;
    const delta = touch.y - point.clientY, horizontal = Math.abs(touch.x - point.clientX); touch = { x: point.clientX, y: point.clientY };
    if (!event.defaultPrevented && Math.abs(delta) >= horizontal && scroll(event.target, delta)) event.preventDefault();
  };
  layer.addEventListener('wheel', wheel, { passive: false }); layer.addEventListener('keydown', keyboard);
  layer.addEventListener('touchstart', start, { passive: true }); layer.addEventListener('touchmove', move, { passive: false });
  return () => { layer.removeEventListener('wheel', wheel); layer.removeEventListener('keydown', keyboard); layer.removeEventListener('touchstart', start); layer.removeEventListener('touchmove', move); };
}
