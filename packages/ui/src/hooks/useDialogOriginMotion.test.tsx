import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDialogOriginMotion } from './useDialogOriginMotion';
import { captureDialogOrigin } from '@/lib/motion/dialogOrigin';

let root: Root, container: HTMLDivElement, source: HTMLButtonElement;
let sourceLeft: number;
const disconnect = vi.fn();
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  disconnect.mockClear(); sourceLeft = 20;
  source = document.createElement('button'); document.body.append(source);
  source.getBoundingClientRect = () => ({ left: sourceLeft, top: 740, width: 36, height: 36 }) as DOMRect;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  captureDialogOrigin('settings', source);
});
afterEach(() => { act(() => root.unmount()); captureDialogOrigin('settings'); vi.unstubAllGlobals(); });

function Harness({ open }: { open: boolean }) {
  const flight = useDialogOriginMotion('settings', open);
  return <div {...flight.popupProps} ref={element => {
    if (element) {
      Object.defineProperties(element, {
        offsetParent: { configurable: true, value: null }, offsetLeft: { configurable: true, value: 100 },
        offsetTop: { configurable: true, value: 100 }, offsetWidth: { configurable: true, value: 800 }, offsetHeight: { configurable: true, value: 600 },
      });
      // The in-flight visual bounds must not affect the return destination.
      element.getBoundingClientRect = () => ({ left: 300, top: 400, width: 80, height: 60 }) as DOMRect;
    }
    flight.popupProps.ref(element);
  }} />;
}

it('uses untransformed layout for launch and refreshes the original button position on close', async () => {
  await act(async () => root.render(<Harness open />));
  const popup = container.firstElementChild as HTMLElement;
  expect(popup.style.getPropertyValue('--dialog-flight-x')).toBe('-462px');
  expect(popup.style.getPropertyValue('--dialog-flight-y')).toBe('358px');
  expect(Number(popup.style.getPropertyValue('--dialog-flight-scale'))).toBeCloseTo(0.045);
  sourceLeft = 80;
  await act(async () => root.render(<Harness open={false} />));
  expect(popup.style.getPropertyValue('--dialog-flight-x')).toBe('-402px');
  expect(popup.getAttribute('data-dialog-flight')).toBe('button');
});

it('keeps the captured point if the trigger unmounts, and discards it for a keyboard reopen', async () => {
  source.remove();
  await act(async () => root.render(<Harness open />));
  const popup = container.firstElementChild as HTMLElement;
  expect(popup.style.getPropertyValue('--dialog-flight-x')).toBe('-462px');
  await act(async () => root.render(<Harness open={false} />));
  captureDialogOrigin('settings');
  await act(async () => root.render(<Harness open />));
  expect(popup.getAttribute('data-dialog-flight')).toBe('center');
  expect(popup.style.getPropertyValue('--dialog-flight-x')).toBe('0px');
  expect(popup.style.getPropertyValue('--dialog-flight-scale')).toBe('0.985');
  expect(disconnect).toHaveBeenCalled();
});
