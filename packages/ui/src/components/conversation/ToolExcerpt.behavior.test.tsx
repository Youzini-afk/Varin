import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolExcerpt } from './ToolExcerpt';
import { DisclosureContext } from './toolDisclosureContext';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));

let root: Root, container: HTMLElement, full: number, resize: () => void;
let choices: Map<string, boolean>;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: () => ({ lineHeight: '20px' }) });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ height: full } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  full = 40; choices = new Map();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = (text = 'Short source excerpt') => act(async () => root.render(
  <DisclosureContext.Provider value={choices}><ToolExcerpt id="source" text={text} /></DisclosureContext.Provider>,
));

it('shows short content directly, reacts to wrapping and preserves explicit expansion on remount', async () => {
  await render();
  expect(container.textContent).toBe('Short source excerpt');
  expect(container.querySelector('button')).toBeNull();
  // A narrower surface wraps the same content over more lines.
  full = 160;
  await act(async () => resize());
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  expect(choices.get('source')).toBe(true);
  await act(async () => root.render(null));
  await render('Retained content with more text');
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => container.querySelector('button')!.click());
  expect(choices.get('source')).toBe(false);
  expect(container.textContent).toContain('Retained content with more text');
});
