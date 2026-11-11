import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { ProjectEntry } from '@varin/application-client';
const mocks = vi.hoisted(() => ({ request: vi.fn(), projects: null as unknown, runtime: 'a', will: [] as Array<() => void>, changed: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createResourceFilesHttpAPI: () => ({ request: mocks.request }), getRuntimeKey: () => mocks.runtime, subscribeRuntimeEndpointWillChange: (cb: () => void) => { mocks.will.push(cb); return () => {}; }, subscribeRuntimeEndpointChanged: (cb: () => void) => { mocks.changed.add(cb); return () => mocks.changed.delete(cb); } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (selector: (value: unknown) => unknown) => (mocks.projects as typeof projects)(selector) }));
vi.mock('./useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/coordinator/old' }));
import { useProjectFileLocation } from './useProjectFileLocation';
const projects = create<{ projects: ProjectEntry[]; activeProjectId: string | null }>(() => ({ projects: [], activeProjectId: null })); mocks.projects = projects;
const project = (hostId: string): ProjectEntry => ({ id: 'same-id', path: '/same/path', source: { resourceOwner: { kind: 'managed_host', hostId, connectionId: `pair-${hostId}`, endpointIdentity: `endpoint-${hostId}` }, workspaceId: 'same-workspace' } });
let root: Root, container: HTMLElement;
function Probe() { const value = useProjectFileLocation(); return <output>{JSON.stringify(value)}</output>; }
const result = () => JSON.parse(container.textContent!);
beforeEach(() => { mocks.will.forEach(cb => cb()); mocks.request.mockReset(); const { window, document } = parseHTML('<html><body></body></html>'); for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value); container = document.createElement('div'); document.body.append(container); root = createRoot(container); projects.setState({ projects: [project('a')], activeProjectId: 'same-id' }); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('keeps same-path source rebinding isolated, ignores late old results and reuses the original resolution on reopen', async () => {
  const pending: Array<(value: unknown) => void> = []; mocks.request.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await act(async () => root.render(<Probe />));
  expect(mocks.request.mock.calls[0][0].resourceOwner.hostId).toBe('a');
  await act(async () => projects.setState({ projects: [project('b')] }));
  expect(result().location).toBeUndefined(); expect(mocks.request.mock.calls[1][0].resourceOwner.hostId).toBe('b');
  await act(async () => pending[0]({ kind: 'opened', root: '/same/path', workspaceId: 'old' }));
  expect(result().location).toBeUndefined();
  await act(async () => pending[1]({ kind: 'opened', root: '/same/path', workspaceId: 'target' }));
  expect(result().location.resourceOwner.hostId).toBe('b'); expect(result().location.workspaceId).toBe('target');
  await act(async () => root.render(null)); await act(async () => root.render(<Probe />)); expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('aborts pending Host requests and never displays an old successful response in the new Host', async () => {
  const pending: Array<(value: unknown) => void> = []; mocks.request.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await act(async () => root.render(<Probe />)); const signal = mocks.request.mock.calls[0][1] as AbortSignal;
  await act(async () => { mocks.will.forEach(cb => cb()); mocks.runtime = 'next'; mocks.changed.forEach(cb => cb()); });
  expect(signal.aborted).toBe(true);
  await act(async () => pending[0]({ kind: 'opened', root: '/old', workspaceId: 'old' }));
  expect(result().location).toBeUndefined();
  await act(async () => pending[1]({ kind: 'opened', root: '/new', workspaceId: 'new' })); expect(result().location.workspaceId).toBe('new');
});
it('preserves local effective navigation without making any remote request', async () => {
  projects.setState({ projects: [{ id: 'local', path: '/project' }], activeProjectId: 'local' });
  await act(async () => root.render(<Probe />)); expect(result()).toMatchObject({ remote: false, root: '/coordinator/old' }); expect(mocks.request).not.toHaveBeenCalled();
});
