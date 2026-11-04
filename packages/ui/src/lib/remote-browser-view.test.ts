import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { BROWSER_SELECTION_SCRIPT, browserInspectorScripts, copyBrowserSelection, cutBrowserSelection, createBrowserResizeQueue, createBrowserTextInput, isBrowserClipboardShortcut } from './remote-browser-view';

afterEach(() => vi.unstubAllGlobals());

test('clipboard shortcuts remain local on both platforms without swallowing AltGr', () => {
  expect(isBrowserClipboardShortcut({ key: 'V', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
  expect(isBrowserClipboardShortcut({ key: 'c', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
  expect(isBrowserClipboardShortcut({ key: 'x', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
  expect(isBrowserClipboardShortcut({ key: 'X', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
  expect(isBrowserClipboardShortcut({ key: 'v', ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
});

test('copy reads the focused editable selection, including shadow roots, without copying password values', () => {
  const { document } = parseHTML('<html><body><input value="before selected after"><textarea></textarea><div></div></body></html>');
  const input = document.querySelector('input')!;
  Object.assign(input, { selectionStart: 7, selectionEnd: 15 });
  Object.defineProperty(document, 'activeElement', { configurable: true, value: input });
  Object.assign(document, { getSelection: () => 'document selection' });
  const read = () => new Function('document', `return ${BROWSER_SELECTION_SCRIPT}`)(document);
  expect(read()).toBe('selected');
  input.type = 'password'; expect(read()).toBe('');
  const host = document.querySelector('div')!, shadow = host.attachShadow({ mode: 'open' });
  const textarea = document.querySelector('textarea')!; textarea.value = 'abc中文xyz';
  Object.assign(textarea, { selectionStart: 3, selectionEnd: 5 }); shadow.appendChild(textarea);
  Object.defineProperty(shadow, 'activeElement', { value: textarea });
  Object.defineProperty(document, 'activeElement', { value: host, configurable: true });
  expect(read()).toBe('中文');
  Object.defineProperty(document, 'activeElement', { value: document.body });
  expect(read()).toBe('document selection');
});

test('starts a promised clipboard write within the copy gesture rather than waiting for the Host', async () => {
  let finish!: (text: string) => void;
  const selected = new Promise<string>(resolve => { finish = resolve; });
  class Item { constructor(readonly data: Record<string, Promise<Blob>>) {} }
  vi.stubGlobal('ClipboardItem', Item);
  const write = vi.fn(async (items: Item[]) => { expect(await (await items[0]!.data['text/plain']).text()).toBe('selected'); });
  const copying = copyBrowserSelection(() => selected, { write: write as unknown as Clipboard['write'], writeText: vi.fn() });
  expect(write).toHaveBeenCalledOnce(); finish('selected'); await copying;
});

test('serializes resize effects and keeps only the latest pending visible size', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const resize = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined), failed = vi.fn();
  const queue = createBrowserResizeQueue(resize, failed);
  queue.update(800.2, 600.2); queue.update(900, 700); queue.update(1000, 800); queue.update(1000, 800); queue.update(0, 0);
  expect(resize.mock.calls).toEqual([[800, 600]]);
  finish(); await vi.waitFor(() => expect(resize.mock.calls).toEqual([[800, 600], [1000, 800]]));
  queue.stop(); queue.update(500, 500); expect(resize).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled();
});

test('an uncertain resize failure is not replayed', async () => {
  const failed = vi.fn(), resize = vi.fn().mockRejectedValue(new Error('Disconnected'));
  const queue = createBrowserResizeQueue(resize, failed);
  queue.update(800, 600); queue.update(900, 700);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  queue.update(800, 600); expect(resize).toHaveBeenCalledOnce();
});

describe('remote IME commits', () => {
  test.each(['insertCompositionText', 'insertFromComposition', 'insertText'])('commits once with a trailing %s event and keeps subsequent identical text', inputType => {
    const send = vi.fn(), text = createBrowserTextInput(send);
    text.start(); text.input('中', 'insertCompositionText', true); text.end('中'); text.input('中', inputType, false);
    text.key(); text.input('中', 'insertText', false);
    expect(send.mock.calls).toEqual([['中'], ['中']]);
  });
  test('losing the control lease discards the old composition commit', () => {
    const send = vi.fn(), text = createBrowserTextInput(send);
    text.start(); text.reset(); text.end('old'); expect(send).not.toHaveBeenCalled();
  });
});

test('inspection cancellation fences late installation and older cancellation cannot stop a newer inspection', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  const run = (script: string) => new Function('window', 'document', `return ${script}`)(window, document);
  const first = browserInspectorScripts('viewer', 1), next = browserInspectorScripts('viewer', 2);
  run(first.cancel); expect(await run(first.start)).toBeNull();
  const pending = run(next.start); expect(document.querySelector('[id^="__varin_browser_overlay"]')).not.toBeNull();
  run(first.cancel); expect(document.querySelector('[id^="__varin_browser_overlay"]')).not.toBeNull();
  run(next.cancel); expect(await pending).toBeNull(); expect(document.querySelector('[id^="__varin_browser_overlay"]')).toBeNull();
});


test('a clipboard write rejected before capture finishes still releases the late original ticket', async () => {
  let captured!: (value: { selectionId: string; text: string }) => void;
  const selection = new Promise<{ selectionId: string; text: string }>(resolve => { captured = resolve; });
  const cut = vi.fn(), release = vi.fn().mockResolvedValue(null);
  const pending = cutBrowserSelection({ capture: () => selection, copy: async () => { throw new Error('denied'); }, valid: () => true, cut, release });
  const failed = expect(pending).rejects.toThrow('denied');
  captured({ selectionId: 'original', text: 'text' }); await failed;
  expect(cut).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith('original');
});
