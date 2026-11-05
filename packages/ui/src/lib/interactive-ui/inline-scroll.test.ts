import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { bindInlineScroll } from './inline-scroll';
it('forwards portal wheel and page keys to the original scroller while preserving local editing and nested scroll', () => {
  const { document, window } = parseHTML('<html><body><main><div id="anchor"></div></main><aside><div id="local"><p>text</p></div><input /></aside></body></html>');
  vi.stubGlobal('Element', window.Element); vi.stubGlobal('CustomEvent', window.CustomEvent); vi.stubGlobal('innerHeight', 900);
  let contain = false;
  vi.stubGlobal('getComputedStyle', (el: Element) => ({ overflowY: el.tagName === 'MAIN' || el.id === 'local' ? 'auto' : 'visible', overscrollBehaviorY: contain && el.id === 'local' ? 'contain' : 'auto' }));
  const main = document.querySelector('main')!, layer = document.querySelector('aside')!, anchor = document.getElementById('anchor')!, local = document.getElementById('local')!;
  const scrollBy = vi.fn(), scrollTo = vi.fn(), intent = vi.fn();
  Object.assign(main, { scrollBy, scrollTo, scrollHeight: 2000, clientHeight: 400 });
  Object.assign(local, { scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
  main.addEventListener('varin:conversation-scroll-intent', intent);
  const release = bindInlineScroll(layer, anchor);
  const dispatch = (target: Element, type: string, data: object) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, data); target.dispatchEvent(event); return event; };
  try {
    expect(dispatch(layer, 'wheel', { deltaY: 50, deltaX: 0, deltaMode: 0 }).defaultPrevented).toBe(true);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 50 }); expect(intent.mock.calls[0]![0].detail).toBe('toward-end');
    expect(dispatch(layer, 'keydown', { key: 'PageUp' }).defaultPrevented).toBe(true); expect(scrollBy).toHaveBeenLastCalledWith({ top: -360 });
    dispatch(layer, 'keydown', { key: 'End' }); expect(scrollTo).toHaveBeenCalledWith({ top: 2000 });
    expect(dispatch(layer.querySelector('input')!, 'keydown', { key: 'ArrowUp' }).defaultPrevented).toBe(false);
    expect(dispatch(local.querySelector('p')!, 'wheel', { deltaY: 20, deltaX: 0, deltaMode: 0 }).defaultPrevented).toBe(false);
    expect(dispatch(local.querySelector('p')!, 'wheel', { deltaY: -20, deltaX: 0, deltaMode: 0 }).defaultPrevented).toBe(true);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -20 });
    contain = true; expect(dispatch(local.querySelector('p')!, 'wheel', { deltaY: -20, deltaX: 0, deltaMode: 0 }).defaultPrevented).toBe(false);
    expect(scrollBy).toHaveBeenCalledTimes(3);
  } finally { release(); vi.unstubAllGlobals(); }
});
