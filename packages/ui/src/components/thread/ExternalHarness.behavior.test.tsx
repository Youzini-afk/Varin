import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalAgentError, type ExternalAgentsAPI, type ExternalAgentSettings, type ExternalConversationSnapshot, type ExternalObservation, type ThreadsAPI } from '@varin/application-client';
import { ThreadDraftConversation } from './ThreadDraftConversation';
import { ExternalConversationView } from './ExternalConversation';
import { ExternalInteractionForm } from './ExternalInteractionForm';
import { ExternalModelControls, ExternalModeControls, ExternalChoiceValidation, ExternalOptionMenu, type ExternalComposerOptions } from './ExternalComposerControls';
import type { ExternalSessionChoice } from './externalSessionChoice';
import { MessageHandoff } from '@/components/conversation/messageHandoff';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { insertDraftMarker, referenceMarkerObject, freezeDraftContentReferences } from '@/lib/agent-editor/contentReferences';
import { externalAgentEn } from '@/lib/i18n/messages/external-agents';

const f = vi.hoisted(() => ({ host: 1, listeners: new Set<() => void>(), api: undefined as ExternalAgentsAPI | undefined,
  composer: undefined as React.ComponentProps<typeof import('./ThreadComposer').ThreadComposer> | undefined,
  settings: undefined as ExternalAgentSettings | undefined, refresh: vi.fn(async () => {}), select: vi.fn() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => f.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  createExternalAgentsHttpAPI: () => f.api,
  createModelConnectionsHttpAPI: () => ({ readSettings: async () => ({ global: {}, project: {} }) }),
}));
vi.mock('@/lib/i18n', async original => { const actual = await original<typeof import('@/lib/i18n')>(); const t = (key: string, values: Record<string, unknown> = {}) =>
  ((externalAgentEn as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name])); return { ...actual, useI18n: () => ({ t }) }; });
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => f.settings,
  useExternalAgentStore: Object.assign(() => null, { getState: () => ({ refresh: f.refresh, select: f.select, setSnapshot: () => {}, clearSnapshot: () => {} }) }) }));
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
  ? <><button type="button" disabled={disabled} onClick={() => onChange('other')}>Choose another Agent</button><button type="button" disabled={disabled} onClick={() => onChange('third')}>Choose third Agent</button></> : <span>Harness</span> }));
vi.mock('./ThreadComposer', () => ({ ThreadComposer: (props: React.ComponentProps<typeof import('./ThreadComposer').ThreadComposer>) => { f.composer = props; return <div>
  {props.agentControls}{props.backendControls}{props.children}{props.connectionStatus}
  {props.external && <><ExternalModelControls options={props.external} /><ExternalModeControls options={props.external} /><ExternalChoiceValidation options={props.external} /></>}
  <textarea aria-label="Message" value={props.value} onFocus={() => props.external?.onInteract('focus')} onInput={event => { props.onChange(event.currentTarget.value); props.external?.onInteract('input'); }} />
  <button type="submit" disabled={props.sendDisabled}>Send</button>
  <button type="button" onClick={props.onWorkspace}>Workspace</button>
  {props.onStop && <button type="button" onClick={props.onStop}>Stop</button>}
</div>; } }));
vi.mock('./ThreadSourcePicker', () => ({ ThreadSourcePicker: ({ onDraftSelection }: { onDraftSelection(value: object): void }) =>
  <><button type="button" onClick={() => onDraftSelection({ path: '/project', resourceOwner: { kind: 'managed_host', hostId: 'source-host', connectionId: 'source-connection', endpointIdentity: 'source-endpoint' }, mode: 'live_root', contentMode: 'saved-files', captureScopes: [] })}>Choose source Host</button><button type="button" onClick={() => onDraftSelection({ path: '/other', resourceOwner: { kind: 'local' }, mode: 'live_root', contentMode: 'working', captureScopes: [] })}>Choose another folder</button></> }));
vi.mock('./WorkOverviewControl', () => ({ WorkOverviewControl: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('./ExternalOverview', () => ({ ExternalOverview: () => null }));
vi.mock('@/components/conversation/ConversationScrollbar', () => ({ ConversationScrollbar: () => null }));
vi.mock('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
}));
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
vi.mock('@/lib/openFileInMainEditor', () => ({ openFileInMainEditor: () => false }));

const capabilities = () => ({ resume: true, images: true, files: 'resource_links' as const, steering: false,
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
    settings: vi.fn<ExternalAgentsAPI['settings']>(async () => structuredClone(f.settings!)),
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
const focusComposer = () => act(async () => { f.composer?.external?.onInteract('focus'); });
const choose = (label: string, value: string) => act(async () => {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const menu = trigger.parentElement!.querySelector('[role="menu"]')!;
  const text = ({ first: 'First model', second: 'Second model', 'value:long': 'Long' } as Record<string, string>)[value] ?? value;
  [...menu.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!.click();
});
const submit = () => act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

it('prepares before the first request, deduplicates focus and typing, and sends using the prepared identity and selected options', async () => {
  const { api } = fixture(); let finish!: () => void;
  const connect = api.connect.getMockImplementation()!;
  api.connect.mockImplementationOnce(id => new Promise(resolve => { finish = () => { void connect(id).then(resolve); }; }));
  await renderDraft(); expect(button('Send').disabled).toBe(false); expect(api.connect).not.toHaveBeenCalled();
  await act(async () => { f.composer?.external?.onInteract('focus'); f.composer?.external?.onInteract('input'); });
  expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(container.textContent).toContain('Use session configuration (current: First model)'); expect(button('Send').disabled).toBe(false);
  await choose('Model', 'first'); await choose('chat.context.thinking', 'high'); await choose('Verbosity', 'value:long');
  await submit();
  expect(api.create).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledWith('prepared', expect.any(String), expect.objectContaining({ text: 'Original question', model: 'first', thinking: 'high', config: { verbosity: 'long' } }));
  expect(f.select).toHaveBeenCalledWith('prepared');
});

it.each(['draft', 'conversation'] as const)('freezes external %s quote/image relations and preserves a newly inserted occurrence of the same quote on receipt', async surface => {
  const { api, views } = fixture();
  const view = views.get('prepared')!; view.connected = true; view.capabilities = capabilities();
  let accept!: () => void;
  api.send.mockImplementationOnce((id, key) => new Promise(resolve => { accept = () => resolve({ id: 'accepted-turn', conversationId: id, key, status: 'queued', createdAt: 1, updatedAt: 1 }); }));
  const key = surface === 'draft' ? 'draft' : `external-draft:${f.host}:prepared`;
  useThreadDraftStore.getState().patch(key, { text: 'Discuss ' });
  const source = { kind: 'chat' as const, thread: { runtime: 'agent' as const, threadId: 'actual-source', branchId: 'main' }, itemId: 'source-entry', passages: [{ entryId: 'source-entry', start: 9, text: 'Frozen quotation' }] };
  const quote = referenceMarkerObject({ ref: 'fixed-quote', title: 'Varin', text: 'Frozen quotation', source });
  const image = referenceMarkerObject({ ref: 'fixed-image', title: 'Original image', image: { mimeType: 'image/png', data: 'YQ==' }, source });
  await insertDraftMarker(key, quote); await insertDraftMarker(key, image);
  const original = useThreadDraftStore.getState().drafts[key];
  const frozen = freezeDraftContentReferences(original);
  if (surface === 'draft') { await renderDraft(); await focusComposer(); } else await renderConversation();
  await submit();
  expect(api.send).toHaveBeenCalledOnce();
  expect(api.send.mock.calls[0]![2]).toMatchObject({ text: original.text, ...frozen,
    images: [{ mimeType: 'image/png', data: 'YQ==', reference: original.images[0]!.reference }] });
  expect(api.send.mock.calls[0]![2]).not.toHaveProperty('replyTo');
  await act(async () => {
    useThreadDraftStore.getState().patch(key, draft => ({ text: `${draft.text} Later: ` }));
    await insertDraftMarker(key, quote);
  });
  const later = useThreadDraftStore.getState().drafts[key].references!.at(-1)!;
  await act(async () => accept());
  const destination = `external-draft:${f.host}:prepared`;
  const remainder = useThreadDraftStore.getState().drafts[destination];
  expect(remainder.images).toEqual([]);
  expect(remainder.references).toHaveLength(1);
  expect(remainder.references![0]!.id).toBe(later.id);
  expect(remainder.markerObjects?.map(object => object.id)).toEqual([quote.id]);
  expect(remainder.text).toBe(`Discuss  Later: ${later.text}`);
  expect(api.send.mock.calls[0]![2].contentReferenceOccurrences).toEqual(frozen.contentReferenceOccurrences);
  if (surface === 'draft') expect(useThreadDraftStore.getState().drafts.draft?.markerObjects ?? []).toEqual([]);
});

it('retains the durable ID on connection failure and cleans an empty binding before switching backends with a new create key', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new Error('Protocol handshake failed'));
  await renderDraft(); await focusComposer();
  const originalKey = api.create.mock.calls[0]![0].key;
  expect(container.textContent).toContain('Protocol handshake failed'); expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared');
  await focusComposer(); expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledTimes(2);
  await click('Choose another Agent');
  expect(api.update).toHaveBeenCalledWith('prepared', 1, { deleted: true });
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'other', text: 'Original question', externalConversationId: 'prepared' });
  await focusComposer(); expect(api.create.mock.calls[1]![0]).toMatchObject({ configurationId: 'other', cwd: '/project' });
  expect(api.create.mock.calls[1]![0].key).not.toBe(originalKey); expect(api.send).not.toHaveBeenCalled();
});

it('preserves an uncertain create key on retry and does not lose the old backend if cleanup fails', async () => {
  const { api } = fixture(); api.create.mockRejectedValueOnce(new Error('Reply lost'));
  await renderDraft(); await focusComposer(); await focusComposer();
  expect(api.create.mock.calls[0]![0].key).toBe(api.create.mock.calls[1]![0].key);
  api.update.mockRejectedValueOnce(new Error('Connection could not stop'));
  await click('Choose another Agent');
  expect(container.textContent).toContain('Connection could not stop');
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'agent', externalConversationId: 'prepared' });
});

it('cleans a prepared binding before changing its folder and ignores a late create after a Host change', async () => {
  const { api } = fixture(); await renderDraft(); await focusComposer(); await click('Workspace'); await click('Choose another folder');
  expect(api.update).toHaveBeenCalledWith('prepared', 1, { deleted: true }); expect(useThreadDraftStore.getState().drafts.draft!.workspacePath).toBe('/other');
  let finish!: () => void; api.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(snapshot('old-host').conversation); }));
  await focusComposer();
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => finish());
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBeUndefined(); expect(api.connect).toHaveBeenCalledTimes(1); expect(api.send).not.toHaveBeenCalled();
  expect(button('Reconnect').disabled).toBe(false);
});

it('renders explicit authentication methods, retries failures, and never executes terminal login or sends a model request', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Sign in first', 401, { authentication: {
    guidance: 'Choose your account', methods: [{ id: 'browser', name: 'Sign in with browser', type: 'agent' }, { id: 'cli', name: 'Terminal account', type: 'terminal', command: 'agent', args: ['login', '--profile', 'work'] }],
  } }));
  await renderDraft(); await focusComposer();
  expect(JSON.parse(container.querySelector('pre')!.textContent!)).toEqual(['agent', 'login', '--profile', 'work']); expect(container.textContent).toContain('argv data, not a shell command'); expect(container.textContent).toContain('Varin does not run it');
  expect(api.authenticate).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
  api.authenticate.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Account still unavailable', 401, { authentication: { methods: [{ id: 'browser', name: 'Sign in with browser', type: 'agent' }] } }));
  await click('Sign in with browser'); expect(container.textContent).toContain('Account still unavailable');
  await click('Sign in with browser');
  expect(api.authenticate.mock.calls).toEqual([['prepared', 'browser'], ['prepared', 'browser']]); expect(api.create).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled(); expect(button('Send').disabled).toBe(false);
});

it('separates current from next choices, clears hidden effort and does not duplicate backend commands', async () => {
  fixture(); let chosen: ExternalSessionChoice = { model: 'first', thinking: 'high' };
  const value = { ...capabilities(), modelsError: 'Catalog unavailable' };
  function Controls() {
    const [choice, setChoice] = React.useState(chosen); chosen = choice;
    const options: ExternalComposerOptions = { capabilities: value, source: 'live', choice, onChange: setChoice, onInteract: () => {} };
    return <><ExternalModelControls options={options} /><ExternalModeControls options={options} /><ExternalChoiceValidation options={options} /></>;
  }
  await act(async () => root.render(<Controls />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Catalog unavailable');
  await choose('Model', 'second');
  expect(chosen.thinking).toBeUndefined(); expect(container.querySelector('[aria-label="chat.context.thinking"]')).toBeNull();
  expect(container.textContent).toContain('Use session configuration (current: First model)');
  expect(button('/plan')).toBeUndefined();
});

it('keeps reconnect separate from explicit continuation and never replays interrupted input', async () => {
  const { api, views } = fixture(); views.get('prepared')!.conversation.needsReview = true;
  views.get('prepared')!.turns.push({ id: 'interrupted', conversationId: 'prepared', key: 'old-key', status: 'interrupted', createdAt: 1, updatedAt: 1 });
  await renderConversation(); expect(button('Continue queued messages').disabled).toBe(true);
  await focusComposer(); expect(api.connect).toHaveBeenCalledWith('prepared'); expect(api.continueConversation).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
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
  expect(container.textContent).toContain('next-model'); expect(container.textContent).not.toContain('Use session configuration (current: First model)');
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  expect(api.send).not.toHaveBeenCalled();
});

it('cancels preparation through the Host, keeps its binding, and can retry without creating another session', async () => {
  const { api } = fixture(); let reject!: (error: Error) => void;
  api.connect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.disconnect.mockImplementationOnce(async () => { reject(new Error('Connection cancelled')); });
  await renderDraft(); await focusComposer(); expect(button('Cancel connection').disabled).toBe(false);
  await act(async () => { button('Cancel connection').click(); button('Cancel connection').click(); });
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.update).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared');
  expect(container.textContent).not.toContain('Connection cancelled'); expect(button('Reconnect').disabled).toBe(false);
  await focusComposer(); expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledTimes(2); expect(api.send).not.toHaveBeenCalled();
});

it('retains a cancelling connection and offers retry when disconnect fails instead of treating HTTP completion as stop', async () => {
  const { api } = fixture(); let reject!: (error: Error) => void;
  api.connect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.disconnect.mockRejectedValueOnce(new Error('Process still stopping'));
  await renderDraft(); await focusComposer(); await click('Cancel connection');
  expect(container.textContent).toContain('Process still stopping'); expect(button('Cancel connection').disabled).toBe(false);
  expect(useThreadDraftStore.getState().drafts.draft!.externalConversationId).toBe('prepared'); expect(api.update).not.toHaveBeenCalled();
  api.disconnect.mockImplementationOnce(async () => { reject(new Error('Cancelled')); });
  await click('Cancel connection'); expect(button('Reconnect').disabled).toBe(false);
});

it('does not let a stale initial read overwrite the result of explicit preparation', async () => {
  const { api } = fixture(); let initial!: (value: ExternalConversationSnapshot) => void;
  api.read.mockImplementationOnce(() => new Promise(resolve => { initial = resolve; }));
  useThreadDraftStore.getState().patch('draft', { externalConversationHost: f.host, externalPreparationKey: 'original', externalConversationId: 'prepared' });
  await renderDraft(); await focusComposer(); expect(button('Send').disabled).toBe(false);
  await act(async () => initial(snapshot()));
  expect(button('Send').disabled).toBe(false); expect(container.textContent).toContain('Use session configuration (current: First model)');
});

it('keeps an explicit model rejection and the draft intact rather than silently falling back to another model', async () => {
  const { api } = fixture(); await renderDraft(); await focusComposer(); await choose('Model', 'second');
  api.send.mockRejectedValueOnce(new ExternalAgentError('invalid_model', 'Model was withdrawn', 400));
  await submit();
  expect(container.textContent).toContain('Model was withdrawn'); expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ text: 'Original question', externalModels: { agent: 'second' }, externalInput: undefined });
  expect(api.send).toHaveBeenCalledOnce(); expect(api.send.mock.calls[0]![2].model).toBe('second');
  expect(api.send.mock.calls[0]![2].thinking).toBeUndefined(); expect(f.select).not.toHaveBeenCalled();
});

it('ignores an authentication completion after the execution Host is replaced', async () => {
  const { api } = fixture(); api.connect.mockRejectedValueOnce(new ExternalAgentError('auth_required', 'Authenticate', 401, { authentication: { methods: [{ id: 'login', name: 'Sign in', type: 'agent' }] } }));
  let finish!: () => void; api.authenticate.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(capabilities()); }));
  await renderDraft(); await focusComposer(); await click('Sign in');
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => finish());
  expect(api.send).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('Use session configuration (current: First model)'); expect(api.send).not.toHaveBeenCalled();
});

it('retries failed model discovery through the existing connection without preparing another binding or sending input', async () => {
  const { api, views } = fixture();
  api.connect.mockImplementationOnce(async id => {
    const view = views.get(id)!; view.connected = true; view.capabilities = { ...capabilities(), models: [], modelsRefresh: true, modelsError: 'Model list request failed' };
    return view.capabilities!;
  });
  await renderDraft(); await focusComposer();
  expect(container.textContent).toContain('Model list request failed'); expect(button('Send').disabled).toBe(false);
  expect(container.querySelector('input[aria-label="Model"]')).toBeNull();
  await click('Retry model discovery');
  expect(api.connect.mock.calls.map(call => call[0])).toEqual(['prepared', 'prepared']); expect(api.create).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Model list request failed'); expect(container.querySelector('button[aria-label="Model"]')?.textContent).toContain('First model');
});

it('refreshes capabilities advertised after preparation without sending input or losing the retained draft', async () => {
  const { views, api, emit } = fixture(); await renderDraft(); await focusComposer();
  const view = views.get('prepared')!; view.capabilities = { ...capabilities(), current: { model: 'second', mode: 'auto' }, commands: [{ name: 'review', description: 'Review changes' }] };
  view.observationRevision++;
  await emit();
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('Second model');
  expect(f.composer?.backendCommands).toEqual([{ name: 'review', description: 'Review changes' }]); expect(useThreadDraftStore.getState().drafts.draft!.text).toBe('Original question');
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
  const { api } = fixture(); await renderDraft(); await focusComposer();
  api.update.mockRejectedValueOnce(new Error('Delete response lost'));
  await click('Choose another Agent'); expect(useThreadDraftStore.getState().drafts.draft!.harnessId).toBe('agent');
  api.read.mockRejectedValueOnce(new ExternalAgentError('external_agent_failed', 'not found: external conversation was deleted', 404));
  await click('Choose another Agent');
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ harnessId: 'other', externalConversationId: 'prepared' });
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
    return view.capabilities!;
  });
  await renderDraft(); await focusComposer(); await choose('Model', 'first'); await choose('chat.context.thinking', 'low');
  await choose('Model', 'second');
  expect(container.querySelector('button[aria-label="chat.context.thinking"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Session effort"]')).toBeNull();
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
  await act(async () => root.render(<ExternalOptionMenu kind="model" options={{ capabilities: { ...capabilities(), modelsError: 'SDK catalog unavailable' },
    choice: {}, onChange: () => {}, onInteract: () => {}, onRetryModels: retry }} />));
  expect(container.textContent).toContain('SDK catalog unavailable');
  expect(container.textContent).not.toContain('Retry model discovery');
  expect(retry).not.toHaveBeenCalled();
});


it('preserves external binary selections on preparation failure and retries without sending a partial input', async () => {
  const { api } = fixture();
  api.uploadAttachment.mockRejectedValueOnce(new Error('remote owner unavailable'));
  await renderDraft(); await focusComposer();
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

it('does not connect on opening a default external draft and first send awaits one preparation', async () => {
  const { api } = fixture();
  f.settings!.defaultAgent = 'agent';
  useThreadDraftStore.getState().patch('draft', { harnessId: undefined });
  await renderDraft(); expect(api.create).not.toHaveBeenCalled(); expect(api.connect).not.toHaveBeenCalled();
  let finish!: () => void;
  const original = api.connect.getMockImplementation()!;
  api.connect.mockImplementationOnce(id => new Promise(resolve => { finish = () => { void original(id).then(resolve); }; }));
  await focusComposer(); await submit(); await submit();
  expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(api.send).toHaveBeenCalledExactlyOnceWith('prepared', expect.any(String), expect.objectContaining({ text: 'Original question' }));
});

it('uses cached choices before connection and validates only the live directory', async () => {
  const { api, views } = fixture();
  f.settings!.capabilityCache = { agent: { capabilities: capabilities(), cachedAt: 1 } };
  await renderDraft(); expect(api.connect).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Last known');
  await choose('Model', 'second');
  expect(useThreadDraftStore.getState().drafts.draft.externalModels?.agent).toBe('second');
  api.connect.mockImplementationOnce(async id => { const view = views.get(id)!; view.connected = true; view.capabilities = { ...capabilities(), models: [capabilities().models[0]!] }; return view.capabilities!; });
  await focusComposer();
  expect(useThreadDraftStore.getState().drafts.draft.externalModels?.agent).toBe('');
  expect(container.textContent).toContain('An option is no longer available');
  expect(api.send).not.toHaveBeenCalled();
});

it('applies configured defaults once per new draft and does not learn the last choice', async () => {
  fixture(); f.settings!.agents[0]!.defaults = { model: 'first', thinking: 'high', mode: 'auto' };
  await renderDraft();
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ externalModels: { agent: 'first' }, externalOptions: { agent: { thinking: 'high', mode: 'auto' } } });
  await focusComposer(); await choose('Model', 'second');
  await act(async () => { useThreadDraftStore.getState().remove('draft'); useThreadDraftStore.getState().patch('draft', { harnessId: 'agent', workspacePath: '/project' }); });
  expect(useThreadDraftStore.getState().drafts.draft.externalModels?.agent).toBe('first');
  expect(f.settings!.agents[0]!.defaults).toEqual({ model: 'first', thinking: 'high', mode: 'auto' });
});

it('cancels while durable creation is unresolved without connecting or losing its identity', async () => {
  const { api } = fixture(); let finish!: () => void;
  api.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(snapshot().conversation); }));
  await renderDraft(); await focusComposer(); await click('Cancel connection');
  expect(api.disconnect).not.toHaveBeenCalled(); expect(api.connect).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.connect).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.draft.externalConversationId).toBe('prepared');
  await focusComposer(); expect(api.create).toHaveBeenCalledOnce(); expect(api.connect).toHaveBeenCalledOnce();
});

it('switches away during unresolved creation only after cancelling and confirming the empty binding', async () => {
  const { api } = fixture(); let finish!: () => void;
  api.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(snapshot().conversation); }));
  await renderDraft(); await focusComposer(); await click('Choose another Agent');
  expect(useThreadDraftStore.getState().drafts.draft.harnessId).toBe('agent');
  expect(api.update).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared');
  expect(api.update).toHaveBeenCalledExactlyOnceWith('prepared', 1, { deleted: true });
  expect(api.create).toHaveBeenCalledTimes(2); expect(api.create.mock.calls[1]![0].configurationId).toBe('other');
  expect(api.connect).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
});

it('keeps explicit model and effort overrides when discovery fails and sends the original choice', async () => {
  const { api, views } = fixture();
  f.settings!.agents[0]!.defaults = { model: 'first', thinking: 'high' };
  api.connect.mockImplementationOnce(async id => { const view = views.get(id)!; view.connected = true; view.capabilities = { ...capabilities(), models: [], modelsError: 'Discovery failed' }; return view.capabilities!; });
  await renderDraft(); await focusComposer();
  expect(useThreadDraftStore.getState().drafts.draft.externalOptions?.agent?.thinking).toBe('high');
  await submit(); expect(api.send.mock.calls[0]![2]).toMatchObject({ model: 'first', thinking: 'high' });
});

it('reconnects reclaimed sessions on input without replaying an old turn', async () => {
  const { api, views } = fixture(); const view = views.get('prepared')!;
  view.connection = { status: 'reclaimed' }; view.capabilities = capabilities(); view.capabilitiesSource = 'cached';
  view.turns = [{ id: 'old', conversationId: 'prepared', key: 'original', status: 'completed', createdAt: 1, updatedAt: 1 }];
  api.connect.mockImplementationOnce(async id => { const current = views.get(id)!; current.connected = true; current.capabilitiesSource = 'live'; current.connection = { status: 'connected' }; return current.capabilities!; });
  await renderConversation(); expect(api.connect).not.toHaveBeenCalled();
  await act(async () => f.composer?.external?.onInteract('input'));
  expect(api.connect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.send).not.toHaveBeenCalled();
});

it('gates image and file attachment routes by live or cached capabilities', async () => {
  fixture(); f.settings!.capabilityCache = { agent: { capabilities: { ...capabilities(), images: false, files: undefined }, cachedAt: 1 } };
  await renderDraft(); expect(f.composer?.imageDisabled).toBe(true);
  await act(async () => f.composer?.onFiles([new File(['test'], 'a.txt')]));
  expect(useThreadDraftStore.getState().drafts.draft.files).toBeUndefined();
  expect(container.textContent).toContain('This Agent does not support files.');
});

it('boolean options toggle in one click and can return to session inheritance', async () => {
  fixture(); let choice: ExternalSessionChoice = {};
  function Controls() {
    const [value, setValue] = React.useState(choice); choice = value;
    return <ExternalModeControls options={{ capabilities: { ...capabilities(), configOptions: [{ id: 'tools', name: 'Tools', type: 'boolean', currentValue: true, options: [] }] }, choice: value, onChange: setValue, onInteract: () => {} }} />;
  }
  await act(async () => root.render(<Controls />));
  await click('Tools: Yes'); expect(choice.config).toEqual({ tools: 'false' });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Use session configuration (current: true)')!.click());
  expect(choice.config).toEqual({}); expect(button('Tools: Yes')).toBeDefined();
});

it('collapses left options only when their measured widths cannot fit and restores them on resize', async () => {
  fixture(); let width = 700, resize!: () => void;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.getAttribute('data-width') ? Number(this.getAttribute('data-width')) : 20, bottom: 50 } as DOMRect; };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width; } });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return 260; } });
  await act(async () => root.render(<div data-chat-input-footer><div className="conversation-composer-options"><button type="button" data-width="30">Add</button><ExternalModeControls options={{ capabilities: capabilities(), choice: {}, onChange: () => {}, onInteract: () => {} }} /></div><div className="conversation-composer-models" data-width="150" /><div className="conversation-composer-actions" data-width="80" /></div>));
  expect(button('Session options')).toBeUndefined();
  await act(async () => { width = 400; resize(); }); expect(button('Session options')).toBeDefined();
  await act(async () => { width = 800; resize(); }); expect(button('Session options')).toBeUndefined();
  window.HTMLElement.prototype.getBoundingClientRect = original;
});

it('explicit reconnect stops the old process first while catalog retry leaves a healthy connection running', async () => {
  const { api, views } = fixture(); views.get('prepared')!.connected = true; views.get('prepared')!.capabilities = capabilities();
  await renderConversation(); await click('Reconnect');
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.connect).toHaveBeenCalledExactlyOnceWith('prepared');
  expect(api.disconnect.mock.invocationCallOrder[0]).toBeLessThan(api.connect.mock.invocationCallOrder[0]!);
});

it.each([
  { images: true, files: undefined, filename: 'image.png', mimeType: 'image/png', allowed: true },
  { images: true, files: undefined, filename: 'vector.svg', mimeType: 'image/svg+xml', allowed: false },
  { images: true, files: undefined, filename: 'notes.txt', mimeType: 'text/plain', allowed: false },
  { images: false, files: 'paths' as const, filename: 'image.png', mimeType: 'image/png', allowed: true },
])('routes $filename with images=$images and files=$files before upload', async ({ images, files, filename, mimeType, allowed }) => {
  const { api, views } = fixture();
  f.settings!.capabilityCache = { agent: { capabilities: { ...capabilities(), images, files }, cachedAt: 1 } };
  api.connect.mockImplementationOnce(async id => { const view = views.get(id)!; view.connected = true; view.capabilities = { ...capabilities(), images, files }; return view.capabilities; });
  await renderDraft();
  await act(async () => f.composer?.onFiles([new File(['original'], filename, { type: mimeType })]));
  expect(Boolean(useThreadDraftStore.getState().drafts.draft.files?.length)).toBe(allowed);
  if (allowed) { await submit(); expect(api.uploadAttachment).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledOnce(); }
  else { expect(api.uploadAttachment).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled(); }
});

it('keeps the latest rapid backend switch while an older preparation is being cancelled', async () => {
  const { api } = fixture(); let finish!: () => void;
  f.settings!.agents.push({ id: 'third', name: 'Third', harness: 'acp', enabled: true, command: 'third', args: [] });
  api.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(snapshot().conversation); }));
  await renderDraft(); await focusComposer();
  await act(async () => { button('Choose another Agent').click(); button('Choose third Agent').click(); });
  await act(async () => finish());
  expect(useThreadDraftStore.getState().drafts.draft.harnessId).toBe('third');
  expect(api.disconnect).toHaveBeenCalledOnce(); expect(api.update).toHaveBeenCalledOnce();
  expect(api.create.mock.calls.map(([input]) => input.configurationId)).toEqual(['agent', 'third']);
  expect(api.connect).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
});

it('deduplicates conversation cancellation and ignores an old completion after a new preparation', async () => {
  const { api } = fixture(); let finish!: () => void;
  api.connect.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(capabilities()); }));
  await renderConversation(); await focusComposer();
  await act(async () => { button('Cancel connection').click(); button('Cancel connection').click(); });
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith('prepared');
  await focusComposer(); expect(api.connect).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  expect(button('Reconnect').disabled).toBe(false); expect(container.textContent).toContain('Connected'); expect(api.send).not.toHaveBeenCalled();
});

it.each(['draft', 'conversation'] as const)('keeps a live non-resumable %s usable instead of disconnecting for restart', async surface => {
  const { api, views } = fixture(); const view = views.get('prepared')!;
  const negotiated = { ...capabilities(), resume: false, modelsError: 'Catalog unavailable' };
  if (surface === 'draft') {
    api.connect.mockImplementationOnce(async () => { view.connected = true; view.capabilities = negotiated; return negotiated; });
    await renderDraft(); await focusComposer();
  } else {
    view.connected = true; view.capabilities = negotiated;
    await renderConversation();
  }
  const reconnects = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Reconnect');
  expect(reconnects.length).toBeGreaterThan(0); expect(reconnects.every(node => node.disabled)).toBe(true);
  expect(container.textContent).toContain('This Agent cannot resume an existing session.');
  // Guard the operation too, not only a disabled presentation.
  await act(async () => f.composer?.external?.onRetryModels?.());
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(api.connect).toHaveBeenCalledTimes(surface === 'draft' ? 1 : 0);
  expect(view.connected).toBe(true); expect(api.send).not.toHaveBeenCalled();
});

it('allows metadata-only catalog refresh for a live non-resumable Agent', async () => {
  const { api, views } = fixture(); const view = views.get('prepared')!;
  view.connected = true; view.capabilities = { ...capabilities(), resume: false, modelsError: 'Catalog unavailable', modelsRefresh: true };
  await renderConversation(); expect(button('Retry model discovery').disabled).toBe(false);
  await click('Retry model discovery');
  expect(api.connect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.disconnect).not.toHaveBeenCalled();
});

it('uses the Host error for an already-disconnected bound non-resumable session', async () => {
  const { api, views } = fixture(); const view = views.get('prepared')!;
  view.conversation.sessionId = 'original-native'; view.capabilities = { ...capabilities(), resume: false }; view.capabilitiesSource = 'cached';
  api.connect.mockRejectedValueOnce(new ExternalAgentError('resume_unsupported', 'The original session cannot be resumed. Start a new conversation.', 409));
  await renderConversation(); await focusComposer();
  expect(api.connect).toHaveBeenCalledExactlyOnceWith('prepared'); expect(api.disconnect).not.toHaveBeenCalled();
  expect(container.textContent).toContain('The original session cannot be resumed. Start a new conversation.');
  expect(api.send).not.toHaveBeenCalled();
});

it('opens an original external turn in the existing read-only view and reads older history without sending or connecting', async () => {
  const { api, views } = fixture(); const view = views.get('prepared')!;
  view.turns = [{ id: 'old-turn', conversationId: 'prepared', key: 'old', status: 'completed', createdAt: 1, updatedAt: 2 }, { id: 'new-turn', conversationId: 'prepared', key: 'new', status: 'completed', createdAt: 3, updatedAt: 4 }];
  view.items = [{ id: 'new-answer', turnId: 'new-turn', kind: 'assistant', text: 'Unrelated latest answer' }]; view.previous = 10;
  api.read.mockImplementation(async (_id, before) => before === 10 ? { ...view, previous: undefined, items: [{ id: 'old-answer', turnId: 'old-turn', kind: 'assistant', text: 'Original event result' }] } : structuredClone(view));
  await act(async () => root.render(<ExternalConversationView id="prepared" turnId="old-turn" readOnly />));
  expect(api.read).toHaveBeenCalledWith('prepared', 10, expect.any(AbortSignal)); expect(container.textContent).toContain('Original event result'); expect(container.textContent).not.toContain('Unrelated latest answer');
  expect(api.connect).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
});


it('uses source Host configuration and model defaults, never the coordinating Host same-ID profile', async () => {
  const { api } = fixture();
  const owner = { kind: 'managed_host' as const, hostId: 'source-host', connectionId: 'source-connection', endpointIdentity: 'source-endpoint' };
  api.settings.mockResolvedValue({ revision: 3, defaultAgent: 'agent', agents: [{ ...f.settings!.agents[0]!, name: 'Source Agent', defaults: { model: 'source-model' } }] });
  useThreadDraftStore.getState().patch('draft', { sourceSelection: { resourceOwner: owner, path: '/project', mode: 'live_root', contentMode: 'saved-files', captureScopes: [] }, externalModels: { agent: 'coordinator-model' } });
  await renderDraft();
  expect(api.settings).toHaveBeenCalledWith(expect.any(AbortSignal), owner);
  expect(f.composer?.external?.choice.model).toBe('source-model');
  expect(api.create).not.toHaveBeenCalled();
  await focusComposer();
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ source: { resourceOwner: owner, path: '/project' }, title: 'Source Agent' }));
});

it('does not fall back to coordinating Host agents or cached capabilities when source settings fail', async () => {
  const { api } = fixture();
  api.settings.mockRejectedValue(new Error('Source Host unavailable'));
  f.settings!.capabilityCache = { agent: { capabilities: capabilities(), cachedAt: 1 } };
  useThreadDraftStore.getState().patch('draft', { sourceSelection: { resourceOwner: { kind: 'managed_host', hostId: 'offline', connectionId: 'offline-connection', endpointIdentity: 'offline-endpoint' }, path: '/project', mode: 'live_root', contentMode: 'saved-files', captureScopes: [] } });
  await renderDraft();
  expect(button('Send').disabled).toBe(true);
  expect(f.composer?.external?.capabilities).toBeUndefined();
  await focusComposer();
  expect(api.create).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.draft?.text).toBe('Original question');
});


it('retains the original draft source and preparation key until source-switch cleanup is confirmed', async () => {
  const { api } = fixture();
  await renderDraft(); await focusComposer();
  const key = useThreadDraftStore.getState().drafts.draft?.externalPreparationKey;
  api.update.mockRejectedValueOnce(new Error('Cleanup outcome unknown'));
  await click('Workspace'); await click('Choose source Host');
  expect(useThreadDraftStore.getState().drafts.draft).toMatchObject({ externalPreparationKey: key, externalConversationId: 'prepared', workspacePath: '/project' });
  expect(useThreadDraftStore.getState().drafts.draft?.sourceSelection).toBeUndefined();
  expect(api.settings).not.toHaveBeenCalled();
  await click('Choose source Host');
  expect(useThreadDraftStore.getState().drafts.draft?.sourceSelection?.resourceOwner).toMatchObject({ kind: 'managed_host', hostId: 'source-host' });
  expect(useThreadDraftStore.getState().drafts.draft?.externalPreparationKey).toBeUndefined();
  expect(api.create).toHaveBeenCalledOnce();
});
