import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ProjectEntry } from '@varin/application-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  host: 1, listeners: new Set<() => void>(), resolve: vi.fn(), fetch: vi.fn(), add: vi.fn(), start: vi.fn(), close: vi.fn(),
  projects: [] as ProjectEntry[], decisions: new Map<string, boolean>(), revision: 1, calls: [] as string[],
}));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  runtimeFetch: fixture.fetch, getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ documents: { resolveWorkspace: fixture.resolve } }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: Object.assign(
  (select: (store: unknown) => unknown) => select({ addProject: fixture.add }),
  { getState: () => ({ projects: fixture.projects }) },
) }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ startThreadFromNavigation: fixture.start }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>, DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
}));
vi.mock('./ProjectFoldersEditor', () => ({ ProjectFoldersEditor: ({ onChange, disabled }: { onChange(value: string[]): void; disabled: boolean }) =>
  <button type="button" disabled={disabled} onClick={() => onChange(['/one', '/two'])}>Choose folders</button> }));
import { ProjectCreateDialog } from './ProjectCreateDialog';

let root: Root, container: HTMLElement;
const read = (workspaceId: string) => ({ workspaceId, path: '/canonical' + workspaceId.slice(3),
  decision: fixture.decisions.get(workspaceId) ?? null, directDecision: fixture.decisions.get(workspaceId) ?? null, revision: String(fixture.revision) });
beforeEach(async () => {
  fixture.projects = []; fixture.host++; fixture.revision = 1; fixture.decisions.clear(); fixture.calls = [];
  vi.clearAllMocks();
  fixture.resolve.mockImplementation(async ({ path }) => ({ workspaceId: 'ws:' + path }));
  fixture.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (url.endsWith('/update')) {
      expect(body.expectedRevision).toBe(String(fixture.revision));
      expect(body.expectedPath).toBe('/canonical' + body.workspaceId.slice(3));
      fixture.decisions.set(body.workspaceId, body.decision); fixture.revision++; fixture.calls.push('trust:' + body.workspaceId);
    }
    return Response.json(read(body.workspaceId));
  });
  fixture.add.mockImplementation(async (path, options) => {
    fixture.calls.push('create');
    const project = { id: 'project:one', path, ...options }; fixture.projects.push(project); return project;
  });
  fixture.start.mockImplementation(async () => { fixture.calls.push('open'); return 'draft'; });
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ProjectCreateDialog open onOpenChange={fixture.close} />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
const create = async () => {
  await click('Choose folders');
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
};
const updates = () => fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/update'));

test('reviews canonical folders before adding a project and can continue without granting trust', async () => {
  await create();
  expect(container.textContent).toContain('projects.create.trustTitle');
  expect(container.textContent).toContain('/canonical/one'); expect(container.textContent).toContain('/canonical/two');
  expect(fixture.add).not.toHaveBeenCalled(); expect(updates()).toHaveLength(0);
  await click('projects.create.withoutTrust');
  expect(updates()).toHaveLength(0);
  expect(fixture.add).toHaveBeenCalledExactlyOnceWith('/one', { label: 'one', additionalPaths: ['/two'] });
  expect(fixture.calls).toEqual(['create', 'open']);
});
test('explicit trust is written in revision order before project activation, with duplicate clicks ignored', async () => {
  await create();
  const approve = button('projects.create.trustAndCreate');
  await act(async () => { approve.click(); approve.click(); });
  expect(fixture.calls).toEqual(['trust:ws:/one', 'trust:ws:/two', 'create', 'open']);
  expect(fixture.close).toHaveBeenCalledWith(false);
});
test('a cancelled review and a stale Host callback never grant trust', async () => {
  await create(); await click('projects.create.back');
  expect(fixture.add).not.toHaveBeenCalled(); expect(updates()).toHaveLength(0);
  await create(); const stale = button('projects.create.trustAndCreate');
  await act(async () => { fixture.host++; for (const listener of fixture.listeners) listener(); });
  await act(async () => stale.click());
  expect(updates()).toHaveLength(0); expect(fixture.add).not.toHaveBeenCalled();
});
test('existing trust is reused without asking again or writing a grant', async () => {
  fixture.decisions.set('ws:/one', true); fixture.decisions.set('ws:/two', true);
  await create();
  expect(updates()).toHaveLength(0); expect(fixture.calls).toEqual(['create', 'open']);
});
test('failed trust does not create a project and a changed canonical folder is never approved', async () => {
  await create();
  fixture.fetch.mockImplementationOnce(async () => Response.json({ ...read('ws:/one'), path: '/changed' }));
  await click('projects.create.trustAndCreate');
  expect(container.querySelector('[role=alert]')?.textContent).toBe('projects.create.trustChanged');
  expect(updates()).toHaveLength(0); expect(fixture.add).not.toHaveBeenCalled();
  fixture.fetch.mockImplementationOnce(async () => Response.json(read('ws:/one')))
    .mockRejectedValueOnce(new Error('trust write failed'));
  await click('projects.create.trustAndCreate');
  expect(container.querySelector('[role=alert]')?.textContent).toBe('trust write failed');
  expect(fixture.add).not.toHaveBeenCalled();
});
test('unavailable trust lookup does not force a grant or prevent creating with unchanged trust', async () => {
  fixture.fetch.mockRejectedValueOnce(new Error('trust lookup unavailable'));
  await create();
  expect(fixture.add).not.toHaveBeenCalled(); expect(updates()).toHaveLength(0);
  await click('projects.create.unchangedTrust');
  expect(fixture.calls).toEqual(['create', 'open']); expect(updates()).toHaveLength(0);
});
