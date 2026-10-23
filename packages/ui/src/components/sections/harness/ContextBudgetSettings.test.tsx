import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ContextBudgetSettings } from './ContextBudgetSettings';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: object) => key + (values ? JSON.stringify(values) : '') }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
let root: Root, container: HTMLElement;
const reserve = vi.fn(), prepare = vi.fn();
const props = () => ({ reserveRatio: .1, preparationWaterline: .75, backgroundPreparation: true, onReserveRatioChange: reserve, onPreparationWaterlineChange: prepare });
beforeEach(async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000 } as DOMRect);
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  reserve.mockReset(); prepare.mockReset();
  await act(async () => root.render(<ContextBudgetSettings {...props()} />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const slider = (kind: 'prepare' | 'replace') => container.querySelector<HTMLElement>(`[aria-label="settings.contextScale.${kind}"]`)!;
async function event(target: HTMLElement, type: string, values: object) {
  const event = new window.Event(type, { bubbles: true }); Object.assign(event, values);
  await act(async () => target.dispatchEvent(event));
}
test('previews both boundaries on the full window and commits only the released setting', async () => {
  expect(slider('prepare').getAttribute('aria-valuetext')).toContain('"position":67.5');
  await event(slider('replace'), 'pointerdown', { button: 0, pointerId: 1, clientX: 900 });
  await event(slider('replace'), 'pointermove', { pointerId: 1, clientX: 800 });
  expect(slider('prepare').getAttribute('aria-valuetext')).toContain('"position":60');
  expect(reserve).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  await event(slider('replace'), 'pointerup', { pointerId: 1 });
  expect(reserve).toHaveBeenCalledOnce(); expect(reserve.mock.calls[0]![0]).toBeCloseTo(.2);
  expect(prepare).not.toHaveBeenCalled();
});
test('Escape and pointer cancellation restore the acknowledged values without saving', async () => {
  for (const cancel of ['keydown', 'pointercancel']) {
    await event(slider('prepare'), 'pointerdown', { button: 0, pointerId: 1, clientX: 675 });
    await event(slider('prepare'), 'pointermove', { pointerId: 1, clientX: 720 });
    expect(slider('prepare').getAttribute('aria-valuenow')).toBe('80');
    await event(slider('prepare'), cancel, { key: 'Escape', pointerId: 1 });
    expect(slider('prepare').getAttribute('aria-valuenow')).toBe('75');
  }
  expect(prepare).not.toHaveBeenCalled();
  await event(slider('prepare'), 'keydown', { key: 'ArrowRight', shiftKey: true });
  expect(prepare).toHaveBeenCalledWith(.751);
});
test('typed replacement percentage maps to reserve, and invalid preparation stays local', async () => {
  vi.useFakeTimers();
  const replacement = container.querySelector<HTMLInputElement>('#context-budget-replace')!;
  replacement.value = '85'; await event(replacement, 'input', {});
  await act(async () => vi.advanceTimersByTime(650));
  expect(reserve.mock.calls[0]![0]).toBeCloseTo(.15);
  const preparation = container.querySelector<HTMLInputElement>('#context-budget-prepare')!;
  preparation.value = '100'; await event(preparation, 'input', {});
  await act(async () => vi.advanceTimersByTime(650));
  expect(prepare).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toBe('settings.contextScale.prepareInvalid');
});
