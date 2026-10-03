import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelGitNavigation } from './ContextPanelGitNavigation';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUIStore.setState({ contextPanelByDirectory: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('opens the PR workflow without an existing PR and binds the selected repository inside the current panel', async () => {
  useUIStore.getState().openContextPanelTab('/session-repo', { mode: 'git' });
  await act(async () => root.render(<ContextPanelGitNavigation
    mode="git" panelDirectory="/session-repo" repositoryDirectory="/selected-repo" onReturnToChanges={vi.fn()}
  />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
  await act(async () => button.click());
  const state = useUIStore.getState().contextPanelByDirectory['/session-repo'];
  expect(state?.isOpen).toBe(true);
  expect(state?.tabs.find((tab) => tab.id === state.activeTabId)).toMatchObject({
    mode: 'pr', targetDirectory: '/selected-repo',
  });
  expect(useUIStore.getState().contextPanelByDirectory['/selected-repo']).toBeUndefined();

  await act(async () => root.render(<ContextPanelGitNavigation
    mode="pr" panelDirectory="/session-repo" repositoryDirectory="/selected-repo" onReturnToChanges={vi.fn()}
  />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.click());
  expect(useUIStore.getState().contextPanelByDirectory['/session-repo']?.isOpen).toBe(true);
});

it('returns a file diff to the changes list for the same repository', async () => {
  const returnToChanges = vi.fn();
  await act(async () => root.render(<ContextPanelGitNavigation
    mode="diff" panelDirectory="/session-repo" repositoryDirectory="/selected-repo" onReturnToChanges={returnToChanges}
  />));
  const changes = container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;
  expect(changes.textContent).toBe('gitView.changes.title');
  await act(async () => changes.click());
  expect(returnToChanges).toHaveBeenCalledExactlyOnceWith('/selected-repo');
});
