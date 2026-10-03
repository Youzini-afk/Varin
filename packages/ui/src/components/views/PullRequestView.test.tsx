import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PullRequestView } from './PullRequestView';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), branches: vi.fn(), ensureAll: vi.fn(), section: vi.fn(),
  git: { getRemotes: vi.fn(), getRemoteUrl: vi.fn() },
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/session-repo' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: mocks.git }) }));
vi.mock('@/hooks/useDetectedWorktreeRoot', () => ({ useDetectedWorktreeMetadata: () => null }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@varin/application-client', () => ({ getRuntimeKey: () => 'host-a' }));
vi.mock('@/stores/useGitStore', () => ({
  useGitStatus: mocks.status,
  useGitBranches: mocks.branches,
  useGitStore: (select: (state: { ensureAll: typeof mocks.ensureAll }) => unknown) => select({ ensureAll: mocks.ensureAll }),
}));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/ScrollShadow', () => ({ ScrollShadow: () => null }));
vi.mock('./git/PullRequestSection', () => ({ PullRequestSection: (props: unknown) => {
  mocks.section(props); return <div>PR workflow</div>;
} }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.status.mockReturnValue({ current: 'feature', tracking: 'origin/feature' });
  mocks.branches.mockReturnValue({ all: ['feature', 'main'], defaultBranches: { origin: 'main' } });
  mocks.git.getRemotes.mockResolvedValue([{ name: 'origin', fetchUrl: 'https://github.com/test/selected', pushUrl: 'https://github.com/test/selected' }]);
  mocks.git.getRemoteUrl.mockResolvedValue('https://github.com/test/selected');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('loads PR data from the explicit repository and retains the panel location for onward navigation', async () => {
  await act(async () => root.render(<PullRequestView directoryOverride="/selected-repo" navigationDirectory="/session-repo" />));
  expect(mocks.status).toHaveBeenCalledWith('/selected-repo');
  expect(mocks.branches).toHaveBeenCalledWith('/selected-repo');
  expect(mocks.ensureAll).toHaveBeenCalledWith('/selected-repo', mocks.git);
  expect(mocks.git.getRemotes).toHaveBeenCalledWith('/selected-repo');
  expect(mocks.git.getRemoteUrl).toHaveBeenCalledWith('/selected-repo');
  expect(mocks.section).toHaveBeenLastCalledWith(expect.objectContaining({
    directory: '/selected-repo', navigationDirectory: '/session-repo', branch: 'feature', baseBranch: 'main',
  }));
  await act(async () => root.render(<PullRequestView isActive={false} directoryOverride="/selected-repo" navigationDirectory="/session-repo" />));
  expect(mocks.section).toHaveBeenLastCalledWith(expect.objectContaining({
    isActive: false, directory: '/selected-repo', navigationDirectory: '/session-repo',
  }));
});
