import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));

const dom = parseHTML('<html><body></body></html>');
// Linkedom dispatches input events but omits this feature-detection property.
dom.document.oninput = null;
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.document);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
// React's input-event support is detected when the renderer loads.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { NumberInput } = await import('./number-input');
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
let commits: number[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  commits = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => vi.unstubAllGlobals());

const render = async (value: number, props: Partial<React.ComponentProps<typeof NumberInput>> = {}) => {
  await act(async () => root.render(<I18nProvider><NumberInput
    min={0} max={200} step={5} {...props} value={value} onValueChange={next => commits.push(next)}
  /></I18nProvider>));
};
const button = (direction: 'Increase' | 'Decrease') => {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${direction} value"]`);
  if (!element) throw new Error(`Missing ${direction} button`);
  return element;
};
const type = async (value: string) => {
  const input = container.querySelector('input')!;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
};
const blur = async () => {
  await act(async () => container.querySelector('input')!.dispatchEvent(new dom.window.Event('focusout', { bubbles: true })));
};

it('accumulates rapid steps before the parent renders, then accepts an external value change', async () => {
  await render(100);
  await act(async () => {
    button('Decrease').click();
    button('Increase').click();
    button('Increase').click();
  });
  expect(commits).toEqual([95, 100, 105]);
  await render(140);
  await act(async () => button('Decrease').click());
  expect(commits.at(-1)).toBe(135);
});

it.each([
  { typed: '110', committed: 110, next: 115 },
  { typed: '20', committed: 50, next: 55 },
])('uses the committed typed value $typed for the next step without a duplicate blur commit', async ({ typed, committed, next }) => {
  await render(100, { min: 50 });
  await type(typed);
  expect(commits).toEqual([committed]);
  await render(committed, { min: 50 });
  await blur();
  await act(async () => button('Increase').click());
  expect(commits).toEqual([committed, next]);
});

it('disables steps at the bounds', async () => {
  await render(50, { min: 50 });
  expect(button('Decrease').disabled).toBe(true);
  await act(async () => button('Decrease').click());
  expect(commits).toEqual([]);
  await render(200, { min: 50 });
  expect(button('Increase').disabled).toBe(true);
});

it('preserves typed precision when step only controls the buttons', async () => {
  const props = { max: 1, step: 0.01, preserveTypedPrecision: true };
  await render(0.68, props);
  await type('0.6789');
  expect(commits).toEqual([0.6789]);
  await render(0.6789, props);
  await blur();
  expect(commits).toEqual([0.6789]);
  await act(async () => button('Increase').click());
  expect(commits.at(-1)).toBeCloseTo(0.6889, 10);
});
