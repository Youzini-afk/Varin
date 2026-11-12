import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ request: vi.fn(), scope: vi.fn(), localTree: vi.fn(), project: {
  id: 'remote-project', label: 'Remote project', path: '/same/path', source: { workspaceId: 'remote-registration', resourceOwner: {
    kind: 'managed_host' as const, hostId: 'remote-host', connectionId: 'saved-connection', endpointIdentity: 'original-endpoint',
  } },
} }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  createResourceFilesHttpAPI: () => ({ request: fixture.request }), getRuntimeKey: () => 'coordinator',
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ projects: [fixture.project], activeProjectId: fixture.project.id }) }));
vi.mock('@/components/layout/SidebarFilesTree', () => ({ SidebarFilesTree: () => { fixture.localTree(); return <div>Local files</div>; } }));
vi.mock('@/components/workbench/EditorWorkbenchArea', () => ({ EditorWorkbenchArea: () => null }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null, DialogHeader: () => null, DialogTitle: () => null, DialogFooter: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuTrigger: () => null, DropdownMenuSeparator: () => null }));
vi.mock('@/components/ui/DocumentCodeMirror', () => ({ DocumentCodeMirror: () => null }));
vi.mock('@/components/workbench/DocumentMonacoEditor', () => ({ DocumentMonacoEditor: () => null }));
vi.mock('@/components/workbench/DocumentEncodingMenu', () => ({ DocumentEncodingMenu: () => null, DocumentEncodingNotice: () => null }));
vi.mock('@/components/workbench/DocumentConflictBanner', () => ({ DocumentConflictBanner: () => null }));
vi.mock('@/lib/documents/hooks', () => ({ useDocumentRecord: () => undefined }));
vi.mock('@/lib/documents/resource-session', () => ({ getResourceDocumentScope: fixture.scope, retainResourceWorkspace: () => () => {} }));
import { FilesView } from './FilesView';
let root: Root, container: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.scope.mockReturnValue({ documents: {}, api: { watch: () => ({ close() {} }) } });
  fixture.request.mockImplementation(async input => input.command.kind === 'open'
    ? { kind: 'opened', workspaceId: 'remote-registration', root: '/same/path', locations: ['/same/path'] }
    : { kind: 'list', page: { entries: [{ path: 'remote.txt', name: 'remote.txt', kind: 'file', size: 12 }], nextCursor: null } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
test('the ordinary Files surface opens and lists the selected remote project through its original resource owner', async () => {
  await act(async () => root.render(<FilesView />));
  expect(container.textContent).toContain('remote.txt');
  expect(fixture.localTree).not.toHaveBeenCalled();
  expect(fixture.scope).toHaveBeenCalledWith(fixture.project.source.resourceOwner);
  expect(fixture.request.mock.calls[0]![0]).toEqual({ resourceOwner: fixture.project.source.resourceOwner, selection: { mode: 'live_root' }, command: { kind: 'open', path: '/same/path' } });
  expect(fixture.request.mock.calls[1]![0]).toMatchObject({ resourceOwner: fixture.project.source.resourceOwner, workspaceId: 'remote-registration', command: { kind: 'list' } });
});
test('an offline resource stays a visible unavailable project, with no local-path fallback', async () => {
  fixture.request.mockRejectedValue(new Error('Remote Host is offline'));
  await act(async () => root.render(<FilesView />));
  expect(container.textContent).toContain('Remote project');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Remote Host is offline');
  expect(fixture.localTree).not.toHaveBeenCalled();
  expect(fixture.request).toHaveBeenCalledTimes(1);
});
