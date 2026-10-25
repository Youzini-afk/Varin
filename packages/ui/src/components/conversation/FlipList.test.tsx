import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { FlipList } from './FlipList';

it('does not measure or restart slides for status-only commits; reorders add to the current glide', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let reads = 0;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    reads++;
    const top = Number(this.getAttribute('data-top') ?? 0);
    return { top, left: 0, width: 200, height: 30, bottom: top + 30, right: 200, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; options: KeyframeAnimationOptions }> = [];
  window.HTMLElement.prototype.animate = function (_frames, options) {
    const cancel = vi.fn();
    animations.push({ cancel, options: options as KeyframeAnimationOptions });
    return { cancel, finished: new Promise(() => {}) } as unknown as Animation;
  };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const list = (order: string[], status: string) => <FlipList layoutKey={order.join(',')}>
    {order.map((key, index) => <div key={key} data-flip-key={key} data-top={index * 30}>{key} {status}</div>)}
  </FlipList>;
  try {
    await act(async () => root.render(list(['a', 'b'], 'running')));
    await act(async () => root.render(list(['b', 'a'], 'running')));
    expect(animations).toHaveLength(2);
    reads = 0;
    await act(async () => root.render(list(['b', 'a'], 'completed')));
    expect(reads).toBe(0);
    expect(animations).toHaveLength(2);
    expect(animations.every(value => value.cancel.mock.calls.length === 0)).toBe(true);
    await act(async () => root.render(list(['a', 'b'], 'completed')));
    expect(animations).toHaveLength(4);
    expect(animations.every(value => value.options.composite === 'add' && !value.cancel.mock.calls.length)).toBe(true);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
