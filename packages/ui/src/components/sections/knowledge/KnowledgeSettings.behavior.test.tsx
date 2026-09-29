import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import { KnowledgeSettings } from './KnowledgeSettings';
import { SettingsSearchTargetContext } from '@/lib/settings/search-target';

const mocks = vi.hoisted(() => ({
  workspace: {
    status: 'ready' as const,
    workspaceId: 'workspace-a',
    directory: '/workspace-a',
    key: 'workspace-a',
    retry: vi.fn(),
  },
  subscribe: vi.fn(() => () => {}),
  translate: (key: string) => key,
}));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: vi.fn(),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_HELPER_CLASS: '',
  SettingsFieldRow: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>,
  SettingsSection: ({ children, headerAction }: { children: React.ReactNode; headerAction?: React.ReactNode }) => <section>{headerAction}{children}</section>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspace: () => mocks.workspace }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: mocks.subscribe }));

type PendingRequest = {
  url: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
};

let root: Root;
let container: HTMLElement;
let pending: PendingRequest[];

const item = (id: number, scope: 'workspace' | 'user', content: string) => ({
  id,
  scope,
  status: 'suggested',
  content,
  trigger: 'review',
  createdAt: id,
  recallCount: 0,
});

const listResponse = (items: unknown[]) => new Response(JSON.stringify({ items }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const findPending = (needle: string): PendingRequest => {
  const request = pending.find((entry) => entry.url.includes(needle));
  if (!request) throw new Error(`No pending request for ${needle}`);
  return request;
};

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pending = [];
  mocks.workspace.status = 'ready';
  mocks.workspace.workspaceId = 'workspace-a';
  mocks.workspace.directory = '/workspace-a';
  mocks.workspace.key = 'workspace-a';
  vi.mocked(runtimeFetch).mockImplementation((url, init) => new Promise<Response>((resolve) => {
    pending.push({ url: String(url), init, resolve });
  }));
});

afterEach(async () => {
  // Finish intentionally delayed reads so React's async effect work is
  // settled before unmounting the real tree.
  for (const request of pending) {
    request.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
  }
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('KnowledgeSettings request generations', () => {
  it('opens user knowledge directly when reached from settings search', async () => {
    await act(async () => root.render(<SettingsSearchTargetContext.Provider value="knowledge.user"><KnowledgeSettings /></SettingsSearchTargetContext.Provider>));
    expect(findPending('scope=user')).toBeDefined();
    expect(pending.some((request) => request.url.includes('scope=workspace'))).toBe(false);
  });
  it('clears the old scope before a slow response and never writes the old item', async () => {
    await act(async () => root.render(<KnowledgeSettings />));
    expect(findPending('scope=workspace')).toBeDefined();

    const userScopeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'harness.knowledge.scope.user');
    expect(userScopeButton).toBeDefined();
    await act(async () => userScopeButton!.click());
    expect(container.textContent).not.toContain('old workspace item');

    await act(async () => findPending('scope=workspace').resolve(listResponse([item(1, 'workspace', 'old workspace item')])));
    expect(container.textContent).not.toContain('old workspace item');

    await act(async () => findPending('scope=user').resolve(listResponse([item(2, 'user', 'new user item')])));
    expect(container.textContent).toContain('new user item');
    expect(container.textContent).not.toContain('old workspace item');
    // The stale workspace item has no selected controls after the context
    // switch, so there is no path that can submit a write for it.
    expect(pending.some((entry) => entry.init?.method === 'POST')).toBe(false);
  });

  it('keeps the newest workspace response when an older workspace response arrives late', async () => {
    await act(async () => root.render(<KnowledgeSettings />));
    const first = findPending('workspaceId=workspace-a');

    mocks.workspace.workspaceId = 'workspace-b';
    mocks.workspace.directory = '/workspace-b';
    mocks.workspace.key = 'workspace-b';
    await act(async () => root.render(<KnowledgeSettings />));
    const second = findPending('workspaceId=workspace-b');

    await act(async () => second.resolve(listResponse([item(2, 'workspace', 'new workspace item')])));
    expect(container.textContent).toContain('new workspace item');
    await act(async () => first.resolve(listResponse([item(1, 'workspace', 'old workspace item')])));
    expect(container.textContent).toContain('new workspace item');
    expect(container.textContent).not.toContain('old workspace item');
  });
});
