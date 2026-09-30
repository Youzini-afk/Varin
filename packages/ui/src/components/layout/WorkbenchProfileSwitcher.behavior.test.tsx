import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchProfileSwitcher } from './WorkbenchProfileSwitcher';
import { useUIStore } from '@/stores/useUIStore';

const state = vi.hoisted(() => ({
  activeProfileId: 'default',
  hostId: 'host-a',
  selectProfile: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/extensions/catalog-store', async () => {
  const { defaultVarinWorkbenchProfileDocument } = await import('@varin/extension-contract');
  return {
    useVarinExtensionCatalog: () => ({
      snapshot: {
        workbench: {
          authoritative: true,
          hostId: state.hostId,
          document: {
            ...defaultVarinWorkbenchProfileDocument(),
            profileSelections: { users: { default: state.activeProfileId } },
          },
        },
      },
    }),
  };
});
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: state.selectProfile }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'desktop' } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: state.error } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Exercise the switcher's actions and durable return choice without testing menu positioning.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext } = await import('react');
  const Selection = createContext({ value: '', onValueChange: (_value: string) => {} });
  const Children = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    DropdownMenu: Children,
    DropdownMenuContent: Children,
    DropdownMenuTrigger: Children,
    DropdownMenuRadioGroup: ({ children, value, onValueChange }: React.PropsWithChildren<{ value: string; onValueChange(value: string): void }>) => (
      <Selection.Provider value={{ value, onValueChange }}>{children}</Selection.Provider>
    ),
    DropdownMenuRadioItem: ({ children, value, disabled }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => {
      const selection = useContext(Selection);
      return <button type="button" role="menuitemradio" aria-checked={selection.value === value} disabled={disabled} data-profile={value} onClick={() => selection.onValueChange(value)}>{children}</button>;
    },
  };
});

describe('independent workbench presentation controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => { root.render(<WorkbenchProfileSwitcher />); });
  };
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
  };
  const agentButton = '[data-profile="workbench"]';
  const ideButton = '[data-profile="ide"]';
  const botButton = '[data-profile="bot"]';
  const researchItem = '[data-profile="varin.research"]';

  beforeEach(() => {
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    state.activeProfileId = 'default';
    state.hostId = 'host-a';
    state.error.mockReset();
    state.selectProfile.mockReset().mockImplementation(async (profileId: string) => { state.activeProfileId = profileId; });
    useUIStore.setState({ agentWorkbenchProfileByHost: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('selects Research within Workbench while offering three top-level modes', async () => {
    await render();
    expect(container.querySelector('[data-profile="varin.ide"]')).toBeNull();
    expect(container.querySelector(ideButton)).not.toBeNull();
    expect(container.querySelector(botButton)).not.toBeNull();
    await click(researchItem);
    expect(state.selectProfile).toHaveBeenLastCalledWith('varin.research', undefined, { enableShell: true });
    expect(container.querySelector(agentButton)?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector(researchItem)?.getAttribute('aria-checked')).toBe('true');
  });

  it('returns from IDE to Research after the shell controls remount', async () => {
    state.activeProfileId = 'varin.research';
    await render();
    await click(ideButton);
    expect(state.activeProfileId).toBe('varin.ide');
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector(researchItem)).toBeNull();
    await click(agentButton);
    expect(state.activeProfileId).toBe('varin.research');
    const persisted = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as { agentWorkbenchProfileByHost: Record<string, string> };
    expect(persisted.agentWorkbenchProfileByHost['host-a']).toBe('varin.research');
  });

  it('returns from Bot to the remembered workspace without treating Bot as a workspace', async () => {
    state.activeProfileId = 'varin.research';
    await render();
    await click(botButton);
    expect(state.activeProfileId).toBe('varin.bot');
    expect(container.querySelector(botButton)?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector(researchItem)).toBeNull();
    expect(useUIStore.getState().agentWorkbenchProfileByHost['host-a']).toBe('varin.research');
    await click(agentButton);
    expect(state.activeProfileId).toBe('varin.research');
  });

  it('retains the current workspace and return choice when a transition fails', async () => {
    await render();
    state.selectProfile.mockRejectedValueOnce(new Error('candidate failed'));
    await click(researchItem);
    expect(state.activeProfileId).toBe('default');
    expect(useUIStore.getState().agentWorkbenchProfileByHost['host-a']).toBe('default');
    expect(state.error).toHaveBeenCalledWith('candidate failed');
  });

  it('does not reuse another Host return choice', async () => {
    useUIStore.setState({ agentWorkbenchProfileByHost: { 'host-a': 'varin.research' } });
    state.hostId = 'host-b';
    state.activeProfileId = 'varin.ide';
    await render();
    await click(agentButton);
    expect(state.activeProfileId).toBe('default');
    expect(useUIStore.getState().agentWorkbenchProfileByHost['host-a']).toBe('varin.research');
  });
});
