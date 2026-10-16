import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@varin/application-client', () => ({ registerRuntimeEndpointSwitchBlocker: vi.fn() }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({
  projects: [{ id: 'one', path: '/one' }, { id: 'two', path: '/two' }], activeProjectId: 'one', setActiveProject: fixture.select,
}) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Selection = React.createContext((_value: string) => {});
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { DropdownMenu: Wrapper, DropdownMenuContent: Wrapper, DropdownMenuTrigger: Wrapper,
    DropdownMenuRadioGroup: ({ children, onValueChange }: React.PropsWithChildren<{ onValueChange(value: string): void }>) => <Selection.Provider value={onValueChange}>{children}</Selection.Provider>,
    DropdownMenuRadioItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => {
      const select = React.useContext(Selection); return <button onClick={() => select(value)}>{children}</button>;
    },
  };
});
import { SettingsProjectSelector } from './SettingsProjectSelector';
import { SettingsActionBar } from './SettingsActionBar';
import { SettingsNavigationContext } from './settings-context';
import { finishSettingsNavigation, getPendingSettingsNavigation, stayInSettings } from '@/lib/settings/drafts';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); stayInSettings(); container.remove(); vi.unstubAllGlobals(); });
const chooseTwo = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Two')!.click();

it('preserves a settings draft when cancelling a project switch and discards only on confirmation', async () => {
  const cancel = vi.fn();
  await act(async () => root.render(<SettingsNavigationContext.Provider value><SettingsProjectSelector /><SettingsActionBar dirty onCancel={cancel} onSave={() => false} /></SettingsNavigationContext.Provider>));
  await act(async () => chooseTwo());
  expect(getPendingSettingsNavigation()).not.toBeNull(); expect(fixture.select).not.toHaveBeenCalled();
  act(() => stayInSettings()); expect(cancel).not.toHaveBeenCalled();
  await act(async () => chooseTwo());
  await act(async () => { expect(await finishSettingsNavigation(true)).toBe(false); });
  expect(fixture.select).not.toHaveBeenCalled();
  await act(async () => { expect(await finishSettingsNavigation(false)).toBe(true); });
  expect(cancel).toHaveBeenCalledOnce(); expect(fixture.select).toHaveBeenCalledExactlyOnceWith('two');
});

it('switches normally outside a settings navigation owner', async () => {
  await act(async () => root.render(<><SettingsProjectSelector /><SettingsActionBar dirty onCancel={() => {}} /></>));
  act(() => chooseTwo());
  expect(fixture.select).toHaveBeenCalledExactlyOnceWith('two'); expect(getPendingSettingsNavigation()).toBeNull();
});

it('guards unloading an in-flight write even after its draft has become clean', async () => {
  await act(async () => root.render(<SettingsActionBar dirty={false} saving onCancel={() => {}} />));
  const beforeUnload = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);
});
