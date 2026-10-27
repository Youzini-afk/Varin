import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { uiFrameDocument } from './frame';

it('sends explicit state immediately and resolves only the matching Host persistence acknowledgement', async () => {
  const { window, document } = parseHTML(uiFrameDocument('state-test'));
  const posted = vi.fn(), parent = { postMessage: posted };
  Object.assign(window, { fetch: vi.fn() });
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), addEventListener() {} } });
  const frames = new Map<number, () => void>(); let frameId = 0;
  const sandbox = { window, document, parent, scrollX: 0, scrollY: 0,
    addEventListener: window.addEventListener.bind(window),
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} } };
  vm.runInNewContext(document.querySelector('script')!.textContent!, sandbox);
  const api = (window as unknown as { varinUI: { state: unknown; saveState(value: unknown): Promise<void> } }).varinUI;
  const deliver = (type: string, id: string, extra: object = {}, source = parent, channel = 'state-test') => {
    const event = new window.Event('message'); Object.assign(event, { source, data: { channel, type, id, ...extra } }); window.dispatchEvent(event);
  };
  const saved = api.saveState({ selected: 'A' });
  expect(api.state).toEqual({ selected: 'A' });
  const request = posted.mock.calls.at(-1)![0];
  expect(request).toMatchObject({ channel: 'state-test', type: 'state', state: { data: { selected: 'A' } } });
  let completed = false; void saved.then(() => { completed = true; });
  deliver('state-saved', request.id, {}, { postMessage: posted });
  deliver('state-saved', request.id, {}, parent, 'different-frame');
  await Promise.resolve(); expect(completed).toBe(false);
  deliver('state-saved', request.id);
  await saved; expect(completed).toBe(true);
  const failed = api.saveState({ selected: 'B' });
  const failure = expect(failed).rejects.toThrow('disk unavailable');
  deliver('state-save-error', posted.mock.calls.at(-1)![0].id, { error: 'disk unavailable' });
  await failure;
});
