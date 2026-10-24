import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SwapText, SWAP_TEXT_MIN_MS } from './SwapText';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

const shown = () => container.querySelector('.swap-text-current')!.textContent;
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

it('holds each text for at least the minimum, then shows the latest', async () => {
  await act(async () => root.render(<SwapText text="Preparing" />));
  await advance(70);
  await act(async () => root.render(<SwapText text="Running" />));
  expect(shown()).toBe('Preparing');
  await advance(SWAP_TEXT_MIN_MS - 70 - 10);
  expect(shown()).toBe('Preparing');
  await advance(20);
  expect(shown()).toBe('Running');
  // Two quick changes coalesce: only the latest is shown after the hold.
  await act(async () => root.render(<SwapText text="Searching" />));
  await advance(50);
  await act(async () => root.render(<SwapText text="Reading" />));
  await advance(SWAP_TEXT_MIN_MS);
  expect(shown()).toBe('Reading');
});

it('shows a change at once when the current text has been readable long enough', async () => {
  await act(async () => root.render(<SwapText text="Reading" live />));
  expect(container.querySelector('[data-live]')).not.toBeNull();
  await advance(SWAP_TEXT_MIN_MS + 1);
  await act(async () => root.render(<SwapText text="Read 2 files" />));
  expect(shown()).toBe('Read 2 files');
  expect(container.querySelector('[data-live]')).toBeNull();
});
