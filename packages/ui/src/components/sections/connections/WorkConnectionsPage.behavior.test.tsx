import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadSourceTargets } from '@varin/application-client';
import type { ComputerCatalog } from '@/lib/computers';

const fixture = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), sources: vi.fn(), computers: vi.fn(),
  selected: {} as { identity: ThreadIdentity | null; snapshot?: ThreadSnapshot; error?: string },
  translate: (key: string) => key,
}));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => fixture.generation, getRuntimeApiBaseUrl: () => 'https://host.example',
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/hooks/useRuntimeAPIs', () => { const threads = { sources: { list: fixture.sources } }; return { useRuntimeAPIs: () => ({ threads }) }; });
vi.mock('@/hooks/useSelectedThreadSnapshot', () => ({ useSelectedThreadSnapshot: () => fixture.selected }));
vi.mock('@/lib/computers', () => ({ listComputers: fixture.computers }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate }) }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, isDesktopLocalOriginActive: () => false }));
vi.mock('@/lib/platform', () => ({ getClientPlatform: () => 'web' }));
vi.mock('@/lib/desktopHosts', () => ({ redactSensitiveUrl: (url: string) => url }));
vi.mock('./DesktopLocalHostSettings', () => ({ DesktopLocalHostSettings: () => null }));
vi.mock('@/lib/settings/drafts', () => ({ requestSettingsNavigation: (proceed: () => void) => proceed() }));
vi.mock('@/components/sections/remote-instances/RemoteInstancesPage', () => ({ RemoteInstancesPage: () => null }));
vi.mock('@/components/desktop/DesktopHostSwitcher', () => ({ DesktopHostSwitcherInline: () => null }));
vi.mock('@/components/sections/shared/SettingsPageLink', () => ({ SettingsPageLink: () => null }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <main>{children}</main> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
import { WorkConnectionsPage } from './WorkConnectionsPage';

let root: Root, container: HTMLDivElement;
const source = (mode: 'live_root' | 'materialized' | 'fixed_branch' = 'materialized') => ({ mode, workspace_id: 'original-workspace', execution_workspace_id: 'execution-copy', branch_id: 'branch', revision: 1, live_root: null,
  resource_owner: { kind: 'managed_host' as const, hostId: 'host-shared-id', connectionId: 'correct-connection', endpointIdentity: 'correct-endpoint' } });
const snapshot = (mode?: 'live_root' | 'materialized' | 'fixed_branch') => ({ launch: { selection: { source: source(mode) } } }) as ThreadSnapshot;
const render = () => act(async () => root.render(<WorkConnectionsPage />));
beforeEach(() => {
  vi.clearAllMocks(); fixture.generation += 1;
  fixture.selected = { identity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' } };
  fixture.sources.mockResolvedValue({ targets: [], unavailable: [] } satisfies ThreadSourceTargets);
  fixture.computers.mockResolvedValue({ machines: [], desktops: [], defaultDesktopId: null } satisfies ComputerCatalog);
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const card = (title: string) => [...container.querySelectorAll('h2')].find(node => node.textContent === title)!.parentElement!;

it('keeps unknown source and missing configured desktop distinct from no source and automatic selection', async () => {
  fixture.computers.mockResolvedValue({ machines: [], desktops: [], defaultDesktopId: 'removed-desktop' });
  await render();
  expect(card('settings.connections.files').textContent).toContain('common.loading');
  expect(card('settings.connections.files').textContent).not.toContain('settings.connections.noSource');
  expect(card('settings.connections.computerDefault').textContent).toContain('settings.connections.resourceUnavailable');
  expect(card('settings.connections.computerDefault').textContent).not.toContain('settings.connections.automaticDesktop');
  fixture.selected = { ...fixture.selected, snapshot: { launch: null } as ThreadSnapshot }; await render();
  expect(card('settings.connections.files').textContent).toContain('settings.connections.noSource');
});

it('uses the complete source authority identity and shows the actual execution copy', async () => {
  fixture.selected.snapshot = snapshot();
  const owner = source().resource_owner;
  fixture.sources.mockResolvedValue({ targets: [
    { resourceOwner: { ...owner, connectionId: 'wrong', endpointIdentity: 'wrong' }, label: 'Wrong Host alias', capabilities: [] },
    { resourceOwner: owner, label: 'Actual source Host', capabilities: [] },
  ], unavailable: [] });
  await render();
  const files = card('settings.connections.files').textContent;
  expect(files).toContain('Actual source Host'); expect(files).not.toContain('Wrong Host alias');
  expect(files).toContain('settings.connections.sourceMode.materialized'); expect(files).toContain('execution-copy');
  fixture.selected = { ...fixture.selected, snapshot: snapshot('fixed_branch') }; await render();
  expect(card('settings.connections.files').textContent).toContain('settings.connections.sourceMode.fixed_branch');
  expect(card('settings.connections.files').textContent).not.toContain('execution-copy');
});

it('fences late resource discovery when the endpoint generation changes even with the same Host identity', async () => {
  let finishOld!: (value: ComputerCatalog) => void;
  fixture.computers.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await render();
  const oldSignal = fixture.sources.mock.calls[0][1] as AbortSignal;
  await act(async () => { fixture.generation += 1; for (const listener of fixture.listeners) listener(); });
  expect(oldSignal.aborted).toBe(true); expect(fixture.sources).toHaveBeenCalledTimes(2);
  await act(async () => finishOld({ machines: [], desktops: [], defaultDesktopId: 'old-default' }));
  expect(card('settings.connections.computerDefault').textContent).toContain('settings.connections.automaticDesktop');
  expect(card('settings.connections.computerDefault').textContent).not.toContain('settings.connections.resourceUnavailable');
});
