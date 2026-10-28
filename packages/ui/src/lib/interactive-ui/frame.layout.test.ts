import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { uiFrameDocument } from './frame';

it('waits for work before measuring and coalesces live growth, shrink and font reflow without echoing unchanged sizes', async () => {
  const { window, document } = parseHTML(uiFrameDocument('layout-test', true));
  const posted = vi.fn(), parent = { postMessage: posted };
  const frames = new Map<number, () => void>(); let frameId = 0;
  let height = 0, width = 640;
  const work = document.getElementById('work')!;
  Object.assign(work, { getBoundingClientRect: () => ({ height, width }) });
  Object.defineProperty(work, 'scrollHeight', { get: () => height });
  Object.assign(window, { fetch: vi.fn() });
  const observers: (() => void)[] = [];
  const fontEvents = new window.EventTarget();
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), addEventListener: fontEvents.addEventListener.bind(fontEvents) } });
  const sandbox = {
    window, document, parent, Node: window.Node, Element: window.Element, DOMParser: window.DOMParser,
    addEventListener: window.addEventListener.bind(window),
    getComputedStyle: () => ({ paddingTop: '0px', paddingBottom: '0px' }),
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} },
    MutationObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} },
  };
  const flushFrame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const remeasure = () => { observers.forEach(callback => callback()); window.dispatchEvent(new window.Event('resize')); };
  const sizes = () => posted.mock.calls.map(([message]) => message).filter(message => message.type === 'resize');
  const update = async (html: string) => {
    const event = new window.Event('message');
    Object.assign(event, { source: parent, data: { channel: 'layout-test', type: 'update', files: { 'index.html': `<!doctype html><html><head></head><body>${html}</body></html>` }, entry: 'index.html', committed: false, source: {} } });
    window.dispatchEvent(event);
    await new Promise(resolve => setImmediate(resolve));
  };
  vm.runInNewContext(document.querySelector('script')!.textContent!, sandbox);
  await Promise.resolve();
  remeasure(); flushFrame();
  expect(sizes()).toEqual([]); // The iframe's empty shell must not erase its retained outer height.

  await update('<p>报告正在生成</p>');
  height = 240.25; remeasure();
  height = 480.5; remeasure(); flushFrame();
  expect(work.textContent).toBe('报告正在生成');
  expect(sizes()).toEqual([{ channel: 'layout-test', type: 'resize', height: 481, width: 640 }]);
  remeasure(); flushFrame();
  expect(sizes()).toHaveLength(1);

  width = 400; height = 720.5;
  fontEvents.dispatchEvent(new window.Event('loadingdone')); remeasure(); flushFrame();
  expect(sizes().at(-1)).toMatchObject({ height: 721, width: 400 });
  height = 100;
  await update('<p>更短的修订</p>'); flushFrame();
  expect(sizes().at(-1)).toMatchObject({ height: 100, width: 400 });

  height = 0;
  await update(''); flushFrame();
  expect(work.textContent).toBe('');
  expect(sizes().at(-1)).toMatchObject({ height: 0, width: 400 });
  expect(posted.mock.calls.map(([message]) => message).filter(message => message.type === 'error')).toEqual([]);
});
