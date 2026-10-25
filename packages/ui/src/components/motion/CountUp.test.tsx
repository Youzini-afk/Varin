import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CountUp } from './CountUp';

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

const format = (value: number) => String(value);

it('rolls from zero to its value when it arrives with motion', async () => {
  await act(async () => root.render(<CountUp value={1200} animate format={format} />));
  expect(container.textContent).toBe('0');
  await act(async () => { vi.advanceTimersByTime(160); });
  const middle = Number(container.textContent);
  expect(middle).toBeGreaterThan(0);
  expect(middle).toBeLessThan(1200);
  await act(async () => { vi.advanceTimersByTime(700); });
  expect(container.textContent).toBe('1200');
});

it('shows history and reduced motion directly', async () => {
  await act(async () => root.render(<CountUp value={42} animate={false} format={format} />));
  expect(container.textContent).toBe('42');
  document.documentElement.dataset.motion = 'reduced';
  await act(async () => root.render(<CountUp value={84} animate format={format} />));
  expect(container.textContent).toBe('84');
  delete document.documentElement.dataset.motion;
});
