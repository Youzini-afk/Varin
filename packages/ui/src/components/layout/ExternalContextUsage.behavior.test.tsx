import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExternalConversationSnapshot, ExternalTurn } from '@varin/application-client';
import { create } from 'zustand';
const runtime = vi.hoisted(() => ({ host: 1 }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => runtime.host,
}));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: create(() => ({ selectedIdentity: null, selectedDraftKey: null, hostKey: 'first' })) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({}) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({}) } }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipContent: () => null }));
// Base UI selects its browser path at import time.
const initial = parseHTML('<html><body></body></html>');
vi.stubGlobal('window', initial.window);
vi.stubGlobal('document', initial.document);
const { ExternalContextUsage } = await import('./ExternalContextUsage');
import { useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { I18nProvider } from '@/lib/i18n';
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const)
    vi.stubGlobal(key, key === 'window' ? window : window[key]);
  vi.stubGlobal('MouseEvent', window.Event);
  vi.stubGlobal('KeyboardEvent', class extends window.Event {});
  vi.stubGlobal('PointerEvent', class extends window.Event {});
  vi.stubGlobal('FocusEvent', class extends window.Event {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const style = () => ({ direction: 'ltr', position: 'static', display: 'block', visibility: 'visible',
    overflow: 'visible', overflowX: 'visible', overflowY: 'visible', margin: '0px', padding: '0px',
    borderWidth: '0px', transitionDuration: '0s', transitionDelay: '0s', animationDuration: '0s', animationDelay: '0s',
    getPropertyValue: () => '' });
  vi.stubGlobal('getComputedStyle', style);
  Object.defineProperty(window, 'getComputedStyle', { value: style, configurable: true });
  Object.defineProperty(window.document, 'activeElement', { get: () => window.document.body, configurable: true });
  container = window.document.getElementById('root')! as unknown as HTMLElement;
  root = createRoot(container);
  runtime.host = 1;
  useThreadStore.setState({ selectedIdentity: null, selectedDraftKey: null });
  useThreadDraftStore.setState({ drafts: {} });
  useExternalAgentStore.setState({ host: 1, selectedId: 'one', snapshots: {} });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const receipt = (id: string, input: number, scope: 'turn' | 'conversation' = 'turn'): ExternalTurn => ({
  id, key: id, conversationId: 'one', status: 'completed', createdAt: 1, updatedAt: 1,
  usage: { input, output: 10, cachedInput: input / 2, cacheCreated: 0, inputIncludesCache: true, scope },
});
const snapshot = (id: string, revision: number, used?: number): ExternalConversationSnapshot => ({
  conversation: { id } as ExternalConversationSnapshot['conversation'], observationEpoch: 'epoch', observationRevision: revision,
  turns: [receipt('a', 100), receipt('b', 500, 'conversation'), receipt('c', 40)], items: [], interactions: [], connected: true,
  ...(used === undefined ? {} : { contextUsage: { used, size: 1000 } }),
});
const publish = async (value: ExternalConversationSnapshot, host = 1) => {
  await act(async () => useExternalAgentStore.getState().setSnapshot(value, host));
};
const render = async () => { await act(async () => root.render(<I18nProvider><ExternalContextUsage /></I18nProvider>)); };

it('opens native occupancy and scoped cumulative usage without a Varin context inspector', async () => {
  await publish(snapshot('one', 1, 250)); await render();
  expect(container.textContent).toContain('25.0%');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.body.textContent).toContain('Agent-reported context');
  expect(document.body.textContent).toContain('250 / 1,000');
  expect(document.body.textContent).toContain('Conversation total');
  expect(document.body.textContent).toContain('540');
  expect(document.body.textContent).toContain('50.0%');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.body.textContent).toContain('Agent-reported context');
  await publish(snapshot('one', 2));
  expect(container.querySelector('button')).toBeNull();
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

it('rejects stale and wrong-Host snapshots, hides on navigation and preserves a real zero', async () => {
  await publish(snapshot('one', 3, 0)); await render();
  expect(container.textContent).toContain('0.0%');
  await publish(snapshot('one', 2, 900));
  await publish(snapshot('one', 4, 900), 0);
  expect(container.textContent).toContain('0.0%');
  await act(async () => useExternalAgentStore.setState({ selectedId: 'two' }));
  expect(container.querySelector('button')).toBeNull();
  await publish(snapshot('two', 1, 500));
  expect(container.textContent).toContain('50.0%');
  await act(async () => useThreadStore.setState({ selectedIdentity: { runtime: 'agent', threadId: 'native', branchId: 'branch' } }));
  expect(container.querySelector('button')).toBeNull();
  await act(async () => { runtime.host = 2; useThreadStore.setState({ hostKey: 'second', selectedIdentity: null }); });
  expect(useExternalAgentStore.getState().snapshots).toEqual({});
});

it('shows only the prepared external draft binding on the current Host', async () => {
  useThreadDraftStore.getState().patch('draft', { harnessId: 'acp', externalConversationId: 'prepared', externalConversationHost: 1 });
  useThreadStore.setState({ selectedDraftKey: 'draft' });
  await publish(snapshot('prepared', 1, 100)); await render();
  expect(container.textContent).toContain('10.0%');
  await act(async () => useThreadDraftStore.getState().patch('draft', { harnessId: null }));
  expect(container.querySelector('button')).toBeNull();
});

it('keeps a newer view projection when the old publisher unmounts', async () => {
  const old = {}, current = {};
  useExternalAgentStore.getState().setSnapshot(snapshot('one', 1, 100), 1, old);
  useExternalAgentStore.getState().setSnapshot(snapshot('one', 2, 200), 1, current);
  await render();
  await act(async () => useExternalAgentStore.getState().clearSnapshot('one', 1, old));
  expect(container.textContent).toContain('20.0%');
  await act(async () => useExternalAgentStore.getState().clearSnapshot('one', 1, current));
  expect(container.querySelector('button')).toBeNull();
});

it('shows last-request scope without treating it as a total or inventing absent cache data', async () => {
  const value = snapshot('one', 1, 30);
  value.turns = [{ ...receipt('request', 100), usage: { input: 100, scope: 'last_request' } }];
  await publish(value); await render();
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.body.textContent).toContain('Last model request');
  expect(document.body.textContent).not.toContain('Conversation total');
  expect(document.body.textContent).not.toContain('Cache rate');
  expect(document.body.textContent).not.toContain('Cache read');
});
