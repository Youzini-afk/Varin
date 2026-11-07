import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Followup } from '@varin/protocol';
import type { ThreadFollowupsAPI, ThreadSummary, ExternalConversation } from '@varin/application-client';
import { ArrangementSourceRoutes } from './ArrangementSourceRoutes';
const state = vi.hoisted(() => ({ host: 1, threads: [] as ThreadSummary[], external: [] as ExternalConversation[], readExternal: vi.fn() }));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => state.host, createExternalAgentsHttpAPI: () => ({ read: state.readExternal }) }));
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => ({ agents: [{ id: 'external-config', enabled: true }] }), useExternalAgentStore: (selector: (value: unknown) => unknown) => selector({ conversations: state.external, children: [], error: null }) }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (selector: (state: { threads: ThreadSummary[] }) => unknown) => selector({ threads: state.threads }) }));
vi.mock('@/lib/i18n', async () => { const { followupPanelEn: messages } = await import('@/lib/i18n/messages/followups'); return { useI18n: () => ({ t: (key: string, params: Record<string, unknown> = {}) => ((messages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')) }) }; });
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
const identity = { runtime: 'agent' as const, threadId: 'bot-entry', branchId: 'main' };
const item = { id: 'watch', revision: 4, owner: { kind: 'bot', bot_id: 'bot' }, trigger: { kind: 'plugin_event', source: { extensionId: 'mail', sourceId: 'chat', accountId: 'account', connectionId: 'connection' } } } as Followup;
const thread = (id: string, extra = {}): ThreadSummary => ({ thread_id: id, title: id, branches: [{ branch_id: 'main' }], ...extra } as ThreadSummary);
let root: Root, container: HTMLElement, props: React.ComponentProps<typeof ArrangementSourceRoutes>;
const sourceRoutes = vi.fn<ThreadFollowupsAPI['sourceRoutes']>();
const removeSourceRoute = vi.fn<ThreadFollowupsAPI['removeSourceRoute']>();
const putSourceRoute = vi.fn<ThreadFollowupsAPI['putSourceRoute']>();
const field = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const button = (text: string) => [...container.querySelectorAll('button')].find(value => value.textContent === text)!;
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<ArrangementSourceRoutes {...props} />)); };
const click = async (text: string) => { await act(async () => button(text).click()); };
const edit = async (label: string, value: string) => { await act(async () => { const element = field(label); Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); };
beforeEach(() => {
  state.external = []; state.readExternal.mockReset().mockImplementation(async (id: string) => ({ conversation: state.external.find(value => value.id === id), connected: true, capabilities: { resume: false }, turns: [], items: [] }));
  const { window } = parseHTML('<html><body></body></html>'); vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); state.host = 1;
  state.threads = [thread('bot-entry', { bot_id: 'bot' }), thread('task'), thread('other-bot', { bot_id: 'other' }), thread('child-task', { bot_id: 'other', parent_thread_id: 'other-bot' })];
  sourceRoutes.mockReset().mockResolvedValue([]); removeSourceRoute.mockReset().mockResolvedValue({ ...item, revision: 5 }); putSourceRoute.mockReset().mockResolvedValue({ ...item, revision: 5 });
  props = { api: { sourceRoutes, putSourceRoute, removeSourceRoute } as unknown as ThreadFollowupsAPI, identity, item, pending: false, act: async work => { try { await work(); } catch { /* Parent may report action errors independently. */ } } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('loads original mappings and saves exact object and selected ordinary task without changing outer authorization', async () => {
  sourceRoutes.mockResolvedValue([{ followupId: 'watch', expectedRevision: 4, objectId: 'existing-object', threadId: 'task', branchId: 'main', userInput: false }]);
  await render(); expect(sourceRoutes).toHaveBeenCalledWith(identity, 'watch', expect.any(AbortSignal)); expect(container.textContent).toContain('existing-object → task');
  const choices = [...field('Linked conversation or task').querySelectorAll('option')].map(option => option.textContent);
  expect(choices).toContain('child-task'); expect(choices).not.toContain('other-bot');
  await edit('Exact source object ID', ' object:exact '); await edit('Linked conversation or task', JSON.stringify(['child-task', 'main'])); await click('Save object link');
  expect(putSourceRoute).toHaveBeenCalledExactlyOnceWith({ ...identity, route: { followupId: 'watch', expectedRevision: 4, objectId: ' object:exact ', threadId: 'child-task', branchId: 'main', externalConversationId: null, userInput: false, senderId: null } });
  expect(container.textContent).toContain('Object link saved.');
});
it('preserves draft and revision through refresh and retries an uncertain write only on explicit action', async () => {
  putSourceRoute.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ ...item, revision: 9 });
  await render(); await edit('Exact source object ID', 'object'); await edit('Linked conversation or task', JSON.stringify(['task', 'main']));
  await render({ item: { ...item, revision: 8 } }); await click('Refresh links'); expect(field('Exact source object ID').value).toBe('object');
  await click('Save object link'); expect(putSourceRoute.mock.calls[0]![0].route.expectedRevision).toBe(4); expect(field('Exact source object ID').disabled).toBe(true);
  await click('Refresh links'); expect(putSourceRoute).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('reply lost');
  await click('Retry original save'); expect(putSourceRoute.mock.calls[1]![0]).toEqual(putSourceRoute.mock.calls[0]![0]);
});
it('requires explicit user-input selection and exact sender before granting user input routing', async () => {
  await render(); await edit('Exact source object ID', 'conversation'); await edit('Linked conversation or task', JSON.stringify(['task', 'main']));
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(field('Exact sender ID')).not.toBeNull(); expect(button('Save object link').disabled).toBe(true);
  expect(container.textContent).toContain('account (account), object (conversation)');
  await edit('Exact sender ID', 'sender:me'); await click('Save object link');
  expect(putSourceRoute.mock.calls[0]![0].route).toMatchObject({ userInput: true, senderId: 'sender:me' });
});
it('retains known routes after read failure and blocks vanished target until explicitly repaired', async () => {
  await render(); await edit('Exact source object ID', 'object'); await edit('Linked conversation or task', JSON.stringify(['task', 'main']));
  sourceRoutes.mockRejectedValueOnce(new Error('Disconnected')); state.threads = [thread('bot-entry', { bot_id: 'bot' })]; await render(); await click('Refresh links');
  expect(container.textContent).toContain('Disconnected'); expect(button('Save object link').disabled).toBe(true); expect(field('Exact source object ID').value).toBe('object');
  await edit('Linked conversation or task', JSON.stringify(['bot-entry', 'main'])); await click('Save object link'); expect(putSourceRoute).toHaveBeenCalledTimes(1);
});

it('removes only the explicitly selected object through the original management identity', async () => {
  sourceRoutes.mockResolvedValue([{ followupId: 'watch', expectedRevision: 4, objectId: 'object-a', threadId: 'task', branchId: 'main', userInput: false }]);
  await render(); expect(removeSourceRoute).not.toHaveBeenCalled(); await click('Remove link for object-a');
  expect(removeSourceRoute).toHaveBeenCalledExactlyOnceWith({ ...identity, followupId: 'watch', expectedRevision: 4, objectId: 'object-a' });
});

it('links an object to an external conversation while retaining the native anchor and clears it on explicit native reassignment', async () => {
  state.external = [{ id: 'external-task', title: 'Codex task', configurationId: 'external-config', harness: 'codex', revision: 1 } as ExternalConversation];
  await render(); await edit('Exact source object ID', 'issue-17'); await edit('Linked conversation or task', JSON.stringify(['external', 'external-task', null])); await click('Save object link');
  expect(putSourceRoute.mock.calls[0]![0]).toMatchObject({ ...identity, route: { threadId: identity.threadId, branchId: identity.branchId, externalConversationId: 'external-task', objectId: 'issue-17' } });
  await edit('Linked conversation or task', JSON.stringify(['task', 'main'])); await click('Save object link');
  expect(putSourceRoute.mock.calls[1]![0].route).toMatchObject({ threadId: 'task', branchId: 'main', externalConversationId: null });
});

it('edits an existing external object route without replacing its original native anchor with the management entry', async () => {
  state.external = [{ id: 'external-task', title: 'Codex task', configurationId: 'external-config', harness: 'codex', revision: 1 } as ExternalConversation];
  sourceRoutes.mockResolvedValue([{ followupId: 'watch', expectedRevision: 4, objectId: 'existing-external', threadId: 'original-native-anchor', branchId: 'original-native-branch', externalConversationId: 'external-task', userInput: false }]);
  await render(); await click('Edit link for existing-external'); await click('Save object link');
  expect(putSourceRoute.mock.calls[0]![0]).toMatchObject({ ...identity, route: { threadId: 'original-native-anchor', branchId: 'original-native-branch', externalConversationId: 'external-task', objectId: 'existing-external' } });
});
