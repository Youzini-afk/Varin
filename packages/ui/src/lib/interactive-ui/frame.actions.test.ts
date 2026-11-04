import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { uiFrameDocument } from './frame';

/** Execute the exact generated frame program; only browser scheduling/layout are simulated. */
function frame() {
  const { window, document } = parseHTML(uiFrameDocument('actions-test', true, true));
  const posted = vi.fn(), parent = { postMessage: posted };
  const frames = new Map<number, () => void>(); let sequence = 0;
  const frameWindow = { fetch: vi.fn(), addEventListener: window.addEventListener.bind(window) };
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), addEventListener() {} } });
  const sandbox = { window: frameWindow, document, parent, Node: window.Node, Element: window.Element, DOMParser: window.DOMParser,
    scrollX: 0, scrollY: 0, innerWidth: 640, innerHeight: 480, CSS: { escape: (value: string) => value },
    scrollTo: vi.fn(), queueMicrotask,
    addEventListener: window.addEventListener.bind(window),
    getComputedStyle: (element: HTMLElement) => ({ paddingTop: '0px', paddingBottom: '0px', visibility: 'visible', overflowY: element.style.overflowY, overscrollBehaviorY: element.style.overscrollBehaviorY }),
    requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} } };
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 120, width: 640, height: 120 }) });
  vm.runInNewContext(document.querySelector('script')!.textContent!, sandbox);
  const api = (frameWindow as unknown as { varinUI: {
    compose(input: { text: string; includeContext?: boolean }): Promise<unknown>;
    requestActions(actions: unknown): Promise<unknown>;
    setContext(value: unknown): void;
  } }).varinUI;
  const deliver = (data: object, source: unknown = parent, channel = 'actions-test') => {
    const event = new window.Event('message'); Object.assign(event, { source, data: { channel, ...data } }); window.dispatchEvent(event);
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const flush = async () => { const scheduled = [...frames.values()]; frames.clear(); scheduled.forEach(callback => callback()); await tick(); };
  const update = async (committed = true, html = '<label>Budget<input id="budget" value="35"></label>', source: unknown = parent, channel = 'actions-test') => {
    deliver({ type: 'update', files: { 'index.html': `<!doctype html><html><head></head><body>${html}</body></html>` }, entry: 'index.html', committed, source: { ref: 'ui:budget@1' } }, source, channel);
    await tick();
  };
  const messages = (type: string) => posted.mock.calls.map(([message]) => message).filter(message => message.type === type);
  return { api, window, document, posted, parent, deliver, tick, flush, update, messages };
}

it('permits startup host-action registration while loading but composes only ready content with its exact snapshot', async () => {
  const h = frame();
  await expect(h.api.compose({ text: 'Before' })).rejects.toThrow('not ready');
  await expect(h.api.requestActions([])).rejects.toThrow('not ready');
  await h.update(); // The committed scripts have installed; restore is waiting for animation frame.
  const actions = [{ key: 'continue', type: 'send', label: 'Send', text: 'Budget: 35' }];
  const registration = h.api.requestActions(actions);
  expect(h.messages('host-actions').at(-1)).toMatchObject({ actions, render: { state: 'loading' }, ready: false });
  await expect(h.api.compose({ text: 'Too early' })).rejects.toThrow('not ready');
  h.deliver({ type: 'action-result', id: h.messages('host-actions')[0].id, result: { status: 'presented' } });
  await expect(registration).resolves.toEqual({ status: 'presented' });
  await h.flush();
  h.api.setContext({ budget: 35 });
  const composed = h.api.compose({ text: 'Discuss budget', includeContext: true });
  const request = h.messages('compose')[0];
  expect(request).toMatchObject({ text: 'Discuss budget', includeContext: true, source: { ref: 'ui:budget@1' }, context: { budget: 35 },
    state: { controls: { '#budget': '35' } }, ready: true, render: { state: 'ready' } });
  h.deliver({ type: 'action-result', id: request.id, result: { status: 'filled', updated: false } });
  await expect(composed).resolves.toEqual({ status: 'filled', updated: false });
  expect(h.messages('send')).toEqual([]);
  expect(Object.keys(h.api).sort()).toEqual(['compose', 'requestActions', 'saveState', 'setContext', 'state'].sort());
});

it('ignores foreign-window and wrong-channel updates and action receipts', async () => {
  const h = frame();
  await h.update(true, '<p>Forged</p>', {});
  await h.update(true, '<p>Wrong channel</p>', h.parent, 'other');
  expect(h.document.getElementById('work')!.textContent).toBe('');
  await h.update(); await h.flush();
  const composed = h.api.compose({ text: 'Actual' });
  const request = h.messages('compose')[0]; let resolved = false;
  void composed.then(() => { resolved = true; });
  h.deliver({ type: 'action-result', id: request.id, result: { status: 'filled' } }, {});
  h.deliver({ type: 'action-result', id: request.id, result: { status: 'filled' } }, h.parent, 'other');
  h.deliver({ type: 'action-result', id: 'unknown', result: { status: 'filled' } });
  await h.tick(); expect(resolved).toBe(false);
  h.deliver({ type: 'action-result', id: request.id, result: { status: 'filled' } });
  await composed; expect(resolved).toBe(true);
});

it('revokes readiness when replacing committed content with a preview and strips executable preview markup', async () => {
  const h = frame(); await h.update(); await h.flush();
  await h.update(false, '<button onclick="doSomething()">Preview</button><a href="javascript:doSomething()">link</a><iframe src="https://example.org"></iframe><script>doSomething()</script>');
  expect(h.document.getElementById('work')!.querySelector('script,iframe,[onclick],[href^="javascript:"]')).toBeNull();
  await expect(h.api.compose({ text: 'Preview' })).rejects.toThrow('not ready');
  await expect(h.api.requestActions([{ type: 'send', text: 'Preview' }])).rejects.toThrow('not ready');
  expect(h.messages('compose')).toEqual([]);
});

it('delivers matching action failures and closes pending requests without replaying them', async () => {
  const h = frame(); await h.update(); await h.flush();
  const failure = h.api.compose({ text: 'First' });
  const failed = expect(failure).rejects.toThrow('snapshot unavailable');
  h.deliver({ type: 'action-error', id: h.messages('compose')[0].id, error: 'snapshot unavailable' }); await failed;
  const pending = h.api.compose({ text: 'Second' }); const closed = expect(pending).rejects.toThrow('Content closed');
  h.window.dispatchEvent(new h.window.Event('pagehide')); await closed;
  expect(h.messages('compose').map(message => message.text)).toEqual(['First', 'Second']);
});

it('forwards anchored keyboard reading to the Host but preserves editing and nested scroll owners', async () => {
  const h = frame(); await h.update(true, '<p id="prose">Reading</p><input id="editing"><div id="local" style="overflow-y:auto"><p id="inside">Local reading</p></div>'); await h.flush();
  const key = (id: string, value: string, options: object = {}) => {
    const event = new h.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: value, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...options });
    h.document.getElementById(id)!.dispatchEvent(event); return event;
  };
  expect(key('prose', 'PageDown').defaultPrevented).toBe(true);
  expect(h.messages('scroll-intent').at(-1)).toMatchObject({ intent: 'toward-end', key: 'PageDown', shiftKey: false });
  expect(key('prose', ' ', { shiftKey: true }).defaultPrevented).toBe(true);
  expect(h.messages('scroll-intent').at(-1)).toMatchObject({ intent: 'away-from-end', key: ' ', shiftKey: true });
  const count = h.messages('scroll-intent').length;
  expect(key('editing', 'ArrowDown').defaultPrevented).toBe(false);
  expect(key('prose', 'Home', { ctrlKey: true }).defaultPrevented).toBe(false);
  const local = h.document.getElementById('local')!;
  Object.defineProperties(local, { scrollHeight: { value: 500 }, clientHeight: { value: 100 }, scrollTop: { value: 50, writable: true } });
  expect(key('inside', 'ArrowDown').defaultPrevented).toBe(false);
  expect(h.messages('scroll-intent')).toHaveLength(count);
  local.scrollTop = 400;
  expect(key('inside', 'ArrowDown').defaultPrevented).toBe(true);
  expect(h.messages('scroll-intent').at(-1)).toMatchObject({ key: 'ArrowDown' });
  local.style.overscrollBehaviorY = 'contain';
  expect(key('inside', 'End').defaultPrevented).toBe(false);
  h.document.documentElement.dataset.anchored = 'false';
  expect(key('prose', 'PageDown').defaultPrevented).toBe(false);
});
