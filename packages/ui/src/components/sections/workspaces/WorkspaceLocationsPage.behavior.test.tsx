import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SettingsPayload, WorkspaceLocationChange, WorkspaceLocationChangeResult } from '@varin/application-client';
const f = vi.hoisted(() => ({ endpoint: 1, listeners: new Set<() => void>(), load: vi.fn(), change: vi.fn(), list: vi.fn(), fetch: vi.fn(), projects: vi.fn() }));
vi.mock('@varin/application-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@varin/application-client')>()),
  getRuntimeApiBaseUrl: () => 'https://service.example', getRuntimeEndpointGeneration: () => f.endpoint,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  registerRuntimeEndpointSwitchBlocker: vi.fn(), runtimeFetch: f.fetch }));
vi.mock('@/hooks/useRuntimeAPIs', () => {
  const apis = { settings: { load: f.load, changeWorkspaceLocation: f.change }, threads: { sources: { list: f.list } } };
  return { useRuntimeAPIs: () => apis };
});
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
import { WorkspaceLocationControls } from './WorkspaceLocationsPage';

function WorkspacesFixture() {
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  return <main><button type="button" onClick={refresh}>Refresh</button>
    <WorkspaceLocationControls refreshRevision={revision} renderRegisteredProjects={f.projects} />
  </main>;
}

const resourceOwner = { kind: 'managed_host' as const, hostId: 'test-machine', connectionId: 'peer', endpointIdentity: 'pinned-peer' };
let root: Root, view: HTMLElement, state: SettingsPayload;
const btn = (text: string) => [...view.querySelectorAll('button')].find(n => n.textContent === text)!;
const click = (text: string) => act(async () => btn(text).click());
const select = async (el: HTMLSelectElement, value: string) => act(async () => {
  Object.defineProperty(el, 'value', { configurable: true, get: () => value }); el.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const type = async (el: HTMLInputElement, value: string) => act(async () => {
  el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const openFolder = async () => {
  await click('Save a folder');
  const inputs = view.querySelectorAll('input'); await type(inputs[0]!, '/same'); await type(inputs[1]!, 'Logs');
};
beforeEach(async () => {
  vi.resetAllMocks(); ++f.endpoint;
  state = { workspaceLocations: [], defaultWorkspaceLocationId: null,
    projects: [{ id: 'existing', label: 'Dev', path: '/same' }] };
  f.list.mockResolvedValue({ targets: [{ resourceOwner, label: 'Test machine', capabilities: ['files'] }], unavailable: [] });
  f.load.mockImplementation(async () => ({ settings: structuredClone(state), source: 'web' }));
  f.change.mockImplementation(async (change: WorkspaceLocationChange): Promise<WorkspaceLocationChangeResult> => {
    const locations = state.workspaceLocations ?? [];
    if (change.kind === 'add') state.workspaceLocations = [...locations, change.location];
    else if (change.kind === 'remove') {
      state.workspaceLocations = locations.filter(location => location.id !== change.id);
      if (state.defaultWorkspaceLocationId === change.id) state.defaultWorkspaceLocationId = null;
    } else {
      const selected = locations.find(location => location.id === change.id);
      if (selected?.kind === 'project' && !state.projects?.some(project => project.id === selected.projectId))
        return { settings: structuredClone(state), conflict: 'stale' };
      state.defaultWorkspaceLocationId = change.id;
    }
    return { settings: structuredClone(state) };
  });
  f.fetch.mockResolvedValue(Response.json({ resourceOwner, path: '/canonical/same', workspaceId: 'target-documents' }));
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  view = document.createElement('div'); document.body.append(view); root = createRoot(view);
  await act(async () => root.render(<WorkspacesFixture />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('reuses one service snapshot for the registered projects and the location controls', () => {
  expect(f.load).toHaveBeenCalledTimes(1);
  expect(f.list).toHaveBeenCalledTimes(1);
  expect(f.projects).toHaveBeenLastCalledWith(state.projects, expect.objectContaining({ targets: [expect.objectContaining({ resourceOwner })] }));
});
it('resolves a folder on the selected device, preserves other saved locations, and clears only its own starting preference on removal', async () => {
  await openFolder();
  // Another device saves a bookmark before the user confirms. It must not disappear.
  state.workspaceLocations = [{ kind: 'project', id: 'dev', projectId: 'existing' }];
  await click('Save location');
  expect(f.list).toHaveBeenCalledWith(null, expect.any(AbortSignal));
  expect(f.fetch).toHaveBeenCalledWith('/api/projects/sources/resolve', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ resourceOwner, path: '/same' }) }));
  const folder = { kind: 'folder', id: expect.any(String), name: 'Logs', resourceOwner, workspaceId: 'target-documents', path: '/canonical/same' };
  expect(f.change).toHaveBeenLastCalledWith({ kind: 'add', location: folder }, expect.any(AbortSignal));
  const id = state.workspaceLocations![1]!.id;
  await select(view.querySelector('select')!, id);
  expect(f.change).toHaveBeenLastCalledWith({ kind: 'set-default', id, expectedId: null }, expect.any(AbortSignal));
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Remove bookmark: Logs"]')!.click());
  expect(f.change).toHaveBeenLastCalledWith({ kind: 'remove', id }, expect.any(AbortSignal));
  expect(state).toMatchObject({ defaultWorkspaceLocationId: null, workspaceLocations: [{ kind: 'project', id: 'dev', projectId: 'existing' }] });
  expect(view.textContent).not.toContain('Logs');
});
it('saves a project by registry ID only and shows a rejected default without claiming success or fallback', async () => {
  await click('Save a project'); await select(view.querySelectorAll('select')[1]!, 'existing'); await click('Save location');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.change).toHaveBeenCalledWith({ kind: 'add', location: { kind: 'project', projectId: 'existing', id: expect.any(String) } }, expect.any(AbortSignal));
  const saved = state.workspaceLocations![0]!;
  f.change.mockRejectedValueOnce(new Error('Preference unavailable'));
  await select(view.querySelector('select')!, saved.id);
  expect(view.querySelector('[role="alert"]')?.textContent).toBe('Preference unavailable');
  expect(state.defaultWorkspaceLocationId).toBeNull(); expect(view.querySelector('[role="status"]')?.textContent).not.toBe('Saved');
  // The project disappears on a second device after the list was rendered.
  state.projects = [];
  await select(view.querySelector('select')!, saved.id);
  expect(view.textContent).toContain('Project no longer registered');
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('changed on the service');
});
it('does not write a resolved folder into a newly connected service', async () => {
  let reply!: (response: Response) => void;
  f.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
  await openFolder(); await click('Save location'); expect(f.fetch).toHaveBeenCalledTimes(1);
  const signal = f.fetch.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => { ++f.endpoint; state = { workspaceLocations: [] }; for (const listener of f.listeners) listener(); });
  expect(signal.aborted).toBe(true);
  await act(async () => reply(Response.json({ resourceOwner, path: '/same', workspaceId: 'old-owner' })));
  expect(f.change).not.toHaveBeenCalled(); expect(view.textContent).not.toContain('Logs');
});

function samePathServices() {
  const serviceA = f.endpoint, serviceB = serviceA + 1;
  const entries = new Map([serviceA, serviceB].map(service => {
    const name = service === serviceA ? 'A' : 'B';
    const owner = { ...resourceOwner, hostId: name, connectionId: 'conn-' + name, endpointIdentity: 'pin-' + name };
    const folder = { kind: 'folder' as const, id: 'bookmark-' + name, name: 'Build logs', path: '/same', workspaceId: 'docs-' + name, resourceOwner: owner };
    return [service, { label: 'Device ' + name, owner, state: { workspaceLocations: [folder], defaultWorkspaceLocationId: null } as SettingsPayload }] as const;
  }));
  const current = () => entries.get(f.endpoint)!;
  f.load.mockImplementation(async () => ({ settings: structuredClone(current().state), source: 'web' }));
  f.list.mockImplementation(async () => ({ targets: [{ resourceOwner: current().owner, label: current().label, capabilities: [] }], unavailable: [] }));
  const switchToB = async () => act(async () => { f.endpoint = serviceB; for (const listener of f.listeners) listener(); });
  return { a: entries.get(serviceA)!, b: entries.get(serviceB)!, at: (service: number) => entries.get(service)!, switchToB };
}
it('never paints a superseded service load over the same named folder at a different physical owner', async () => {
  const { a, b, switchToB } = samePathServices();
  await click('Refresh');
  expect(view.textContent).toContain('Device A'); expect(view.textContent).toContain('/same');
  let release!: () => void;
  f.load.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ settings: structuredClone(a.state), source: 'web' }); }));
  await click('Refresh'); await switchToB();
  expect(view.textContent).toContain('Device B'); expect(view.textContent).toContain('/same');
  await act(async () => release());
  expect([...view.querySelectorAll('option')].map(option => option.value)).toEqual(['', 'bookmark-B']);
  expect(view.textContent).not.toContain('Device A'); expect(f.change).not.toHaveBeenCalled();
  expect(b.state.workspaceLocations![0]).toMatchObject({ resourceOwner: { hostId: 'B' } });
});
it('keeps an already-dispatched A preference write at A when B has an identically named location', async () => {
  const { a, b, at, switchToB } = samePathServices();
  await click('Refresh');
  let ack!: () => void;
  const written = new Set<number>();
  f.change.mockImplementationOnce((change: Extract<WorkspaceLocationChange, { kind: 'set-default' }>) => {
    const ownerAtDispatch = f.endpoint;
    return new Promise(resolve => { ack = () => {
      written.add(ownerAtDispatch); const original = at(ownerAtDispatch); original.state.defaultWorkspaceLocationId = change.id;
      resolve({ settings: structuredClone(original.state) });
    }; });
  });
  const first = f.endpoint;
  await select(view.querySelector('select')!, 'bookmark-A');
  expect(f.change).toHaveBeenCalledExactlyOnceWith({ kind: 'set-default', id: 'bookmark-A', expectedId: null }, expect.any(AbortSignal));
  await switchToB(); await act(async () => ack());
  expect(written).toEqual(new Set([first])); expect(a.state.defaultWorkspaceLocationId).toBe('bookmark-A');
  expect(b.state.defaultWorkspaceLocationId).toBeNull(); expect(view.textContent).toContain('Device B');
  expect([...view.querySelectorAll('option')].map(option => option.value)).toEqual(['', 'bookmark-B']);
  expect(view.querySelector('[role="status"]')?.textContent).not.toBe('Saved');
});
