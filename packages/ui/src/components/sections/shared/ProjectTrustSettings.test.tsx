import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VarinEvent } from '@/lib/varinEvents';
const fixture = vi.hoisted(() => ({ host: 1, fetch: vi.fn(), resolve: vi.fn(), listeners: new Set<() => void>(), events: undefined as ((event: VarinEvent) => void) | undefined }));
const documents = { resolveWorkspace: fixture.resolve };
vi.mock('@varin/application-client', () => ({ runtimeFetch: fixture.fetch, getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => { fixture.events = listener; return () => { fixture.events = undefined; }; } }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ documents }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: '/one' }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, onOpenChange, children }: React.PropsWithChildren<{ open: boolean; onOpenChange(open: boolean): void }>) => open ? <div role="dialog"><button onClick={() => onOpenChange(false)}>Dismiss</button>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
import { ProjectTrustSettings } from './ProjectTrustSettings';
let root: Root, container: HTMLDivElement;
const snapshot = (workspaceId = 'workspace:/one', decision: boolean | null = null) => ({ workspaceId, path: workspaceId.replace('workspace:', '/canonical'), decision, directDecision: decision, revision: decision === true ? 'accepted' : 'initial' });
beforeEach(() => {
  fixture.host += 1; vi.clearAllMocks();
  fixture.resolve.mockImplementation(async ({ path }) => ({ workspaceId: `workspace:${path}` }));
  fixture.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    return { ok: true, json: async () => snapshot(body.workspaceId, url.endsWith('update') ? body.decision : null) };
  });
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text: string, dialog = false) => [...(dialog ? container.querySelector('[role="dialog"]')! : container).querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
const updates = () => fixture.fetch.mock.calls.filter(([url]) => url.endsWith('update'));
const mount = (directory = '/one') => act(async () => { root.render(<ProjectTrustSettings directory={directory} />); });

it('shows the canonical project in an asynchronous review and submits only once after approval', async () => {
  await mount();
  await act(async () => { button('settings.projectTrust.trust').click(); button('settings.projectTrust.trust').click(); });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('/canonical/one'); expect(updates()).toHaveLength(0);
  await act(async () => button('settings.projectTrust.trust', true).click());
  expect(updates()).toHaveLength(1);
  expect(JSON.parse(updates()[0][1].body)).toMatchObject({ workspaceId: 'workspace:/one', expectedPath: '/canonical/one', expectedRevision: 'initial', decision: true });
});

it.each(['cancel', 'dismiss', 'project', 'host', 'invalidation'] as const)('retires the review on %s and never writes through a stale callback', async reason => {
  await mount(); await act(async () => button('settings.projectTrust.trust').click());
  const oldApprove = button('settings.projectTrust.trust', true);
  if (reason === 'cancel') await act(async () => button('settings.common.actions.cancel', true).click());
  if (reason === 'dismiss') await act(async () => button('Dismiss', true).click());
  if (reason === 'project') await mount('/two');
  if (reason === 'host') await act(async () => { fixture.host += 1; for (const listener of fixture.listeners) listener(); });
  if (reason === 'invalidation') await act(async () => fixture.events?.({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'revoked', ids: ['project-trust'] }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => oldApprove.click()); expect(updates()).toHaveLength(0);
});

it('does not publish a late old project read over the newly selected project', async () => {
  let resolve!: (value: unknown) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount('/one'); await mount('/two');
  await act(async () => resolve({ ok: true, json: async () => snapshot('workspace:/one', true) }));
  expect(container.textContent).toContain('/canonical/two'); expect(container.textContent).not.toContain('/canonical/one');
  expect(button('settings.projectTrust.trust').disabled).toBe(false);
});

it('keeps save errors visible and offers a fresh revision instead of automatically retrying approval', async () => {
  await mount(); await act(async () => button('settings.projectTrust.trust').click());
  fixture.fetch.mockRejectedValueOnce(new Error('Settings changed. Reload before saving.'));
  await act(async () => button('settings.projectTrust.trust', true).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Settings changed'); expect(updates()).toHaveLength(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
