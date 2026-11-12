import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { ProjectEntry } from '@varin/application-client';
import { useProjectActionsContext } from './useProjectActionsContext';

const state = vi.hoisted(() => ({ projects: null as unknown, directory: null as unknown }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (selector: (value: unknown) => unknown) => (state.projects as typeof projects)(selector) }));
vi.mock('./useEffectiveDirectory', () => ({ useEffectiveDirectory: () => (state.directory as typeof directory)((value: { path: string }) => value.path) }));
const projects = create<{ projects: ProjectEntry[]; activeProjectId: string | null }>(() => ({ projects: [], activeProjectId: null }));
const directory = create(() => ({ path: '/coordinator/old-worktree' }));
state.projects = projects; state.directory = directory;
const local: ProjectEntry = { id: 'local', path: '/local/repo' };
const remote: ProjectEntry = { id: 'remote', path: '/remote/repo', source: { resourceOwner: { kind: 'managed_host', hostId: 'device-b', connectionId: 'pair-b', endpointIdentity: 'endpoint-b' }, workspaceId: 'documents:root' } };
function Probe() { const context = useProjectActionsContext(); return <output>{JSON.stringify(context)}</output>; }
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  projects.setState({ projects: [local, remote], activeProjectId: 'local' }); directory.setState({ path: '/local/adopted-mount/worktree' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const result = () => JSON.parse(container.textContent!);
it('preserves local adopted navigation but never carries it into a remote project', async () => {
  await act(async () => root.render(<Probe />));
  expect(result().directory).toBe('/local/adopted-mount/worktree');
  await act(async () => projects.setState({ activeProjectId: 'remote' }));
  expect(result()).toMatchObject({ directory: '/remote/repo', projectRef: { source: remote.source, resourceOwner: remote.source!.resourceOwner } });
  await act(async () => directory.setState({ path: '/coordinator/unrelated' }));
  expect(result().directory).toBe('/remote/repo');
});
it('does not retain a stale owner across Host clearing or same-path source rebinding', async () => {
  await act(async () => { projects.setState({ activeProjectId: 'remote' }); root.render(<Probe />); });
  await act(async () => projects.setState({ projects: [], activeProjectId: null }));
  expect(result()).toBeNull();
  const next = { ...remote, source: { ...remote.source!, resourceOwner: { kind: 'managed_host' as const, hostId: 'device-c', connectionId: 'pair-c', endpointIdentity: 'endpoint-c' } } };
  await act(async () => projects.setState({ projects: [next], activeProjectId: next.id }));
  expect(result().projectRef.resourceOwner.hostId).toBe('device-c');
  expect(result().directory).toBe('/remote/repo');
});
