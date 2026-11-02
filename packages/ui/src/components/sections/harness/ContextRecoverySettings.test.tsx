import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextRecoverySettings } from './ContextRecoverySettings';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('preserves legacy values visibly without operating controls or write callbacks', async () => {
  await act(async () => root.render(<ContextRecoverySettings value={{ enabled: true, streamIdleMs: 9000, responseWaitMs: 42000, maxRetries: 3 }} />));
  const disclosure = container.querySelector('details')!;
  expect(disclosure.getAttribute('data-settings-item')).toBe('harness.context.compactionRecovery');
  expect(disclosure.textContent).toContain('settings.page.harness.context.recovery.description');
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  expect(inputs.map(input => input.value)).toEqual(['9', '42', '3']);
  expect(inputs.every(input => input.hasAttribute('disabled'))).toBe(true);
  const toggle = container.querySelector<HTMLElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-disabled')).toBe('true');
  await act(async () => toggle.dispatchEvent(new window.Event('click', { bubbles: true })));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => root.render(<ContextRecoverySettings value={{ enabled: false, streamIdleMs: 1000, responseWaitMs: 2000, maxRetries: 0 }} />));
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(input => input.value)).toEqual(['1', '2', '0']);
});
