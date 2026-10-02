import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { QueuedUserMessage } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { PiMessageQueue, type QueueUpdate } from './PiMessageQueue';

const first: QueuedUserMessage = { id: 'first', revision: 1, mode: 'followUp', text: 'same text', imageCount: 2 };
const second: QueuedUserMessage = { ...first, id: 'second', imageCount: 0 };
let container: HTMLDivElement;
let root: Root;
const update = vi.fn(async (_change: QueueUpdate) => ({ accepted: true, status: 'updated' as 'updated' | 'missing' | 'conflict' }));
const clear = vi.fn(async () => {});
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  update.mockClear(); clear.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (messages = [first, second], working = true, key = 'runtime:session') => act(async () => root.render(
  <I18nProvider><PiMessageQueue key={key} messages={messages} working={working} onUpdate={update} onClear={clear} /></I18nProvider>,
));
const row = (id: string) => container.querySelector(`[data-pi-queued-message="${id}"]`)!;
const click = async (parent: Element, label: string) => act(async () => {
  const button = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
  expect(button).toBeDefined(); button.click();
});

test('sends and removes the selected identity while leaving queue ownership to Pi', async () => {
  await render();
  await click(row('second'), 'Send now');
  expect(update).toHaveBeenLastCalledWith({ id: 'second', revision: 1, action: 'steer' });
  expect(container.querySelectorAll('[data-pi-queued-message]').length).toBe(2);
  await click(row('first'), 'Remove from queue');
  expect(update).toHaveBeenLastCalledWith({ id: 'first', revision: 1, action: 'remove' });
  await click(container, 'Clear all');
  expect(clear).toHaveBeenCalledTimes(1);
});

test('edits in place and preserves image attachments', async () => {
  await render();
  await click(row('first'), 'edit');
  const input = container.querySelector('textarea')!;
  expect(input.value).toBe('same text');
  await act(async () => {
    input.value = 'edited in place';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(container.textContent).toContain('2 image(s) will be kept.');
  await click(container, 'Save Changes');
  expect(update).toHaveBeenCalledWith({ id: 'first', revision: 1, action: 'edit', text: 'edited in place' });
  expect(container.querySelector('textarea')).toBeNull();
});

test('keeps an edit visible when the queued message is consumed and discards it only on explicit close or navigation', async () => {
  await render();
  await click(row('first'), 'edit');
  await render([]);
  expect(container.querySelector('textarea')?.value).toBe('same text');
  expect(container.textContent).toContain('Your edited text remains here to copy.');
  const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save Changes')!;
  expect(save.disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
  await render([], false, 'other-runtime:session');
  expect(container.querySelector('textarea')).toBeNull();
});

test('supplemental messages wait for the native boundary and can resume when idle', async () => {
  await render([{ ...first, mode: 'steer' }]);
  expect(container.textContent).toContain('Adding to current task');
  expect(container.textContent).not.toContain('Send now');
  await render([{ ...first, mode: 'steer' }], false);
  await click(row('first'), 'Send now');
  expect(update).toHaveBeenCalledWith({ id: 'first', revision: 1, action: 'steer' });
});
