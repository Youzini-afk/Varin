import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Followup, ThreadSummary } from '@varin/protocol';
import type { ScheduledTask, ThreadFollowupsAPI, ExternalConversation, ExternalConversationSnapshot, ExternalDelegation } from '@varin/application-client';
import type { VarinEventSourceDescriptor } from '@varin/extension-contract';
import { ThreadEventArrangements } from './ThreadEventArrangements';

const state = vi.hoisted(() => ({ host: 1, threads: [] as ThreadSummary[], list: vi.fn(), settings: vi.fn(), external: [] as ExternalConversation[], children: [] as ExternalDelegation[], readExternal: vi.fn() }));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => state.host, createScheduledTasksHttpAPI: () => ({ list: state.list }), createExternalAgentsHttpAPI: () => ({ read: state.readExternal }) }));
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => ({ agents: [{ id: 'external-config', enabled: true }] }), useExternalAgentStore: (selector: (value: unknown) => unknown) => selector({ conversations: state.external, children: state.children, error: null }) }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (selector: (state: { threads: ThreadSummary[] }) => unknown) => selector({ threads: state.threads }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setSettingsPage: state.settings, setSettingsDialogOpen: vi.fn() }) } }));
vi.mock('@/lib/i18n', async () => { const { followupPanelEn } = await import('@/lib/i18n/messages/followups'); const messages: Record<string, string> = followupPanelEn; return { useI18n: () => ({ t: (key: string, params: Record<string, unknown> = {}) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')) }) }; });
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const Disclosure = React.createContext({ open: false, toggle: () => {} });
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ open, onOpenChange, children }: React.PropsWithChildren<{ open: boolean; onOpenChange(open: boolean): void }>) => <Disclosure.Provider value={{ open, toggle: () => onOpenChange(!open) }}>{children}</Disclosure.Provider>,
  CollapsibleTrigger: ({ children, asChild }: React.PropsWithChildren<{ asChild?: boolean }>) => {
    const value = React.useContext(Disclosure);
    const props = { 'aria-expanded': value.open, onClick: value.toggle };
    return asChild && React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>, props)
      : <button {...props}>{children}</button>;
  },
  CollapsibleContent: ({ children }: React.PropsWithChildren) => { const { open } = React.useContext(Disclosure); return <div hidden={!open}>{children}</div>; },
}));
const identity = { runtime: 'agent' as const, threadId: 'bot-entry', branchId: 'main' };
const source: VarinEventSourceDescriptor = { extensionId: 'inbox', sourceId: 'arrived', displayName: 'Support inbox', credentials: 'required', available: true, recovery: 'history', modes: ['poll'],
  connections: [{ connectionId: 'work', accountId: 'generation-1', displayName: 'Work mailbox', available: true }],
  filterSchema: { type: 'object', required: ['folder'], additionalProperties: false, properties: { folder: { type: 'string', title: 'Folder', minLength: 1 }, unread: { type: 'boolean', title: 'Unread only' }, priority: { type: 'integer', minimum: 1, title: 'Minimum priority' } } } };
const watch = (): Followup => ({ id: 'watch', revision: 4, generation: 1, name: 'Customer replies', owner: { kind: 'bot', bot_id: 'bot' }, thread_id: 'task', branch_id: 'branch', source_run_id: null,
  trigger: { kind: 'plugin_event', source: { extensionId: 'inbox', sourceId: 'arrived', connectionId: 'work', accountId: 'generation-1' }, filter: { folder: 'support' } }, timing: { kind: 'passive' }, repeat: 'each', state: 'active', pending_events: 2, pending_occurrences: 0, next_delivery_at_ms: null, source_status: null,
  actor: { kind: 'user' }, sources: [], has_instruction: true, registered_at_ms: 1, goal_id: null, occurrence: null, observation: null, exhausted: false, wait: { id: 'wait', kind: 'plugin_event', after_cursor: 0, trigger_cursor: null, state: 'waiting' } });
const thread = (id: string, branch: string, extra = {}): ThreadSummary => ({ thread_id: id, title: id, branches: [{ branch_id: branch }], bot_id: null, ...extra } as ThreadSummary);
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
let root: Root, container: HTMLElement, props: React.ComponentProps<typeof ThreadEventArrangements>;
const eventSources = vi.fn<ThreadFollowupsAPI['eventSources']>();
const putArrangement = vi.fn<ThreadFollowupsAPI['putArrangement']>();
const get = vi.fn<ThreadFollowupsAPI['get']>();
const control = vi.fn<ThreadFollowupsAPI['control']>();
const backlog = vi.fn<ThreadFollowupsAPI['backlog']>();
const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(<ThreadEventArrangements {...props} />)); };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => !element.closest('[hidden]') && element.textContent === text)!;
const click = async (text: string) => { const element = button(text); expect(element, text).toBeTruthy(); await act(async () => element.click()); };
const field = (label: string) => [...container.querySelectorAll<HTMLInputElement>(`[aria-label="${label}"]`)].find(element => !element.closest('[hidden]')) ?? null!;
const edit = async (label: string, value: string) => { const element = field(label); expect(element, label).toBeTruthy(); await act(async () => {
  Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}); };
const fill = async () => { await click('Watch an event source'); await edit('Name', 'Important replies'); await edit('Event source', JSON.stringify(['inbox', 'arrived'])); await edit('Connection', JSON.stringify(['work', 'generation-1'])); await edit('Folder *', 'support'); await edit('What should happen', 'Investigate unanswered questions'); };
beforeEach(() => {
  const { window } = parseHTML('<html><body></body></html>'); vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); state.host = 1;
  state.external = []; state.children = []; state.readExternal.mockReset().mockImplementation(async (id: string) => ({ conversation: state.external.find(value => value.id === id), connected: true, capabilities: { resume: false }, turns: [], items: [], interactions: [] } as unknown as ExternalConversationSnapshot));
  state.threads = [thread('bot-entry', 'main', { bot_id: 'bot' }), thread('task', 'branch'), thread('other-bot', 'main', { bot_id: 'other' })];
  eventSources.mockReset().mockResolvedValue([source]); putArrangement.mockReset().mockResolvedValue(watch()); get.mockReset().mockResolvedValue({ followup: watch(), instruction: 'Original intent', registration_trigger: null });
  control.mockReset().mockResolvedValue(watch()); backlog.mockReset().mockResolvedValue(watch()); state.list.mockReset().mockResolvedValue([]);
  props = { api: { eventSources, putArrangement, get, control, backlog } as unknown as ThreadFollowupsAPI, identity, botId: 'bot', followups: [], pending: false, act: async work => { await work(); }, records: item => <p>Actual record {item.id}</p> };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('creates from actual schema fields and explicitly chosen task without changing the management identity', async () => {
  await render(); await fill(); await edit('Unread only', 'true'); await edit('Minimum priority', '2'); await edit('Receiving conversation or task', JSON.stringify(['task', 'branch']));
  expect([...field('Receiving conversation or task').querySelectorAll('option')].map(option => option.textContent)).not.toContain('other-bot');
  await edit('When to process', 'batch'); await edit('Gathering window (seconds)', '1.5'); await click('Save arrangement');
  expect(putArrangement).toHaveBeenCalledExactlyOnceWith({ ...identity, arrangement: expect.objectContaining({ botId: 'bot', threadId: 'task', branchId: 'branch', name: 'Important replies', source: { extensionId: 'inbox', sourceId: 'arrived', connectionId: 'work', accountId: 'generation-1' }, filter: { folder: 'support', unread: true, priority: 2 }, timing: { kind: 'batch', windowMs: 1500 } }) });
});
it('offers only real Calendar definitions for the selected target and preserves empty-run intent', async () => {
  const schedule = (id: string, target: string): ScheduledTask => ({ id, name: id, enabled: true, target: { kind: 'existing_work', threadId: target, branchId: target === 'task' ? 'branch' : 'main' }, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, calendar: { definition: { id: `definition-${id}`, deleted: false } } } as ScheduledTask);
  state.list.mockResolvedValue([schedule('Daily review', 'task'), schedule('Other conversation', 'other')]);
  await render(); await fill(); await edit('Receiving conversation or task', JSON.stringify(['task', 'branch'])); await edit('When to process', 'scheduled');
  expect(state.list).toHaveBeenCalledWith('bot:bot', expect.any(AbortSignal));
  expect(field('Calendar schedule').textContent).toContain('Daily review'); expect(field('Calendar schedule').textContent).not.toContain('Other conversation');
  expect(button('Save arrangement').disabled).toBe(true); await edit('Calendar schedule', 'definition-Daily review');
  const checkbox = field('Run even when no new events arrive');
  await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
  await click('Save arrangement'); expect(putArrangement.mock.calls[0]![0].arrangement.timing).toMatchObject({ kind: 'scheduled', calendarId: 'definition-Daily review', runEmpty: true });
});
it('retains drafts through close/reopen and source refresh, then retries an unknown save with identical key and payload', async () => {
  putArrangement.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce(watch());
  await render(); await fill(); await edit('When to process', 'passive'); await click('Close editor'); await click('Watch an event source'); expect(field('Name').value).toBe('Important replies');
  eventSources.mockResolvedValue([{ ...source, displayName: 'Updated source name' }]); await click('Refresh sources'); expect(field('Folder *').value).toBe('support');
  await click('Save arrangement'); const original = putArrangement.mock.calls[0]![0]; expect(field('Name').disabled).toBe(true); expect(container.textContent).toContain('Acceptance is unconfirmed');
  await click('Close editor'); await click('Watch an event source'); await click('Retry original save');
  expect(putArrangement.mock.calls[1]![0]).toEqual(original); expect(putArrangement.mock.calls[1]![0].arrangement.timing).toEqual({ kind: 'passive' });
});
it('keeps the original account generation and unavailable saved target until the user explicitly repairs both', async () => {
  state.external = []; state.children = []; state.readExternal.mockReset().mockImplementation(async (id: string) => ({ conversation: state.external.find(value => value.id === id), connected: true, capabilities: { resume: false }, turns: [], items: [], interactions: [] } as unknown as ExternalConversationSnapshot));
  state.threads = [thread('bot-entry', 'main', { bot_id: 'bot' })]; eventSources.mockResolvedValue([{ ...source, connections: [{ ...source.connections[0]!, accountId: 'generation-2' }] }]);
  await render({ followups: [watch()], focusId: 'watch' }); await click('Edit arrangement');
  expect(get).toHaveBeenCalledWith(identity, 'watch'); expect(field('Receiving conversation or task').value).toBe(JSON.stringify(['task', 'branch'])); expect(container.textContent).toContain('saved account is unavailable'); expect(button('Save arrangement').disabled).toBe(true);
  await edit('Connection', JSON.stringify(['work', 'generation-2'])); await edit('Receiving conversation or task', JSON.stringify(['bot-entry', 'main'])); await click('Save arrangement');
  expect(putArrangement.mock.calls[0]![0]).toMatchObject({ ...identity, arrangement: { key: 'watch', expectedRevision: 4, source: { accountId: 'generation-2' }, threadId: 'bot-entry', branchId: 'main' } });
});
it('preserves an edit basis and draft across status refresh, search hiding and interrupted disclosure', async () => {
  await render({ followups: [watch()], focusId: 'watch' }); await click('Edit arrangement'); await edit('What should happen', 'Unfinished draft');
  await render({ followups: [{ ...watch(), revision: 8, pending_events: 5 }], visibleArrangementIds: new Set() }); await render({ visibleArrangementIds: new Set(['watch']) });
  await click('Close editor'); await click('Edit arrangement'); expect(field('What should happen').value).toBe('Unfinished draft');
  await click('Save arrangement'); expect(putArrangement.mock.calls[0]![0].arrangement).toMatchObject({ expectedRevision: 4, instruction: 'Unfinished draft', threadId: 'task', branchId: 'branch' });
});
it('uses owner management authorization for pause, resume, process, cancel and explicitly confirmed discard', async () => {
  await render({ followups: [watch()], focusId: 'watch' }); await click('Pause watch'); await click('Process now'); await click('Continue from now'); expect(backlog).toHaveBeenCalledTimes(1); await click('Keep backlog');
  await click('Continue from now'); await click('Discard backlog and continue from now'); await click('Cancel watch');
  await render({ followups: [{ ...watch(), state: 'paused', revision: 5 }] }); await click('Resume watch');
  expect(control.mock.calls.map(([request]) => request)).toEqual(['pause', 'cancel', 'resume'].map((action, index) => ({ ...identity, followupId: 'watch', expectedRevision: index === 2 ? 5 : 4, action })));
  expect(backlog.mock.calls.map(([request]) => request.action)).toEqual(['process_now', 'discard']); expect(backlog.mock.calls.every(([request]) => request.threadId === identity.threadId)).toBe(true);
});
it('does not adopt a stale source reply after unmount and prevents overlapping saves', async () => {
  const result = gate<Followup>(); putArrangement.mockImplementationOnce(() => result.promise);
  await render(); await fill(); await act(async () => { button('Save arrangement').click(); button('Save arrangement').click(); }); expect(putArrangement).toHaveBeenCalledTimes(1);
  await act(async () => result.resolve(watch()));
  const pending = gate<VarinEventSourceDescriptor[]>(); eventSources.mockImplementationOnce(() => pending.promise); await click('Watch an event source');
  await act(async () => root.unmount()); expect(eventSources.mock.calls.at(-1)![1]!.aborted).toBe(true); await act(async () => pending.resolve([source]));
  root = createRoot(container);
});

it('distinguishes identical source names on separate Hosts and saves the exact selected transport identity', async () => {
  const host = { hostId: 'remote', connectionId: 'saved-remote', endpointIdentity: 'verified-endpoint' };
  eventSources.mockResolvedValue([source, { ...source, host }]); await render(); await fill();
  await edit('Event source', JSON.stringify(['inbox', 'arrived', 'remote', 'saved-remote', 'verified-endpoint']));
  await edit('Connection', JSON.stringify(['work', 'generation-1'])); await edit('Folder *', 'support'); await click('Save arrangement');
  expect(putArrangement.mock.calls[0]![0].arrangement.source).toEqual({ host, extensionId: 'inbox', sourceId: 'arrived', connectionId: 'work', accountId: 'generation-1' });
});

it('keeps a conflicted draft and requires an explicit revision refresh before saving it over newer facts', async () => {
  putArrangement.mockRejectedValueOnce(Object.assign(new Error('Revision changed'), { status: 409 }));
  await render({ followups: [watch()], focusId: 'watch' }); await click('Edit arrangement'); await edit('Name', 'My draft'); await click('Save arrangement');
  expect(button('Save arrangement').disabled).toBe(true); expect(field('Name').value).toBe('My draft');
  get.mockResolvedValue({ followup: { ...watch(), revision: 9 }, instruction: 'Newer remote instructions', registration_trigger: null });
  await click('Refresh the saved revision and keep my draft'); expect(field('Name').value).toBe('My draft'); await click('Save arrangement');
  expect(putArrangement.mock.calls[1]![0].arrangement).toMatchObject({ key: 'watch', expectedRevision: 9, name: 'My draft' });
});

it('selects an existing external task, including another Bot’s child, without replacing the native management anchor', async () => {
  state.external = [{ id: 'external-task', title: 'Existing Codex task', harness: 'codex', configurationId: 'external-config', revision: 1, sessionId: 'native-session' } as ExternalConversation];
  state.children = [{ conversationId: 'external-task', parentThreadId: 'other-bot', name: 'Existing Codex task', harness: 'codex' } as ExternalDelegation];
  await render(); await fill(); await edit('Receiving conversation or task', JSON.stringify(['external', 'external-task', null]));
  expect(state.readExternal).toHaveBeenCalledWith('external-task', undefined, expect.any(AbortSignal));
  expect(container.textContent).toContain('existing external session is connected'); expect(button('Save arrangement').disabled).toBe(false);
  await click('Save arrangement'); expect(putArrangement.mock.calls[0]![0]).toMatchObject({ ...identity, arrangement: { threadId: identity.threadId, branchId: identity.branchId, externalConversationId: 'external-task' } });
});
it('preserves a saved external target until an explicit native selection clears it, and shows configuration review blocks', async () => {
  state.external = [{ id: 'external-task', title: 'Review first', configurationId: 'external-config', harness: 'acp', revision: 1, needsReview: true } as ExternalConversation];
  const saved = { ...watch(), external_conversation_id: 'external-task' }; get.mockResolvedValue({ followup: saved, instruction: 'Original intent', registration_trigger: null });
  await render({ followups: [saved], focusId: 'watch' }); await click('Edit arrangement');
  expect(field('Receiving conversation or task').value).toBe(JSON.stringify(['external', 'external-task', null])); expect(button('Save arrangement').disabled).toBe(true); expect(container.textContent).toContain('review its changed configuration');
  await edit('Receiving conversation or task', JSON.stringify(['task', 'branch'])); await click('Save arrangement');
  expect(putArrangement.mock.calls[0]![0].arrangement).toMatchObject({ threadId: 'task', branchId: 'branch', externalConversationId: null });
});

it('keeps a selected external receiver and draft when its actual adapter read reports a recovery failure', async () => {
  state.external = [{ id: 'external-task', title: 'Existing task', harness: 'acp', configurationId: 'external-config', revision: 1 } as ExternalConversation];
  state.readExternal.mockRejectedValue(new Error('Original external session cannot be recovered'));
  await render(); await fill(); await edit('Receiving conversation or task', JSON.stringify(['external', 'external-task', null]));
  expect(container.textContent).toContain('Original external session cannot be recovered'); expect(field('Receiving conversation or task').value).toBe(JSON.stringify(['external', 'external-task', null]));
  expect(field('Name').value).toBe('Important replies'); expect(button('Save arrangement').disabled).toBe(true); expect(putArrangement).not.toHaveBeenCalled();
});

it('creates first-contact Bot sessions only with an explicit native-target choice and clears it for external targets', async () => {
  await render(); await fill();
  const choice = field('Create a Bot conversation for each new source object'); expect(choice.checked).not.toBe(true);
  await act(async () => { choice.checked = true; choice.dispatchEvent(new window.Event('click', { bubbles: true })); });
  await click('Close editor'); await click('Watch an event source');
  expect(field('Create a Bot conversation for each new source object').checked).toBe(true);
  await click('Save arrangement'); expect(putArrangement.mock.calls[0]![0].arrangement).toMatchObject({ firstContact: 'create_bot_session', externalConversationId: null });
  const saved = { ...watch(), first_contact: 'create_bot_session' as const }; get.mockResolvedValue({ followup: saved, instruction: 'Original intent', registration_trigger: null });
  state.external = [{ id: 'external-task', title: 'Existing task', harness: 'codex', configurationId: 'external-config', revision: 1 } as ExternalConversation];
  await render({ followups: [saved], focusId: 'watch' }); await click('Edit arrangement');
  expect(field('Create a Bot conversation for each new source object').checked).toBe(true);
  await edit('Receiving conversation or task', JSON.stringify(['external', 'external-task', null]));
  expect(field('Create a Bot conversation for each new source object')).toBeNull();
  await click('Save arrangement'); expect(putArrangement.mock.calls[1]![0].arrangement).toMatchObject({ firstContact: null, externalConversationId: 'external-task', threadId: 'task', branchId: 'branch' });
});
