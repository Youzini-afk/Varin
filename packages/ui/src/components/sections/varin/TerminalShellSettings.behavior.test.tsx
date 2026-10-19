import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalShellOption } from '@varin/application-client';

const fixture = vi.hoisted(() => ({ host: 1, listeners: new Set<() => void>(),
  terminal: { listShells: vi.fn() }, store: { terminalShell: 'auto', terminalLoginShells: [], setTerminalShell: vi.fn(), setTerminalLoginShells: vi.fn() },
  translate: (key: string, params?: Record<string, unknown>) => key.endsWith('autoResolved') ? `Auto · ${params?.shell}` : key.endsWith('discoveryError') ? `Discovery failed: ${params?.message}` : key,
}));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { fixture.listeners.add(callback); return () => { fixture.listeners.delete(callback); }; } }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal: fixture.terminal }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (selector: (state: typeof fixture.store) => unknown) => selector(fixture.store) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _v, size: _s, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SETTINGS_SELECT_SIZE: 'settings',
  SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SettingsCheckboxRow: () => null }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectValue: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectItem: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));
import { TerminalShellSettings } from './TerminalShellSettings';

let root: Root, container: HTMLDivElement;
const shells = (executable: string): TerminalShellOption[] => [
  { id: 'auto', name: 'Auto', executable, supportsLogin: false },
  { id: 'pwsh', name: 'PowerShell (pwsh)', executable, supportsLogin: false },
];
beforeEach(() => {
  vi.resetAllMocks(); fixture.host += 1;
  fixture.terminal.listShells.mockResolvedValue(shells('C:\\PowerShell\\pwsh.exe'));
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('shows Auto’s actual shell and path, exposes discovery failures, and refreshes without changing the saved preference', async () => {
  await act(async () => root.render(<TerminalShellSettings />));
  expect(container.textContent).toContain('Auto · PowerShell (pwsh)');
  expect(container.textContent).toContain('C:\\PowerShell\\pwsh.exe');
  fixture.terminal.listShells.mockRejectedValueOnce(new Error('Host offline'));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host offline');
  fixture.terminal.listShells.mockResolvedValueOnce(shells('D:\\NewPowerShell\\pwsh.exe'));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('D:\\NewPowerShell\\pwsh.exe');
  expect(fixture.store.setTerminalShell).not.toHaveBeenCalled();
});

it('keeps a late discovery result from the previous Host out of the current settings', async () => {
  let old!: (value: TerminalShellOption[]) => void;
  fixture.terminal.listShells.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  await act(async () => root.render(<TerminalShellSettings />));
  fixture.terminal.listShells.mockResolvedValueOnce(shells('/new-host/pwsh'));
  await act(async () => { fixture.host += 1; fixture.listeners.forEach(callback => callback()); });
  expect(container.textContent).toContain('/new-host/pwsh');
  await act(async () => old(shells('C:\\OldHost\\pwsh.exe')));
  expect(container.textContent).not.toContain('C:\\OldHost');
  expect(container.textContent).toContain('/new-host/pwsh');
});
