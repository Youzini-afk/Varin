import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { ProjectEntry } from '@varin/application-client';
const f = vi.hoisted(() => ({ projects: null as unknown, execute: vi.fn(), local: { getGitStatus: vi.fn() } }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), executeProjectGit: f.execute }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (value: unknown) => unknown) => (f.projects as typeof projects)(select) }));
vi.mock('./useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/local/work' }));
vi.mock('./useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: f.local }) }));
import { useProjectGit } from './useProjectGit';
import { projectGitDirectory } from '@/lib/worktrees/projectGit';
const projects = create<{ projects: ProjectEntry[]; activeProjectId: string }>(() => ({ projects: [], activeProjectId: '' })); f.projects = projects;
const project = (hostId: string): ProjectEntry => ({ id: 'project', path: '/same/root', source: { workspaceId: 'root', resourceOwner: { kind: 'managed_host', hostId, connectionId: hostId, endpointIdentity: hostId } } });
let root: Root, container: HTMLElement;
function Probe({ directory }: { directory?: string }) { const source = useProjectGit(directory); return <button onClick={() => void source.git.getGitStatus(source.directory!)}>{source.directory}</button>; }
beforeEach(() => { const { window, document } = parseHTML('<html><body></body></html>'); for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value); container = document.createElement('div'); document.body.append(container); root = createRoot(container); projects.setState({ projects: [project('a')], activeProjectId: 'project' }); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('retains an explicit local tab when a remote project becomes active', async () => {
  await act(async () => root.render(<Probe directory="/original/local" />));
  await act(async () => container.querySelector('button')!.click());
  expect(f.local.getGitStatus).toHaveBeenCalledWith('/original/local'); expect(f.execute).not.toHaveBeenCalled();
});
it('uses the active original owner only for a new unbound view, and retains a pinned remote tab', async () => {
  await act(async () => root.render(<Probe />)); expect(container.textContent).toBe(projectGitDirectory(project('a')));
  const pinned = projectGitDirectory(project('a'));
  await act(async () => root.render(<Probe directory={pinned} />));
  await act(async () => projects.setState({ projects: [project('b')] }));
  await act(async () => container.querySelector('button')!.click());
  expect(f.execute.mock.calls.at(-1)?.[1]).toEqual(project('a').source);
  await act(async () => root.render(<Probe />)); expect(container.textContent).toBe(projectGitDirectory(project('b')));
});
