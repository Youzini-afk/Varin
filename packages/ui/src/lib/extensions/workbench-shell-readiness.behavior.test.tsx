import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SurfaceContribution } from '@varin/extension-surface';
import { WorkbenchShellHost } from './workbench-shell-host';

const state = vi.hoisted(() => ({
  generation: 1, selected: null as SurfaceContribution | null,
  workspace: { status: 'none' } as Record<string, unknown>,
}));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => state.generation }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, onClick }: React.PropsWithChildren<{ onClick(): void }>) => <button onClick={onClick}>{children}</button> }));
vi.mock('@/components/layout/WorkbenchRecoveryShell', () => ({ WorkbenchRecoveryShell: () => <p>Recovery workspace</p> }));
vi.mock('@/lib/workbench/profile-transition', () => {
  const snapshot = { phase: 'idle', id: 0 };
  return { getWorkbenchProfileTransitionSnapshot: () => snapshot, subscribeWorkbenchProfileTransition: () => () => {}, markWorkbenchProfileTransitionTargetPainted: () => {} };
});
vi.mock('./catalog-store', () => ({ useVarinExtensionCatalog: () => ({ snapshot: { catalog: { hostId: 'test-host' } } }) }));
vi.mock('./surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
vi.mock('./workbench-workspace', () => ({ useWorkbenchWorkspace: () => state.workspace }));
vi.mock('./workbench-shell-view', () => ({ resolveWorkbenchShellView: () => ({
  view: 'ready', resolved: { profileId: 'selected-profile', shellContributionId: 'test-shell' },
}) }));
vi.mock('./workbench-registry', () => ({
  WORKBENCH_REPLACEMENT_TARGETS: { shell: 'workbench.shell' },
  useSurfaceRegistrySnapshot: () => ({ visibleContributions: state.selected ? [state.selected] : [] }),
  workbenchContributionInstanceKey: (contribution: SurfaceContribution) => `${contribution.descriptor.id}:${contribution.owner.generation}`,
  WorkbenchSurfaceContributionHost: ({ contribution, onMountReady }: { contribution: SurfaceContribution; onMountReady(): void }) => {
    const Component = (contribution.implementation as { Component: React.ComponentType }).Component;
    React.useEffect(onMountReady, [onMountReady]);
    return <Component />;
  },
}));

let root: Root;
let host: HTMLElement;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map(); let id = 0;
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  window.cancelAnimationFrame = handle => { frames.delete(handle); };
  state.generation = 1; state.workspace = { status: 'none' };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); expect(frames.size).toBe(0); vi.unstubAllGlobals(); });
const paint = () => act(async () => {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(0);
});
const select = (Component: React.ComponentType, generation = 1) => {
  state.selected = { descriptor: { id: 'test-shell', replacement: { target: 'workbench.shell' } },
    owner: { generation }, implementation: { Component } } as unknown as SurfaceContribution;
};

it('keeps startup covered while the selected lazy Shell loads, then reports its actual paint boundary', async () => {
  let complete!: (module: { default: React.ComponentType }) => void;
  select(React.lazy(() => new Promise<{ default: React.ComponentType }>(resolve => { complete = resolve; })));
  const readiness = vi.fn();
  await act(async () => root.render(<WorkbenchShellHost onReadyChange={readiness} />));
  await paint(); await paint();
  expect(readiness).not.toHaveBeenCalledWith(true);
  expect(host.textContent).not.toContain('Workspace content');
  await act(async () => complete({ default: () => <p>Workspace content</p> }));
  expect(host.textContent).toContain('Workspace content');
  await paint();
  expect(readiness).not.toHaveBeenCalledWith(true);
  await paint();
  expect(readiness).toHaveBeenLastCalledWith(true);

  // A different runtime/contribution cannot inherit that ready receipt.
  state.generation = 2;
  select(React.lazy(() => new Promise(() => {})), 2);
  await act(async () => root.render(<WorkbenchShellHost onReadyChange={readiness} />));
  expect(readiness).toHaveBeenLastCalledWith(false);
  readiness.mockClear();
  await paint(); await paint();
  expect(readiness).not.toHaveBeenCalledWith(true);
});

it('lets the actual recovery screen release startup when workspace resolution fails', async () => {
  select(() => <p>Workspace content</p>);
  state.workspace = { status: 'error', errorMessage: 'Workspace resolution failed', retry() {} };
  const readiness = vi.fn();
  await act(async () => root.render(<WorkbenchShellHost onReadyChange={readiness} />));
  expect(host.textContent).toContain('Workspace resolution failed');
  expect(readiness).not.toHaveBeenCalledWith(true);
  await paint(); await paint();
  expect(readiness).toHaveBeenLastCalledWith(true);
});
