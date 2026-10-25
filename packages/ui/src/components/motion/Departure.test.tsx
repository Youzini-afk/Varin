import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Departure } from './Departure';

let root: Root;
let host: HTMLElement;
let finishAll: () => Promise<void>;
let animated: Array<{ element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }>;

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Element', window.Element); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('SVGElement', window.SVGElement);
  animated = [];
  const finishers: Array<() => void> = [];
  finishAll = async () => { finishers.splice(0).forEach(finish => finish()); for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
  const proto = window.HTMLElement.prototype;
  proto.animate = function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    animated.push({ element: this, keyframes, options });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    finishers.push(finish);
    return { finished, cancel: () => undefined } as unknown as Animation;
  } as unknown as typeof proto.animate;
  // linkedom has no layout: the host is the offset parent, and boxes are fixed.
  Object.defineProperty(proto, 'offsetParent', { configurable: true, get(this: Element) { return this.closest('[data-host]'); } });
  proto.getBoundingClientRect = function rect(this: Element) {
    const box = this.hasAttribute('data-host') ? { left: 0, top: 0 } : { left: 24, top: 120 };
    return { ...box, width: 400, height: 80, right: box.left + 400, bottom: box.top + 80, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  };
  host = document.createElement('div');
  host.setAttribute('data-host', '');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const home = (present: boolean, animatedExit = true) => <>
  <Departure present={present} animated={animatedExit} exit="rise" className="title"><h1 id="title">What shall we build?</h1></Departure>
  <Departure present={present} animated={animatedExit} exit="sink" stagger=".chips > *" className="starters">
    <div className="chips"><button type="button">One</button><button type="button">Two</button><button type="button">Three</button></div>
  </Departure>
</>;

it('removes the content at once and lets a paint-only copy leave where it was', async () => {
  await act(async () => root.render(home(true)));
  await act(async () => root.render(home(false)));
  // The real content is gone in the same commit: nothing semantic lingers.
  expect(host.querySelector('h1')).toBeNull();
  expect(host.querySelectorAll('button:not([data-departing] *)')).toHaveLength(0);
  const copies = [...host.querySelectorAll<HTMLElement>(':scope > [data-departing]')];
  expect(copies).toHaveLength(2);
  for (const copy of copies) {
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.inert).toBe(true);
    expect(copy.style.position).toBe('absolute');
    expect(copy.style.left).toBe('24px');
    expect(copy.style.top).toBe('120px');
  }
  const title = copies.find(copy => copy.classList.contains('title'))!;
  expect(title.querySelector('div')?.textContent).toBe('What shall we build?');
  expect(title.querySelector('[id]')).toBeNull();
  // The title rises as one; starters sink one after another.
  const titleExit = animated.find(entry => entry.element === title)!;
  expect(String(titleExit.keyframes[1]!.transform)).toBe('translateY(-10px)');
  const chips = animated.filter(entry => entry.element.tagName === 'BUTTON');
  expect(chips.map(entry => entry.options.delay)).toEqual([0, 20, 40]);
  expect(String(chips[0]!.keyframes[1]!.transform)).toBe('translateY(6px)');
  await finishAll();
  expect(host.querySelector('[data-departing]')).toBeNull();
});

it('leaves at once when the departure is not animated', async () => {
  await act(async () => root.render(home(true)));
  await act(async () => root.render(home(false, false)));
  expect(host.querySelector('[data-departing]')).toBeNull();
  expect(animated).toHaveLength(0);
});

it('drops a copy still leaving when the content comes back', async () => {
  await act(async () => root.render(home(true)));
  await act(async () => root.render(home(false)));
  await act(async () => root.render(home(true)));
  expect(host.querySelector('[data-departing]')).toBeNull();
  expect(host.querySelector('h1')).not.toBeNull();
});
