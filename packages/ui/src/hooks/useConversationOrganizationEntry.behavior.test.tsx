import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { create } from 'zustand';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationOrganizationEntry, ConversationOrganizationRef } from '@varin/application-client';
const f = vi.hoisted(() => ({ host: 1, entry: vi.fn(), openNative: vi.fn(), openExternal: vi.fn(), store: null as unknown }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => f.host }));
vi.mock('./useRuntimeAPIs', () => { const api = { conversationOrganization: { entry: f.entry } }; return { useRuntimeAPIs: () => api }; });
vi.mock('@/stores/useConversationOrganizationStore', () => ({ useConversationOrganization: () => (f.store as typeof store)(), useConversationOrganizationStore: (select: (value: unknown) => unknown) => (f.store as typeof store)(select) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, args?: { name?: string; id?: string }) => `${key} ${args?.name ?? args?.id ?? ''}` }) }));
vi.mock('@/workbenches/bot/BotFigure', () => ({ BotFigure: ({ bot }: { bot: { name: string } }) => <span>{bot.name}</span> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: f.openNative, openExternalConversationFromNavigation: f.openExternal }));
import { useConversationOrganizationEntry } from './useConversationOrganizationEntry';
import { ConversationOrigin } from '@/components/conversation/ConversationOrigin';
const store = create(() => ({ host: 1, snapshot: { cursor: 1, conversations: [] as ConversationOrganizationEntry[] }, bots: [{ id: 'bot', name: 'Original Bot' }], botsError: null })); f.store = store;
const entry = (reference: ConversationOrganizationRef): ConversationOrganizationEntry => ({ conversation: reference, title: 'Nested task', archived: false, pinned: false, revision: 1,
  position: { conversation: reference, containerId: 'unloaded-group', order: 0, revision: 1, explicit: true, inheritedFrom: null }, path: ['unloaded-group'],
  origin: { botId: 'bot', directBotId: null, conversation: { kind: 'native', id: 'original-session' } } });
let root: Root, container: HTMLElement;
function Detail({ reference }: { reference: ConversationOrganizationRef }) {
  const result = useConversationOrganizationEntry(reference);
  return <div>{result.entry && <ConversationOrigin origin={result.entry.origin} />}{result.error && <p role="alert">{result.error}</p>}</div>;
}
beforeEach(() => { const { window, document } = parseHTML('<html><body></body></html>'); for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); f.host = 1; store.setState({ host: 1, snapshot: { cursor: 1, conversations: [] }, bots: [{ id: 'bot', name: 'Original Bot' }], botsError: null }); vi.clearAllMocks(); f.openNative.mockResolvedValue(undefined); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it.each(['native', 'external'] as const)('opens %s provenance without first loading the containing navigation page', async kind => {
  const reference = { kind, id: 'unloaded-task' }; f.entry.mockResolvedValue(entry(reference));
  await act(async () => root.render(<Detail reference={reference} />));
  expect(f.entry).toHaveBeenCalledWith(reference, expect.any(AbortSignal));
  expect(store.getState().snapshot.conversations).toEqual([]);
  expect(container.textContent).toContain('Original Bot');
  await act(async () => container.querySelector('button')!.click());
  expect(f.openNative).toHaveBeenCalledWith({ threadId: 'original-session' });
  await act(async () => store.setState({ snapshot: { cursor: 2, conversations: [] } }));
  expect(f.entry).toHaveBeenCalledTimes(2);
});
it('ignores an old Host reply and distinguishes unavailable provenance from a missing Bot profile', async () => {
  const reference = { kind: 'external' as const, id: 'same-id' };
  let settle!: (value: ConversationOrganizationEntry) => void;
  f.entry.mockImplementationOnce(() => new Promise<ConversationOrganizationEntry>(resolve => { settle = resolve; }));
  await act(async () => root.render(<Detail reference={reference} />));
  const oldSignal = f.entry.mock.calls[0]![1] as AbortSignal;
  f.host = 2; f.entry.mockRejectedValue(new Error('Original metadata unavailable'));
  await act(async () => store.setState({ host: 2, snapshot: { cursor: 1, conversations: [] } }));
  await act(async () => settle(entry(reference)));
  expect(oldSignal.aborted).toBe(true); expect(container.textContent).not.toContain('Original Bot');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Original metadata unavailable');
  f.entry.mockResolvedValue(entry(reference));
  await act(async () => store.setState({ bots: [], snapshot: { cursor: 2, conversations: [] } }));
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('organization.botMissing bot');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
