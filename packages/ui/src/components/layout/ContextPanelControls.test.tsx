import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelControls } from './ContextPanelControls';

vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

let root: Root;
let container: HTMLElement;
beforeEach(async () => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUIStore.setState({ contextPanelByDirectory: {}, isContextRailOpen: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<ContextPanelControls />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const click = async (label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};

it('opens the panel with the rail hidden, then toggles either without losing the other view', async () => {
  await click('contextPanel.actions.openPanel');
  expect(useUIStore.getState().isContextRailOpen).toBe(false);
  const opened = useUIStore.getState().contextPanelByDirectory['/repo'];
  expect(opened?.isOpen).toBe(true);
  expect(opened?.tabs.length).toBeGreaterThan(0);

  await click('contextRail.actions.expand');
  expect(useUIStore.getState().isContextRailOpen).toBe(true);
  expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(opened);

  await click('contextPanel.actions.closePanel');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(false);
  expect(useUIStore.getState().isContextRailOpen).toBe(true);

  await click('contextRail.actions.collapse');
  expect(useUIStore.getState().isContextRailOpen).toBe(false);
  await click('contextPanel.actions.openPanel');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.activeTabId).toBe(opened?.activeTabId);
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.map(tab => [tab.id, tab.mode, tab.targetPath]))
    .toEqual(opened?.tabs.map(tab => [tab.id, tab.mode, tab.targetPath]));
});

it('opening only the rail does not create or select a resource tab', async () => {
  await click('contextRail.actions.expand');
  expect(useUIStore.getState().isContextRailOpen).toBe(true);
  expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
});
