import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectEntry } from '@varin/application-client';
import { ProjectWorkspaceSection } from './ProjectWorkspaceSection';

const mocks = vi.hoisted(() => ({ manage: vi.fn(), local: vi.fn(), directory: vi.fn(), update: vi.fn(), projects: [] as ProjectEntry[] }));
vi.mock('@varin/application-client', async original => ({ ...await original<object>(), manageProject: mocks.manage }));
vi.mock('@/lib/nativeWorkspace', () => ({ projectWorkspaceRequest: mocks.local, inspectWorkspaceBackend: mocks.local, openWorkspaceBackendSettings: mocks.local }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock('../shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ projects: mocks.projects, activeProjectId: 'remote' }), setState: mocks.update } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: mocks.directory }) } }));
const remote: ProjectEntry = { id: 'remote', path: '/same/repo', source: { resourceOwner: { kind: 'managed_host', hostId: 'device-b', connectionId: 'pair-b', endpointIdentity: 'endpoint-b' }, workspaceId: 'documents:root' } };
const ready = { workspace: { state: 'ready' }, executionPath: '/source/mount', mountState: 'ready', leases: 0, preparing: false, progress: null, capabilities: null };
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  mocks.manage.mockReset(); mocks.local.mockReset(); mocks.directory.mockReset(); mocks.update.mockReset(); mocks.projects = [remote];
  mocks.manage.mockImplementation(async (_id, action) => action === 'backend' ? { backend: 'native', dependenciesReady: true } : ready);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const enable = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('settings.projects.workspace.enable'))!;
it('applies remote adoption with its frozen binding and never changes the local directory', async () => {
  await act(async () => root.render(<ProjectWorkspaceSection project={remote} />));
  await act(async () => enable().click());
  expect(mocks.manage).toHaveBeenCalledWith('remote', 'enable', {}, expect.any(AbortSignal), remote.source);
  expect(mocks.update).toHaveBeenCalledOnce(); expect(mocks.directory).not.toHaveBeenCalled(); expect(mocks.local).not.toHaveBeenCalled();
});
it('discards a late adoption response after switching the selected project', async () => {
  let finish!: (value: typeof ready) => void;
  mocks.manage.mockImplementation(async (_id, action) => action === 'enable' ? new Promise(resolve => { finish = resolve; }) : action === 'backend' ? { backend: 'native', dependenciesReady: true } : ready);
  await act(async () => root.render(<ProjectWorkspaceSection project={remote} />));
  await act(async () => enable().click());
  const signal = mocks.manage.mock.calls.find(call => call[1] === 'enable')![3] as AbortSignal;
  await act(async () => root.render(<ProjectWorkspaceSection project={{ ...remote, id: 'other' }} />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(ready));
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.directory).not.toHaveBeenCalled();
});
