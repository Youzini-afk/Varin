import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalAgentError, type ExternalAgentsAPI, type ExternalAgentSettings, type ExternalConversationSnapshot, type ExternalObservation, type ThreadsAPI } from '@varin/application-client';
import { ThreadDraftConversation } from './ThreadDraftConversation';
import { ExternalConversationView } from './ExternalConversation';
import { ExternalInteractionForm } from './ExternalInteractionForm';
import { ExternalSessionControls } from './ExternalSessionControls';
import type { ExternalSessionChoice } from './externalSessionChoice';
import { MessageHandoff } from '@/components/conversation/messageHandoff';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { externalAgentEn } from '@/lib/i18n/messages/external-agents';

const f = vi.hoisted(() => ({ host: 1, listeners: new Set<() => void>(), api: undefined as ExternalAgentsAPI | undefined,
  settings: undefined as ExternalAgentSettings | undefined, refresh: vi.fn(async () => {}), select: vi.fn() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => f.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  createExternalAgentsHttpAPI: () => f.api,
  createModelConnectionsHttpAPI: () => ({ readSettings: async () => ({ global: {}, project: {} }) }),
}));
vi.mock('@/lib/i18n', () => { const t = (key: string, values: Record<string, unknown> = {}) =>
  ((externalAgentEn as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name])); return { useI18n: () => ({ t }) }; });
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => f.settings,
  useExternalAgentStore: Object.assign(() => null, { getState: () => ({ refresh: f.refresh, select: f.select }) }) }));
vi.mock('@/stores/useThreadStore', () => ({ threadHostKey: () => `host:${f.host}` }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign((select: (state: object) => unknown) => select({ chatRenderMode: 'live' }), { getState: () => ({}) }) }));
vi.mock('@/stores/useInlineCommentDraftStore', () => ({ useInlineCommentDraftStore: (select: (state: object) => unknown) => select({ drafts: {} }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/agent-editor/attachments', () => ({ subscribeEditorContextAttachments: () => () => {}, getEditorContextAttachmentsRevision: () => 0, listEditorContextAttachments: () => [] }));
vi.mock('@/lib/agent-editor/projection', () => ({ projectEditorContextAttachments: (text: string) => text }));
vi.mock('@/lib/messages/inlineComments', () => ({ appendInlineComments: (text: string) => text }));
vi.mock('@/lib/agent-runtime/sendThreadDraft', () => ({ sendThreadDraft: vi.fn() }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('@/components/motion/Departure', () => ({ Departure: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/lib/motion/haptics', () => ({ tapHaptic: () => {} }));
vi.mock('./useThreadWorkFocus', () => ({ useThreadWorkFocus: () => 'general' }));
vi.mock('./useFirstMessagePreview', () => ({ useFirstMessagePreview: () => ({ message: null }) }));
vi.mock('./ThreadAgentControls', () => ({ ThreadAgentControls: () => null }));
vi.mock('./HarnessSelector', () => ({ HarnessSelector: ({ disabled, onChange }: { disabled?: boolean; onChange?(id: string): void }) => onChange
  ? <button type="button" disabled={disabled} onClick={() => onChange('other')}>Choose another Agent</button> : <span>Harness</span> }));
vi.mock('./ThreadComposer', () => ({ ThreadComposer: (props: React.ComponentProps<typeof import('./ThreadComposer').ThreadComposer>) => <div>
  {props.agentControls}{props.backendControls}{props.children}
  <textarea aria-label="Message" value={props.value} onInput={event => props.onChange(event.currentTarget.value)} />
  <button type="submit" disabled={props.sendDisabled}>Send</button>
  <button type="button" onClick={props.onWorkspace}>Workspace</button>
  {props.onStop && <button type="button" onClick={props.onStop}>Stop</button>}
</div> }));
vi.mock('./ThreadSourcePicker', () => ({ ThreadSourcePicker: ({ onDraftSelection }: { onDraftSelection(value: object): void }) =>
  <button type="button" onClick={() => onDraftSelection({ path: '/other', resourceOwner: { kind: 'local' }, mode: 'live_root', contentMode: 'working', captureScopes: [] })}>Choose another folder</button> }));
vi.mock('./WorkOverviewControl', () => ({ WorkOverviewControl: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('./ExternalOverview', () => ({ ExternalOverview: () => null }));
vi.mock('@/components/conversation/ConversationScrollbar', () => ({ ConversationScrollbar: () => null }));
vi.mock('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/components/conversation/ChatThinkingBlock', () => ({ ChatThinkingBlock: () => null }));
vi.mock('@/components/conversation/ChatFileChangePreview', () => ({ ChatFileChangePreview: () => null }));
vi.mock('@/components/conversation/ChatAgentMessageBubble', () => ({ ChatAgentMessageBubble: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/conversation/ChatTimelineEntries', () => ({ ChatTurnUserMessage: () => null }));
vi.mock('@/components/conversation/ToolDisclosure', () => ({ ToolDisclosure: ({ children }: React.PropsWithChildren) => <details>{children}</details>, ToolDisclosureScope: ({ children }: React.PropsWithChildren) => <div>{children}</div>, ToolStatus: () => null }));
vi.mock('@/components/conversation/ActiveEditorSuggestion', () => ({ ActiveEditorSuggestion: () => null }));
vi.mock('@/components/workbench/EditorContextAttachmentChips', () => ({ EditorContextAttachmentChips: () => null }));
vi.mock('@/components/chat/composer/ImageAttachmentStrip', () => ({ ImageAttachmentStrip: () => null }));
vi.mock('@/components/chat/composer/imageAttachments', () => ({ beginImageInsertion: () => ({ append: () => {}, dispose: () => {} }), fileToImageAttachment: vi.fn(), removeDraftImage: vi.fn() }));
vi.mock('@/lib/openFileInMainEditor', () => ({ openFileInMainEditor: () => false }));

const capabilities = () => ({ resume: true, images: true, steering: false,
  models: [{ id: 'first', name: 'First model', thinkingLevels: ['low', 'high'] }, { id: 'second', name: 'Second model' }],
  current: { model: 'first', thinking: 'low', mode: 'ask' }, modes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }],
  configOptions: [{ id: 'verbosity', name: 'Verbosity', currentValue: 'short', options: [{ value: 'short', name: 'Short' }, { value: 'long', name: 'Long' }] }],
  commands: [{ name: 'plan', description: 'Prepare a plan', inputHint: 'task' }],
});
function snapshot(id = 'prepared'): ExternalConversationSnapshot {
  return { observationEpoch: 'epoch', observationRevision: 1, conversation: { id, configurationId: 'agent', harness: 'acp', title: 'Agent', cwd: '/project',
    revision: 1, createdAt: 1, updatedAt: 1, archived: false, pinned: false, deleted: false }, turns: [], items: [], connected: false, interactions: [] };
}
function fixture() {
  const views = new Map<string, ExternalConversationSnapshot>([['prepared', snapshot()]]);
  let listener: ((event: ExternalObservation) => void) | undefined;
  const api = {
    uploadAttachment: vi.fn<ExternalAgentsAPI['uploadAttachment']>(async (_id, file) => ({ ref: 'attachment:external-original', filename: file.filename, mimeType: file.mimeType, byteLength: file.data.size })),
    readAttachment: vi.fn<ExternalAgentsAPI['readAttachment']>(async () => new Blob(['original'])),
    create: vi.fn<ExternalAgentsAPI['create']>(async () => structuredClone(views.get('prepared')!.conversation)),
    connect: vi.fn<ExternalAgentsAPI['connect']>(async id => { const view = views.get(id)!; view.connected = true; view.capabilities = capabilities(); view.observationRevision++; return capabilities(); }),
    authenticate: vi.fn<ExternalAgentsAPI['authenticate']>(async id => { const view = views.get(id)!; view.connected = true; view.capabilities = capabilities(); view.observationRevision++; return capabilities(); }),
    continueConversation: vi.fn<ExternalAgentsAPI['continueConversation']>(async id => { views.get(id)!.conversation.needsReview = false; views.get(id)!.observationRevision++; }),
    read: vi.fn<ExternalAgentsAPI['read']>(async id => structuredClone(views.get(id)!)),
    send: vi.fn<ExternalAgentsAPI['send']>(async (id, key) => ({ id: 'turn', conversationId: id, key, status: 'queued', createdAt: 1, updatedAt: 1 })),
    update: vi.fn<ExternalAgentsAPI['update']>(async (id, _revision, patch) => ({ ...views.get(id)!.conversation, ...patch })),
    disconnect: vi.fn<ExternalAgentsAPI['disconnect']>(async id => { views.get(id)!.connected = false; views.get(id)!.capabilities = undefined; }),
    respond: vi.fn<ExternalAgentsAPI['respond']>(async () => {}), stop: vi.fn<ExternalAgentsAPI['stop']>(async () => {}),
    observe: vi.fn<ExternalAgentsAPI['observe']>(async (_id, next) => { listener = next; }),
  };
  f.api = api as unknown as ExternalAgentsAPI;
  return { api, views, emit: async () => { await act(async () => listener?.({ epoch: 'epoch', revision: 99, kind: 'refresh' })); } };
}
let root: Root, container: HTMLDivElement, handoff: MessageHandoff;
const nativeApi = { listModels: async () => [] } as unknown as ThreadsAPI;
beforeEach(() => {
  vi.clearAllMocks(); f.host++; useThreadDraftStore.setState({ drafts: {} });
  f.settings = { revision: 1, defaultAgent: null, agents: [
    { id: 'agent', name: 'Agent', harness: 'acp', enabled: true, command: 'agent', args: [] },
    { id: 'other', name: 'Other', harness: 'acp', enabled: true, command: 'other', args: [] },
  ] };
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); handoff = new MessageHandoff();
  useThreadDraftStore.getState().patch('draft', { harnessId: 'agent', workspacePath: '/project', text: 'Original question' });
});
afterEach(() => { act(() => root.unmount()); handoff.dispose(); container.remove(); vi.unstubAllGlobals(); });
const renderDraft = () => act(async () => root.render(<ThreadDraftConversation api={nativeApi} draftKey="draft" handoff={handoff} />));
const renderConversation = (id = 'prepared') => act(async () => root.render(<ExternalConversationView id={id} />));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const click = (label: string) => act(async () => button(label).click());
const choose = (label: string, value: string) => act(async () => {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  Object.defineProperty(select, 'value', { configurable: true, value }); select.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const submit = () => act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

it('prepares before the first request, deduplicates repeated prepare clicks, and sends using the prepared identity and selected options', async () => {
  const { api } = fixture(); let finish!: () => void;
  const connect = api.connect.getMockImplementation()!;
  api.connect.mockImplementationOnce(id => new Promise(resolve => { finish = () => { void connect(id).then(resolve); }; }));
  await renderDraft(); expect(button('Send').disabled).toBe(true);
  await act(async () => { button('Prepare connection').click(); button('Prepare connection').click(); });
  expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(container.textContent).toContain('Current session: first'); expect(button('Send').disabled).toBe(false);
  await choose('Model', 'first'); await choose('chat.context.thinking', 'high'); await choose('Verbosity', 'value:long');
  await submit();
  expect(api.create).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledWith('prepared', expect.any(String), expect.objectContaining({ text: 'Original question', model: 'first', thinking: 'high', config: { verbosity: 'long' } }));
  expect(f.select).toHaveBeenCalledWith('prepared');
});

it('retains the durable ID on connection failure and cleans an empty binding before switching backends with a new create key', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new Error('Protocol handshake failed'));
  await renderDraft(); await click('Prepare connection');
  const originalKey = api.create.mock.calls[0]![0].key;
  expect(container.textContent).toContain('Protocol handshake failed'); expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared');
  await click('Prepare connection'); expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledTimes(2);
  await click('Choose another Agent');
  expect(api.update).toHaveBeenCalledWith('prepared', 1, { deleted: true });
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'other', text: 'Original question', externalConversationId: undefined });
  await click('Prepare connection'); expect(api.create.mock.calls[1]![0]).toMatchObject({ configurationId: 'other', cwd: '/project' });
  expect(api.create.mock.calls[1]![0].key).not.toBe(originalKey); expect(api.send).not.toHaveBeenCalled();
});

it('preserves an uncertain create key on retry and does not lose the old backend if cleanup fails', async () => {
  const { api } = fixture(); api.create.mockRejectedValueOnce(new Error('Reply lost'));
  await renderDraft(); await click('Prepare connection'); await click('Prepare connection');
  expect(api.create.mock.calls[0]![0].key).toBe(api.create.mock.calls[1]![0].key);
  api.update.mockRejectedValueOnce(new Error('Connection could not stop'));
  await click('Choose another Agent');
  expect(container.textContent).toContain('Connection could not stop');
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'agent', externalConversationId: 'prepared' });
});

it('cleans a prepared binding before changing its folder and ignores a late create after a Host change', async () => {
  const { api } = fixture(); await renderDraft(); await click('Prepare connection'); await click('Workspace'); await click('Choose another folder');
  expect(api.update).toHaveBeenCalledWith('prepared', 1, { deleted: true }); expect(useThreadDraftStore.getState().drafts.draft!.workspacePath).toBe('/other');
  let finish!: () => void; api.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(snapshot('old-host').conversation); }));
  await click('Prepare connection');
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => finish());
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBeUndefined(); expect(api.connect).toHaveBeenCalledTimes(1); expect(api.send).not.toHaveBeenCalled();
  expect(button('Prepare connection').disabled).toBe(false);
});

it('renders explicit authentication methods, retries failures, and never executes terminal login or sends a model request', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Sign in first', 401, { authentication: {
    guidance: 'Choose your account', methods: [{ id: 'browser', name: 'Sign in with browser', type: 'agent' }, { id: 'cli', name: 'Terminal account', type: 'terminal', command: 'agent', args: ['login', '--profile', 'work'] }],
  } }));
  await renderDraft(); await click('Prepare connection');
  expect(JSON.parse(container.querySelector('pre')!.textContent!)).toEqual(['agent', 'login', '--profile', 'work']); expect(container.textContent).toContain('argv data, not a shell command'); expect(container.textContent).toContain('Varin does not run it');
  expect(api.authenticate).not.toHaveBeenCalled(); expect(button('Send').disabled).toBe(true);
  api.authenticate.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Account still unavailable', 401, { authentication: { methods: [{ id: 'browser', name: 'Sign in with browser', type: 'agent' }] } }));
  await click('Sign in with browser'); expect(container.textContent).toContain('Account still unavailable');
  await click('Sign in with browser');
  expect(api.authenticate.mock.calls).toEqual([['prepared', 'browser'], ['prepared', 'browser']]); expect(api.create).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled(); expect(button('Send').disabled).toBe(false);
});

it('shows model discovery errors, separates current from next choices, clears hidden effort, and only inserts advertised commands', async () => {
  fixture(); let chosen: ExternalSessionChoice = { model: 'first', thinking: 'high' };
  const value = { ...capabilities(), modelsError: 'Catalog unavailable' };
  function Controls() {
    const [choice, setChoice] = React.useState(chosen); chosen = choice;
    const [text, setText] = React.useState('');
    return <><ExternalSessionControls capabilities={value} choice={choice} onChange={setChoice} onCommand={setText} /><output>{text}</output></>;
  }
  await act(async () => root.render(<Controls />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Catalog unavailable');
  await choose('Model', 'second');
  expect(chosen.thinking).toBeUndefined(); expect(container.querySelector('[aria-label="chat.context.thinking"]')).toBeNull();
  expect(container.querySelector('[aria-label="Current session"]')?.textContent).toContain('first');
  await click('/plan'); expect(container.querySelector('output')?.textContent).toBe('/plan ');
});

it('keeps reconnect separate from explicit continuation and never replays interrupted input', async () => {
  const { api, views } = fixture(); views.get('prepared')!.conversation.needsReview = true;
  views.get('prepared')!.turns.push({ id: 'interrupted', conversationId: 'prepared', key: 'old-key', status: 'interrupted', createdAt: 1, updatedAt: 1 });
  await renderConversation(); expect(button('Continue queued messages').disabled).toBe(true);
  await click('Connect'); expect(api.connect).toHaveBeenCalledWith('prepared'); expect(api.continueConversation).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
  expect(button('Continue queued messages').disabled).toBe(false);
  await click('Continue queued messages'); expect(api.continueConversation).toHaveBeenCalledWith('prepared'); expect(api.send).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Continue queued messages');
});

it('allows explicit termination while ordinary stop awaits actual completion and renders termination failures', async () => {
  const { api, views, emit } = fixture(); const view = views.get('prepared')!; view.connected = true; view.capabilities = capabilities(); view.conversation.activeTurn = 'active';
  view.turns.push({ id: 'active', conversationId: 'prepared', key: 'key', status: 'running', createdAt: 1, updatedAt: 1 });
  let stopped!: () => void;
  api.stop.mockImplementationOnce(async () => { view.turns[0]!.status = 'stopping'; await new Promise<void>(resolve => { stopped = resolve; }); });
  await renderConversation(); await click('Stop'); await emit();
  api.stop.mockRejectedValueOnce(new Error('Process termination failed'));
  await click('Terminate connection'); expect(api.stop).toHaveBeenLastCalledWith('prepared', 'active', true); expect(container.textContent).toContain('Process termination failed');
  await act(async () => stopped());
});

it('retains form fields on failed answer/cancel, submits false/zero/empty/array values, and gates repeated answers', async () => {
  const { api, views } = fixture(); const view = views.get('prepared')!; view.connected = true; view.capabilities = capabilities();
  view.interactions = [{ id: 'question', turnId: 'active', kind: 'question', title: '<script>Exact request</script>', options: [], fields: [
    { id: 'flag', label: 'Flag', type: 'boolean', required: true, defaultValue: false },
    { id: 'count', label: 'Count', type: 'number', required: true, defaultValue: 0 },
    { id: 'empty', label: 'Empty', type: 'text', defaultValue: '' },
    { id: 'many', label: 'Many', type: 'multiselect', defaultValue: [], options: [{ value: 'one', label: 'One' }] },
  ] }];
  let reject!: (error: Error) => void; api.respond.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await renderConversation(); expect(container.querySelector('script')).toBeNull();
  await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.respond).toHaveBeenCalledOnce(); expect(api.respond.mock.calls[0]).toEqual(['prepared', 'question', { values: { flag: false, count: 0, empty: '', many: [] }, answers: {}, text: '' }]);
  await act(async () => reject(new Error('Answer rejected'))); expect(container.textContent).toContain('Answer rejected');
  api.respond.mockRejectedValueOnce(new Error('Cancel not confirmed'));
  await click('Cancel request'); expect(api.respond).toHaveBeenLastCalledWith('prepared', 'question', { cancelled: true }); expect(container.textContent).toContain('Cancel not confirmed');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Count"]')!.value).toBe('0');
  await submit(); expect(api.respond.mock.lastCall?.[2]).toMatchObject({ values: { flag: false, count: 0 } });
});

it('does not send absent required field values and keeps cancellation distinct from a permission rejection', async () => {
  const respond = vi.fn();
  await act(async () => root.render(<ExternalInteractionForm pending={false} respond={respond} request={{ id: 'field', turnId: 'turn', kind: 'question', title: 'Required', options: [], fields: [{ id: 'flag', label: 'Explicit flag', type: 'boolean', required: true }] }} />));
  await submit(); expect(respond).not.toHaveBeenCalled(); expect(container.textContent).toContain('Choose a value for Explicit flag.');
  await click('Cancel request'); expect(respond).toHaveBeenCalledWith({ cancelled: true });
});

it('discards stale session reads and authentication completions after navigation or Host replacement', async () => {
  const { api, views } = fixture(); views.set('next', { ...snapshot('next'), connected: true, capabilities: { ...capabilities(), current: { model: 'next-model' } } });
  let finish!: (value: ExternalConversationSnapshot) => void; api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await renderConversation(); await renderConversation('next');
  await act(async () => finish({ ...snapshot(), connected: true, capabilities: capabilities() }));
  expect(container.textContent).toContain('next-model'); expect(container.textContent).not.toContain('Current session: first');
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  expect(api.send).not.toHaveBeenCalled();
});

it('cancels preparation through the Host, keeps its binding, and can retry without creating another session', async () => {
  const { api } = fixture(); let reject!: (error: Error) => void;
  api.connect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.disconnect.mockImplementationOnce(async () => { reject(new Error('Connection cancelled')); });
  await renderDraft(); await click('Prepare connection'); expect(button('Cancel connection').disabled).toBe(false);
  await act(async () => { button('Cancel connection').click(); button('Cancel connection').click(); });
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.update).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared');
  expect(container.textContent).not.toContain('Connection cancelled'); expect(button('Prepare connection').disabled).toBe(false);
  await click('Prepare connection'); expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledTimes(2); expect(api.send).not.toHaveBeenCalled();
});

it('retains a cancelling connection and offers retry when disconnect fails instead of treating HTTP completion as stop', async () => {
  const { api } = fixture(); let reject!: (error: Error) => void;
  api.connect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.disconnect.mockRejectedValueOnce(new Error('Process still stopping'));
  await renderDraft(); await click('Prepare connection'); await click('Cancel connection');
  expect(container.textContent).toContain('Process still stopping'); expect(button('Cancel connection').disabled).toBe(false);
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared'); expect(api.update).not.toHaveBeenCalled();
  api.disconnect.mockImplementationOnce(async () => { reject(new Error('Cancelled')); });
  await click('Cancel connection'); expect(button('Prepare connection').disabled).toBe(false);
});

it('does not let a stale initial read overwrite the result of explicit preparation', async () => {
  const { api } = fixture(); let initial!: (value: ExternalConversationSnapshot) => void;
  api.read.mockImplementationOnce(() => new Promise(resolve => { initial = resolve; }));
  useThreadDraftStore.getState().patch('draft', { externalConversationHost: f.host, externalPreparationKey: 'original', externalConversationId: 'prepared' });
  await renderDraft(); await click('Prepare connection'); expect(button('Send').disabled).toBe(false);
  await act(async () => initial(snapshot()));
  expect(button('Send').disabled).toBe(false); expect(container.textContent).toContain('Current session: first');
});

it('keeps an explicit model rejection and the draft intact rather than silently falling back to another model', async () => {
  const { api } = fixture(); await renderDraft(); await click('Prepare connection'); await choose('Model', 'second');
  api.send.mockRejectedValueOnce(new ExternalAgentError('invalid_model', 'Model was withdrawn', 400));
  await submit();
  expect(container.textContent).toContain('Model was withdrawn'); expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ text: 'Original question', externalModels: { agent: 'second' }, externalInput: undefined });
  expect(api.send).toHaveBeenCalledOnce(); expect(api.send.mock.calls[0]![2].model).toBe('second');
  expect(api.send.mock.calls[0]![2].thinking).toBeUndefined(); expect(f.select).not.toHaveBeenCalled();
});

it('ignores an authentication completion after the execution Host is replaced', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Authenticate', 401, { authentication: { methods: [{ id: 'login', name: 'Sign in', type: 'agent' }] } }));
  let finish!: () => void; api.authenticate.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(capabilities()); }));
  await renderDraft(); await click('Prepare connection'); await click('Sign in');
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => finish());
  expect(button('Send').disabled).toBe(true); expect(container.textContent).not.toContain('Current session: first'); expect(api.send).not.toHaveBeenCalled();
});

it('retries failed model discovery through the existing connection without preparing another binding or sending input', async () => {
  const { api, views } = fixture();
  api.connect.mockImplementationOnce(async id => {
    const view = views.get(id)!; view.connected = true; view.capabilities = { ...capabilities(), models: [], modelsRefresh: true, modelsError: 'Model list request failed' };
    return view.capabilities;
  });
  await renderDraft(); await click('Prepare connection');
  expect(container.textContent).toContain('Model list request failed'); expect(button('Send').disabled).toBe(false);
  expect(container.querySelector('input[aria-label="Model"]')).toBeNull();
  await click('Retry model discovery');
  expect(api.connect.mock.calls.map(call => call[0])).toEqual(['prepared', 'prepared']); expect(api.create).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Model list request failed'); expect(container.querySelector('select[aria-label="Model"]')?.textContent).toContain('First model');
});

it('refreshes capabilities advertised after preparation without sending input or losing the retained draft', async () => {
  const { views, api, emit } = fixture(); await renderDraft(); await click('Prepare connection');
  const view = views.get('prepared')!; view.capabilities = { ...capabilities(), current: { model: 'second', mode: 'auto' }, commands: [{ name: 'review', description: 'Review changes' }] };
  view.observationRevision++;
  await emit();
  expect(container.querySelector('[aria-label="Current session"]')?.textContent).toContain('second');
  expect(button('/review')).toBeDefined(); expect(useThreadDraftStore.getState().drafts.draft!.text).toBe('Original question');
  expect(api.send).not.toHaveBeenCalled(); expect(api.create).toHaveBeenCalledOnce();
});

it.each([
  { id: 'count', label: 'Count', type: 'number' as const, defaultValue: 1.5, integer: true, minimum: 0, maximum: 3 },
  { id: 'name', label: 'Name', type: 'text' as const, defaultValue: 'too long', maxLength: 3 },
  { id: 'many', label: 'Many', type: 'multiselect' as const, defaultValue: [], options: [{ value: 'one', label: 'One' }], minItems: 1 },
])('keeps invalid $type constraints visible and the answer unconsumed', async field => {
  const respond = vi.fn();
  await act(async () => root.render(<ExternalInteractionForm pending={false} respond={respond} request={{ id: 'constrained', turnId: 'turn', kind: 'question', title: 'Constraints', options: [], fields: [field] }} />));
  await submit();
  expect(respond).not.toHaveBeenCalled(); expect(container.textContent).toContain(`Check the value of ${field.label}.`);
  if (field.type === 'number') {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Count"]')!;
    expect(input.value).toBe('1.5'); expect(input.getAttribute('step')).toBe('1'); expect(input.getAttribute('max')).toBe('3');
  }
  if (field.type === 'multiselect') {
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); });
    await submit(); expect(respond).toHaveBeenCalledWith(expect.objectContaining({ values: { many: ['one'] } }));
  }
});

it('recovers a lost cleanup response only after the original binding is confirmed unavailable', async () => {
  const { api } = fixture(); await renderDraft(); await click('Prepare connection');
  api.update.mockRejectedValueOnce(new Error('Delete response lost'));
  await click('Choose another Agent'); expect(useThreadDraftStore.getState().drafts.draft!.harnessId).toBe('agent');
  api.read.mockRejectedValueOnce(new ExternalAgentError('external_agent_failed', 'not found: external conversation was deleted', 404));
  await click('Choose another Agent');
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'other', externalConversationId: undefined, externalPreparationKey: undefined });
  expect(api.update).toHaveBeenCalledOnce();
});

it('does not reuse the current model’s session effort menu or retained effort for an alternate model with unknown levels', async () => {
  const { api, views } = fixture();
  api.connect.mockImplementationOnce(async id => {
    const view = views.get(id)!; view.connected = true;
    view.capabilities = { ...capabilities(), configOptions: [
      { id: 'session-effort', name: 'Session effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      ...capabilities().configOptions,
    ] };
    return view.capabilities;
  });
  await renderDraft(); await click('Prepare connection'); await choose('Model', 'first'); await choose('chat.context.thinking', 'low');
  await choose('Model', 'second');
  expect(container.querySelector('select[aria-label="chat.context.thinking"]')).toBeNull();
  expect(container.querySelector('select[aria-label="Session effort"]')).toBeNull();
  // A retained older draft must be normalized as well as a fresh model-picker change.
  await act(async () => useThreadDraftStore.getState().patch('draft', { externalOptions: { agent: { thinking: 'low', config: { 'session-effort': 'low', verbosity: 'long' } } } }));
  expect(useThreadDraftStore.getState().drafts.draft!.externalOptions!.agent).toEqual({ thinking: undefined, config: { verbosity: 'long' } });
  await submit();
  expect(api.send.mock.calls[0]![2]).toMatchObject({ model: 'second', config: { verbosity: 'long' } });
  expect(api.send.mock.calls[0]![2].thinking).toBeUndefined();
  expect(api.send.mock.calls[0]![2].config).not.toHaveProperty('session-effort');
});


it('does not promise a live model retry for a connection-scoped SDK catalog', async () => {
  fixture(); const retry = vi.fn();
  await act(async () => root.render(<ExternalSessionControls capabilities={{ ...capabilities(), modelsError: 'SDK catalog unavailable' }}
    choice={{}} onChange={() => {}} onRetryModels={retry} />));
  expect(container.textContent).toContain('SDK catalog unavailable');
  expect(container.textContent).not.toContain('Retry model discovery');
  expect(retry).not.toHaveBeenCalled();
});


it('preserves external binary selections on preparation failure and retries without sending a partial input', async () => {
  const { api } = fixture();
  api.uploadAttachment.mockRejectedValueOnce(new Error('remote owner unavailable'));
  await renderDraft(); await click('Prepare connection');
  await act(async () => useThreadDraftStore.getState().patch('draft', { text: '' }));
  const file = new File([new Uint8Array([0, 255, 7])], 'model.bin');
  await act(async () => {
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    Object.defineProperty(picker, 'files', { value: [file] }); picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  expect(button('Send').disabled).toBe(false);
  await submit();
  expect(api.send).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.draft.files?.[0]?.status).toBe('failed');
  expect(container.textContent).toContain('model.bin: remote owner unavailable');
  const original = api.uploadAttachment.mock.calls[0]![1];
  await submit();
  expect(api.uploadAttachment.mock.calls[1]![1]).toEqual(original);
  expect(api.uploadAttachment.mock.calls[1]![1].data).toBe(file);
  expect(api.send).toHaveBeenCalledWith('prepared', expect.any(String), expect.objectContaining({ text: '', attachments: [{ ref: 'attachment:external-original' }] }));
});
