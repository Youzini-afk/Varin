import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { activationPoint } from '@/lib/motion/pointer';
import { useUIStore } from '@/stores/useUIStore';
import { useDesktopSettingsTransition } from './useDesktopSettingsTransition';

const stage = vi.hoisted(() => ({ cover: vi.fn(), close: vi.fn(), reveal: vi.fn(), dispose: vi.fn() }));
vi.mock('@/components/ui/workbench-lattice-stage', () => ({ LatticeStage: class {
  cover = stage.cover; close = stage.close; reveal = stage.reveal; dispose = stage.dispose;
} }));
vi.mock('@/components/views/SettingsWindow', () => ({ SettingsWindow: () => <div>Settings content</div> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({
  WorkbenchReplacement: ({ fallback }: { fallback: React.ReactNode }) => fallback,
  WORKBENCH_REPLACEMENT_TARGETS: { settings: 'workbench.settings' },
}));

function Shell() {
  const settings = useDesktopSettingsTransition(true);
  return <div data-shell="">
    <header data-startup-part="header">
      {settings.open && <button type="button" onClick={event => useUIStore.getState().setSettingsDialogOpen(false, activationPoint(event))}>Return</button>}
    </header>
    <section hidden={settings.open}><button type="button" onClick={event => useUIStore.getState().setSettingsDialogOpen(true, activationPoint(event))}>Settings</button><input defaultValue="Retained draft" /></section>
    {settings.content}
    {settings.layer}
  </div>;
}

it('swaps under the cover and reveals from each button while retaining the working surface', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const box = (selector: string, left: number, top: number, width: number, height: number) => {
    host.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  };
  const pending: Array<(finished: boolean) => void> = [];
  stage.cover.mockImplementation(() => new Promise<boolean>(resolve => pending.push(resolve)));
  stage.reveal.mockResolvedValue(true);
  useUIStore.setState({ isSettingsDialogOpen: false, settingsTransitionOrigin: null, motionPreference: 'full' });
  try {
    await act(async () => root.render(<Shell />));
    box('[data-shell]', 10, 10, 800, 600);
    box('header', 10, 10, 800, 44);
    box('.wb-lattice', 10, 54, 800, 556);
    const cover = host.querySelector<HTMLElement>('.wb-lattice')!;
    const draft = host.querySelector('input');
    const press = Object.assign(new window.Event('click', { bubbles: true }), { detail: 1, clientX: 83, clientY: 551 });
    await act(async () => { host.querySelector('section button')!.dispatchEvent(press); });
    expect(stage.cover).toHaveBeenLastCalledWith({ x: 73, y: 497 });
    expect(cover.style.top).toBe('44px');
    expect(cover.hidden).toBe(false);
    expect(host.querySelector('section')!.hidden).toBe(false);
    await act(async () => pending.shift()!(true));
    expect(host.textContent).toContain('Settings content');
    expect(stage.reveal).toHaveBeenLastCalledWith({ x: 73, y: 497 }, false);
    box('header button', 20, 16, 80, 28);
    await act(async () => { host.querySelector<HTMLButtonElement>('header button')!.click(); });
    expect(stage.cover).toHaveBeenLastCalledWith({ x: 50, y: 0 });
    expect(host.textContent).toContain('Settings content');
    await act(async () => pending.shift()!(true));
    expect(stage.reveal).toHaveBeenLastCalledWith({ x: 50, y: 0 }, false);
    expect(cover.hidden).toBe(true);
    expect(host.querySelector('input')).toBe(draft);
    expect(host.querySelector('section')!.hidden).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ isSettingsDialogOpen: false, settingsTransitionOrigin: null });
    vi.unstubAllGlobals();
  }
});
