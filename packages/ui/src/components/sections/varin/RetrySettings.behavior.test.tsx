import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _v, size: _s, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('../shared/SettingsSection', () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
  SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SettingsCheckboxRow: () => null,
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectValue: () => null, SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectItem: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));
import { RetrySettings } from './RetrySettings';

it('tests draft rule order without saving and saves that order explicitly', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const testRetry = vi.fn<React.ComponentProps<typeof RetrySettings>['api']['testRetry']>(async () => ({ retry: false, reason: 'rule', ruleIndex: 0, delayMs: 0 }));
  const onSave = vi.fn<React.ComponentProps<typeof RetrySettings>['onSave']>(async () => {});
  try {
    await act(async () => root.render(<RetrySettings value={{ rules: [
      { field: 'message', match: 'contains', pattern: 'busy', action: 'retry' },
      { field: 'message', match: 'contains', pattern: 'quota', action: 'stop' },
    ] }} disabled={false} api={{ testRetry } as never} onSave={onSave} />));
    await act(async () => container.querySelectorAll<HTMLButtonElement>('button[aria-label="settings.retry.up"]')[1]!.click());
    const click = async (text: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click());
    await click('settings.retry.test');
    expect(testRetry.mock.calls[0]).toMatchObject([{ rules: [{ pattern: 'quota' }, { pattern: 'busy' }] }, { status: 503 }, expect.any(AbortSignal)]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('settings.retry.stop');
    expect(onSave).not.toHaveBeenCalled();
    await click('settings.retry.save');
    expect(onSave.mock.calls[0]).toMatchObject([{ retry: { maxRetries: 2, rules: [{ pattern: 'quota' }, { pattern: 'busy' }] } }]);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
