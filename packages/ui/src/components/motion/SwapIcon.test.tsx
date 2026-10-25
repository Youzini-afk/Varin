import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SwapIcon } from './SwapIcon';

let root: Root;
let container: HTMLElement;
let finishAll: () => Promise<void>;
let animated: Array<{ element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }>;

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Element', window.Element); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('SVGElement', window.SVGElement);
  animated = [];
  const finishers: Array<() => void> = [];
  finishAll = async () => { finishers.splice(0).forEach(finish => finish()); await Promise.resolve(); await Promise.resolve(); };
  window.HTMLElement.prototype.animate = function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    animated.push({ element: this, keyframes, options });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    finishers.push(finish);
    return { finished, cancel: () => undefined } as unknown as Animation;
  } as unknown as typeof HTMLElement.prototype.animate;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const icon = (name: string) => <SwapIcon swapKey={name} enter={name === 'stop' ? 'settle' : 'glide'}><i data-icon={name} /></SwapIcon>;

it('lets the previous icon leave in the same cell while the next one lands', async () => {
  await act(async () => root.render(icon('arrow-up')));
  expect(animated).toHaveLength(0);
  await act(async () => root.render(icon('stop')));
  const leaving = container.querySelector('[data-swap-leaving]');
  expect(leaving?.getAttribute('aria-hidden')).toBe('true');
  expect(leaving?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('arrow-up');
  expect(container.querySelector('.swap-icon-current [data-icon]')?.getAttribute('data-icon')).toBe('stop');
  // The arrow rises out; Stop drops in with the settle spring.
  expect(String(animated[0]!.keyframes[1]!.transform)).toContain('translateY(-');
  expect(animated[1]!.element.className).toBe('swap-icon-current');
  expect(String(animated[1]!.keyframes[0]!.transform)).toContain('scale(.6)');
  await finishAll();
  expect(container.querySelector('[data-swap-leaving]')).toBeNull();
});

it('swaps directly when motion is off', async () => {
  document.documentElement.dataset.motion = 'off';
  await act(async () => root.render(icon('arrow-up')));
  await act(async () => root.render(icon('stop')));
  expect(container.querySelector('[data-swap-leaving]')).toBeNull();
  expect(animated).toHaveLength(0);
});
