import { addEditorContextAttachment, listEditorContextAttachments, resetEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import { registerRuntimeAPIs, getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { DocumentsAPI, RuntimeAPIs } from '@varin/application-client';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import type { ContextCheckpoint, ThreadIdentity, ThreadSnapshot, ThreadSubmit, ThreadsAPI } from '@varin/application-client';
import type { ChildTask, DelegatedExecution, StoredMedia, McpInteractionView, FetchResult } from '@varin/protocol';
import { ThreadConversation } from './ThreadConversation';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { bindThreadStore, threadHostKey, threadIdentityKey, useThreadStore } from '@/stores/useThreadStore';
import { ChatView } from '@/components/views/ChatView';
import { AgentWorkspaceShell } from '@/workbenches/agent/AgentWorkspaceShell';
import { useUIStore } from '@/stores/useUIStore';
import type { WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryPlan, WorkspaceRecoveryAPI } from '@varin/extension-contract';

const translations = vi.hoisted(() => ({ dictionary: {} as Record<string, string> }));
const runtimeState = vi.hoisted(() => ({ api: undefined as ThreadsAPI | undefined }));
const endpoint = vi.hoisted(() => ({ generation: 1, hostKey: 'host-a', listeners: new Set<() => void>() }));
const recoveryService = vi.hoisted(() => ({ api: undefined as WorkspaceRecoveryAPI | undefined }));
vi.mock('@/lib/recovery/workspaceRecovery', async original => ({
  ...await original<typeof import('@/lib/recovery/workspaceRecovery')>(),
  getWorkspaceRecoveryAPI: () => { if (!recoveryService.api) throw new Error('Recovery unavailable'); return recoveryService.api; },
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  getRuntimeKey: () => endpoint.hostKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/lib/attachProcessTerminal', () => ({ attachProcessTerminal: vi.fn() }));
// This fixture drives the Thread observer directly; the global Host event transport
// has its own lifecycle tests and must not open a real connection from linkedom.
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ ...getRegisteredRuntimeAPIs(), threads: runtimeState.api }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign((selector: (state: { currentDirectory: string }) => unknown) => selector({ currentDirectory: '/workspace/project' }), { getState: () => ({ currentDirectory: '/workspace/project', setDirectory: () => {} }) }) }));
vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: ({ renderConversation }: { renderConversation?: (active: boolean) => React.ReactNode }) => <div>{renderConversation ? renderConversation(true) : <ChatView />}</div> }));
vi.mock('@/components/views/RegularChatView', () => ({ RegularChatView: () => <div data-testid="existing-conversations" /> }));
vi.mock('@/apps/mobileWorkspaceShell', () => ({ MobileWorkspaceShell: () => null }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
vi.mock('@/lib/extensions/workbench-registry', async original => ({ ...await original<typeof import('@/lib/extensions/workbench-registry')>(), useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => undefined }));

vi.mock('@/lib/i18n', () => {
  const t = (key: string) => translations.dictionary[key] ?? key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
// Exercise the conversation's delivery/ownership behavior through the composer port.
// CodeMirror, popup interaction and layout are exercised in the actual desktop renderer.
vi.mock('./ThreadComposer', () => ({ ThreadComposer: (props: React.ComponentProps<typeof import('./ThreadComposer').ThreadComposer>) => <div
  onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); props.onFiles([...event.dataTransfer.files]); }}>
  {props.children}
  <select aria-label="Registered model" disabled={props.modelDisabled} value={JSON.stringify([props.providerId, props.modelId])}
    onChange={event => { const [provider, model] = JSON.parse(event.currentTarget.value); props.onModelChange(provider, model, props.thinkingLevel); }}>
    <option value={JSON.stringify(['', ''])}>Choose a registered model</option>
    {props.models.map(model => <option key={`${model.providerId}:${model.modelId}`} value={JSON.stringify([model.providerId, model.modelId])}>{model.name ?? model.modelId}</option>)}
  </select>
  <select aria-label="Thinking level" disabled={props.modelDisabled} value={props.thinkingLevel} onChange={event => props.onModelChange(props.providerId, props.modelId, event.currentTarget.value as typeof props.thinkingLevel)}>
    {(props.models.find(model => model.providerId === props.providerId && model.modelId === props.modelId)?.thinkingLevels ?? ['off']).map(level => <option key={level}>{level}</option>)}
  </select>
  <select aria-label="Input delivery" value={props.delivery} onChange={event => props.onDeliveryChange(event.currentTarget.value as typeof props.delivery)}>
    <option value="boundary">At next model boundary</option><option value="interrupt">Interrupt current generation</option>{props.allowNextRun && <option value="next_run">After current run</option>}
  </select>
  <textarea aria-label="Message thread" ref={props.editorRef as React.Ref<HTMLTextAreaElement>} value={props.value} onInput={event => props.onChange(event.currentTarget.value)}
    onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); props.onFiles(files); } }} />
  <button type="button" disabled={props.attachmentDisabled || props.imageDisabled} onClick={props.onAttachImages}>Attach images</button>
  <button type="button" disabled={props.attachmentDisabled} onClick={props.onAttachPdfs}>chat.fileAttachment.actions.attachPdfs</button>
  <button type="button" disabled={!props.onCompact} onClick={props.onCompact}>Generate context summary</button>
  <button type="button" onClick={props.onOpenHistory}>Open conversation history</button>
  <button type="submit" disabled={props.sendDisabled}>{props.retrying ? 'Retry delivery' : props.active ? 'Queue message' : 'Send'}</button>
  {props.onStop && <button type="button" onClick={props.onStop}>Stop run</button>}
</div> }));
vi.mock('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('./WorkOverviewControl', () => ({ WorkOverviewControl: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));

// This suite tests native conversation ownership and its real message controls. The
// virtual viewport's geometry and scrolling require a browser, so render its rows here.
vi.mock('@legendapp/list/react', () => ({ LegendList: React.forwardRef((props: {
  data: Array<{ id: string }>; renderItem(input: { item: { id: string }; index: number }): React.ReactNode;
  ListHeaderComponent?: React.ReactNode; ListFooterComponent?: React.ReactNode;
}, ref) => {
  const node = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => ({ getScrollableNode: () => node.current,
    getState: () => ({ data: props.data, scroll: 0, scrollLength: 600, contentLength: 600, positionAtIndex: () => 0 }),
    scrollToIndex: async () => {}, scrollToOffset: async () => {}, scrollToEnd: async () => {},
  }), [props.data]);
  return <div ref={node}>{props.ListHeaderComponent}{props.data.map((item, index) => <React.Fragment key={item.id}>{props.renderItem({ item, index })}</React.Fragment>)}{props.ListFooterComponent}</div>;
}) }));

const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=';
const storedImage: StoredMedia = { media_type: 'image/png', content_ref: { content_object: 'sha256-original-image' }, source: { kind: 'operation', operation_id: 'capture' } };
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:ui-fixture', branchId: 'branch:ui-fixture' };
function initialSnapshot(active = false): ThreadSnapshot {
  const run = { id: 'ui-run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: { providerId: 'fixture-provider', model: 'fixture-model' }, cancel_requested: false, waiting_on: null };
  return { identity, eventCursor: 0, thread: { thread_id: identity.threadId, main_branch_id: identity.branchId, title: '', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: active ? run.id : null, latest_run: active ? run : null }] }, activeRun: active ? run : null,
    history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [], launch: null, modelSelection: {desired:null,active:null}, policySelection: null, context: { checkpoint: null, jobs: [] } };
}
function fixture(active = false) {
  const view = initialSnapshot(active);
  const submit = vi.fn(async (_input: ThreadSubmit) => ({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', input_id: 'sent', cursor: 1 }));
  const enqueue = vi.fn(async () => ({ input_id: 'queued-new', run_id: 'ui-run', mode: 'interrupt' as const, cursor: 2 }));
  const editInput = vi.fn(async (id: string, revision: number, text: string) => {
    const input = view.inputs.find(value => value.id === id)!;
    input.revision = revision + 1; input.content = { text }; return input;
  });
  const cancelInput = vi.fn(async (id: string) => { const input = view.inputs.find(value => value.id === id)!; input.state = 'cancelled'; return input; });
  const cancelRun = vi.fn(async () => {
    const run = { ...view.activeRun!, state: 'cancelled' as const, cancel_requested: true };
    view.activeRun = null; view.thread.branches[0]!.active_run_id = null; view.thread.branches[0]!.latest_run = run;
    return run;
  });
  let listener: Parameters<ThreadsAPI['observe']>[1] | undefined;
  const unused = async (): Promise<never> => { throw new Error('unused fixture API'); };
  const api: ThreadsAPI = { contextHistory: unused, fileTarget: unused, usage: unused, update: unused, delete: unused, markRead: unused, materials: { upload: vi.fn(unused), readSource: vi.fn(unused), read: vi.fn(unused), readArtifact: vi.fn(unused) }, computer: { state: vi.fn<ThreadsAPI['computer']['state']>(async target => ({ state: { work: target, rootWork: target, currentExecution: null, currentRootExecution: null, active: false, status: 'enabled', leases: [], requests: [], cleanups: [] }, activities: [] })), stop: vi.fn(unused), decide: vi.fn(unused) }, goals: { start: vi.fn(unused), update: unused, control: unused, list: async () => view.goals }, resources: { refresh: unused }, followups: { jobSources: async () => [], register: unused, list: unused, get: unused, occurrence: unused, occurrences: unused, control: unused, pendingRegistrations: async () => [], cancelRegistration: unused }, listModels: async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model' }], list: async () => [view.thread], create: async () => identity,
    mediaRead: vi.fn(async input => ({ media: storedImage, partIndex: input.partIndex, chunkIndex: 0, chunkCount: 1, totalBytes: Buffer.from(imageData, 'base64').length, bytesBase64: imageData })),
    listMcpInteractions: vi.fn(async () => ({ items: [], nextCursor: null })), readMcpInteraction: unused, respondMcpInteraction: unused,
    reviewMcpSamplingRequest: unused, reviewMcpSamplingOutput: unused,
    snapshot: async () => structuredClone(view), submit, enqueue, editInput, cancelInput, cancelRun,
    sources: { list: async () => ({ targets: [{ resourceOwner: { kind: 'local' }, label: 'This Host', capabilities: [] }], unavailable: [] }),
      resolve: async (_identity, request) => ({ resourceOwner: request.resourceOwner, path: request.path, workspaceId: (await getRegisteredRuntimeAPIs()!.documents.resolveWorkspace({ path: request.path })).workspaceId }) },
    recoverySource: unused, prepareNavigation: unused, navigate: unused, navigationReceipt: unused,
    inspectTools: unused, inspectPolicy: unused, restartPolicy: unused, cancelPolicyUpdate: unused, selectModel: unused, decidePermission: unused, answerQuestion: unused, prepareSource: unused, fork: unused, compact: unused, publishContext: unused, cancelContext: unused, resumeContext: unused, historyPage: unused, run: unused, operation: unused, cancelOperation: unused, resume: unused, retryPreparation: unused, events: async () => [],
    observe: async (_cursor, onEvent, { signal }) => new Promise<void>(resolve => { listener = onEvent; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }),
  };
  return { api, view, submit, enqueue, editInput, cancelInput, cancelRun, emit: (event: Parameters<ThreadsAPI['observe']>[1] extends (value: infer T) => void ? T : never) => listener?.(event) };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  translations.dictionary = {};
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  useThreadDraftStore.setState({ drafts: {} });
  useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
  resetEditorContextAttachments();
  endpoint.generation = 1; endpoint.hostKey = 'host-a';
  recoveryService.api = undefined;
  useUIStore.setState({ recoveryPreference: 'conversation' });
  runtimeState.api = undefined; vi.mocked(attachProcessTerminal).mockClear();
  const documents: Pick<DocumentsAPI, 'resolveWorkspace'> = { resolveWorkspace: async () => ({ workspaceId: 'canonical-source-workspace', hostId: 'fixture-host', epoch: 1 }) };
  registerRuntimeAPIs({ documents } as RuntimeAPIs);
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '20px', fontSize: '14px' }));
  window.HTMLElement.prototype.scrollIntoView = () => {};
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('FileReader', class {
    result: string | null = null; error: Error | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    readAsDataURL(file: File) {
      void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }, error => { this.error = error; this.onerror?.(); });
    }
  });
  vi.stubGlobal('FormData', class { constructor(private form: HTMLFormElement) {} get(name: string) { return this.form.querySelector<HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? null; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); registerRuntimeAPIs(null); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const edit = async (selector: string, value: string, event = 'input') => {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event(event, { bubbles: true })); });
};
const submitForm = async (form: HTMLFormElement) => { await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
const button = (text: string) => {
  const labels: Record<string, string> = { 'Resume run': 'chat.run.resume', 'Retry preparation': 'chat.run.retryPreparation', 'Save queued input': 'settings.common.actions.saveChanges', 'Read report': 'chat.children.report', 'Read execution report': 'chat.children.report', 'Stop child subtree': 'harness.threads.stop', 'Cancel queued input': 'chat.queuedMessage.removeAria', 'Restore before this message': 'chat.messageBody.actions.revertAria', 'Restore through this message': 'chat.messageBody.actions.revertAria', 'Branch conversation only': 'chat.messageBody.actions.forkAria', 'Generate context summary': 'thread.message.summarize', 'View image': 'chat.media.view', 'Stop task and children': 'harness.threads.stopAll' };
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => {
    if (value.textContent === text || value.textContent === labels[text] || text === 'Continue child' && value.textContent === 'Send') return true;
    if (!labels[text] || value.getAttribute('aria-label') !== labels[text]) return false;
    if (text.startsWith('Restore ')) return value.closest('[data-conversation-message-role]')?.getAttribute('data-conversation-message-role') === (text.startsWith('Restore before') ? 'user' : 'assistant');
    return true;
  })!;
};
const pdfFile = (name = 'original.pdf') => new File(['%PDF-1.7\nOriginal PDF bytes\n%%EOF'], name, { type: 'application/pdf' });
const uploadedPdf = (snapshotId = 'retained-original'): FetchResult => {
  const sourceSnapshot = { snapshotId, sourceUrl: 'upload:original.pdf', finalUrl: 'upload:original.pdf', fetchedAt: 1,
    contentHash: 'text-hash', representation: 'pdf-text', byteLength: 31,
    document: { kind: 'pdf' as const, parser: 'native', source: { contentHash: 'original-byte-hash', byteLength: 31, contentType: 'application/pdf' } } };
  return { status: 'ok', url: sourceSnapshot.sourceUrl, finalUrl: sourceSnapshot.finalUrl, contentType: 'application/pdf',
    markdown: '', bytes: 31, rendered: false, fromCache: false, sourceSnapshot,
    snapshot: { ...sourceSnapshot, snapshotId: 'derived-text-view' } };
};
const choosePdfs = async (...files: File[]) => {
  const picker = container.querySelector<HTMLInputElement>('[aria-label="chat.fileAttachment.actions.choosePdfs"]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: files });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const composerForm = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!;

it('waits for the original snapshot before choosing submit or enqueue for a restored draft', async () => {
  const f = fixture(true);
  let finish!: (snapshot: ThreadSnapshot) => void;
  f.api.snapshot = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async () => structuredClone(f.view));
  const key = threadIdentityKey(threadHostKey(), identity);
  useThreadDraftStore.getState().patch(key, { text: 'Restored draft', inputMode: 'boundary', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(button('Send').disabled).toBe(true);
  await submitForm(composerForm());
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  await act(async () => finish(structuredClone(f.view)));
  expect(button('Queue message').disabled).toBe(false);
  await submitForm(composerForm());
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ text: 'Restored draft', mode: 'boundary' }));
  expect(f.submit).not.toHaveBeenCalled();
});

it('sends a new conversation from its captured project workspace, independent of later navigation', async () => {
  const f = fixture();
  const key = threadIdentityKey(threadHostKey(), identity);
  useThreadDraftStore.getState().patch(key, { workspacePath: '/chosen-project', text: 'Read the project', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  const prepared = { path: '/chosen-project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'chosen', executionWorkspaceId: 'chosen', mode: 'live_root' as const,
    liveRoot: { hostId: 'host-a', canonicalRoot: '/chosen-project', rootId: 'root-a' }, tools: ['file_read' as const] } };
  f.api.sources.resolve = vi.fn(async (_identity, request) => ({ resourceOwner: request.resourceOwner, path: request.path, workspaceId: 'chosen' }));
  f.api.prepareSource = vi.fn().mockResolvedValue(prepared);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/different-sidebar-project" />));
  await submitForm(composerForm());
  expect(f.api.sources.resolve).toHaveBeenCalledExactlyOnceWith(identity, { resourceOwner: { kind: 'local' }, path: '/chosen-project' });
  expect(f.api.prepareSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: 'chosen', mode: 'live_root' }));
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: prepared.source, text: 'Read the project' }));
  expect(useThreadDraftStore.getState().drafts[key]?.text).toBe('');
});

it('an explicitly armed goal retains its accepted Run and budget when Goal registration needs retry', async () => {
  const f = fixture();
  const key = threadIdentityKey(threadHostKey(), identity);
  useUIStore.setState({ sessionGoalDefaultBudgetEnabled: true, sessionGoalDefaultBudget: 200_000 });
  useThreadDraftStore.getState().patch(key, { text: 'Complete the project', goalArmed: true, model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  f.api.goals.start = vi.fn().mockRejectedValueOnce(new Error('Goal receipt disconnected')).mockResolvedValue({});
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await submitForm(composerForm());
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(useThreadDraftStore.getState().drafts[key]?.pendingInput).toMatchObject({ status: 'unknown', acceptedRunId: 'ui-run' });
  await submitForm(composerForm());
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.api.goals.start).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.api.goals.start).mock.calls[0]).toEqual(vi.mocked(f.api.goals.start).mock.calls[1]);
  expect(f.api.goals.start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'ui-run', objective: 'Complete the project', budget: { maxOutputTokens: 200_000 } }));
  expect(useThreadDraftStore.getState().drafts[key]?.goalArmed).toBe(false);
  useUIStore.setState({ sessionGoalDefaultBudgetEnabled: false });
});

it('selects a desired model during an active run and keeps its display until activation',async()=>{
  const f = fixture(true);
  f.api.listModels = async()=>[{providerId:'fixture-provider',modelId:'fixture-model'},{providerId:'replacement-provider',modelId:'replacement-model'}];
  const selectModel = vi.fn<ThreadsAPI['selectModel']>(async input=>{
    const selection = {id:input.key,run_id:input.runId,revision:1,binding_id:`model:${input.key}`,status:'ready' as const,failure:null,credential_scope:null,
      configuration:{providerId:input.model.providerId,providerFamily:'openai-responses',model:input.model.modelId,thinkingLevel:input.model.thinkingLevel,
        endpoint:'http://localhost/responses',allowAnonymous:true,credentialEnvironment:null,configurationGeneration:2,maxOutputTokens:32}};
    f.view.modelSelection.desired = selection;
    return selection;
  });
  f.api.selectModel = selectModel;
  await act(async()=>root.render(<ThreadConversation api={f.api} identity={identity}/>));
  const selector = container.querySelector<HTMLSelectElement>('[aria-label="Registered model"]')!;
  expect(selector.disabled).toBe(false);
  await edit('[aria-label="Registered model"]',JSON.stringify(['replacement-provider','replacement-model']),'change');
  expect(selectModel).toHaveBeenCalledOnce();
  expect(selectModel.mock.calls[0]![0]).toMatchObject({...identity,runId:'ui-run',model:{providerId:'replacement-provider',modelId:'replacement-model'}});
  expect(selector.value).toBe(JSON.stringify(['replacement-provider','replacement-model']));
  expect(container.textContent).toContain('chat.model.nextRequest');
  expect(f.view.activeRun?.configuration).toMatchObject({model:'fixture-model'});
  f.view.activeRun!.configuration = f.view.modelSelection.desired!.configuration;
  f.view.modelSelection.desired!.status = 'active';
  f.view.modelSelection.active = f.view.modelSelection.desired;
  await act(async()=>f.emit({cursor:1,subject:'ui-run',revision:2,kind:'run.model_activated',data:{}}));
  expect(selector.value).toBe(JSON.stringify(['replacement-provider','replacement-model']));
  expect(container.textContent).not.toContain('chat.model.nextRequest');
});

it('renders the composer and retries an uncertain send with the same request identity and text', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(new Error('temporary transport failure'));
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(container.querySelector('[aria-label="Thread conversation"]')).not.toBeNull();
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'keep this user message');
  await submitForm(container.querySelector('form')!);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporary transport failure');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('keep this user message');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]);
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ ...identity, text: 'keep this user message', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('');
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.api.goals.start).not.toHaveBeenCalled();
});

it('active-thread controls queue the chosen mode, save/cancel queued text, and stop the selected Run', async () => {
  const f = fixture(true);
  const job: ThreadSnapshot['operations'][number] = { id: 'independent-research-job', run_id: 'ui-run', epoch: 1,
    revision: 1, phase: 'running', outcome: null, effect: 'confirmed', cancel_requested: false,
    lifetime: 'thread', handed_off: true, executor: 'research_submit', waiting_on: null,
    intent: {}, result: null, external_receipt: null, call_completion: null,
    execution_owner: { kind: 'external', identity: 'research-owner', epoch: 'owner-epoch' } };
  const observation = { ...job, id: 'research-observer', executor: 'research_wait', phase: 'waiting' as const,
    effect: 'none' as const, waiting_on: 'host-job-wait:research-observer' };
  f.view.operations.push(job, observation);
  const cancelOperation = vi.fn<ThreadsAPI['cancelOperation']>(async id => {
    const operation = f.view.operations.find(item => item.id === id)!;
    operation.cancel_requested = true; return operation;
  });
  f.api.cancelOperation = cancelOperation;
  f.view.inputs.push({ id: 'queued-existing', thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', mode: 'boundary', state: 'queued', revision: 3, content: { text: 'original queued text' }, cursor: 1 });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(button('Cancel operation')).toBeDefined();
  await act(async () => { button('Cancel observation wait').click(); });
  expect(cancelOperation.mock.calls).toEqual([[observation.id]]);
  expect(job.cancel_requested).toBe(false);
  await edit('[aria-label="Input delivery"]', 'interrupt', 'change');
  await edit('[aria-label="Message thread"]', 'new queued instructions');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!);
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ...identity, mode: 'interrupt', text: 'new queued instructions' }));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="chat.queuedMessage.edit"]')!.click());
  await edit('textarea[aria-label="chat.queuedMessage.edit"]', 'edited queued text');
  await submitForm(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="chat.queuedMessage.edit"]')!.closest('form')!);
  expect(f.editInput).toHaveBeenCalledWith('queued-existing', 3, 'edited queued text');
  await act(async () => { button('Cancel queued input').click(); });
  expect(f.cancelInput).toHaveBeenCalledWith('queued-existing', 4);
  expect(container.querySelector('textarea[aria-label="chat.queuedMessage.edit"]')).toBeNull();
  await act(async () => { button('Stop run').click(); });
  expect(f.cancelRun).toHaveBeenCalledWith('ui-run');
  expect(button('Stop run')).toBeUndefined();
});

it.each(['file-backed', 'source-free'] as const)('keeps the original report, wait and subtree stop for a %s child without inferring file or effect completion', async sourceKind => {
  const f = fixture(true); pauseView(f.view);
  const sourceFree = sourceKind === 'source-free';
  const child: ChildTask = { operation_id: 'original-child', parent_run_id: 'ui-run', parent_thread_id: identity.threadId, parent_branch_id: identity.branchId,
    child_thread_id: 'thread:child', child_branch_id: 'branch:child', origin: { kind: 'model_step' as const, request_id: 'request' }, call_id: 'dispatch', project_id: null,
    input: { task: sourceFree ? 'Summarize task-family messages' : 'Run a private experiment' }, selected_profile: { preset_id: 'custom:experiment', catalog_identity: 'frozen', work_mode: sourceFree ? 'read_only' : 'isolated_write',
      tools: sourceFree ? ['send', 'wait_child'] : ['process_spawn'], instructions: 'Retain measured results' }, configuration: {}, launch: f.view.launch!.selection,
    state: sourceFree ? 'failed' : 'completed', revision: 3, cursor: 3, receipt: { run_id: 'child-run', input_id: 'input', branch_id: 'branch:child', thread_id: 'thread:child', cursor: 1 },
    report: { outcome: sourceFree ? 'failed' : 'succeeded', sender_thread_id: 'thread:child', run_id: 'child-run', history_ids: ['original-report'], detail: 'The original child report' },
    resources_released: !sourceFree, code_result: sourceFree ? { kind: 'not_applicable' } : { kind: 'pending' },
    source: sourceFree ? { kind: 'absent' } : { kind: 'pending', handoff: { operation_id: 'handoff', resource_authority: null, source: { resource_owner: { kind: 'local' as const }, mode: 'fixed_branch' as const, workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'source', revision: 0, live_root: null },
      root: { kind: 'fixed' as const, pin: { pin_id: 'pin', root: 'root', source: { resource_owner: { kind: 'local' as const }, mode: 'fixed_branch' as const, workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'source', revision: 0, live_root: null } } } } },
  };
  f.view.children = [child];
  const observation: ThreadSnapshot['operations'][number] = { id: 'original-child-wait', run_id: 'ui-run', epoch: 1, revision: 1,
    phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'run', handed_off: false,
    executor: 'wait_child', waiting_on: 'wait:original-child', intent: {}, result: null, external_receipt: null, call_completion: null, execution_owner: { kind: 'kernel' } };
  f.view.operations.push(observation, { ...observation, id: 'independent-effect', executor: 'extension_capability',
    phase: 'running', effect: 'unknown', waiting_on: null, handed_off: true });
  const cancelOperation = vi.fn<ThreadsAPI['cancelOperation']>(async () => observation);
  f.api.cancelOperation = cancelOperation;
  const readReport = vi.fn<NonNullable<ThreadsAPI['collaboration']>['readReport']>(async () => ({
    format: 'text', operation_id: child.operation_id, execution_id: 'original-execution', item_id: 'original-report', offset: 0, next_offset: null, total_bytes: 14, text: 'Original bytes',
  }));
  const cancelChild = vi.fn(async (_identity: ThreadIdentity, operationId: string) => ({ target: { kind: 'child' as const, operation_id: operationId }, cursor: 4, run_count: 1, child_count: 1, process_count: 1 }));
  const cancelTree = vi.fn(async () => ({ target: { kind: 'thread' as const, thread_id: identity.threadId }, cursor: 5, run_count: 2, child_count: 1, process_count: 1 }));
  f.api.collaboration = { integration: vi.fn(), continueChild: async () => { throw new Error('No continuation'); }, executions: async () => [], readExecutionReport: async () => { throw new Error('No report'); }, children: async () => [child], readReport, cancelWait: async () => { throw new Error('No wait'); }, cancelChild, cancelTree };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  const assertFileResult = () => sourceFree
    ? expect(container.textContent).not.toMatch(/chat.children.(filesPublished|noChanges|settling|filesUnavailable)/)
    : expect(container.textContent).toContain('chat.children.settling');
  assertFileResult();
  if (sourceFree) {
    const card = container.querySelector('[aria-label="harness.threads.title"]')!;
    expect(card.textContent).toContain('harness.threads.state.failed');
    expect(card.textContent).toContain('The original child report');
    expect(card.textContent).not.toMatch(/Private working copy|Read-only source|Preparing a stable source|No file changes|File result (pending|unavailable)/);
  }
  expect(container.textContent).toContain('Background operation · running · In progress · effect: unknown');
  await act(async () => { button('Read report').click(); });
  expect(readReport).toHaveBeenCalledExactlyOnceWith(identity, child.operation_id, 'original-report', 0, undefined, expect.any(AbortSignal));
  expect(container.textContent).toContain('Original bytes');
  await act(async () => { button('Cancel observation wait').click(); });
  expect(cancelOperation).toHaveBeenCalledExactlyOnceWith(observation.id);
  expect(cancelChild).not.toHaveBeenCalled();
  assertFileResult();
  await act(async () => { button('Stop child subtree').click(); });
  expect(cancelChild).toHaveBeenCalledExactlyOnceWith(identity, 'original-child');
  // A short admission ACK is not a process-stop or file-publication fact.
  assertFileResult();
  expect(container.textContent).toContain('Background operation · running · In progress · effect: unknown');
  await act(async () => { button('Stop task and children').click(); });
  expect(cancelTree).toHaveBeenCalledExactlyOnceWith(identity);
});

it('registers a process follow-up through an uncertain reply and preserves the actual delivery and observation owners', async () => {
  const f = fixture(true);
  f.view.operations = [{ id: 'process:original', run_id: 'ui-run', epoch: 1, revision: 1,
    phase: 'running', outcome: null, effect: 'dispatched', cancel_requested: false,
    lifetime: 'environment', handed_off: true, executor: 'process_spawn', waiting_on: null,
    intent: {}, result: null, external_receipt: null, call_completion: {
      kind: 'job_accepted', operation_id: 'process:original', phase: 'running', effect: 'dispatched', lifetime: 'environment',
    }, execution_owner: { kind: 'kernel' } }];
  const followup: ThreadSnapshot['followups'][number] = { repeat: 'once', exhausted: false, pending_occurrences: 0, id: 'followup:one', revision: 1, generation: 1,
    thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'ui-run', sources: [{ consumed_cursor: 0, source_index: 0, after_cursor: 1, observed: null, file: null, log: null, metric: null }], state: 'active', goal_id: null,
    actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1_700_000_000_000, observation: null,
    trigger: { kind: 'process_stopped', operation_id: 'process:original' },
    wait: { id: 'wait:process', kind: 'process_stopped', after_cursor: 1, trigger_cursor: null, state: 'waiting' }, occurrence: null };
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('uncertain follow-up reply'))
    .mockImplementation(async () => { f.view.followups = [followup]; return followup; });
  const control = vi.fn<ThreadsAPI['followups']['control']>(async input => {
    expect(input.expectedRevision).toBe(followup.revision); followup.revision += 1;
    followup.state = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'cancelled';
    return structuredClone(followup);
  });
  const get = vi.fn<ThreadsAPI['followups']['get']>(async () => ({ followup, instruction: 'Read the original output.', registration_trigger: { kind: 'process_stopped', operationId: 'process:original' } }));
  const resumeRun = vi.fn(f.api.resume); f.api.resume = resumeRun;
  f.api.followups = { ...f.api.followups, register, control, get, list: async () => f.view.followups };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'process_stopped', 'change');
  await edit('[aria-label="Follow-up process"]', 'process:original', 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Read the original output.');
  await act(async () => button('Register one-time follow-up').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('uncertain follow-up reply');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up instruction"]')!.disabled).toBe(true);
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(register.mock.calls[0]![0]);
  expect(register.mock.calls[0]![0]).toMatchObject({ ...identity, runId: 'ui-run', trigger: { kind: 'process_stopped', operationId: 'process:original' }, instruction: 'Read the original output.' });
  expect(get).not.toHaveBeenCalled();
  await act(async () => button('Read follow-up instruction').click());
  expect(get).toHaveBeenCalledWith(identity, followup.id, expect.any(AbortSignal));
  expect(container.textContent).toContain('Read the original output.');
  await act(async () => button('Pause follow-up').click()); await act(async () => button('Resume follow-up').click());
  expect(control.mock.calls.map(([input]) => [input.action, input.expectedRevision])).toEqual([['pause', 1], ['resume', 2]]);
  expect(resumeRun).not.toHaveBeenCalled();
  followup.occurrence = { accepted_cursor: 4, id: 'occurrence:one', generation: 1, trigger_cursor: 4, evidence: { kind: 'process_stopped', receipt_identity: 'receipt:process', receipt_epoch: 'kernel:original' },
    state: 'admitted', hold_reason: 'question', delivery: { input_id: 'input:original', run_id: 'continuation:run', execution_id: null,
      state: 'queued', activation_state: 'bound', delivered_cursor: null, failure_code: null } };
  await act(async () => f.emit({ cursor: 5, subject: followup.id, revision: 4, kind: 'ingress.run_ready', data: { run_id: 'continuation:run' } }));
  expect(container.textContent).toContain('Waiting for a user answer'); expect(button('Cancel follow-up')).toBeDefined();
  followup.occurrence.delivery!.state = 'delivered'; followup.occurrence.delivery!.delivered_cursor = 6; followup.occurrence.hold_reason = null;
  followup.wait.state = 'consumed';
  await act(async () => f.emit({ cursor: 6, subject: followup.id, revision: 5, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).toBeNull(); expect(button('Cancel follow-up')).toBeUndefined();
  expect(container.querySelector('[aria-label="Past follow-up"]')).toBeNull();
  await act(async () => button('Past follow-ups (1)').click());
  expect(container.textContent).toContain('run continuation:run'); expect(f.cancelRun).not.toHaveBeenCalled();
  f.view.followups = [{ ...followup, goal_id: 'goal-owner', actor: { kind: 'goal', goal_id: 'goal-owner' }, occurrence: null }];
  await act(async () => f.emit({ cursor: 7, subject: followup.id, revision: 6, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).toBeNull(); expect(button('Pause follow-up')).toBeUndefined();
});

it('retains an exact absolute time across an uncertain retry and exposes explicit Goal follow-ups without reviving the stopped Run', async () => {
  const f = fixture(true); const source = { ...f.view.activeRun!, state: 'cancelled' as const, cancel_requested: true };
  f.view.activeRun = null; f.view.thread.branches[0]!.active_run_id = null; f.view.thread.branches[0]!.latest_run = source;
  const followup: ThreadSnapshot['followups'][number] = { repeat: 'once', exhausted: false, pending_occurrences: 0, id: 'followup:time', revision: 1, generation: 1, thread_id: identity.threadId,
    branch_id: identity.branchId, source_run_id: source.id, sources: [{ consumed_cursor: 0, source_index: 0, after_cursor: 0, observed: null, file: null, log: null, metric: null }], state: 'active', goal_id: 'goal:original',
    actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1_700_000_000_000, observation: null,
    trigger: { kind: 'at', at_ms: 0 }, wait: { id: 'time-wait', kind: 'at', after_cursor: 0, trigger_cursor: null, state: 'waiting' }, occurrence: null };
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('reply lost')).mockImplementation(async input => {
    followup.trigger = { kind: 'at', at_ms: input.trigger.kind === 'at' ? input.trigger.atMs : 0 }; f.view.followups = [followup]; return followup;
  }); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  const chosen = '2030-02-03T04:05:06'; await edit('[aria-label="Follow-up time"]', chosen);
  await edit('[aria-label="Follow-up instruction"]', '  Check the original output.\nKeep the dependency blocked.  ');
  await act(async () => button('Register one-time follow-up').click());
  expect(register.mock.calls[0]![0]).toMatchObject({ runId: source.id, trigger: { kind: 'at', atMs: new Date(chosen).getTime() }, instruction: '  Check the original output.\nKeep the dependency blocked.  ' });
  f.view.thread.branches[0]!.latest_run = { ...source, id: 'later-run' };
  await act(async () => f.emit({ cursor: 1, subject: 'later-run', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(register.mock.calls[0]![0]);
  expect(container.querySelector('[aria-label="Pending follow-up"]')?.textContent).toContain('registered by User');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});

it.each(['any', 'all'] as const)('registers %s conditions as one retained intent and renders original partial source progress', async kind => {
  const f = fixture(true);
  f.view.operations = [{ id: 'process:original', run_id: 'ui-run', epoch: 1, revision: 1, phase: 'running', outcome: null,
    effect: 'dispatched', cancel_requested: false, lifetime: 'environment', handed_off: true, executor: 'process_spawn', waiting_on: null,
    intent: {}, result: null, external_receipt: null, call_completion: { kind: 'job_accepted', operation_id: 'process:original',
      phase: 'running', effect: 'dispatched', lifetime: 'environment' }, execution_owner: { kind: 'kernel' } }];
  const chosen = '2030-02-03T04:05:06'; const atMs = new Date(chosen).getTime();
  const followup: ThreadSnapshot['followups'][number] = { repeat: 'once', exhausted: false, pending_occurrences: 0, id: `followup:${kind}`, revision: 1, generation: 1,
    thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'ui-run', state: 'active', goal_id: null,
    actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1_700_000_000_000, observation: null,
    trigger: { kind, sources: [{ kind: 'at', at_ms: atMs }, { kind: 'process_stopped', operation_id: 'process:original' }] },
    sources: [{ consumed_cursor: 0, source_index: 0, after_cursor: 1, observed: null, file: null, log: null, metric: null }, { consumed_cursor: 0, source_index: 1, after_cursor: 1, observed: null, file: null, log: null, metric: null }],
    wait: { id: `wait:${kind}`, kind, after_cursor: 1, trigger_cursor: null, state: 'waiting' }, occurrence: null };
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('acceptance reply lost'))
    .mockImplementation(async () => { f.view.followups = [followup]; return followup; });
  f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', kind, 'change');
  await edit('[aria-label="Condition 1 time"]', chosen);
  await edit('[aria-label="Condition 2 process"]', 'process:original', 'change');
  await act(async () => button('Add condition').click());
  expect(button('Register one-time follow-up').disabled).toBe(true);
  await act(async () => button('Remove condition 3').click());
  await edit('[aria-label="Follow-up instruction"]', 'Read the original evidence once.');
  await act(async () => button('Register one-time follow-up').click());
  expect(register.mock.calls[0]![0]).toMatchObject({ ...identity, runId: 'ui-run', trigger: { kind, sources: [
    { kind: 'at', atMs }, { kind: 'process_stopped', operationId: 'process:original' },
  ] } });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Condition 1 time"]')!.disabled).toBe(true);
  expect(button('Add condition').disabled).toBe(true);
  f.view.activeRun = { ...f.view.activeRun!, id: 'later-run' };
  await act(async () => f.emit({ cursor: 2, subject: 'later-run', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(register.mock.calls[0]![0]);
  followup.sources[0]!.observed = { accepted_cursor: 3, trigger_cursor: 3, evidence: { kind: 'at', at_ms: atMs, observed_at_ms: atMs + 1 } };
  if (kind === 'any') {
    followup.wait = { ...followup.wait, state: 'observed', trigger_cursor: 3 };
    followup.occurrence = { accepted_cursor: 3, id: 'occurrence:any', generation: 1, trigger_cursor: 3, state: 'held', hold_reason: 'manual_pause',
      evidence: { kind: 'any', sources: [{ source_index: 0, ...followup.sources[0]!.observed }] }, delivery: null };
  }
  await act(async () => f.emit({ cursor: 3, subject: followup.id, revision: 2, kind: 'followup.sources_observed', data: {} }));
  expect(container.textContent).toContain('observed at event 3');
  expect(container.textContent).toContain('Condition 2: After process process:original actually stops · waiting');
  expect(button('Cancel follow-up')).toBeDefined();
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});


it('ordinary Agent workspace creates a native Thread directly and opens its canonical branch', async () => {
  const f = fixture(); const create = vi.fn(f.api.create); f.api.create = create; runtimeState.api = f.api;
  let unbind: (() => void) | undefined;
  try {
    await act(async () => { unbind = bindThreadStore(f.api); });
    useThreadStore.setState({ selectedIdentity: null });
    await act(async () => { root.render(<AgentWorkspaceShell />); });
    expect(create).toHaveBeenCalledOnce();
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    expect(container.querySelector('[aria-label="Thread conversation"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Conversation runtime"]')).toBeNull();
  } finally { await act(async () => unbind?.()); }
});

it('freezes editor and inline context on an unknown send and acknowledges only captured revisions', async () => {
  const f = fixture(); f.submit.mockRejectedValueOnce(new Error('lost receipt'));
  const host = threadHostKey(); const threadKey = threadIdentityKey(host, identity);
  const attachment: EditorContextAttachment = { id: 'editor-1', runtimeKey: host, threadKey, workspaceId: 'workspace-a', resourceId: 'file-a',
    label: 'code.ts', documentInstanceId: 'document-a', documentRevision: 'disk-1', localEditRevision: 1,
    source: 'unsaved-buffer', kind: 'selection', text: 'original editor context', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 } };
  addEditorContextAttachment(attachment);
  const target = { directory: '/workspace/project', sessionKey: threadKey };
  const inlineId = useInlineCommentDraftStore.getState().addDraft(target, { source: 'diff', fileLabel: 'code.ts', startLine: 2, endLine: 2,
    code: 'original code', language: 'typescript', text: 'original inline context' })!;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  // Context-only submission is a real input even when the text editor is empty.
  expect(button('Send').disabled).toBe(false);
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[0][0].text).toContain('original editor context');
  expect(f.submit.mock.calls[0][0].text).toContain('original inline context');
  await act(async () => {
    addEditorContextAttachment({ ...attachment, localEditRevision: 2, text: 'newer editor context' });
    useInlineCommentDraftStore.getState().updateDraft(target, inlineId, { text: 'newer inline context' });
  });
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[1][0]).toEqual(f.submit.mock.calls[0][0]);
  expect(listEditorContextAttachments(host, threadKey)[0].text).toBe('newer editor context');
  expect(useInlineCommentDraftStore.getState().getDrafts(target)[0].text).toBe('newer inline context');
});

it.each(['thread', 'branch', 'host'] as const)('a late accepted receipt clears only its original text and PDF draft after %s navigation', async changed => {
  const f = fixture(); let accept!: (value: Awaited<ReturnType<ThreadsAPI['submit']>>) => void;
  f.submit.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  vi.mocked(f.api.materials.upload).mockResolvedValueOnce(uploadedPdf('original-pdf')).mockResolvedValueOnce(uploadedPdf('new-pdf'));
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'accepted original');
  await choosePdfs(pdfFile());
  await submitForm(container.querySelector('form')!);
  const originalKey = threadIdentityKey(threadHostKey(), identity);
  const fork = changed === 'thread' ? { ...identity, threadId: 'thread:late' } : changed === 'branch' ? { ...identity, branchId: 'branch:late' } : identity;
  if (changed === 'host') await act(async () => { endpoint.generation++; endpoint.hostKey = 'host-b'; endpoint.listeners.forEach(listener => listener()); });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={fork} />); });
  await edit('[aria-label="Message thread"]', 'keep fork draft');
  await choosePdfs(pdfFile('new.pdf'));
  await act(async () => { accept({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'accepted', input_id: 'accepted', cursor: 2 }); });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('keep fork draft');
  expect(useThreadDraftStore.getState().drafts[originalKey].text).toBe('');
  expect(useThreadDraftStore.getState().drafts[originalKey].materials).toEqual([]);
  expect(useThreadDraftStore.getState().drafts[originalKey].pendingInput).toBeUndefined();
  expect(useThreadDraftStore.getState().drafts[threadIdentityKey(threadHostKey(), fork)].materials.map(item => item.snapshotId)).toEqual(['new-pdf']);
});

it('retains original text, image bytes and request identity across branch navigation after a lost receipt', async () => {
  const f = fixture(); f.submit.mockRejectedValueOnce(new Error('lost receipt'));
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'original message');
  await submitForm(container.querySelector('form')!);
  const original = f.submit.mock.calls[0][0];
  const fork = { ...identity, branchId: 'branch:other' };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={fork} />); });
  await edit('[aria-label="Message thread"]', 'other draft');
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('original message');
  await edit('[aria-label="Message thread"]', 'newer editor text');
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[1][0]).toEqual(original);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('newer editor text');
  expect(useThreadDraftStore.getState().drafts[threadIdentityKey(threadHostKey(), fork)].text).toBe('other draft');
});

it('shared file picker previews image-only input, retains bytes/key on failure, and supports removing a selected image', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(new ThreadRequestError(400, 'kernel-frame-too-large'));
  f.submit.mockImplementationOnce(async input => {
    f.view.history.push({ id: 'accepted-image', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', provider: null, content: { text: input.text, attachments: input.images?.map(() => storedImage) } });
    return { thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', input_id: 'sent', cursor: 1 };
  });
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=';
  const file = new File([Uint8Array.from(Buffer.from(data, 'base64'))], 'fixture.png', { type: 'image/png' });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  const choose = async () => {
    const picker = container.querySelector<HTMLInputElement>('[aria-label="Choose image attachments"]')!;
    await act(async () => {
      Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
      picker.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  await choose();
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
  expect(button('Send').disabled).toBe(false);
  await submitForm(container.querySelector('form')!);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('attachments are still here');
  expect(container.querySelector('img')).not.toBeNull();
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]);
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ text: '', images: [{ mimeType: 'image/png', data }] });
  expect(container.querySelector('form img')).toBeNull();
  expect(container.querySelector('article img')).toBeNull();
  await act(async () => button('View image').click());
  expect(container.querySelector('article img')?.getAttribute('src')).toBe('blob:test-image');
  await choose();
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="chat.fileAttachment.actions.removeImage"]')!.click(); });
  expect(container.querySelector('form img')).toBeNull();
  expect(button('Send').disabled).toBe(true);
});

it('uploads original PDF bytes under the selected Thread and sends its retained source snapshot with a text-only model', async () => {
  const f = fixture();
  f.api.listModels = async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model', acceptsImages: false }];
  const upload = vi.mocked(f.api.materials.upload).mockResolvedValue(uploadedPdf());
  vi.mocked(f.api.materials.read).mockResolvedValue({ status: 'snapshot-missing', snapshotId: 'retained-original' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  expect(button('Attach images').disabled).toBe(true);
  expect(button('chat.fileAttachment.actions.attachPdfs').disabled).toBe(false);
  const file = pdfFile(); await choosePdfs(file);
  expect(upload).toHaveBeenCalledExactlyOnceWith(identity, { filename: file.name, mimeType: 'application/pdf',
    data: Buffer.from(await file.arrayBuffer()).toString('base64') }, expect.any(AbortSignal));
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')?.textContent).toContain(file.name);
  await act(async () => button('harness.pdf.openReader · original.pdf').click());
  expect(f.api.materials.read).toHaveBeenCalledExactlyOnceWith(identity, { snapshotId: 'retained-original', view: 'overview' }, expect.any(AbortSignal));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button('Send').disabled).toBe(false);
  await submitForm(composerForm());
  expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ ...identity, text: '', images: [], materials: [{ snapshotId: 'retained-original' }] }));
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')).toBeNull();
  expect(button('Send').disabled).toBe(true);
  expect(upload).toHaveBeenCalledOnce();
});

it.each(['paste', 'drop'] as const)('accepts PDF and image files through %s while preserving their separate native attachment paths', async kind => {
  const f = fixture(); const upload = vi.mocked(f.api.materials.upload).mockResolvedValue(uploadedPdf());
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  const pdf = new File(['%PDF-1.7\noriginal bytes'], 'browser.PDF', { type: kind === 'drop' ? 'application/octet-stream' : '' });
  const image = new File([Buffer.from(imageData, 'base64')], 'image.png', { type: 'image/png' });
  await act(async () => {
    const event = new window.Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files: [pdf, image], types: ['Files'] } });
    container.querySelector('[aria-label="Message thread"]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(upload).toHaveBeenCalledExactlyOnceWith(identity, { filename: 'browser.PDF', mimeType: 'application/pdf',
    data: Buffer.from(await pdf.arrayBuffer()).toString('base64') }, expect.any(AbortSignal));
  await submitForm(composerForm());
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ images: [{ mimeType: 'image/png', data: imageData }], materials: [{ snapshotId: 'retained-original' }] });
});

it('joins repeated PDF selection and send clicks, then retries uncertain delivery with the same snapshots without another transfer', async () => {
  const f = fixture();
  let retain!: (result: FetchResult) => void;
  const upload = vi.mocked(f.api.materials.upload).mockImplementationOnce(() => new Promise(resolve => { retain = resolve; }));
  let reject!: (error: Error) => void;
  f.submit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await choosePdfs(pdfFile()); await choosePdfs(pdfFile());
  expect(upload).toHaveBeenCalledOnce(); expect(button('Send').disabled).toBe(true);
  await submitForm(composerForm()); expect(f.submit).not.toHaveBeenCalled();
  await act(async () => retain(uploadedPdf()));
  await act(async () => {
    composerForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    composerForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(f.submit).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Input receipt lost')));
  await choosePdfs(pdfFile('newer.pdf')); expect(upload).toHaveBeenCalledOnce();
  expect(button('chat.fileAttachment.actions.attachPdfs').disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="chat.fileAttachment.actions.removeNamed"]')?.disabled).toBe(true);
  const original = f.submit.mock.calls[0]![0];
  const next = { ...identity, branchId: 'other-branch' };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={next} />));
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')).toBeNull();
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Message thread"]', 'Keep this newer draft');
  await submitForm(composerForm());
  expect(f.submit.mock.calls[1]![0]).toEqual(original);
  expect(original.materials).toEqual([{ snapshotId: 'retained-original' }]);
  expect(upload).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('Keep this newer draft');
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')).toBeNull();
});

it('keeps retained PDFs after explicit pre-admission rejection and permits a corrected attachment without replaying the old upload', async () => {
  const f = fixture();
  const upload = vi.mocked(f.api.materials.upload).mockResolvedValueOnce(uploadedPdf()).mockResolvedValueOnce(uploadedPdf('replacement-pdf'));
  f.submit.mockRejectedValueOnce(new ThreadRequestError(409, 'material-unavailable', 'not_started'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await choosePdfs(pdfFile()); await submitForm(composerForm());
  expect(button('Send')).toBeDefined();
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')?.textContent).toContain('original.pdf');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="chat.fileAttachment.actions.removeNamed"]')!.click());
  expect(button('Send').disabled).toBe(true);
  await choosePdfs(pdfFile('replacement.pdf')); await submitForm(composerForm());
  expect(upload).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[1]![0].key).not.toBe(f.submit.mock.calls[0]![0].key);
  expect(f.submit.mock.calls[1]![0].materials).toEqual([{ snapshotId: 'replacement-pdf' }]);
});

it.each(['thread', 'branch', 'host', 'unmount'] as const)('discards a late PDF upload after %s replacement without attaching it to the new draft', async changed => {
  const f = fixture(); let retain!: (result: FetchResult) => void;
  const upload = vi.mocked(f.api.materials.upload).mockImplementationOnce(() => new Promise(resolve => { retain = resolve; }))
    .mockResolvedValue(uploadedPdf('new-snapshot'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await choosePdfs(pdfFile('old.pdf'));
  const originalHost = threadHostKey(); const signal = upload.mock.calls[0]![2]!;
  const next = changed === 'thread' ? { ...identity, threadId: 'other-thread' } : changed === 'branch' ? { ...identity, branchId: 'other-branch' } : identity;
  if (changed === 'host') await act(async () => { endpoint.generation++; endpoint.hostKey = 'host-b'; endpoint.listeners.forEach(listener => listener()); });
  if (changed === 'unmount') await act(async () => root.render(null));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={next} />));
  expect(signal.aborted).toBe(true);
  await choosePdfs(pdfFile('new.pdf'));
  await act(async () => retain(uploadedPdf('late-snapshot')));
  const chips = container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')!;
  expect(chips.textContent).toContain('new.pdf'); expect(chips.textContent).not.toContain('old.pdf');
  expect(useThreadDraftStore.getState().drafts[threadIdentityKey(threadHostKey(), next)].materials.map(item => item.snapshotId)).toEqual(['new-snapshot']);
  if (threadIdentityKey(originalHost, identity) !== threadIdentityKey(threadHostKey(), next)) {
    expect(useThreadDraftStore.getState().drafts[threadIdentityKey(originalHost, identity)]?.materials ?? []).toEqual([]);
  }
  expect(upload).toHaveBeenCalledTimes(2); expect(f.submit).not.toHaveBeenCalled();
});

it.each(['boundary', 'interrupt', 'next_run'] as const)('queues retained PDF input in %s mode without sending upload bytes to the model request', async mode => {
  const f = fixture(true); const upload = vi.mocked(f.api.materials.upload).mockResolvedValue(uploadedPdf());
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Input delivery"]', mode, 'change'); await choosePdfs(pdfFile());
  await submitForm(composerForm());
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...identity, text: '', images: [], mode, materials: [{ snapshotId: 'retained-original' }] }));
  expect(upload).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')).toBeNull();
});

it('keeps earlier retained PDFs when a later file fails and never claims success without a retained PDF snapshot', async () => {
  const f = fixture(); const upload = vi.mocked(f.api.materials.upload).mockResolvedValueOnce(uploadedPdf())
    .mockResolvedValueOnce({ status: 'ok', url: 'upload:failed.pdf', finalUrl: 'upload:failed.pdf', contentType: 'application/pdf', markdown: '', bytes: 0, rendered: false, fromCache: false });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await choosePdfs(pdfFile(), pdfFile('failed.pdf'));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('chat.fileAttachment.pdfNotRetained');
  const chips = container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')!;
  expect(chips.textContent).toContain('original.pdf'); expect(chips.textContent).not.toContain('failed.pdf');
  expect(button('Send').disabled).toBe(false); await submitForm(composerForm());
  expect(upload).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[0]![0].materials).toEqual([{ snapshotId: 'retained-original' }]);
});


it('loads earlier images under a pinned head while live controls continue, then returns to latest messages', async () => {
  const f = fixture(true);
  const item = (id: string, text: string) => ({ id, thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'assistant' as const, content: { id, provenance: { kind: 'assistant' }, content: { kind: 'text', text }, opaque: null }, provider: null });
  f.view.history = [item('message-2', 'middle message'), item('message-3', 'pinned newest message')];
  f.view.historyPage = { head: 'message-3', previous: 'message-2' };
  f.view.thread.branches[0]!.head = 'message-3';
  const earlier = { ...item('message-1', 'oldest image message'), source: 'user' as const, content: { text: 'oldest image message', attachments: [storedImage] } };
  const historyPage = vi.fn(async () => ({ head: 'message-3', previous: null, items: [earlier] }));
  f.api.historyPage = historyPage;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await act(async () => { button('Load earlier history').click(); });
  expect(historyPage).toHaveBeenCalledWith(identity, { headId: 'message-3', beforeId: 'message-2' });
  expect(container.textContent).toContain('oldest image message');
  await act(async () => button('View image').click());
  expect(container.querySelector('article img')?.getAttribute('src')).toBe('blob:test-image');
  f.view.history = [item('message-3', 'pinned newest message'), item('message-4', 'new live arrival')];
  f.view.historyPage = { head: 'message-4', previous: 'message-3' };
  f.view.thread.branches[0]!.head = 'message-4';
  await act(async () => { f.emit({ cursor: 20, subject: 'ui-run', revision: 2, kind: 'history.appended', data: {} }); });
  expect(container.textContent).not.toContain('new live arrival');
  expect(button('Show latest messages')).toBeDefined();
  await act(async () => { button('Stop run').click(); });
  expect(f.cancelRun).toHaveBeenCalledWith('ui-run');
  expect(container.textContent).toContain('oldest image message');
  await act(async () => { button('Show latest messages').click(); });
  expect(container.textContent).toContain('new live arrival');
  expect(container.textContent).not.toContain('oldest image message');
});

it('acknowledges only visible live history and waits to mark newer activity until returning from an earlier page', async () => {
  const f = fixture(true);
  f.view.thread.activity_cursor = 1;
  f.view.historyPage = { head: 'head', previous: 'previous' };
  f.api.historyPage = async () => ({ head: 'head', previous: null, items: [] });
  const markRead = vi.spyOn(useThreadStore.getState(), 'markRead').mockResolvedValue(undefined);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(markRead).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  expect(markRead).toHaveBeenLastCalledWith(identity.threadId, 1);
  await act(async () => button('Load earlier history').click());
  markRead.mockClear();
  f.view.thread.activity_cursor = 2;
  await act(async () => f.emit({ cursor: 2, subject: 'ui-run', revision: 2, kind: 'history.appended', data: {} }));
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  expect(markRead).not.toHaveBeenCalled();
  await act(async () => button('Return to latest view').click());
  expect(markRead).toHaveBeenLastCalledWith(identity.threadId, 2);
});

it('discards an earlier-page response after the selected branch changes', async () => {
  const f = fixture();
  f.view.historyPage = { head: 'old-head', previous: 'old-cursor' };
  let resolvePage!: (page: Awaited<ReturnType<ThreadsAPI['historyPage']>>) => void;
  f.api.historyPage = () => new Promise(resolve => { resolvePage = resolve; });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await act(async () => { button('Load earlier history').click(); });
  expect(button('Loading earlier history').disabled).toBe(true);
  const next = { ...identity, branchId: 'another-branch' };
  f.view.identity = next;
  f.view.thread.branches = [{ branch_id: next.branchId, head: null, active_run_id: null, latest_run: null }];
  f.view.historyPage = { head: null, previous: null };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={next} />); });
  await act(async () => { resolvePage({ head: 'old-head', previous: null, items: [{ id: 'old-message', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', content: { text: 'history from the previous branch' }, provider: null }] }); });
  expect(container.textContent).not.toContain('history from the previous branch');
  expect(container.textContent).not.toContain('Viewing saved history');
  expect([...container.querySelectorAll('button')].filter(value => !value.closest('[inert]')).map(value => value.textContent)).not.toContain('Loading earlier history');
});

it('retries a conversation fork with the same request key and opens only the accepted branch', async () => {
  const f = fixture();
  f.view.history = [{ id: 'selected-message', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', content: { text: 'branch point' }, provider: null }];
  f.view.historyPage = { head: 'selected-message', previous: null };
  const created = { ...identity, branchId: 'accepted-fork' };
  const fork = vi.fn<ThreadsAPI['fork']>().mockRejectedValueOnce(new Error('uncertain transport')).mockResolvedValue(created);
  f.api.fork = fork;
  const open = vi.fn();
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} onBranchCreated={open} />); });
  await act(async () => { button('Branch conversation only').click(); });
  expect(open).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('uncertain transport');
  await act(async () => { button('Branch conversation only').click(); });
  expect(fork).toHaveBeenCalledTimes(2);
  expect(fork.mock.calls[1]![0]).toEqual(fork.mock.calls[0]![0]);
  expect(fork.mock.calls[0]![0]).toMatchObject({ ...identity, headId: 'selected-message' });
  expect(open).toHaveBeenCalledExactlyOnceWith(created);
});

it('does not navigate to a late fork result after the user selects another branch', async () => {
  const f = fixture();
  f.view.history = [{ id: 'selected-message', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', content: { text: 'branch point' }, provider: null }];
  let resolveFork!: (value: ThreadIdentity) => void;
  f.api.fork = () => new Promise(resolve => { resolveFork = resolve; });
  const open = vi.fn();
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} onBranchCreated={open} />); });
  await act(async () => { button('Branch conversation only').click(); });
  const next = { ...identity, branchId: 'user-selected-branch' };
  f.view.identity = next;
  f.view.thread.branches = [{ branch_id: next.branchId, head: null, active_run_id: null, latest_run: null }];
  f.view.history = [];
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={next} onBranchCreated={open} />); });
  await act(async () => { resolveFork({ ...identity, branchId: 'late-created-fork' }); });
  expect(open).not.toHaveBeenCalled();
});

function resourceCheckpoint(): ContextCheckpoint {
  const instruction = { origin: 'project' as const, kind: 'project-instruction' as const, appliesTo: '.',
    reference: { domainId: 'project:fixture', viewId: 'source:fixed', path: 'AGENTS.md', canonicalId: 'resource:instructions', version: 'instructions:one' } };
  const skill = { id: 'skill:review', name: 'review-code', description: 'Review code', disableModelInvocation: false, requiresProjectTrust: true,
    origin: 'project' as const, basePath: '.pi/skills/review', baseCanonicalId: 'resource:review', priority: 1,
    reference: { ...instruction.reference, path: '.pi/skills/review/SKILL.md', canonicalId: 'resource:review:skill', version: 'skill:one' } };
  return { id: 'context:original', revision: 3, resource_activations: [],
    proposal: { key: 'context:original', branch_id: identity.branchId, through_id: null, expected_revision: 2,
      summary: '', effective_system_prompt: 'Private composed prompt', instruction_sources: [], memory_checkpoint: null },
    resources: {
      source: { resource_owner: { kind: 'local' as const }, workspace_id: 'workspace:fixture', execution_workspace_id: 'workspace:fixture', branch_id: 'source:branch', revision: 7, mode: 'fixed_branch', live_root: null },
      snapshot: { id: 'resources:original', scope: { threadId: identity.threadId, branchId: identity.branchId, mode: 'agent', threadRole: 'main',
        projectId: 'project:fixture', sourceIdentity: 'source:fixed', cwd: '/workspace/project', projectTrusted: true, projectRoot: '/workspace/project' },
        readers: [{ domainId: 'project:fixture', viewId: 'source:fixed', consistency: 'immutable' }],
        project: { domainId: 'project:fixture', viewId: 'source:fixed', cwd: '.' }, configurationDigest: 'configuration:one', shadowedContextCanonicalIds: [],
        system: null, appendSystem: null, instructions: [instruction], instructionScopes: [], skills: [skill],
        diagnostics: [{ kind: 'read', status: 'missing', message: 'Optional resource is missing', location: { domainId: 'project:fixture', viewId: 'source:fixed', path: '.pi/skills/optional' } }],
        capturedFiles: [{ reference: instruction.reference, content: 'Private instruction body' }, { reference: skill.reference, content: 'Private skill body' }], observations: [] },
    },
  };
}

it('projects a registered source failure without exposing upstream detail or losing the unsent draft', async () => {
  const f = fixture();
  const failure = new ThreadRequestError(404, 'source_registration_missing');
  failure.message = 'Private storage path and upstream body';
  f.submit.mockRejectedValueOnce(failure);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'Continue reading the original source');
  await submitForm(container.querySelector('form')!);
  expect(container.textContent).toContain('Restore its original registration or select a new source.');
  expect(container.textContent).not.toContain('Private storage path');
  expect((container.querySelector('[aria-label="Message thread"]') as HTMLTextAreaElement).value).toBe('Continue reading the original source');
});

it('adds a hidden skill command and retains the draft and image through a resource conflict and retry', async () => {
  const f = fixture();
  const failure = new ThreadRequestError(409, 'resource-stale', 'not_started');
  failure.message = 'Private skill body at /not-for-ui/secret.md';
  f.submit.mockRejectedValueOnce(failure);
  const refresh = vi.fn<ThreadsAPI['resources']['refresh']>(async input => {
    const next = structuredClone(f.view.context.checkpoint!);
    next.id = 'context:retry'; next.revision = input.expectedRevision + 1; next.resources!.snapshot.id = 'resources:retry';
    f.view.context.checkpoint = next; return next;
  });
  f.api.resources.refresh = refresh;
  const checkpoint = resourceCheckpoint();
  checkpoint.resources!.snapshot.skills[0]!.disableModelInvocation = true;
  const skill = checkpoint.resources!.snapshot.skills[0]!;
  checkpoint.resources!.snapshot.skills.push({ ...skill, id: 'skill:spaced-name', name: `${skill.name} extra`,
    reference: { ...skill.reference, canonicalId: 'resource:spaced-name', path: '.pi/skills/spaced/SKILL.md' } });
  f.view.context.checkpoint = checkpoint;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  expect(container.textContent).toContain('Hidden from automatic model discovery');
  expect(button('Add /skill:review-code extra to draft').disabled).toBe(true);
  await act(async () => button('Add /skill:review-code extra to draft').click());
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('');
  await act(async () => button('Add /skill:review-code to draft').click());
  const composer = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!;
  expect(composer().value).toBe('/skill:review-code ');
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();

  const draft = 'Review this exact draft.\nKeep  its spacing.  ';
  await edit('[aria-label="Message thread"]', draft);
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=';
  const file = new File([Uint8Array.from(Buffer.from(data, 'base64'))], 'fixture.png', { type: 'image/png' });
  const picker = container.querySelector<HTMLInputElement>('[aria-label="Choose image attachments"]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => { button('Add /skill:review-code to draft').click(); button('Add /skill:review-code to draft').click(); });
  const text = `/skill:review-code ${draft}`;
  expect(composer().value).toBe(text);
  expect(composer().closest('form')?.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
  expect(f.submit).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Private skill body');
  await submitForm(composer().closest('form')!);
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ ...identity, text, images: [{ mimeType: 'image/png', data }] });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('has changed. Refresh instructions and skills');
  expect(container.textContent).not.toContain('/not-for-ui/secret.md');
  expect(composer().value).toBe(text);
  expect(composer().closest('form')?.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
  expect(button('Send').disabled).toBe(false);
  expect(button('Add /skill:review-code to draft').disabled).toBe(false);
  await act(async () => button('Refresh instructions and skills').click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ ...identity, expectedRevision: 3 });
  expect(composer().value).toBe(text);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await submitForm(composer().closest('form')!);
  expect(f.submit).toHaveBeenCalledTimes(2);
  const [first, second] = f.submit.mock.calls.map(([input]) => input);
  expect(second!.key).not.toBe(first!.key);
  expect(second).toEqual({ ...first, key: second!.key });
  expect(composer().value).toBe('');
  expect(composer().closest('form')?.querySelector('img')).toBeNull();
});

it('projects frozen skill metadata separately from original history and editable queued input', async () => {
  const f = fixture(true);
  const checkpoint = resourceCheckpoint();
  const skill = checkpoint.resources!.snapshot.skills[0]!;
  const text = '/skill:review-code  Keep the original\nuser text.  ';
  const invocation = { ordinal: 0, contentRevision: 1, resourceCheckpointId: checkpoint.id,
    snapshotId: checkpoint.resources!.snapshot.id, resourceId: skill.id, reference: { ...skill.reference },
    name: skill.name, arguments: 'Keep the original\nuser text.', body: 'Private admitted skill body' };
  const attachments = [storedImage];
  const content = { text, attachments, skillInvocations: [invocation] };
  f.view.history = [{ id: 'skill-history', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', provider: null, content }];
  f.view.inputs = [{ id: 'skill-queued', thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run',
    mode: 'boundary', state: 'queued', revision: 1, content, cursor: 1 }];
  // Resource refresh does not rewrite the material already accepted with each input.
  skill.name = 'review-revised-code'; skill.reference.version = 'skill:latest';
  f.view.context.checkpoint = checkpoint;
  f.editInput.mockImplementationOnce(async (id, revision, edited) => {
    const input = f.view.inputs.find(value => value.id === id)!;
    input.revision = revision + 1; input.content = { text: edited, attachments }; return input;
  });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="chat.queuedMessage.edit"]')!.click());
  const history = container.querySelector('article')!;
  const queued = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="chat.queuedMessage.edit"]')!;
  for (const metadata of container.querySelectorAll('[aria-label="Skill materials"]')) {
    expect(metadata.textContent).toContain(invocation.name);
    expect(metadata.textContent).toContain(invocation.reference.version);
    expect(metadata.textContent).toContain(invocation.reference.path);
    expect(metadata.textContent).not.toContain('skill:latest');
  }
  expect(container.querySelectorAll('[aria-label="Skill materials"]')).toHaveLength(2);
  expect(history.textContent).toContain(text);
  expect(queued().value).toBe(text);
  await act(async () => [...history.querySelectorAll('button')].find(value => value.textContent === 'chat.media.view')!.click());
  expect(history.querySelector('img')?.getAttribute('src')).toBe('blob:test-image');
  expect(container.textContent).not.toContain(invocation.body);
  expect(container.textContent).not.toContain('Private skill body');

  const edited = 'Ordinary queued instructions\nwith exact spacing.  ';
  await edit('textarea[aria-label="chat.queuedMessage.edit"]', edited);
  await submitForm(queued().closest('form')!);
  expect(f.editInput).toHaveBeenCalledExactlyOnceWith('skill-queued', 1, edited);
  expect(queued()).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="chat.queuedMessage.edit"]')!.click());
  expect(queued().value).toBe(edited);
  expect(queued().closest('form')?.querySelector('[aria-label="Skill materials"]')).toBeNull();
  await act(async () => [...queued().closest('form')!.querySelectorAll('button')].find(value => value.textContent === 'chat.media.view')!.click());
  expect(queued().closest('form')?.querySelector('img')?.getAttribute('src')).toBe('blob:test-image');
  expect(f.api.mediaRead).toHaveBeenLastCalledWith(expect.objectContaining({ holder: { kind: 'input', inputId: 'skill-queued', expectedRevision: 2 }, expectedContentRef: storedImage.content_ref.content_object }), expect.any(AbortSignal));
  expect(history.querySelector('[aria-label="Skill materials"]')).not.toBeNull();
  expect(history.textContent).toContain(text);
});

it('keeps frozen resource metadata on conflict and refreshes once with the current checkpoint revision', async () => {
  const f = fixture(true);
  const checkpoint = resourceCheckpoint();
  f.view.context.checkpoint = checkpoint;
  let completeRefresh!: (checkpoint: ContextCheckpoint) => void;
  const refresh = vi.fn<ThreadsAPI['resources']['refresh']>()
    .mockRejectedValueOnce(new ThreadRequestError(409, 'thread-conflict'))
    .mockImplementation(() => new Promise(resolve => { completeRefresh = resolve; }));
  f.api.resources.refresh = refresh;
  const snapshot = vi.fn(f.api.snapshot); f.api.snapshot = snapshot;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const resources = () => container.querySelector('[aria-label="Instructions and skills"]')!;
  expect(resources().textContent).toContain('resources:original');
  expect(resources().textContent).toContain('review-code');
  expect(resources().textContent).toContain('AGENTS.md');
  expect(resources().textContent).toContain('source:fixed');
  expect(resources().querySelector('[aria-label="Resource diagnostics"]')?.textContent).toContain('Optional resource is missing');
  expect(container.textContent).not.toContain('Private instruction body');
  expect(container.textContent).not.toContain('Private skill body');
  expect(container.textContent).not.toContain('Private composed prompt');
  // Another context update has committed without changing the frozen resources.
  f.view.context.checkpoint = { ...checkpoint, id: 'context:other-update', revision: 4 };
  const snapshotsBefore = snapshot.mock.calls.length;
  await act(async () => button('Refresh instructions and skills').click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ ...identity, expectedRevision: 3 });
  expect(snapshot.mock.calls.length).toBe(snapshotsBefore + 1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('409');
  expect(resources().textContent).toContain('resources:original');
  expect(resources().textContent).toContain('context:other-update');
  await act(async () => { button('Refresh instructions and skills').click(); button('Refresh instructions and skills').click(); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenLastCalledWith({ ...identity, expectedRevision: 4 });
  expect(button('Refresh instructions and skills').disabled).toBe(true);
  expect(button('Add /skill:review-code to draft').disabled).toBe(true);
  expect(resources().textContent).toContain('resources:original');
  await act(async () => {
    const next = structuredClone(f.view.context.checkpoint!);
    next.id = 'context:refreshed'; next.revision = 5; next.resources!.snapshot.id = 'resources:refreshed';
    next.resources!.snapshot.skills[0]!.name = 'review-revised-code'; next.resources!.snapshot.diagnostics = [];
    f.view.context.checkpoint = next; completeRefresh(next);
  });
  expect(resources().textContent).toContain('resources:refreshed');
  expect(resources().textContent).toContain('review-revised-code');
  expect(resources().textContent).not.toContain('resources:original');
  expect(resources().querySelector('[aria-label="Resource diagnostics"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button('Refresh instructions and skills').disabled).toBe(false);
  expect(f.view.activeRun?.state).toBe('generating');
  expect(f.cancelRun).not.toHaveBeenCalled();
});

it('retries summary generation without duplicating the job and applies its completed checkpoint without hiding history', async () => {
  const f = fixture();
  f.view.history = [{ id: 'summary-cut', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', content: { text: 'original full message' }, provider: null }];
  f.view.historyPage = { head: 'summary-cut', previous: null };
  f.view.thread.branches[0]!.head = 'summary-cut';
  const run = { ...initialSnapshot(true).activeRun!, id: 'summary-run', state: 'completed' as const };
  const compact = vi.fn<ThreadsAPI['compact']>().mockRejectedValueOnce(new Error('uncertain summary acceptance')).mockImplementation(async input => {
    const job = { compaction: { producer: { kind: 'builtin' as const, name: 'fold' as const, version: '1' as const }, kind: 'model_plan' as const, sourceCutHash: 'fixture-cut', planHash: 'fixture-plan' }, request: { compaction: null, summary_recipe: { strategy: { kind: 'builtin' as const, name: 'manual', version: '1' }, mode: 'manual' as const, configurationIdentity: null, additionalInstructions: null }, key: input.key, branch_id: input.branchId, through_id: input.throughId, expected_revision: input.expectedRevision, effective_system_prompt: '', instruction_sources: [], memory_checkpoint: null }, receipt: { thread_id: 'context-job-thread:fixture', branch_id: 'context-job-branch:fixture', run_id: run.id, input_id: 'summary-input', cursor: 2 } };
    f.view.context.jobs = [{ job, run }];
    return job;
  });
  f.api.compact = compact;
  const publish = vi.fn<ThreadsAPI['publishContext']>(async () => {
    const request = f.view.context.jobs[0]!.job.request;
    const checkpoint: ContextCheckpoint = { id: request.key, revision: 1, resource_activations: [], proposal: { ...request, summary: 'continuation summary' } };
    f.view.context.checkpoint = checkpoint;
    return checkpoint;
  });
  f.api.publishContext = publish;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(button('Generate context summary').disabled).toBe(true);
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await act(async () => { button('Generate context summary').click(); });
  expect(button('Apply context summary')).toBeUndefined();
  await act(async () => { button('Generate context summary').click(); });
  expect(compact.mock.calls[1]![0]).toEqual(compact.mock.calls[0]![0]);
  expect(compact.mock.calls[0]![0]).toMatchObject({ ...identity, throughId: 'summary-cut', expectedRevision: 0 });
  await act(async () => { button('Apply context summary').click(); });
  expect(publish).toHaveBeenCalledExactlyOnceWith(identity, run.id);
  expect(container.querySelector('[aria-label="Active context summary"]')?.textContent).toContain('continuation summary');
  expect(container.textContent).toContain('original full message');
  expect(button('Apply context summary')).toBeUndefined();
});

it('prepares a real source selection, preserves it and the draft on uncertain send, then omits it for continuation', async () => {
  const f = fixture();
  const prepared = { path: '/workspace/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'captured-workspace', executionWorkspaceId: 'captured-workspace', branchId: 'captured-branch', revision: 0, mode: 'fixed_branch' as const, tools: ['file_read' as const] } };
  f.api.prepareSource = vi.fn().mockRejectedValueOnce(new Error('capture unavailable')).mockResolvedValue(prepared);
  f.submit.mockRejectedValueOnce(new Error('send uncertain'));
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/workspace/project" />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'preserve this draft');
  await act(async () => { button('Prepare workspace').click(); });
  expect(container.textContent).toContain('capture unavailable');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('preserve this draft');
  await act(async () => { button('Prepare workspace').click(); });
  const calls = vi.mocked(f.api.prepareSource).mock.calls;
  expect(calls[1]![0]).toEqual(calls[0]![0]);
  expect(calls[0]![0]).toMatchObject({ ...identity, workspaceId: 'canonical-source-workspace', mode: 'fixed_branch' });
  await submitForm(container.querySelector('form')!);
  expect(container.querySelector('[aria-label="Prepared workspace"]')).not.toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('preserve this draft');
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]);
  expect(f.submit.mock.calls[1]![0].source).toEqual(prepared.source);
  expect(container.querySelector('[aria-label="Prepared workspace"]')).toBeNull();
  await edit('[aria-label="Message thread"]', 'next turn inherits');
  await submitForm(container.querySelector('form')!);
  expect(f.submit.mock.calls[2]![0].source).toBeUndefined();
});

it('discards in-flight source preparation when the API owner changes', async () => {
  const f = fixture();
  let resolvePrepare!: (value: Awaited<ReturnType<ThreadsAPI['prepareSource']>>) => void;
  f.api.prepareSource = () => new Promise(resolve => { resolvePrepare = resolve; });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/old-host/project" />); });
  await act(async () => { button('Prepare workspace').click(); });
  const next = fixture();
  await act(async () => { root.render(<ThreadConversation api={next.api} identity={identity} initialWorkspacePath="/new-host/project" />); });
  await act(async () => { resolvePrepare({ path: '/old-host/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'old-host-workspace', executionWorkspaceId: 'old-host-workspace', branchId: 'old-host-source', revision: 0, mode: 'fixed_branch', tools: ['file_read'] } }); });
  expect(container.querySelector('[aria-label="Prepared workspace"]')).toBeNull();
  expect(button('Preparing workspace snapshot')).toBeUndefined();
});

it('does not silently discard a prepared workspace when a live run appears before send', async () => {
  const f = fixture();
  f.api.prepareSource = vi.fn().mockResolvedValue({ path: '/workspace/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'prepared-ws', executionWorkspaceId: 'prepared-ws', branchId: 'prepared-source', revision: 0, mode: 'materialized', tools: ['file_read', 'file_write'] } });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/workspace/project" />); });
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'run on prepared workspace');
  await act(async () => { button('Prepare workspace').click(); });
  const active = initialSnapshot(true);
  f.view.activeRun = active.activeRun;
  f.view.thread.branches = active.thread.branches;
  await act(async () => { f.emit({ cursor: 9, subject: 'ui-run', revision: 1, kind: 'run.accepted', data: {} }); });
  expect(button('Queue message').disabled).toBe(true);
  await submitForm(container.querySelector('form')!);
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Prepared workspace"]')).not.toBeNull();
  await act(async () => { button('Remove prepared workspace').click(); });
  await submitForm(container.querySelector('form')!);
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'run on prepared workspace' }));
});

it('answers a policy-node question explicitly, keeps the draft on failure and disables a stale question', async () => {
  const f = fixture(true);
  const operationId = 'ui-run:policy:question-action:node:ask';
  const operation: ThreadSnapshot['operations'][number] = { id: operationId, run_id: 'ui-run', epoch: 1, revision: 2, phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'thread', handed_off: true, executor: 'ask_user', waiting_on: `question:${operationId}`, intent: { kind: 'tool', origin: { kind: 'policy_action', action_id: 'ui-run:policy:question-action', node_id: 'ask' }, call: { call_id: 'ask', name: 'ask_user', schema_version: '1', arguments: { question: 'Which approach?', options: ['Option A', 'Option B'] } } }, result: null, external_receipt: null, call_completion: { kind: 'job_accepted', operation_id: operationId, phase: 'awaiting_user', effect: 'none', lifetime: 'thread' }, execution_owner: null };
  f.view.activeRun!.state = 'waiting'; f.view.activeRun!.waiting_on = operation.waiting_on;
  f.view.operations = [operation];
  const answer = vi.fn<ThreadsAPI['answerQuestion']>().mockRejectedValueOnce(new Error('uncertain answer acceptance')).mockImplementation(async () => {
    f.view.operations[0] = { ...operation, phase: 'terminal', outcome: 'succeeded', result: { kind: 'control', value: { answer: 'Option B with detail' } } };
    f.view.activeRun!.waiting_on = 'question:another-operation';
    return f.view.operations[0]!;
  });
  f.api.answerQuestion = answer;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(answer).not.toHaveBeenCalled();
  await act(async () => { button('Option B').click(); });
  expect(answer).not.toHaveBeenCalled();
  await edit('[aria-label="chat.questionCard.yourAnswer"]', 'Option B with detail');
  await submitForm(document.querySelector<HTMLFormElement>('form[aria-label="chat.questionCard.inputNeeded"]')!);
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="chat.questionCard.yourAnswer"]')!.value).toBe('Option B with detail');
  expect(container.textContent).toContain('uncertain answer acceptance');
  await submitForm(document.querySelector<HTMLFormElement>('form[aria-label="chat.questionCard.inputNeeded"]')!);
  expect(answer.mock.calls[0]![0]).toEqual({ ...identity, operationId: operation.id, answer: 'Option B with detail' });
  expect(answer.mock.calls[1]![0]).toEqual(answer.mock.calls[0]![0]);
  expect(document.querySelector('form[aria-label="chat.questionCard.inputNeeded"]')).toBeNull();
  expect(answer).toHaveBeenCalledTimes(2);
});

it('keeps a sibling branch question non-actionable while viewing an earlier conversation fork', async () => {
  const f = fixture();
  const fork = { ...identity, branchId: 'earlier-fork-branch' };
  f.view.identity = fork;
  f.view.thread.branches.push({ branch_id: fork.branchId, head: 'earlier-user', active_run_id: null, latest_run: null });
  f.view.operations = [{ id: 'source-question-op', run_id: 'source-run', epoch: 1, revision: 2, phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'thread', handed_off: true, executor: 'ask_user', waiting_on: 'question:source-question-op', intent: { call: { arguments: { question: 'Original branch clarification', options: ['Proceed'] } } }, result: null, external_receipt: null, call_completion: null, execution_owner: null }];
  const answer = vi.fn<ThreadsAPI['answerQuestion']>();
  const cancel = vi.fn<ThreadsAPI['cancelOperation']>();
  f.api.answerQuestion = answer; f.api.cancelOperation = cancel;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={fork} />); });
  expect(button('Proceed').disabled).toBe(true);
  expect(button('chat.questionCard.submit').disabled).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="chat.questionCard.yourAnswer"]')!.disabled).toBe(true);
  expect(button('Cancel operation')).toBeUndefined();
  await submitForm(document.querySelector<HTMLFormElement>('form[aria-label="chat.questionCard.inputNeeded"]')!);
  expect(answer).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it('permission UI sends only an explicit one-action decision and cannot approve a sibling Run', async () => {
  const f = fixture(true);
  f.view.activeRun!.state = 'executing';
  const permission = { id: 'permission-1', call: { runId: 'ui-run', origin: { kind: 'model_step', request_id: 'request-1' }, operationId: 'request-1:tool:call-1', callId: 'call-1', name: 'mcp_send', schemaVersion: 'schema-1', arguments: { recipient: 'chosen-target', body: 'exact content' } }, scope: { ownerReference: 'mcp-owner', ownerGeneration: 4, toolSchemaVersion: 'schema-1', policyGeneration: 'policy-generation', reason: 'External effect' }, actor: { account: 'selected-account', authority: 'fixture-authority' }, decision: null, consumed: false };
  const operation: ThreadSnapshot['operations'][number] = { id: permission.call.operationId, run_id: 'ui-run', epoch: 1, revision: 2, phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'run', handed_off: false, executor: 'mcp_send', waiting_on: 'permission:permission-1', intent: {}, result: { kind: 'control', value: { permission } }, external_receipt: null, call_completion: null, execution_owner: null };
  f.view.operations = [operation];
  const answer = vi.fn<ThreadsAPI['answerQuestion']>(); f.api.answerQuestion = answer;
  const decide = vi.fn<ThreadsAPI['decidePermission']>().mockRejectedValueOnce(new Error('decision transport unavailable')).mockImplementation(async () => {
    f.view.operations = [{ ...operation, phase: 'accepted', waiting_on: null, result: { kind: 'control', value: { permission: { ...permission, decision: 'allow_once', consumed: true } } } }]; return f.view.operations[0]!;
  });
  f.api.decidePermission = decide;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(decide).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  expect(container.textContent).toContain('chosen-target'); expect(container.textContent).toContain('selected-account');
  await act(async () => { button('Allow once').click(); });
  expect(container.textContent).toContain('decision transport unavailable');
  await act(async () => { button('Allow once').click(); });
  expect(decide.mock.calls[0]![0]).toEqual({ ...identity, operationId: operation.id, permissionId: permission.id, decision: 'allow_once' });
  expect(decide.mock.calls[1]![0]).toEqual(decide.mock.calls[0]![0]); expect(answer).not.toHaveBeenCalled();
  f.view.operations = [{ ...operation, run_id: 'sibling-run' }];
  await act(async () => { f.emit({ cursor: 20, subject: 'sibling-run', revision: 2, kind: 'permission.opened', data: {} }); });
  expect(button('Allow once').disabled).toBe(true); expect(button('Deny').disabled).toBe(true);
});

it('requires an explicit live workspace choice and discloses direct effects before sending its prepared identity', async () => {
  const f = fixture();
  const prepared = { path: '/workspace/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'live-workspace', executionWorkspaceId: 'live-workspace', mode: 'live_root' as const,
    liveRoot: { hostId: 'selected-host', canonicalRoot: '/workspace/project', rootId: 'registered-root' }, tools: ['file_read' as const, 'file_write' as const] } };
  f.api.prepareSource = vi.fn().mockResolvedValue(prepared);
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/workspace/project" />); });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Workspace access"]')!.value).toBe('fixed_branch');
  expect(f.api.prepareSource).not.toHaveBeenCalled();
  await edit('[aria-label="Workspace access"]', 'live_root', 'change');
  expect(container.textContent).toContain('Edits change the selected workspace immediately');
  expect(container.textContent).toContain('not a security sandbox');
  expect(f.submit).not.toHaveBeenCalled();
  await act(async () => { button('Prepare workspace').click(); });
  expect(f.api.prepareSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...identity, workspaceId: 'canonical-source-workspace', mode: 'live_root' }), expect.any(AbortSignal));
  expect(container.querySelector('[aria-label="Prepared workspace"]')?.textContent).toContain('Live files and commands');
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'work on these actual files');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: prepared.source, text: 'work on these actual files' }));
});

it.each(['fixed_branch', 'materialized'] as const)('reprepares %s and submits the new source tool directory unchanged', async mode => {
  const f = fixture();
  const languageTools = ['language_definition', 'language_references', 'language_diagnostics'] as const;
  const live = { path: '/workspace/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'selected-workspace', executionWorkspaceId: 'selected-workspace', mode: 'live_root' as const,
    liveRoot: { hostId: 'host', canonicalRoot: '/workspace/project', rootId: 'live-root' }, tools: ['file_read' as const, ...languageTools] } };
  const fixed = { path: '/workspace/project', source: { resourceOwner: { kind: 'local' as const }, workspaceId: 'selected-workspace', executionWorkspaceId: 'selected-workspace', branchId: 'captured-source', revision: 0,
    mode, tools: mode === 'fixed_branch' ? ['file_read' as const] : [...live.source.tools, 'file_write' as const] } };
  f.api.prepareSource = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(fixed);
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/workspace/project" />); });
  await edit('[aria-label="Workspace access"]', 'live_root', 'change');
  await act(async () => { button('Prepare workspace').click(); });
  expect(f.api.prepareSource).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'live_root' }), expect.any(AbortSignal));
  expect(container.querySelector('[aria-label="Prepared workspace"]')?.textContent).toContain('Live files and commands');
  await edit('[aria-label="Workspace access"]', mode, 'change');
  await act(async () => { button('Prepare workspace').click(); });
  expect(f.api.prepareSource).toHaveBeenLastCalledWith(expect.objectContaining({ mode }), expect.any(AbortSignal));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'use the newly prepared source');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: fixed.source }));
  expect(f.submit.mock.calls[0]![0].source?.tools).toEqual(fixed.source.tools);
});

function pauseView(view: ThreadSnapshot, waitId = 'wait:policy-one') {
  view.activeRun!.state = 'waiting'; view.activeRun!.waiting_on = waitId;
  view.launch = { run_id: view.activeRun!.id, revision: 1, policy_generation: 0, policy_preparable: false, policy_target: { kind: 'default' }, startable: false, requires_rebind: true, bound_epoch: null, preparation_failure: null,
    pause: { action_id: `action:${waitId}`, wait_id: waitId, reason: 'Review the first delivered result.' },
    selection: { extension_bindings: [], child_dispatch: null, policy_models: [], mcp_binding: null, credential_scope: null, connection_identity: 'fixture', provider_family: 'fixture', model: 'fixture',
      configuration_generation: 1, tool_schema_generation: 1, tools: [], policy: { name: 'fixture', version: '1' }, source: null } };
  view.operations = [{ id: view.launch.pause!.action_id, run_id: view.activeRun!.id, epoch: 1, revision: 1,
    phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'run', handed_off: false,
    executor: 'policy.pause', waiting_on: waitId, intent: {}, result: null, external_receipt: null, call_completion: null, execution_owner: null }];
}

it('targets the displayed strategy candidate without clearing Pause or submitting twice', async () => {
  const f = fixture(true); pauseView(f.view);
  const original = { expected_selection_id: null, selection_id: 'policy:incompatible', run_id: 'ui-run', generation: 2, expected_generation: 0,
    target: { kind: 'default' as const }, state_mode: 'preserve' as const, status: 'failed' as const,
    failure: 'policy_state_incompatible', activation_cursor: null };
  f.view.policySelection = { active: { generation: 0, target: { kind: 'default' }, identity: { name: 'default', version: '1' }, activation_cursor: null }, desired: original, preparation: null };
  const resume = vi.fn<ThreadsAPI['resume']>(); f.api.resume = resume;
  let finish!: (receipt: Awaited<ReturnType<ThreadsAPI['restartPolicy']>>) => void;
  const restart = vi.fn<ThreadsAPI['restartPolicy']>(() => new Promise(resolve => { finish = resolve; }));
  f.api.restartPolicy = restart;
  const cancel = vi.fn<ThreadsAPI['cancelPolicyUpdate']>(async () => {
    const selected = f.view.policySelection!.desired!;
    selected.status = 'cancelled'; return selected;
  });
  f.api.cancelPolicyUpdate = cancel;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(container.textContent).toContain('keeps conversation history and independent tasks');
  await act(async () => { button('Restart strategy state').click(); button('Restart strategy state').click(); });
  expect(restart).toHaveBeenCalledExactlyOnceWith(identity, 'ui-run', 'policy:incompatible');
  expect(resume).not.toHaveBeenCalled();
  await act(async () => {
    const selected = { ...original, selection_id: 'policy:restart', generation: 3, state_mode: 'restart_state' as const,
      status: 'ready' as const, failure: null };
    f.view.policySelection!.desired = selected; finish(selected);
  });
  expect(container.querySelector('[aria-label="Policy update"]')?.textContent).toContain('remains paused');
  expect(f.view.activeRun?.waiting_on).toBe('wait:policy-one');
  expect(button('Resume run')).toBeDefined();
  await act(async () => { button('Cancel strategy update').click(); });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(identity, 'ui-run', 'policy:restart');
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
});

it('shows the core Pause reason and exact resume control while input remains queued', async () => {
  const f = fixture(true); pauseView(f.view);
  const resume = vi.fn<ThreadsAPI['resume']>(); f.api.resume = resume;
  f.api.retryPreparation = vi.fn();
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(container.querySelector('[aria-label="Policy pause"]')?.textContent).toContain('Review the first delivered result.');
  expect(button('Resume run')).toBeDefined();
  expect(button('Retry preparation')).toBeUndefined();
  expect(button('Cancel operation')).toBeUndefined();
  expect(container.textContent).not.toContain('Background operation');
  expect(button('Stop run')).toBeDefined();
  await edit('[aria-label="Message thread"]', 'Please keep this for the resumed run');
  await submitForm(container.querySelector('form')!);
  expect(f.enqueue).toHaveBeenCalledOnce();
  expect(resume).not.toHaveBeenCalled();
  expect(f.api.retryPreparation).not.toHaveBeenCalled();
  let resolve!: (receipt: Awaited<ReturnType<ThreadsAPI['resume']>>) => void;
  resume.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => { button('Resume run').click(); button('Resume run').click(); });
  expect(resume).toHaveBeenCalledExactlyOnceWith('ui-run', 'wait:policy-one');
  expect(button('Resume run').disabled).toBe(true);
  await act(async () => {
    f.view.activeRun!.state = 'runnable'; f.view.activeRun!.waiting_on = null;
    f.view.launch!.pause = null; f.view.launch!.startable = true; f.view.launch!.preparation_failure = 'preparation_failed';
    f.view.operations = [];
    resolve({ run_id: 'ui-run', action_id: 'action:wait:policy-one', wait_id: 'wait:policy-one', cursor: 2 });
  });
  expect(button('Resume run')).toBeUndefined();
  expect(button('Retry preparation')).toBeDefined();
  await act(async () => { button('Retry preparation').click(); });
  expect(f.api.retryPreparation).toHaveBeenCalledExactlyOnceWith('ui-run');
  expect(resume).toHaveBeenCalledOnce();
});

it('a late old-Wait failure cannot refresh or alter the newly selected branch', async () => {
  const first = fixture(true); pauseView(first.view);
  let reject!: (error: Error) => void;
  const resume = vi.fn<ThreadsAPI['resume']>(() => new Promise((_done, fail) => { reject = fail; })); first.api.resume = resume;
  await act(async () => { root.render(<ThreadConversation api={first.api} identity={identity} />); });
  await act(async () => { button('Resume run').click(); });
  const next = fixture(true); const nextIdentity = { ...identity, branchId: 'branch:new-selection' };
  next.view.identity = nextIdentity; next.view.activeRun!.id = 'new-run'; next.view.activeRun!.branch_id = nextIdentity.branchId;
  next.view.thread.branches = [{ branch_id: nextIdentity.branchId, head: null, active_run_id: 'new-run', latest_run: next.view.activeRun }];
  pauseView(next.view, 'wait:policy-new');
  const snapshot = vi.fn(next.api.snapshot); next.api.snapshot = snapshot;
  const nextResume = vi.fn<ThreadsAPI['resume']>().mockResolvedValue({ run_id: 'new-run', action_id: 'action:wait:policy-new', wait_id: 'wait:policy-new', cursor: 3 });
  next.api.resume = nextResume;
  await act(async () => { root.render(<ThreadConversation api={next.api} identity={nextIdentity} />); });
  const snapshotsBefore = snapshot.mock.calls.length;
  await act(async () => { reject(new Error('old resume response arrived late')); });
  expect(container.textContent).not.toContain('old resume response arrived late');
  expect(snapshot.mock.calls.length).toBe(snapshotsBefore);
  expect(button('Resume run').disabled).toBe(false);
  await act(async () => { button('Resume run').click(); });
  expect(nextResume).toHaveBeenCalledExactlyOnceWith('new-run', 'wait:policy-new');
  expect(resume).toHaveBeenCalledExactlyOnceWith('ui-run', 'wait:policy-one');
});


it('Stop run remains reachable during a blocked preparation retry and its late reply cannot reopen controls', async () => {
  const f = fixture(true); pauseView(f.view);
  f.view.activeRun!.state = 'runnable'; f.view.activeRun!.waiting_on = null; f.view.operations = [];
  f.view.launch!.pause = null; f.view.launch!.startable = true; f.view.launch!.preparation_failure = 'preparation_failed';
  let reject!: (error: Error) => void;
  const retry = vi.fn<ThreadsAPI['retryPreparation']>(() => new Promise((_resolve, fail) => { reject = fail; })); f.api.retryPreparation = retry;
  f.cancelRun.mockImplementationOnce(async () => {
    const run = { ...f.view.activeRun!, state: 'cancelled' as const, cancel_requested: true };
    f.view.activeRun = null; f.view.thread.branches[0]!.active_run_id = null; f.view.thread.branches[0]!.latest_run = run;
    f.view.launch!.startable = false;
    return run;
  });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await act(async () => { button('Retry preparation').click(); });
  expect(retry).toHaveBeenCalledOnce();
  expect(button('Stop run').disabled).toBe(false);
  await act(async () => { button('Stop run').click(); });
  expect(f.cancelRun).toHaveBeenCalledExactlyOnceWith('ui-run');
  expect(button('Stop run')).toBeUndefined();
  await act(async () => { reject(new Error('old cold preparation failed after cancellation')); });
  expect(container.textContent).not.toContain('old cold preparation failed after cancellation');
  expect(button('Retry preparation')).toBeUndefined();
  expect(button('Send').disabled).toBe(true); // Empty composer, rather than the old pending request.
});


it('starts an explicit goal from the latest finished Run and keeps Stop run available during a pending Goal write', async () => {
  const f = fixture(true);
  const source = { ...f.view.activeRun!, state: 'completed' as const };
  f.view.activeRun = null; f.view.thread.branches[0]!.active_run_id = null; f.view.thread.branches[0]!.latest_run = source;
  let finish!: (value: Awaited<ReturnType<ThreadsAPI['goals']['start']>>) => void;
  const start = vi.fn<ThreadsAPI['goals']['start']>(() => new Promise(resolve => { finish = resolve; }));
  f.api.goals.start = start;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Create goal').click());
  await edit('[aria-label="New goal objective"]', 'Continue the finished work');
  await act(async () => button('Start goal').click());
  expect(start.mock.calls[0]![0]).toMatchObject({ ...identity, runId: source.id, objective: 'Continue the finished work', budget: null });
  const next = { ...source, id: 'new-running-work', state: 'generating' as const };
  f.view.activeRun = next; f.view.thread.branches[0]!.active_run_id = next.id; f.view.thread.branches[0]!.latest_run = next;
  await act(async () => f.emit({ cursor: 1, subject: next.id, revision: 1, kind: 'run.changed', data: {} }));
  expect(button('Stop run').disabled).toBe(false);
  await act(async () => button('Stop run').click());
  expect(f.cancelRun).toHaveBeenCalledWith(next.id);
  await act(async () => finish({ id: start.mock.calls[0]![0].key, revision: 1, generation: 1, thread_id: identity.threadId, branch_id: identity.branchId, control: 'active' }));
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});


it.each([
  { kind: 'local' as const },
  { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'connection-b', endpointIdentity: 'sha256-b' },
])('opens the original $kind PTY with its owner and fences a late response after changing branches', async resourceOwner => {
  const f = fixture(true);
  const operation: ThreadSnapshot['operations'][number] = { id: 'process:interactive', run_id: 'ui-run', epoch: 1, revision: 1,
    phase: 'running', outcome: null, effect: 'dispatched', cancel_requested: false,
    lifetime: 'environment', handed_off: true, executor: 'process_spawn', waiting_on: null,
    intent: { call: { arguments: { mode: 'pty' } } }, result: null, external_receipt: null,
    call_completion: { kind: 'job_accepted', operation_id: 'process:interactive', phase: 'running', effect: 'dispatched', lifetime: 'environment' }, execution_owner: null };
  f.view.operations = [operation];
  const result = { sessionId: 'original-terminal', cwd: '/original-workspace', resourceOwner, operationId: operation.id, processId: operation.id };
  const open = vi.fn(async () => result); f.api.processes = { openTerminal: open };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await act(async () => { button('Open process terminal').click(); });
  expect(open).toHaveBeenCalledWith({ ...identity, operationId: operation.id });
  expect(attachProcessTerminal).toHaveBeenCalledWith(result.cwd, result.sessionId, 'Agent process', resourceOwner, {
    identity, operationId: operation.id, processId: result.processId, endpointGeneration: endpoint.generation,
  });
  let resolve!: (value: typeof result) => void;
  open.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => { button('Open process terminal').click(); });
  const other = { ...identity, branchId: 'other-branch' };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={other} />); });
  await act(async () => { resolve(result); });
  expect(attachProcessTerminal).toHaveBeenCalledTimes(1);
});


it.each(['file-backed', 'source-free'] as const)('continues a completed %s child with its exact predecessor and retries an uncertain receipt without changing its model or old report', async sourceKind => {
  const f = fixture(true); pauseView(f.view);
  const upload = vi.mocked(f.api.materials.upload).mockResolvedValue(uploadedPdf('child-input-pdf'));
  const sourceFree = sourceKind === 'source-free';
  const previous = { ...f.view.activeRun!, state: 'completed' as const };
  f.view.activeRun = null; f.view.thread.branches[0]!.active_run_id = null; f.view.thread.branches[0]!.latest_run = previous;
  f.view.thread.branches[0]!.head = 'old-head';
  const source = { resource_owner: { kind: 'local' as const }, mode: 'fixed_branch' as const, workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'source', revision: 0, live_root: null };
  const original: DelegatedExecution = { execution_id: 'old-execution', child_operation_id: 'original-dispatch', child_thread_id: identity.threadId, child_branch_id: identity.branchId,
    parent_run_id: 'parent-run', parent_thread_id: 'parent-thread', parent_branch_id: 'parent-branch', origin: { kind: 'model_step', request_id: 'original-request' }, call_id: 'dispatch', project_id: null,
    selected_profile: { preset_id: null, catalog_identity: 'frozen', work_mode: sourceFree ? 'read_only' : 'isolated_write', tools: [], instructions: '' },
    input: { task: 'Keep the original report' }, configuration: {}, launch: f.view.launch!.selection, policy_target: { kind: 'default' }, source_basis: null,
    source: sourceFree ? { kind: 'absent' } : { kind: 'ready', handoff: null, selection: source,
      pin: { pin_id: 'pin', root: 'root', source }, provenance: { consistency: 'fixed-root', root: 'root' } },
    trigger: { kind: 'dispatch' }, state: 'completed', receipt: { run_id: previous.id, input_id: 'original-input',
      thread_id: identity.threadId, branch_id: identity.branchId, cursor: 1 }, cancel_requested: false, revision: 2, cursor: 2, resources_released: true, terminal_head: 'old-head',
    code_result: sourceFree ? { kind: 'not_applicable' } : { kind: 'published', effect: 'confirmed', result: {
      publication_id: 'old-publication', result_revision: 2, workspace_id: 'workspace', branch_id: 'result', root: 'result-root', base_root: 'root', record_id: 'result-record' } },
    report: { outcome: 'succeeded', sender_thread_id: identity.threadId, run_id: previous.id, detail: 'Original report stays fixed', history_ids: ['old-report'] } };
  f.view.delegatedExecutions = [original];
  const continued: DelegatedExecution = { ...original, execution_id: 'new-execution', trigger: { kind: 'user_continuation', key: 'new', previous_execution_id: original.execution_id,
    previous_run_id: previous.id, previous_run_revision: previous.revision, expected_head: 'old-head' }, state: 'preparing', receipt: null, report: null,
    source: sourceFree ? { kind: 'absent' } : null, code_result: sourceFree ? { kind: 'not_applicable' } : { kind: 'pending' }, resources_released: false, terminal_head: null };
  const continueChild = vi.fn<NonNullable<ThreadsAPI['collaboration']>['continueChild']>(async () => {
    f.view.delegatedExecutions = [original, continued]; return continued;
  }).mockRejectedValueOnce(new Error('uncertain continuation reply'));
  const reportBody = JSON.stringify({ data: { original: true }, parts: [{ kind: 'text', text: 'old evidence' }, { kind: 'media', media: storedImage }] });
  const readExecutionReport = vi.fn<NonNullable<ThreadsAPI['collaboration']>['readExecutionReport']>(async (_identity, executionId, itemId) => ({
    format: 'output_body', operation_id: original.child_operation_id, execution_id: executionId, item_id: itemId, offset: 0, next_offset: null,
    total_bytes: new TextEncoder().encode(reportBody).length, text: reportBody }));
  const cancelTree = vi.fn<NonNullable<ThreadsAPI['collaboration']>['cancelTree']>(async target => ({ target: { kind: 'thread', thread_id: target.threadId }, cursor: 15, run_count: 0, child_count: 1, process_count: 0 }));
  const unused = async (): Promise<never> => { throw new Error('unused collaboration control'); };
  f.api.collaboration = { integration: vi.fn(), continueChild, readExecutionReport, executions: async () => f.view.delegatedExecutions!, children: async () => [],
    readReport: unused, cancelChild: unused, cancelWait: unused, cancelTree };
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Registered model"]')?.disabled).toBe(true);
  if (sourceFree) expect(container.textContent).not.toContain('chat.children.filesPublished');
  else expect(container.textContent).toContain('chat.children.filesPublished');
  await edit('[aria-label="Message thread"]', 'Keep the next user instruction');
  await choosePdfs(pdfFile('child.pdf'));
  const form = container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!;
  await submitForm(form);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('Keep the next user instruction');
  await submitForm(form);
  expect(continueChild).toHaveBeenCalledTimes(2);
  expect(continueChild.mock.calls[1]![0]).toEqual(continueChild.mock.calls[0]![0]);
  expect(continueChild.mock.calls[0]![0]).toMatchObject({ ...identity, previousRunId: previous.id, expectedHead: 'old-head', text: 'Keep the next user instruction', materials: [{ snapshotId: 'child-input-pdf' }] });
  expect(upload).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="chat.fileAttachment.pdfAttachments"]')).toBeNull();
  expect(continueChild.mock.calls[0]![0]).not.toHaveProperty('model');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Original report stays fixed');
  expect(container.textContent).toContain('chat.children.trigger.user');
  if (sourceFree) {
    const executions = container;
    expect(executions.textContent).not.toContain('chat.children.settling');
    expect(executions.textContent).not.toMatch(/File result: (pending|not_applicable)|No file changes|File result unavailable/);
    expect(executions.textContent).toContain('chat.children.trigger.user');
    expect(executions.textContent).toContain('harness.threads.state.starting');
    expect(button('Continue child').disabled).toBe(true);
  }
  await act(async () => { button('Read execution report').click(); });
  expect(readExecutionReport).toHaveBeenCalledWith(identity, 'old-execution', 'old-report', 0, undefined, expect.any(AbortSignal));
  expect(container.textContent).toContain('old evidence');
  await act(async () => button('View image').click());
  expect(f.api.mediaRead).toHaveBeenCalledWith(expect.objectContaining({ holder: { kind: 'child_report', operationId: 'original-dispatch', executionId: 'old-execution', itemId: 'old-report' }, partIndex: 1 }), expect.any(AbortSignal));
  expect(container.querySelector('[aria-label="chat.children.report"] img')?.getAttribute('src')).toBe('blob:test-image');
  expect(f.view.activeRun).toBeNull();
  await act(async () => { button('Stop task and children').click(); });
  expect(cancelTree).toHaveBeenCalledExactlyOnceWith(identity);
});


it('retains an original file condition after a lost reply and displays unavailable and immutable evidence without evaluating it', async () => {
  const f = fixture(true);
  const followup: ThreadSnapshot['followups'][number] = { repeat: 'once', exhausted: false, pending_occurrences: 0, id: 'followup:file', revision: 1, generation: 1,
    thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'ui-run', state: 'active', goal_id: null,
    actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1, observation: null,
    trigger: { kind: 'file', path: 'results/output.txt', condition: 'changed' },
    sources: [{ consumed_cursor: 0, source_index: 0, after_cursor: 1, observed: null, log: null, metric: null, file: { receipt_id: 'receipt:file', revision: 1,
      baseline: null, current: null, immutable: true, watch_id: null, ready: false, resource_authority: null,
      position: null, gap: true, failure_code: 'source_unavailable', released: false } }],
    wait: { id: 'wait:file', kind: 'file', after_cursor: 1, trigger_cursor: null, state: 'waiting' }, occurrence: null };
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('reply lost'))
    .mockImplementation(async () => { f.view.followups = [followup]; return followup; });
  f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'file', 'change');
  await edit('[aria-label="Follow-up file path"]', 'results/output.txt');
  await edit('[aria-label="Follow-up file condition"]', 'changed', 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Read this original result once.');
  await act(async () => button('Register one-time follow-up').click());
  expect(register.mock.calls[0]![0]).toMatchObject({ ...identity, runId: 'ui-run',
    trigger: { kind: 'file', path: 'results/output.txt', condition: 'changed' } });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Follow-up file path"]')!.disabled).toBe(true);
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-run' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-run', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(register.mock.calls[0]![0]);
  expect(container.textContent).toContain('awaiting original baseline');
  expect(container.textContent).toContain('fixed immutable source');
  expect(container.textContent).toContain('observation gap');
  expect(container.textContent).toContain('source_unavailable');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('discovers retained unconfirmed file resources and retries their explicit cancellation by the original key and Run', async () => {
  const f = fixture();
  let pending = [{ id: 'file-request-before-catalog', sourceRunId: 'previous-source-run',
    threadId: identity.threadId, branchId: identity.branchId, paths: ['results/exact.txt'] }];
  f.api.followups.pendingRegistrations = vi.fn(async () => pending);
  const cancel = vi.fn<ThreadsAPI['followups']['cancelRegistration']>(async () => {
    pending = []; return { followup: null };
  });
  cancel.mockRejectedValueOnce(new Error('cancellation reply unavailable'));
  f.api.followups.cancelRegistration = cancel;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.textContent).toContain('File resources were accepted, but this follow-up has not been registered.');
  expect(container.textContent).toContain('results/exact.txt');
  await act(async () => button('Cancel unconfirmed registration').click());
  expect(container.textContent).toContain('cancellation reply unavailable');
  expect(button('Cancel unconfirmed registration')).toBeDefined();
  await act(async () => button('Cancel unconfirmed registration').click());
  expect(cancel.mock.calls.map(([input]) => input)).toEqual([
    { ...identity, key: 'file-request-before-catalog', runId: 'previous-source-run' },
    { ...identity, key: 'file-request-before-catalog', runId: 'previous-source-run' },
  ]);
  expect(container.querySelector('[aria-label="Unconfirmed file registration"]')).toBeNull();
  expect(f.submit).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});


it.each(['job_stopped', 'any', 'all'] as const)('registers %s from accepted family jobs outside visible operations using current work and stable retry', async kind => {
  const f = fixture(true);
  const job: Awaited<ReturnType<ThreadsAPI['followups']['jobSources']>>[number] = {
    observationKinds: ['job_stopped', 'artifact', 'collection'], binding: { operationId: 'user-job:original', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original-domain' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'workspace', subjectId: 'attempt:historical' } },
    sourceRunId: 'old-completed-run', threadId: 'thread:family-child', branchId: 'branch:family-child', cancelRequested: false, phase: 'terminal', executorStopped: true, origin: { kind: 'user', key: 'submit-original' },
  };
  f.api.followups.jobSources = vi.fn(async () => [job]);
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('accepted response lost')).mockRejectedValueOnce(new Error('still uncertain'));
  f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  expect(f.view.operations).toEqual([]);
  await edit('[aria-label="Follow-up trigger"]', kind, 'change');
  if (kind === 'job_stopped') await edit('[aria-label="Follow-up job"]', job.binding.operationId, 'change');
  else {
    await edit('[aria-label="Condition 1 time"]', '2030-02-03T04:05:06');
    await edit('[aria-label="Condition 2 kind"]', 'job_stopped', 'change');
    await edit('[aria-label="Condition 2 job"]', job.binding.operationId, 'change');
  }
  expect(f.api.followups.jobSources).toHaveBeenCalledWith(identity, 'ui-run', expect.any(AbortSignal));
  expect(container.textContent).toContain('attempt:historical');
  await edit('[aria-label="Follow-up instruction"]', 'Read the original job result in this work.');
  await act(async () => button('Register one-time follow-up').click());
  const original = register.mock.calls[0]![0];
  expect(original.runId).toBe('ui-run'); expect(original.runId).not.toBe(job.sourceRunId);
  const leaf = { kind: 'job_stopped', operationId: job.binding.operationId };
  if (kind === 'job_stopped') expect(original.trigger).toEqual(leaf);
  else expect(original.trigger).toMatchObject({ kind, sources: [expect.objectContaining({ kind: 'at' }), leaf] });
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-current-run' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-current-run', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(original);
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});

it('discards a late accepted-job query from the previous work Run and keeps a failed query explicit', async () => {
  const f = fixture(true);
  let release: ((value: Awaited<ReturnType<ThreadsAPI['followups']['jobSources']>>) => void) | undefined;
  f.api.followups.jobSources = vi.fn<ThreadsAPI['followups']['jobSources']>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockRejectedValue(new Error('original source unavailable'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'job_stopped', 'change');
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-work' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-work', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => release!([{ observationKinds: ['job_stopped', 'artifact', 'collection'], binding: { operationId: 'late-job', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'old' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'ws', subjectId: 'late-attempt' } }, sourceRunId: 'old-work', threadId: identity.threadId, branchId: identity.branchId, phase: 'running', executorStopped: false, cancelRequested: false, origin: { kind: 'user', key: 'old' } }]));
  await edit('[aria-label="Follow-up trigger"]', 'job_stopped', 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Wait for a real candidate');
  expect(container.textContent).toContain('Accepted jobs could not be read');
  expect(container.textContent).not.toContain('late-attempt');
  expect(button('Register one-time follow-up').disabled).toBe(true);
});

function repeatedFollowup(): ThreadSnapshot['followups'][number] {
  return { id: 'followup:each', repeat: 'each', exhausted: false, pending_occurrences: 0, revision: 1, generation: 1,
    thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'ui-run', state: 'active', goal_id: null,
    actor: { kind: 'user' }, has_instruction: true, registered_at_ms: 1, observation: null,
    trigger: { kind: 'file', path: 'results/output.txt', condition: 'changed' },
    sources: [{ source_index: 0, after_cursor: 1, consumed_cursor: 0, observed: null, file: null, log: null, metric: null }],
    wait: { id: 'wait:each', kind: 'file', after_cursor: 1, trigger_cursor: null, state: 'waiting' }, occurrence: null };
}
function repeatedOccurrence(id: string, accepted: number, delivered: boolean): NonNullable<ThreadSnapshot['followups'][number]['occurrence']> {
  return { id, accepted_cursor: accepted, trigger_cursor: 1000 - accepted, generation: 1,
    state: delivered ? 'completed' : 'held', hold_reason: delivered ? null : 'question',
    evidence: { kind: 'file', receipt_id: 'receipt:file', path: 'results/output.txt', condition: 'changed',
      state: { kind: 'regular-file', objectHash: `object:${id}`, byteLength: 10, mode: null }, proof: 'snapshot_difference', position: null, gap: false, observed_at_ms: accepted },
    delivery: { input_id: `input:${id}`, run_id: `run:${id}`, execution_id: `execution:${id}`, state: delivered ? 'delivered' : 'queued',
      activation_state: 'bound', delivered_cursor: delivered ? accepted + 1 : null, failure_code: null } };
}

it('requires legal repeat conditions and keeps the original repeated authorization across an uncertain reply and newer Run', async () => {
  const f = fixture(true); const followup = repeatedFollowup();
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('reply lost'))
    .mockImplementation(async () => { f.view.followups = [followup]; return followup; });
  f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change');
  await edit('[aria-label="Follow-up time"]', '2030-02-03T04:05:06');
  await edit('[aria-label="Follow-up instruction"]', 'Read each accepted change.');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  expect(container.textContent).toContain('Repetition requires a metric, file-change, artifact, collection or log-literal condition');
  await edit('[aria-label="Follow-up trigger"]', 'any', 'change');
  await edit('[aria-label="Condition 1 time"]', '2030-02-03T04:05:06');
  await edit('[aria-label="Condition 2 kind"]', 'file', 'change');
  await edit('[aria-label="Condition 2 file path"]', 'results/output.txt');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Condition 2 file condition"]', 'changed', 'change');
  expect(button('Register repeating follow-up').disabled).toBe(false);
  await edit('[aria-label="Follow-up trigger"]', 'all', 'change');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  expect(container.textContent).toContain('Repeated All requires every condition');
  await edit('[aria-label="Condition 1 kind"]', 'file', 'change');
  await edit('[aria-label="Condition 1 file path"]', 'results/first.txt');
  await edit('[aria-label="Condition 1 file condition"]', 'changed', 'change');
  expect(button('Register repeating follow-up').disabled).toBe(false);
  await act(async () => button('Register repeating follow-up').click());
  const original = register.mock.calls[0]![0];
  expect(original).toMatchObject({ runId: 'ui-run', repeat: 'each', instruction: 'Read each accepted change.', trigger: { kind: 'all', sources: [
    { kind: 'file', path: 'results/first.txt', condition: 'changed' }, { kind: 'file', path: 'results/output.txt', condition: 'changed' },
  ] } });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Follow-up repetition"]')!.disabled).toBe(true);
  await act(async () => button('Hide follow-up form').click());
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-current-run' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-current-run', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Schedule a follow-up').click());
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(original);
  expect(container.textContent).toContain('Continuing to observe changes');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('keeps repeating controls after delivery and reads each historical occurrence and its actual Run without executing it', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); const first = repeatedOccurrence('first', 10, true); const second = repeatedOccurrence('second', 20, false);
  followup.occurrence = first; f.view.followups = [followup];
  const occurrences = vi.fn<ThreadsAPI['followups']['occurrences']>(async (_identity, _id, after) => after === undefined
    ? { occurrences: [structuredClone(first)], nextCursor: 10 } : { occurrences: [structuredClone(second)], nextCursor: null });
  f.api.followups.occurrences = occurrences;
  const control = vi.fn<ThreadsAPI['followups']['control']>(async input => {
    followup.revision++; followup.state = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'cancelled';
    if (input.action === 'cancel') followup.pending_occurrences = 0;
    return structuredClone(followup);
  }); f.api.followups.control = control;
  const read = vi.fn<NonNullable<ThreadsAPI['family']>['read']>(async (_identity, request) => ({ ...request, runId: request.runId ?? null, headId: 'head:original', anchor: 'anchor:original',
    items: [{ id: 'record:first', parentId: null, sequence: 10, runId: request.runId!, source: 'assistant', kind: 'text', body: { id: 'record:first', provenance: { kind: 'assistant' }, content: { kind: 'text', text: 'Original first occurrence result' }, opaque: null }, preview: '', bodyBytes: 32, bodyTruncated: false, tool: null }],
    nextCursor: null, scanned: 1, scanComplete: true, hasEarlier: false, hasLater: false }));
  f.api.family = { read, list: vi.fn(), runs: vi.fn(), item: vi.fn() };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(button('Cancel follow-up')).toBeDefined(); expect(button('Pause follow-up')).toBeDefined(); expect(occurrences).not.toHaveBeenCalled();
  await act(async () => button('Read occurrence history').click());
  const history = () => container.querySelector('[aria-label="Follow-up occurrence history"]')!;
  expect(history().textContent).toContain('input:first'); expect(history().textContent).toContain('child execution execution:first');
  followup.occurrence = second; followup.pending_occurrences = 1; followup.revision++;
  await act(async () => f.emit({ cursor: 3, subject: followup.id, revision: followup.revision, kind: 'followup.changed', data: {} }));
  expect(occurrences).toHaveBeenCalledTimes(1);
  expect(history().textContent).toContain('input:first'); expect(history().textContent).toContain('Refresh to read current delivery states');
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')!.textContent).toContain('input:second');
  expect(container.textContent).toContain('1 undelivered occurrence');
  // Retry stays available without using the latest row as the definition's execution authority.
  await act(async () => button('Retry undelivered occurrences').click());
  expect(control.mock.calls.at(-1)![0].action).toBe('resume');
  const readFirst = [...history().querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === 'Read occurrence Run')!;
  await act(async () => readFirst.click());
  expect(read).toHaveBeenCalledWith(identity, { threadId: identity.threadId, branchId: identity.branchId, runId: 'run:first', query: { kind: 'recent' }, anchor: undefined, cursor: undefined }, expect.any(AbortSignal));
  expect(history().textContent).toContain('Original first occurrence result'); expect(f.api.family.runs).not.toHaveBeenCalled();
  occurrences.mockRejectedValueOnce(new Error('history temporarily unavailable'));
  await act(async () => button('Next occurrence page').click());
  expect(history().textContent).toContain('Occurrence history could not be read'); expect(history().textContent).not.toContain('No occurrences');
  await act(async () => button('Retry occurrence page').click());
  expect(occurrences.mock.calls.at(-1)!.slice(0, 3)).toEqual([identity, followup.id, 10]);
  expect(history().textContent).toContain('input:second'); expect(history().textContent).not.toContain('input:first');
  await act(async () => button('Previous occurrence page').click());
  expect(history().textContent).toContain('input:first');
  await act(async () => button('Pause follow-up').click());
  expect(followup.pending_occurrences).toBe(1); expect(button('Resume follow-up')).toBeDefined();
  await act(async () => button('Resume follow-up').click());
  await act(async () => button('Cancel follow-up').click());
  expect(control.mock.calls.map(([input]) => input.action)).toEqual(['resume', 'pause', 'resume', 'cancel']);
  expect(button('Cancel follow-up')).toBeUndefined(); expect(history()).toBeNull();
  await act(async () => button('Past follow-ups (1)').click());
  await act(async () => button('Read occurrence history').click());
  expect(history().textContent).toContain('input:first');
  expect(container.textContent).toContain('Repeating authorization cancelled');
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('aborts occurrence reads on close, Host and branch changes and ignores late pages without cancelling monitoring', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); f.view.followups = [followup];
  type Page = Awaited<ReturnType<ThreadsAPI['followups']['occurrences']>>;
  const releases: ((page: Page) => void)[] = [];
  const occurrences = vi.fn<ThreadsAPI['followups']['occurrences']>(() => new Promise(resolve => releases.push(resolve)));
  const control = vi.fn(f.api.followups.control); f.api.followups = { ...f.api.followups, occurrences, control };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Read occurrence history').click());
  const closed = occurrences.mock.calls[0]![3]!;
  await act(async () => button('Hide occurrence history').click()); expect(closed.aborted).toBe(true);
  await act(async () => releases[0]!({ occurrences: [repeatedOccurrence('late-closed', 10, true)], nextCursor: null }));
  expect(container.textContent).not.toContain('late-closed');
  await act(async () => button('Read occurrence history').click());
  const oldHost = occurrences.mock.calls[1]![3]!;
  await act(async () => { endpoint.generation++; for (const listener of endpoint.listeners) listener(); });
  expect(oldHost.aborted).toBe(true);
  await act(async () => releases[1]!({ occurrences: [repeatedOccurrence('late-host', 20, true)], nextCursor: null }));
  expect(container.textContent).not.toContain('late-host');
  await act(async () => button('Read occurrence history').click());
  const oldBranch = occurrences.mock.calls[2]![3]!;
  const nextIdentity = { ...identity, branchId: 'branch:new' };
  const next = fixture(true); next.view.identity = nextIdentity; next.view.thread.branches[0]!.branch_id = nextIdentity.branchId;
  await act(async () => root.render(<ThreadConversation api={next.api} identity={nextIdentity} />));
  expect(oldBranch.aborted).toBe(true);
  await act(async () => releases[2]!({ occurrences: [repeatedOccurrence('late-branch', 30, true)], nextCursor: null }));
  expect(container.textContent).not.toContain('late-branch'); expect(control).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});

it('offers the original definition retry when an older occurrence failed and the latest already delivered', async () => {
  const f = fixture(true); const followup = repeatedFollowup();
  const older = repeatedOccurrence('older-failed', 10, false); older.state = 'failed'; older.hold_reason = 'preparation_failed';
  older.delivery = { ...older.delivery!, activation_state: 'failed', failure_code: 'source_unavailable' };
  followup.occurrence = repeatedOccurrence('latest-delivered', 20, true); followup.pending_occurrences = 1;
  f.view.followups = [followup];
  f.api.followups.occurrences = vi.fn(async () => ({ occurrences: [older, followup.occurrence!], nextCursor: null }));
  const control = vi.fn<ThreadsAPI['followups']['control']>(async () => followup); f.api.followups.control = control;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')!.textContent).toContain('input:latest-delivered');
  await act(async () => button('Retry undelivered occurrences').click());
  expect(control).toHaveBeenCalledExactlyOnceWith({ ...identity, followupId: followup.id, expectedRevision: followup.revision, action: 'resume' });
  await act(async () => button('Read occurrence history').click());
  expect(container.querySelector('[aria-label="Follow-up occurrence history"]')!.textContent).toContain('source_unavailable');
  expect(button('Cancel follow-up')).toBeDefined(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

function researchJob(): Awaited<ReturnType<ThreadsAPI['followups']['jobSources']>>[number] {
  return { observationKinds: ['job_stopped', 'artifact', 'collection'],
    binding: { operationId: 'job:research-original', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'workspace:original', subjectId: 'attempt:historical-research' } },
    sourceRunId: 'run:historical-child', threadId: 'thread:child', branchId: 'branch:child', phase: 'running', executorStopped: false, cancelRequested: false, origin: { kind: 'user', key: 'user-accepted' } };
}
function researchOccurrence(id: string, accepted: number): NonNullable<ThreadSnapshot['followups'][number]['occurrence']> {
  const binding = researchJob().binding;
  return { ...repeatedOccurrence(id, accepted, true), evidence: { kind: 'all', sources: [
    { source_index: 0, accepted_cursor: accepted - 3, trigger_cursor: 95, evidence: { kind: 'artifact', binding, fact: { kind: 'artifact_available', artifact_id: 'artifact:zero', record_revision: 2 }, gap: false } },
    { source_index: 1, accepted_cursor: accepted, trigger_cursor: 80, evidence: { kind: 'collection', binding, completion_revision: 7, outcome: 'done', counts: { available: 1, failed: 0, expired: 0, pending: 0 }, gap: false } },
  ] } };
}
function researchDetail(occurrence: ReturnType<typeof researchOccurrence>): Awaited<ReturnType<ThreadsAPI['followups']['occurrence']>> {
  return { occurrence, facts: [
    { source_index: 0, accepted_cursor: occurrence.accepted_cursor - 3, content: { artifactId: 'artifact:zero', byteLength: 0, name: `<img src=x onerror="runInstructions()">${occurrence.id}` } },
    { source_index: 1, accepted_cursor: occurrence.accepted_cursor, content: { completionRevision: 7, outcome: 'done' } },
  ] };
}

it.each(['any', 'artifactId', 'name', 'collection'] as const)('registers exact research %s facts on selected work and preserves the entire uncertain intent', async selector => {
  const f = fixture(true); const job = researchJob();
  const repeat = selector === 'any' ? 'once' : 'each';
  const registerLabel = repeat === 'once' ? 'Register one-time follow-up' : 'Register repeating follow-up';
  const unsupported = { ...job, observationKinds: ['job_stopped'] as const, binding: { ...job.binding, operationId: 'job:unsupported-version', domainVersion: 99, subject: { kind: 'workspace' as const, workspaceId: 'workspace:original', subjectId: 'unsupported-research-attempt' } } };
  f.api.followups.jobSources = vi.fn(async () => [job, { ...unsupported, observationKinds: [...unsupported.observationKinds] }]);
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValue(new Error('acceptance reply lost')); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', selector === 'collection' ? 'collection' : 'artifact', 'change');
  const picker = container.querySelector('[aria-label="Follow-up job"]')!;
  expect(picker.textContent).toContain('attempt:historical-research'); expect(picker.textContent).not.toContain('unsupported-research-attempt');
  await edit('[aria-label="Follow-up job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Follow-up repetition"]', repeat, 'change');
  if (selector !== 'collection') {
    await edit('[aria-label="Follow-up artifact selector"]', selector, 'change');
    if (selector !== 'any') {
      await edit('[aria-label="Follow-up instruction"]', 'Use the accepted original facts.');
      expect(button(registerLabel).disabled).toBe(true);
      await edit('[aria-label="Follow-up artifact value"]', 'original-artifact');
    }
  }
  await edit('[aria-label="Follow-up instruction"]', '  Use the accepted original facts.\nKeep failures visible.  ');
  expect(button(registerLabel).disabled).toBe(false);
  await act(async () => button(registerLabel).click());
  const original = register.mock.calls[0]![0];
  expect(original).toMatchObject({ ...identity, runId: 'ui-run', repeat, instruction: '  Use the accepted original facts.\nKeep failures visible.  ',
    trigger: selector === 'collection' ? { kind: 'collection', operationId: job.binding.operationId }
      : { kind: 'artifact', operationId: job.binding.operationId, ...(selector === 'any' ? {} : { [selector]: 'original-artifact' }) } });
  expect(original.runId).not.toBe(job.sourceRunId);
  const keys = Object.keys(original.trigger); expect(keys).not.toContain(selector === 'name' ? 'artifactId' : 'name');
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-selected-work' };
  await act(async () => f.emit({ cursor: 8, subject: 'new-selected-work', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(original);
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});

it('allows repeatable artifact and collection in Any and FIFO All while keeping finite leaves once-only', async () => {
  const f = fixture(true); const job = researchJob(); f.api.followups.jobSources = async () => [job];
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValue(new Error('uncertain')); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change');
  await edit('[aria-label="Follow-up trigger"]', 'any', 'change');
  await edit('[aria-label="Condition 1 time"]', '2030-02-03T04:05:06');
  await edit('[aria-label="Condition 2 kind"]', 'artifact', 'change');
  await edit('[aria-label="Condition 2 job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Use each original fact.');
  expect(button('Register repeating follow-up').disabled).toBe(false);
  await edit('[aria-label="Follow-up trigger"]', 'all', 'change');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Condition 1 kind"]', 'collection', 'change');
  await edit('[aria-label="Condition 1 job"]', job.binding.operationId, 'change');
  expect(button('Register repeating follow-up').disabled).toBe(false);
  await act(async () => button('Register repeating follow-up').click());
  expect(register.mock.calls[0]![0]).toMatchObject({ runId: 'ui-run', repeat: 'each', trigger: { kind: 'all', sources: [
    { kind: 'collection', operationId: job.binding.operationId }, { kind: 'artifact', operationId: job.binding.operationId },
  ] } });
});

it('reads frozen O1 research metadata on demand with distinct source cursors while O2 becomes latest', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); const first = researchOccurrence('research:O1', 20); const second = researchOccurrence('research:O2', 40);
  followup.occurrence = first; f.view.followups = [followup];
  const detail = vi.fn<ThreadsAPI['followups']['occurrence']>(async (_identity, _followup, id) => researchDetail(id === first.id ? first : second));
  f.api.followups.occurrence = detail; f.api.followups.occurrences = async () => ({ occurrences: [first], nextCursor: null });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(detail).not.toHaveBeenCalled();
  await act(async () => button('Read occurrence history').click());
  const history = () => container.querySelector('[aria-label="Follow-up occurrence history"]')!;
  const readOriginal = () => [...history().querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === 'Read occurrence metadata')!;
  await act(async () => readOriginal().click());
  expect(detail).toHaveBeenCalledExactlyOnceWith(identity, followup.id, first.id, expect.any(AbortSignal));
  const metadata = () => history().querySelector('[aria-label="Original occurrence metadata"]')!;
  expect(metadata().textContent).toContain('Condition 1 · accepted 17'); expect(metadata().textContent).toContain('Condition 2 · accepted 20');
  expect(metadata().textContent).toContain('"byteLength": 0'); expect(metadata().textContent).toContain('<img'); expect(metadata().querySelector('img')).toBeNull();
  followup.occurrence = second;
  await act(async () => f.emit({ cursor: 50, subject: followup.id, revision: 2, kind: 'followup.changed', data: {} }));
  expect(detail).toHaveBeenCalledTimes(1); expect(metadata().textContent).toContain(first.id); expect(metadata().textContent).not.toContain(second.id);
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')!.textContent).toContain(second.id);
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('rejects wrong occurrence or mismatched accepted-source metadata and retries the same original read', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); const first = researchOccurrence('research:O1', 20);
  followup.occurrence = first; f.view.followups = [followup];
  const good = researchDetail(first); const wrongCursor = structuredClone(good); wrongCursor.facts[0]!.accepted_cursor = 20;
  const detail = vi.fn<ThreadsAPI['followups']['occurrence']>()
    .mockRejectedValueOnce(new Error('metadata storage failed'))
    .mockResolvedValueOnce(researchDetail(researchOccurrence('research:O2', 40)))
    .mockResolvedValueOnce(wrongCursor).mockResolvedValueOnce(good);
  f.api.followups.occurrence = detail;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Read occurrence metadata').click());
  for (let retry = 0; retry < 3; retry++) {
    expect(container.textContent).toContain('Original occurrence metadata could not be read');
    expect(container.textContent).not.toContain('"byteLength"'); expect(container.textContent).not.toContain('research:O2');
    await act(async () => button('Retry occurrence metadata').click());
  }
  expect(container.textContent).toContain('"byteLength": 0');
  for (const call of detail.mock.calls) expect(call.slice(0, 3)).toEqual([identity, followup.id, first.id]);
});

it('discards late occurrence metadata after close, a newer occurrence, Host replacement and branch navigation', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); const first = researchOccurrence('research:O1', 20); const second = researchOccurrence('research:O2', 40);
  followup.occurrence = first; f.view.followups = [followup];
  type Detail = Awaited<ReturnType<ThreadsAPI['followups']['occurrence']>>;
  const releases: ((value: Detail) => void)[] = [];
  const detail = vi.fn<ThreadsAPI['followups']['occurrence']>(() => new Promise(resolve => releases.push(resolve))); f.api.followups.occurrence = detail;
  const open = async () => { await act(async () => button('Read occurrence metadata').click()); return detail.mock.calls.at(-1)![3]!; };
  const late = async (index: number, original: typeof first) => { await act(async () => releases[index]!(researchDetail(original))); expect(container.textContent).not.toContain('"byteLength"'); };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const closed = await open(); await act(async () => button('Hide occurrence metadata').click()); expect(closed.aborted).toBe(true); await late(0, first);
  const previous = await open(); followup.occurrence = second;
  await act(async () => f.emit({ cursor: 50, subject: followup.id, revision: 2, kind: 'followup.changed', data: {} }));
  expect(previous.aborted).toBe(true); await late(1, first);
  const oldHost = await open(); await act(async () => { endpoint.generation++; for (const listener of endpoint.listeners) listener(); });
  expect(oldHost.aborted).toBe(true); await late(2, second);
  const oldBranch = await open(); const nextIdentity = { ...identity, branchId: 'branch:other' }; const next = fixture(true);
  next.view.identity = nextIdentity; next.view.thread.branches[0]!.branch_id = nextIdentity.branchId;
  await act(async () => root.render(<ThreadConversation api={next.api} identity={nextIdentity} />));
  expect(oldBranch.aborted).toBe(true); await late(3, second);
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it('keeps failed collection with no records distinct from a genuinely empty completed collection', async () => {
  const f = fixture(true); const followup = repeatedFollowup(); const binding = researchJob().binding;
  followup.occurrence = { ...researchOccurrence('failed-collection', 20), evidence: { kind: 'all', sources: [
    { source_index: 0, accepted_cursor: 17, trigger_cursor: 95, evidence: { kind: 'artifact', binding, fact: { kind: 'artifact_absent', completion_revision: 7, outcome: 'failed' }, gap: true } },
    { source_index: 1, accepted_cursor: 20, trigger_cursor: 80, evidence: { kind: 'collection', binding, completion_revision: 7, outcome: 'failed', counts: { available: 0, failed: 0, expired: 0, pending: 0 }, gap: true } },
  ] } }; f.view.followups = [followup];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const latest = () => container.querySelector('[aria-label="Latest follow-up occurrence"]')!;
  expect(latest().textContent).toContain('source file absence is unproven'); expect(latest().textContent).toContain('collection failed');
  expect(latest().textContent).toContain('observation gap'); expect(latest().textContent).not.toContain('empty collection');
  followup.occurrence = { ...researchOccurrence('done-empty-collection', 40), evidence: { kind: 'collection', binding, completion_revision: 8, outcome: 'done', counts: { available: 0, failed: 0, expired: 0, pending: 0 }, gap: false } };
  await act(async () => f.emit({ cursor: 50, subject: followup.id, revision: 2, kind: 'followup.changed', data: {} }));
  expect(latest().textContent).toContain('collection done'); expect(latest().textContent).toContain('empty collection');
  expect(button('Cancel follow-up')).toBeDefined(); expect(button('Pause follow-up')).toBeDefined();
});

function logJob(): ReturnType<typeof researchJob> {
  return { ...researchJob(), observationKinds: ['job_stopped', 'log_literal', 'log_end'] };
}
function logFollowup(): ThreadSnapshot['followups'][number] {
  return { ...repeatedFollowup(), id: 'followup:log',
    wait: { id: 'wait:log', kind: 'log_literal', after_cursor: 1, trigger_cursor: null, state: 'waiting' },
    trigger: { kind: 'log_literal', operation_id: logJob().binding.operationId, stream: 'stderr', from_offset: 0, literal_bytes: 3 },
    sources: [{ source_index: 0, after_cursor: 1, consumed_cursor: 0, observed: null, file: null, metric: null,
      log: { offset: 0, matched_prefix: 0, ended: false, failure_code: null } }] };
}
function logOccurrence(id: string, accepted: number): ReturnType<typeof repeatedOccurrence> {
  return { ...repeatedOccurrence(id, accepted, true), evidence: { kind: 'log_literal', binding: logJob().binding, stream: 'stderr',
    start_offset: 2, end_offset: 5, published_bytes: 8, job_revision: 4 } };
}

// Controlled application API: these tests exercise the real React consumer, not Host/Rust IPC.
it('registers exact log bytes on accepted task-family work and preserves the complete uncertain intent', async () => {
  const f = fixture(true); const job = logJob(); const unsupported = researchJob();
  unsupported.binding = { ...unsupported.binding, operationId: 'job:without-log-observation', subject: { kind: 'workspace', workspaceId: 'workspace:original', subjectId: 'no-log-support' } };
  f.api.followups.jobSources = vi.fn(async () => [job, unsupported]);
  const followup = logFollowup(); const get = vi.fn<ThreadsAPI['followups']['get']>(async () => ({ followup, instruction: 'Use the matching output.',
    registration_trigger: { kind: 'log_literal', operationId: job.binding.operationId, stream: 'stderr', literal: ' A中\nA ', fromOffset: 50000 } }));
  f.api.followups.get = get;
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('acceptance reply lost'))
    .mockImplementation(async input => {
      if (input.trigger.kind !== 'log_literal') throw new Error('expected log literal');
      followup.trigger = { kind: 'log_literal', operation_id: input.trigger.operationId, stream: input.trigger.stream,
        from_offset: input.trigger.fromOffset ?? 0, literal_bytes: new TextEncoder().encode(input.trigger.literal).length };
      f.view.followups = [followup]; return followup;
    }); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'log_literal', 'change');
  expect(container.querySelector('[aria-label="Follow-up job"]')?.textContent).toContain('attempt:historical-research');
  expect(container.querySelector('[aria-label="Follow-up job"]')?.textContent).not.toContain('no-log-support');
  await edit('[aria-label="Follow-up job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change');
  await edit('[aria-label="Follow-up log stream"]', 'stderr', 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Use the matching output.');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Follow-up log literal"]', ' A中\nA ');
  await edit('[aria-label="Follow-up log offset"]', '-1'); expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Follow-up log offset"]', '1.5'); expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Follow-up log offset"]', '50000'); expect(button('Register repeating follow-up').disabled).toBe(false);
  await act(async () => button('Register repeating follow-up').click());
  const original = register.mock.calls[0]![0];
  expect(original).toMatchObject({ ...identity, runId: 'ui-run', repeat: 'each', instruction: 'Use the matching output.',
    trigger: { kind: 'log_literal', operationId: job.binding.operationId, stream: 'stderr', literal: ' A中\nA ', fromOffset: 50000 } });
  expect(original.runId).not.toBe(job.sourceRunId); expect(get).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up log literal"]')!.disabled).toBe(true);
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-work' };
  await act(async () => f.emit({ cursor: 8, subject: 'new-work', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(original);
  const pending = container.querySelector('[aria-label="Pending follow-up"]')!;
  expect(pending.textContent).toContain('8 literal bytes from byte 50000');
  expect(pending.textContent).not.toContain(' A中\nA '); expect(get).not.toHaveBeenCalled();
  await act(async () => button('Read follow-up instruction and literal').click());
  expect(get).toHaveBeenCalledExactlyOnceWith(identity, followup.id, expect.any(AbortSignal));
  expect(container.querySelector('[aria-label="Condition 1 original literal"]')?.textContent).toBe(' A中\nA ');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});

it('defaults log matching to published history, accepts whitespace literals and keeps finite log-end leaves out of repeated All', async () => {
  const f = fixture(true); const job = logJob(); f.api.followups.jobSources = async () => [job];
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValue(new Error('uncertain')); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'any', 'change');
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change');
  await edit('[aria-label="Condition 1 kind"]', 'log_literal', 'change');
  await edit('[aria-label="Condition 1 job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Condition 1 log literal"]', '  ');
  await edit('[aria-label="Condition 2 kind"]', 'log_end', 'change');
  await edit('[aria-label="Condition 2 job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Condition 2 log stream"]', 'stderr', 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Read each accepted fact.');
  expect(button('Register repeating follow-up').disabled).toBe(false);
  await edit('[aria-label="Follow-up trigger"]', 'all', 'change');
  expect(button('Register repeating follow-up').disabled).toBe(true);
  expect(container.textContent).toContain('Repeated All requires every condition');
  await edit('[aria-label="Follow-up trigger"]', 'any', 'change');
  await act(async () => button('Register repeating follow-up').click());
  expect(register.mock.calls[0]![0].trigger).toEqual({ kind: 'any', sources: [
    { kind: 'log_literal', operationId: job.binding.operationId, stream: 'stdout', literal: '  ' },
    { kind: 'log_end', operationId: job.binding.operationId, stream: 'stderr' },
  ] });
});

it('keeps frozen log occurrence evidence while the source advances and controls only its observation', async () => {
  const f = fixture(true); const followup = logFollowup(); const first = logOccurrence('log:O1', 10); const second = logOccurrence('log:O2', 20);
  if (second.evidence.kind !== 'log_literal') throw new Error('expected log evidence');
  second.evidence = { ...second.evidence, start_offset: 15, end_offset: 18, published_bytes: 21, job_revision: 8 };
  followup.occurrence = first; followup.sources[0]!.log!.offset = 8; f.view.followups = [followup];
  const history = vi.fn<ThreadsAPI['followups']['occurrences']>(async () => ({ occurrences: [structuredClone(first)], nextCursor: null }));
  const details = vi.fn(f.api.followups.occurrence); const get = vi.fn(f.api.followups.get);
  const control = vi.fn<ThreadsAPI['followups']['control']>(async input => {
    followup.revision++; followup.state = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'cancelled';
    if (input.action === 'resume') followup.sources[0]!.log!.failure_code = null;
    return structuredClone(followup);
  }); f.api.followups = { ...f.api.followups, occurrences: history, occurrence: details, get, control };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.textContent).toContain('stderr literal match · bytes 2–5 (end exclusive) · 8 published bytes · job revision 4');
  await act(async () => button('Read occurrence history').click());
  followup.occurrence = second; followup.sources[0]!.log!.offset = 21;
  await act(async () => f.emit({ cursor: 21, subject: followup.id, revision: 2, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Follow-up occurrence history"]')?.textContent).toContain('bytes 2–5');
  expect(container.querySelector('[aria-label="Follow-up occurrence history"]')?.textContent).not.toContain('bytes 15–18');
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')?.textContent).toContain('bytes 15–18');
  expect(get).not.toHaveBeenCalled(); expect(details).not.toHaveBeenCalled();
  followup.sources[0]!.log = { offset: 21, matched_prefix: 2, ended: false, failure_code: 'log_blob_unavailable' };
  followup.repeat = 'once'; followup.occurrence = null;
  await act(async () => f.emit({ cursor: 22, subject: followup.id, revision: 3, kind: 'followup.changed', data: {} }));
  expect(container.textContent).toContain('Log observation unavailable · log_blob_unavailable');
  await act(async () => button('Retry log observation').click());
  expect(control.mock.calls.at(-1)![0]).toMatchObject({ followupId: followup.id, action: 'resume' });
  expect(followup.sources[0]!.log).toMatchObject({ offset: 21, matched_prefix: 2 });
  await act(async () => button('Pause follow-up').click()); await act(async () => button('Resume follow-up').click());
  await act(async () => button('Cancel follow-up').click());
  expect(followup.sources[0]!.log).toMatchObject({ offset: 21, matched_prefix: 2 });
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('discards late literal reads after close, Host replacement and branch navigation, then retries a failed original read', async () => {
  const f = fixture(true); const followup = logFollowup(); f.view.followups = [followup];
  type Detail = Awaited<ReturnType<ThreadsAPI['followups']['get']>>;
  const releases: ((value: Detail) => void)[] = [];
  const get = vi.fn<ThreadsAPI['followups']['get']>(() => new Promise(resolve => releases.push(resolve))); f.api.followups.get = get;
  const result: Detail = { followup, instruction: 'Read original output.', registration_trigger: { kind: 'log_literal', operationId: logJob().binding.operationId, stream: 'stderr', literal: 'OLD-LITERAL' } };
  const open = async () => { await act(async () => button('Read follow-up instruction and literal').click()); return get.mock.calls.at(-1)![2]!; };
  const late = async (index: number) => { await act(async () => releases[index]!(result)); expect(container.textContent).not.toContain('OLD-LITERAL'); };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const closed = await open(); await act(async () => button('Hide follow-up instruction and literal').click()); expect(closed.aborted).toBe(true); await late(0);
  const host = await open(); await act(async () => { endpoint.generation++; for (const listener of endpoint.listeners) listener(); });
  expect(host.aborted).toBe(true); await late(1);
  const branch = await open(); const nextIdentity = { ...identity, branchId: 'branch:next' }; const next = fixture(true);
  next.view.identity = nextIdentity; next.view.thread.branches[0]!.branch_id = nextIdentity.branchId;
  const nextFollowup = { ...logFollowup(), branch_id: nextIdentity.branchId }; next.view.followups = [nextFollowup];
  const currentResult = { ...result, followup: nextFollowup, registration_trigger: { kind: 'log_literal' as const, operationId: logJob().binding.operationId, stream: 'stderr' as const, literal: '<img src=x>' } };
  next.api.followups.get = vi.fn<ThreadsAPI['followups']['get']>().mockRejectedValueOnce(new Error('read unavailable')).mockResolvedValue(currentResult);
  await act(async () => root.render(<ThreadConversation api={next.api} identity={nextIdentity} />));
  expect(branch.aborted).toBe(true); await late(2);
  await act(async () => button('Read follow-up instruction and literal').click());
  expect(container.textContent).toContain('The original follow-up could not be read.');
  await act(async () => button('Retry original follow-up details').click());
  expect(container.querySelector('[aria-label="Condition 1 original literal"]')?.textContent).toBe('<img src=x>');
  expect(container.querySelector('[aria-label="Original follow-up details"] img')).toBeNull();
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it('moves exhausted logs into history only after pending deliveries finish, without inventing a trigger', async () => {
  const f = fixture(true); const followup = logFollowup(); followup.repeat = 'once';
  followup.sources[0]!.log = { offset: 100, matched_prefix: 0, ended: true, failure_code: null };
  followup.exhausted = true;
  followup.observation = { wait_id: 'wait:log-observation', operation_id: 'operation:log-observation', run_id: 'ui-run', state: 'exhausted', delivered: false, delivery_pending: true };
  f.view.followups = [followup];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).not.toBeNull();
  expect(container.textContent).toContain('Log ended without satisfying the condition');
  expect(container.textContent).toContain('Stream ended without a literal match');
  expect(container.textContent).toContain('ended without triggering · result awaiting delivery');
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')).toBeNull();
  expect(container.textContent).not.toContain('Waiting for the original trigger');
  followup.observation.delivered = true; followup.observation.delivery_pending = false;
  await act(async () => f.emit({ cursor: 12, subject: followup.id, revision: 2, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).toBeNull();
  expect(button('Past follow-ups (1)')).toBeDefined();
  await act(async () => button('Past follow-ups (1)').click());
  expect(container.querySelector('[aria-label="Past follow-up"]')?.textContent).toContain('Log ended without satisfying the condition');
  expect(button('Pause follow-up')).toBeUndefined(); expect(button('Cancel follow-up')).toBeUndefined();
  expect(container.textContent).toContain('ended without triggering · result delivered');
  // Real Catalog probe: failed original Run -> terminal Wait cleanup -> no-match EOF.
  // Its cancelled observation has no history delivery and no remaining delivery obligation.
  followup.observation.state = 'cancelled'; followup.observation.delivered = false;
  f.view.thread.branches[0]!.latest_run = { ...f.view.activeRun!, state: 'failed' };
  f.view.thread.branches[0]!.active_run_id = null; f.view.activeRun = null;
  await act(async () => f.emit({ cursor: 14, subject: followup.id, revision: 3, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).toBeNull();
  expect(container.querySelector('[aria-label="Past follow-up"]')?.textContent).toContain('cancelled · no result pending delivery');
  expect(container.querySelector('[aria-label="Latest follow-up occurrence"]')).toBeNull();
  expect(button('End follow-up observation')).toBeUndefined(); expect(button('Cancel follow-up')).toBeUndefined();
  followup.repeat = 'each'; followup.observation = null; followup.pending_occurrences = 1;
  followup.occurrence = { ...logOccurrence('log:pending', 15), state: 'held', hold_reason: 'manual_pause', delivery: null };
  followup.sources[0]!.observed = { accepted_cursor: 15, trigger_cursor: 15, evidence: followup.occurrence.evidence as Extract<typeof followup.occurrence.evidence, { kind: 'log_literal' }> };
  await act(async () => f.emit({ cursor: 16, subject: followup.id, revision: 4, kind: 'followup.changed', data: {} }));
  expect(container.querySelector('[aria-label="Pending follow-up"]')).not.toBeNull();
  expect(container.textContent).toContain('Log observation ended'); expect(container.textContent).not.toContain('Continuing to observe changes');
  expect(button('Cancel follow-up')).toBeDefined();
  expect(followup.sources[0]!.log!.offset).toBe(100);
});

it('registers a single stream end and shows its fixed empty-stream evidence separately from collection', async () => {
  const f = fixture(true); const job = logJob(); f.api.followups.jobSources = async () => [job];
  const followup = logFollowup(); followup.repeat = 'once'; followup.exhausted = true;
  followup.trigger = { kind: 'log_end', operation_id: job.binding.operationId, stream: 'stdout' };
  followup.wait.kind = 'log_end'; followup.wait.state = 'consumed';
  const occurrence = { ...logOccurrence('log:end', 10), evidence: { kind: 'log_end' as const, binding: job.binding, stream: 'stdout' as const,
    published_bytes: 0, job_revision: null, attempt_revision: 5 } };
  followup.occurrence = occurrence;
  followup.sources[0]!.log = { offset: 0, matched_prefix: 0, ended: true, failure_code: null };
  followup.sources[0]!.observed = { accepted_cursor: 10, trigger_cursor: 10, evidence: occurrence.evidence };
  const register = vi.fn<ThreadsAPI['followups']['register']>(async () => { f.view.followups = [followup]; return followup; }); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'log_end', 'change');
  await edit('[aria-label="Follow-up job"]', job.binding.operationId, 'change');
  await edit('[aria-label="Follow-up instruction"]', 'Check the completed output.');
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change'); expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Follow-up repetition"]', 'once', 'change');
  expect(container.textContent).toContain('Artifact collection may finish later.');
  await act(async () => button('Register one-time follow-up').click());
  expect(register.mock.calls[0]![0].trigger).toEqual({ kind: 'log_end', operationId: job.binding.operationId, stream: 'stdout' });
  expect(container.querySelector('[aria-label="Pending follow-up"]')).toBeNull();
  await act(async () => button('Past follow-ups (1)').click());
  expect(container.textContent).toContain('stdout ended · 0 published bytes · attempt revision 5');
  expect(container.textContent).toContain('Log condition 1: Stream ended');
  expect(container.textContent).not.toContain('without a literal match');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

function metricResources(): Awaited<ReturnType<NonNullable<ThreadsAPI['research']>['resources']>> {
  return { generatedAt: 10, text: 'Original resource directory', machines: [
    { machineId: 'machine:local', label: 'Research workstation', kind: 'local', state: 'available',
      connection: { status: 'connected', checkedAt: 10 }, commitments: [], queued: [],
      capacity: { gpus: [{ index: 3, uuid: 'GPU-stable-original', name: 'Compute GPU' }] },
      usage: { cpuPercent: 35, memoryMb: 4096, observedAt: 10, source: 'host', stale: false,
        gpus: [{ index: 7, uuid: 'GPU-stable-original', name: 'Compute GPU', utilizationPercent: 60 }] } },
    { machineId: 'machine:no-uuid', label: 'GPU inventory incomplete', kind: 'local', state: 'degraded',
      connection: { status: 'degraded', checkedAt: 10 }, commitments: [], queued: [], capacity: { gpus: [{ index: 0, name: 'Unnamed GPU' }] } },
    { machineId: 'machine:remote', label: 'Offline remote', kind: 'remote', state: 'offline',
      connection: { status: 'offline', checkedAt: 10 }, commitments: [], queued: [] },
  ] };
}
function withMetricResources(f: ReturnType<typeof fixture>) {
  const unused = async (): Promise<never> => { throw new Error('unused research API'); };
  const resources = vi.fn<NonNullable<ThreadsAPI['research']>['resources']>(async () => metricResources());
  f.api.research = { scopes: async () => [], resources, list: unused, get: unused, logs: unused, artifact: unused,
    cancel: unused, collect: unused, submit: unused, sources: unused };
  return resources;
}
function metricFollowup(): ThreadSnapshot['followups'][number] {
  return { ...repeatedFollowup(), id: 'followup:metric',
    trigger: { kind: 'metric', machine_id: 'machine:local', metric: 'cpu_percent', predicate: 'above', threshold: 75 },
    wait: { id: 'wait:metric', kind: 'metric', after_cursor: 1, trigger_cursor: null, state: 'waiting' },
    sources: [{ source_index: 0, after_cursor: 1, consumed_cursor: 0, observed: null, file: null, log: null,
      metric: { identity: { host_id: 'host:original', machine_id: 'machine:local', kind: 'local', backend: null, target_host_id: null },
        sample_revision: 9, observed_at_ms: 1000, status: 'available', failure_code: null, holding: true, value: 80, gap: false } }] };
}

it.each([
  ['metric', 'once'], ['metric', 'each'], ['any', 'once'], ['any', 'each'], ['all', 'once'], ['all', 'each'],
] as const)('registers %s %s metrics from the original machine directory and original source Run', async (kind, repeat) => {
  const f = fixture(true); const resources = withMetricResources(f);
  const register = vi.fn<ThreadsAPI['followups']['register']>(async () => metricFollowup()); f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(resources).not.toHaveBeenCalled();
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', kind, 'change');
  await edit('[aria-label="Follow-up repetition"]', repeat, 'change');
  const label = kind === 'metric' ? 'Follow-up' : 'Condition 1';
  if (kind !== 'metric') await edit('[aria-label="Condition 1 kind"]', 'metric', 'change');
  await edit(`[aria-label="${label} machine"]`, 'machine:local', 'change');
  await edit(`[aria-label="${label} metric threshold"]`, '75.5');
  const finiteAny = kind === 'any' && repeat === 'each';
  if (kind !== 'metric') {
    if (finiteAny) {
      await edit('[aria-label="Condition 2 kind"]', 'at', 'change');
      await edit('[aria-label="Condition 2 time"]', '2030-02-03T04:05:06');
    } else {
      await edit('[aria-label="Condition 2 kind"]', 'metric', 'change');
      await edit('[aria-label="Condition 2 machine"]', 'machine:remote', 'change');
      await edit('[aria-label="Condition 2 metric"]', 'memory_mb', 'change');
      expect(container.textContent).toContain('Threshold (MiB)');
      await edit('[aria-label="Condition 2 metric predicate"]', 'below', 'change');
      await edit('[aria-label="Condition 2 metric threshold"]', '1024');
    }
  }
  await edit('[aria-label="Follow-up instruction"]', 'Continue when the observed metric qualifies.');
  if (finiteAny) {
    await edit('[aria-label="Follow-up trigger"]', 'all', 'change');
    expect(button('Register repeating follow-up').disabled).toBe(true);
    await edit('[aria-label="Follow-up trigger"]', 'any', 'change');
  }
  expect(container.textContent).toContain('Remote metric sampling is not supported yet');
  expect(container.textContent).toContain(repeat === 'each' ? 'Unknown samples do not rearm it' : 'including the initial observation');
  const submit = button(repeat === 'each' ? 'Register repeating follow-up' : 'Register one-time follow-up');
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  const cpu = { kind: 'metric', machineId: 'machine:local', metric: 'cpu_percent', predicate: 'above', threshold: 75.5 };
  expect(register).toHaveBeenCalledExactlyOnceWith({ ...identity, key: expect.any(String), runId: 'ui-run', repeat,
    instruction: 'Continue when the observed metric qualifies.', trigger: kind === 'metric' ? cpu : { kind, sources: [cpu,
      finiteAny ? { kind: 'at', atMs: new Date('2030-02-03T04:05:06').getTime() }
        : { kind: 'metric', machineId: 'machine:remote', metric: 'memory_mb', predicate: 'below', threshold: 1024 }] } });
  expect(resources).toHaveBeenCalledExactlyOnceWith({ ...identity, sourceRunId: 'ui-run' }, expect.any(AbortSignal));
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('requires a finite threshold and stable GPU UUID, then retains the complete uncertain metric intent across newer work and Close/Back', async () => {
  const f = fixture(true); const resources = withMetricResources(f);
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue(metricFollowup());
  f.api.followups.register = register;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Schedule a follow-up').click());
  await edit('[aria-label="Follow-up trigger"]', 'metric', 'change');
  await edit('[aria-label="Follow-up repetition"]', 'each', 'change');
  await edit('[aria-label="Follow-up machine"]', 'machine:no-uuid', 'change');
  await edit('[aria-label="Follow-up metric"]', 'gpu_memory_mb', 'change');
  expect(container.textContent).toContain('Threshold (MiB)');
  await edit('[aria-label="Follow-up metric threshold"]', '1024');
  await edit('[aria-label="Follow-up instruction"]', 'Read the GPU result.');
  expect(container.textContent).toContain('No stable GPU UUID is available');
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Follow-up GPU"]')!.disabled).toBe(true);
  expect(button('Register repeating follow-up').disabled).toBe(true);
  await edit('[aria-label="Follow-up machine"]', 'machine:local', 'change');
  expect(container.querySelectorAll('[aria-label="Follow-up GPU"] option')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Follow-up GPU"]')!.textContent).toContain('GPU 7');
  await edit('[aria-label="Follow-up GPU"]', 'GPU-stable-original', 'change');
  for (const invalid of ['', ' ', 'Infinity', 'NaN', '1e999']) {
    await edit('[aria-label="Follow-up metric threshold"]', invalid);
    expect(button('Register repeating follow-up').disabled).toBe(true);
  }
  await edit('[aria-label="Follow-up metric threshold"]', '1024.5');
  await edit('[aria-label="Follow-up metric predicate"]', 'below', 'change');
  await act(async () => button('Register repeating follow-up').click());
  const original = register.mock.calls[0]![0];
  expect(original.trigger).toEqual({ kind: 'metric', machineId: 'machine:local', metric: 'gpu_memory_mb',
    gpuUuid: 'GPU-stable-original', predicate: 'below', threshold: 1024.5 });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Follow-up machine"]')!.disabled).toBe(true);
  await act(async () => button('Hide follow-up form').click());
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-work' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-work', revision: 1, kind: 'run.accepted', data: {} }));
  await act(async () => button('Schedule a follow-up').click());
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Follow-up GPU"]')!.value).toBe('GPU-stable-original');
  await act(async () => button('Retry original follow-up').click());
  expect(register.mock.calls[1]![0]).toEqual(original);
  expect(resources).toHaveBeenCalledTimes(1);
  expect(f.cancelRun).not.toHaveBeenCalled();
});

it('shows original metric evidence and unknown holding without inventing occurrences, and controls only the observation', async () => {
  const f = fixture(true); const followup = metricFollowup(); const fact = followup.sources[0]!.metric!;
  const occurrence = { ...repeatedOccurrence('metric:O1', 20, true), evidence: { kind: 'metric' as const, fact: {
    identity: fact.identity!, machine_revision: 4, sample_revision: 9, observed_at_ms: 1000, metric: 'cpu_percent' as const,
    gpu_uuid: null, predicate: 'above' as const, threshold: 75, value: 80, gap: true } } };
  followup.occurrence = occurrence; f.view.followups = [followup];
  const control = vi.fn<ThreadsAPI['followups']['control']>(async input => {
    followup.revision += 1; followup.state = input.action === 'cancel' ? 'cancelled' : input.action === 'pause' ? 'paused' : 'active'; return followup;
  }); f.api.followups.control = control;
  const details = vi.fn(f.api.followups.occurrence); f.api.followups.occurrence = details;
  const resources = withMetricResources(f);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const latest = () => container.querySelector('[aria-label="Latest follow-up occurrence"]')!;
  expect(latest().textContent).toContain('CPU usage 80 %'); expect(latest().textContent).toContain('sample revision 9');
  expect(latest().textContent).toContain('machine revision 4'); expect(latest().textContent).toContain('1970-01-01T00:00:01.000Z');
  expect(latest().textContent).toContain('Host host:original'); expect(latest().textContent).toContain('observation gap');
  expect(container.querySelector('[aria-label="Metric condition 1"]')!.textContent).toContain('condition satisfied');
  for (const [index, status] of (['missing', 'stale', 'unavailable'] as const).entries()) {
    fact.status = status; fact.value = null; fact.sample_revision = 10 + index; fact.gap = true; fact.failure_code = 'machine_unavailable';
    await act(async () => f.emit({ cursor: 30 + index, subject: followup.id, revision: 2 + index, kind: 'followup.changed', data: {} }));
    const state = container.querySelector('[aria-label="Metric condition 1"]')!;
    expect(state.textContent).toContain(`Unknown (${status})`); expect(state.textContent).toContain('previous satisfied condition retained');
    expect(state.textContent).not.toContain('0 %'); expect(state.textContent).toContain('unavailable crossings are not reconstructed');
    expect(latest().textContent).toContain('sample revision 9');
    expect(container.querySelectorAll('[aria-label="Follow-up occurrence"]')).toHaveLength(1);
  }
  expect(details).not.toHaveBeenCalled(); expect(resources).not.toHaveBeenCalled();
  await act(async () => button('Retry metric observation').click());
  await act(async () => button('Pause follow-up').click());
  await act(async () => button('Resume follow-up').click());
  await act(async () => button('Cancel follow-up').click());
  expect(control.mock.calls.map(([value]) => value.action)).toEqual(['resume', 'pause', 'resume', 'cancel']);
  expect(control.mock.calls[0]![0]).toEqual({ ...identity, followupId: followup.id, expectedRevision: 1, action: 'resume' });
  expect(button('Past follow-ups (1)')).toBeDefined(); expect(button('Cancel follow-up')).toBeUndefined();
  expect(f.cancelRun).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('discards late machine reads after closing, changing Run, Host or Thread/branch and offers explicit retry', async () => {
  const f = fixture(true); const resources = withMetricResources(f);
  type Directory = Awaited<ReturnType<typeof resources>>;
  const releases: Array<(result: Directory) => void> = [];
  resources.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const open = async () => {
    await act(async () => button('Schedule a follow-up').click());
    await edit('[aria-label="Follow-up trigger"]', 'metric', 'change');
    return resources.mock.calls.at(-1)![1]!;
  };
  const late = async (index: number) => {
    await act(async () => releases[index]!(metricResources()));
    expect(container.textContent).not.toContain('Research workstation');
  };
  const closed = await open();
  expect(container.textContent).toContain('Reading original machines');
  await act(async () => button('Hide follow-up form').click()); expect(closed.aborted).toBe(true); await late(0);
  const oldRun = await open();
  f.view.activeRun = { ...f.view.activeRun!, id: 'new-work' };
  await act(async () => f.emit({ cursor: 2, subject: 'new-work', revision: 1, kind: 'run.accepted', data: {} }));
  expect(oldRun.aborted).toBe(true); await late(1);
  expect(resources.mock.calls.at(-1)![0].sourceRunId).toBe('new-work');
  const oldHost = resources.mock.calls.at(-1)![1]!;
  await act(async () => { endpoint.generation += 1; for (const listener of endpoint.listeners) listener(); });
  expect(oldHost.aborted).toBe(true); await late(2);
  const oldBranch = await open();
  const nextIdentity = { ...identity, threadId: 'thread:metric-next', branchId: 'branch:metric-next' };
  f.view.identity = nextIdentity; f.view.thread.thread_id = nextIdentity.threadId;
  f.view.thread.branches[0]!.branch_id = nextIdentity.branchId;
  f.view.activeRun = { ...f.view.activeRun!, thread_id: nextIdentity.threadId, branch_id: nextIdentity.branchId };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={nextIdentity} />));
  expect(oldBranch.aborted).toBe(true); await late(3);
  resources.mockRejectedValueOnce(new Error('connection unavailable'));
  await open();
  expect(container.textContent).toContain('Original machines could not be read');
  expect(button('Register one-time follow-up').disabled).toBe(true);
  resources.mockResolvedValueOnce(metricResources());
  await act(async () => button('Retry machines').click());
  expect(container.textContent).toContain('Research workstation');
  expect(resources.mock.calls.at(-1)![0]).toEqual({ ...nextIdentity, sourceRunId: 'new-work' });
  expect(container.textContent).not.toContain('Original machines could not be read');
});

it('shows Native Computer owner state and stops the exact displayed execution without a Pi session', async () => {
  const f = fixture(true);
  const execution = { work: identity, runId: 'computer-run' };
  const computerState = { work: identity, rootWork: identity, currentExecution: execution, currentRootExecution: execution,
    active: true, status: 'enabled' as const, leases: [], requests: [], cleanups: [] };
  vi.mocked(f.api.computer.state).mockResolvedValue({ state: computerState, activities: [] });
  vi.mocked(f.api.computer.stop).mockResolvedValue({ state: { ...computerState, currentExecution: null, currentRootExecution: null,
    status: 'cancel-unconfirmed', cleanups: [{ execution, desktopId: 'desktop', status: 'cancel-unconfirmed' }] } });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(f.api.computer.state).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
  await act(async () => button('computer.automation.stop').click());
  expect(f.api.computer.stop).toHaveBeenCalledWith(identity, { runId: 'computer-run', desktopId: undefined });
  expect(container.textContent).toContain('computer.automation.cancel-unconfirmed');
});

it('keeps stored images for a text edit, explicitly removes them with [], and replaces only with new inline upload bytes', async () => {
  const f = fixture(true);
  f.view.inputs = [{ id: 'image-queue', thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run',
    mode: 'boundary', state: 'queued', revision: 1, content: { text: 'original text', attachments: [storedImage] }, cursor: 1 }];
  const editInput = vi.fn<ThreadsAPI['editInput']>(async (_id, _revision, _text, _images) => { throw new Error('Uncertain edit reply'); });
  f.api.editInput = editInput;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="chat.queuedMessage.edit"]')!.click());
  const form = () => container.querySelector('textarea[aria-label="chat.queuedMessage.edit"]')!.closest('form')!;
  await edit('textarea[aria-label="chat.queuedMessage.edit"]', 'changed text');
  await submitForm(form());
  expect(editInput).toHaveBeenLastCalledWith('image-queue', 1, 'changed text');
  await act(async () => button('Remove queued images').click());
  await submitForm(form());
  expect(editInput).toHaveBeenLastCalledWith('image-queue', 1, 'changed text', []);
  const file = new File([Uint8Array.of(1, 2, 3)], 'new.png', { type: 'image/png' });
  const picker = container.querySelector<HTMLInputElement>('[aria-label="Replace queued images"]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(form().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
  await submitForm(form());
  expect(editInput).toHaveBeenLastCalledWith('image-queue', 1, 'changed text', [{ mimeType: 'image/png', data: 'AQID' }]);
  expect(JSON.stringify(editInput.mock.calls)).not.toContain(storedImage.content_ref.content_object);
  await act(async () => button('Keep original images').click());
  await submitForm(form());
  expect(editInput).toHaveBeenLastCalledWith('image-queue', 1, 'changed text');
});

it('reads actual operation completion, result and external receipt images through their distinct original holders', async () => {
  const f = fixture(true);
  const output = { data: { screenshot: { width: 1, height: 1 } }, parts: [{ kind: 'text' as const, text: 'Screenshot' }, { kind: 'media' as const, media: storedImage }] };
  f.view.operations = [{ id: 'media-operation', run_id: 'ui-run', epoch: 1, revision: 2, phase: 'terminal', outcome: 'failed', effect: 'partial',
    cancel_requested: false, lifetime: 'run', handed_off: true, executor: 'script', waiting_on: null, intent: {}, execution_owner: null,
    call_completion: { kind: 'result', outcome: 'failed', effect: 'partial', content: output }, result: { kind: 'output', output },
    external_receipt: { executor: 'script', identity: 'receipt', epoch: 'epoch', outcome: 'failed', effect: 'partial', result: output, executor_stopped: true } }];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(f.api.mediaRead).not.toHaveBeenCalled();
  expect(container.textContent).toContain('failed'); expect(container.textContent).toContain('partial');
  for (const view of [...document.querySelectorAll<HTMLButtonElement>('button')].filter(value => value.textContent === 'chat.media.view')) {
    await act(async () => view.click());
  }
  expect(vi.mocked(f.api.mediaRead).mock.calls.map(([input]) => input.holder)).toEqual(['completion', 'result', 'external_receipt'].map(output => ({ kind: 'operation', operationId: 'media-operation', output })));
  expect(container.querySelectorAll('img')).toHaveLength(3);
});

it('keeps accepted remote task control after its Run ends and distinguishes cancellation, result and executor stop', async () => {
  const f = fixture();
  const operation: ThreadSnapshot['operations'][number] = {
    id: 'local:original-dispatch', run_id: 'completed-source-run', epoch: 1, revision: 3,
    phase: 'terminal', outcome: 'indeterminate', effect: 'unknown', cancel_requested: false,
    lifetime: 'thread', handed_off: true, executor: 'mcp', waiting_on: null, intent: {}, result: null,
    external_receipt: null, call_completion: { kind: 'job_accepted', operation_id: 'local:original-dispatch', phase: 'accepted', effect: 'confirmed', lifetime: 'thread' },
    execution_owner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' },
    host_job: { binding: { operationId: 'local:original-dispatch', executionOwner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' },
      domain: 'mcp', domainVersion: 1, subject: { kind: 'mcp', dispatchId: 'local:original-dispatch',
        endpoint: { server: 'original-server', resourceKey: 'original-server-resource', configurationVersion: 'configuration', credentialVersion: 'opaque-grant' } } },
      mcpHolderReleased: false, acceptanceRef: 'original-acceptance', mcpTask: { revision: 1, task: { taskId: 'remote:receiver-task', status: 'working', createdAt: '2026-10-11T18:00:00Z', lastUpdatedAt: '2026-10-11T18:00:01Z', ttl: null },
        observationRef: 'original-observation', availability: 'available', resultReady: false } },
  };
  f.view.operations = [operation];
  const cancel = vi.fn<ThreadsAPI['cancelOperation']>(async id => {
    expect(id).toBe('local:original-dispatch');
    operation.cancel_requested = true;
    operation.host_job!.mcpTask!.task.status = 'cancelled';
    operation.host_job!.mcpTask!.resultReady = true;
    operation.host_job!.mcpTaskResult = { data: { isError: true, original: 'receiver-result' }, parts: [
      { kind: 'text', text: 'Original remote task output' }, { kind: 'media', media: storedImage },
    ] };
    return structuredClone(operation);
  }); f.api.cancelOperation = cancel;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const card = () => container.querySelector('[aria-label="Remote MCP task"]')!;
  expect(card().textContent).toContain('original-server · remote task remote:receiver-task');
  expect(card().textContent).toContain('Result not received');
  expect(card().textContent).toContain('Executor stop unconfirmed');
  await act(async () => button('Request remote task cancellation').click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('local:original-dispatch');
  expect(card().textContent).toContain('Remote status: cancelled · Result stored');
  expect(card().textContent).toContain('Executor stop unconfirmed · Cancellation requested');
  expect(card().textContent).toContain('does not prove execution has stopped');
  expect(container.textContent).toContain('Original remote task output');
  await act(async () => button('View image').click());
  expect(f.api.mediaRead).toHaveBeenCalledExactlyOnceWith({ ...identity, holder: { kind: 'operation', operationId: 'local:original-dispatch', output: 'mcp_task_result' },
    partIndex: 1, chunkIndex: 0, expectedContentRef: storedImage.content_ref.content_object }, expect.any(AbortSignal));
  expect(button('Request remote task cancellation')).toBeUndefined();
  operation.host_job!.mcpTask!.availability = 'unavailable';
  operation.host_job!.mcpTask!.problem = { kind: 'owner', stage: 'rebind' };
  await act(async () => f.emit({ cursor: 1, subject: operation.id, revision: 4, kind: 'operation.changed', data: {} }));
  expect(card().textContent).toContain('Restore that connection to observe this task');
  expect(card().textContent).toContain('Current task observation unavailable');
  expect(card().textContent).not.toContain('Executor stop confirmed');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

function resourceObservation(): ThreadSnapshot['operations'][number] {
  const id = 'operation:original-resource-subscribe';
  return {
    id, run_id: 'completed-source-run', epoch: 1, revision: 3, phase: 'terminal',
    outcome: 'indeterminate', effect: 'unknown', cancel_requested: false, lifetime: 'thread',
    handed_off: true, executor: 'mcp', waiting_on: null, intent: {}, result: null,
    external_receipt: null, execution_owner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' },
    call_completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
      content: { data: { original: 'subscribe-response' }, parts: [{ kind: 'text', text: 'Original subscribe RPC response' }] } },
    mcp_resource_subscription: {
      binding: { operationId: id, executionOwner: { kind: 'external', identity: 'original-mcp', epoch: 'original-owner' },
        endpoint: { server: 'original-resource-server', resourceKey: 'original-resource-key', configurationVersion: 'frozen-config', credentialVersion: 'original-grant' },
        schemaVersion: 'original-resources-schema', uri: 'file:///opaque/server-resource?revision=original' },
      sourceScope: 'workspace', acceptanceRef: { content_object: 'resource-acceptance' }, listenerId: 'original-listener',
      availability: 'active', mcpHolderReleased: false, localReleased: false, remoteCleanup: 'not_requested', lastEventCursor: 11, problem: null,
    },
  };
}

it('stops the original live resource observation after its subscribe RPC and Run ended, retaining the original Unknown result', async () => {
  const f = fixture();
  const operation = resourceObservation();
  f.view.operations = [operation];
  const cancel = vi.fn<ThreadsAPI['cancelOperation']>(async id => {
    expect(id).toBe(operation.id);
    operation.cancel_requested = true;
    Object.assign(operation.mcp_resource_subscription!, {
      availability: 'closed', localReleased: true, remoteCleanup: 'unknown',
      problem: 'Remote error with private data: do not display this text',
    });
    return structuredClone(operation);
  });
  f.api.cancelOperation = cancel;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const card = () => container.querySelector('[aria-label="MCP resource observation"]')!;
  expect(card().textContent).toContain('original-resource-server · file:///opaque/server-resource?revision=original');
  expect(card().querySelector('a')).toBeNull();
  expect(card().textContent).toContain('Resource observation active');
  expect(card().textContent).toContain('Local observation retained · Remote cleanup not requested');
  expect(container.textContent).toContain('terminal · indeterminate · effect: unknown');
  expect(container.textContent).toContain('Original subscribe RPC response');
  await act(async () => button('Stop resource observation').click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith(operation.id);
  expect(card().textContent).toContain('Resource observation closed');
  expect(card().textContent).toContain('Local observation released · Remote cleanup unconfirmed');
  expect(card().textContent).toContain('Check the original service');
  expect(card().textContent).not.toContain('Remote error with private data');
  expect(container.textContent).toContain('terminal · indeterminate · effect: unknown');
  expect(container.textContent).toContain('Original subscribe RPC response');
  expect(button('Stop resource observation')).toBeUndefined();
  expect(f.cancelRun).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.api.mediaRead).not.toHaveBeenCalled();
});

it('keeps resource observation state separate from RPC completion and shows each local/remote cleanup outcome', async () => {
  const f = fixture();
  const operation = resourceObservation();
  f.view.operations = [operation];
  operation.outcome = 'succeeded'; operation.effect = 'confirmed';
  operation.call_completion = { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: {}, parts: [] } };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  const card = () => container.querySelector('[aria-label="MCP resource observation"]')!;
  for (const [index, [availability, text]] of ([
    ['pending', 'Subscription acknowledgement pending'],
    ['gap', 'Resource observation gap: some updates may have been missed'],
    ['unavailable', 'Resource observation unavailable'],
  ] as const).entries()) {
    operation.mcp_resource_subscription!.availability = availability;
    operation.mcp_resource_subscription!.localReleased = availability !== 'pending';
    operation.mcp_resource_subscription!.problem = 'Do not disclose remote credentials or diagnostics';
    await act(async () => f.emit({ cursor: index + 1, subject: operation.id, revision: index + 4, kind: 'mcp.resource_listener_changed', data: { subscription: operation.mcp_resource_subscription } }));
    expect(card().textContent).toContain(text);
    expect(card().textContent).toContain('Check the original MCP connection and resource access');
    expect(card().textContent).not.toContain('Do not disclose');
    expect(container.textContent).toContain('terminal · succeeded · effect: confirmed');
    expect(button('Stop resource observation')).toBeDefined();
  }
  operation.mcp_resource_subscription!.localReleased = true;
  operation.mcp_resource_subscription!.availability = 'closed';
  for (const [index, [remoteCleanup, text]] of ([
    ['shared', 'Remote subscription retained for other observers'],
    ['acknowledged', 'Remote unsubscribe acknowledged'],
  ] as const).entries()) {
    operation.mcp_resource_subscription!.remoteCleanup = remoteCleanup;
    await act(async () => f.emit({ cursor: index + 5, subject: operation.id, revision: index + 8, kind: 'mcp.resource_listener_changed', data: { subscription: operation.mcp_resource_subscription } }));
    expect(card().textContent).toContain(`Local observation released · ${text}`);
    expect(button('Stop resource observation')).toBeUndefined();
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('allows retrying Stop until local resource observation is released, even if cancellation was already requested', async () => {
  const f = fixture();
  const operation = resourceObservation();
  operation.cancel_requested = true;
  f.view.operations = [operation];
  const cancel = vi.fn<ThreadsAPI['cancelOperation']>()
    .mockRejectedValueOnce(new ThreadRequestError(503, 'resource-release-unavailable'))
    .mockImplementationOnce(async () => {
      operation.mcp_resource_subscription!.localReleased = true;
      operation.mcp_resource_subscription!.availability = 'closed';
      return structuredClone(operation);
    });
  f.api.cancelOperation = cancel;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Stop resource observation').click());
  expect(button('Stop resource observation')).toBeDefined();
  await act(async () => button('Stop resource observation').click());
  expect(cancel.mock.calls).toEqual([[operation.id], [operation.id]]);
  expect(button('Stop resource observation')).toBeUndefined();
});


it('projects original MCP interaction events onto idle Task requests without active Operations or an automatic Run continuation', async () => {
  const f = fixture(false);
  const request: McpInteractionView = { record: { id: 'request:server', revision: 1, runId: 'run:already-finished',
    threadId: identity.threadId, branchId: identity.branchId, mode: 'form', availability: 'live', choice: null,
    delivery: 'not_started', completionReported: false, deliveryReleased: true, problem: null,
    binding: { operationId: 'operation:accepted-task', executionOwner: { kind: 'external', identity: 'original-owner', epoch: 'epoch' },
      connectionId: 'original-connection', source: { kind: 'server_request', requestId: 0, relation: { kind: 'task', taskId: 'original-remote-task' } },
      endpoint: { server: 'original-server', resourceKey: 'server-key', configurationVersion: 'configuration', credentialVersion: 'grant' } } },
    request: {}, presentation: { mode: 'form', message: 'The retained task needs your choice.', fields: [
      { name: 'enabled', title: 'Enable task option', kind: 'boolean', required: true, default: false },
    ] }, response: null };
  let visible = false;
  f.api.listMcpInteractions = vi.fn(async () => ({ items: visible ? [structuredClone({ record: request.record, presentation: request.presentation, response: request.response })] : [], nextCursor: null }));
  f.api.respondMcpInteraction = vi.fn(async input => {
    request.response = input.response; request.record.choice = input.response.action; request.record.delivery = 'sending'; request.record.revision += 1;
    return structuredClone(request);
  });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.textContent).not.toContain('The retained task needs your choice');
  visible = true; f.view.eventCursor = 1;
  await act(async () => f.emit({ cursor: 1, subject: request.record.id, revision: 1, kind: 'mcp.interaction.opened', data: {} }));
  expect(container.textContent).toContain('The retained task needs your choice');
  expect(f.view.operations).toEqual([]); expect(f.view.activeRun).toBeNull();
  const form = container.querySelector<HTMLFormElement>('[aria-label="Respond to MCP request request:server"]')!;
  await submitForm(form);
  expect(f.api.respondMcpInteraction).toHaveBeenCalledWith({ ...identity, operationId: 'operation:accepted-task', interactionId: 'request:server', expectedRevision: 1,
    response: { action: 'accept', content: { enabled: false } } });
  expect(container.textContent).toContain('Your choice: accept · Response delivery started');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  const other = { ...identity, branchId: 'branch:other' };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={other} />));
  expect([...container.querySelectorAll('[aria-label="MCP request request:server"]')].filter(element => !element.closest('[inert]'))).toHaveLength(0);
  expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
});


it('keeps original RPC-error choices available after natural Run failure without invoking continuation or operation controls', async () => {
  const f = fixture(true);
  const failedRun = { ...f.view.activeRun!, state: 'failed' as const };
  const request: McpInteractionView = { record: { id: 'error:original', revision: 2, runId: failedRun.id,
    threadId: identity.threadId, branchId: identity.branchId, mode: 'url', availability: 'owner_unavailable', choice: null,
    delivery: null, completionReported: false, deliveryReleased: true, problem: null,
    binding: { operationId: 'operation:failed-call', executionOwner: { kind: 'external', identity: 'original-owner', epoch: 'epoch' },
      connectionId: 'original-connection', source: { kind: 'rpc_error', outgoingRequestId: 'rpc:original', method: 'tools/call', elicitationId: 'remote:url' },
      endpoint: { server: 'original-server', resourceKey: 'server-key', configurationVersion: 'configuration', credentialVersion: 'grant' } } },
    request: { code: -32042, message: 'Original error remains', data: { elicitations: [{ mode: 'url', message: 'Review the external step', url: 'https://accounts.example.test/step', elicitationId: 'remote:url' }] } },
    presentation: { mode: 'url', message: 'Review the external step', url: 'https://accounts.example.test/step', elicitationId: 'remote:url' }, response: null };
  f.api.listMcpInteractions = vi.fn(async () => ({ items: [{ record: structuredClone(request.record), presentation: request.presentation, response: request.response }], nextCursor: null }));
  f.api.respondMcpInteraction = vi.fn(async input => {
    request.response = input.response; request.record.choice = input.response.action; request.record.revision += 1;
    return structuredClone(request);
  });
  f.api.cancelOperation = vi.fn(); f.api.resume = vi.fn(); f.api.retryPreparation = vi.fn();
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  f.view.activeRun = null; f.view.thread.branches[0]!.active_run_id = null; f.view.thread.branches[0]!.latest_run = failedRun;
  f.view.eventCursor = 1;
  await act(async () => f.emit({ cursor: 1, subject: failedRun.id, revision: 2, kind: 'run.failed', data: {} }));
  expect(container.textContent).toContain('ended with error -32042');
  expect(button('Accept locally').disabled).toBe(false);
  await submitForm(container.querySelector('[aria-label="Record choice for MCP interaction error:original"]')!);
  expect(f.api.respondMcpInteraction).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:failed-call', interactionId: 'error:original', expectedRevision: 2, response: { action: 'accept' } });
  expect(container.textContent).toContain('Local choice: accept · No MCP response applies');
  expect(f.view.thread.branches[0]!.latest_run?.state).toBe('failed');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
  expect(f.api.cancelOperation).not.toHaveBeenCalled(); expect(f.api.resume).not.toHaveBeenCalled(); expect(f.api.retryPreparation).not.toHaveBeenCalled();
});

it('uses the actual Thread model and sampling lifecycle in the conversation, requiring separate output acceptance without a Run input', async () => {
  const f = fixture(true);
  f.view.activeRun!.configuration = { providerId: 'fixture-provider', model: 'fixture-model', thinkingLevel: 'off', modelOptions: { temperature: 0 } };
  const modelCatalog = [{ providerId: 'other-provider', modelId: 'other-model' }, { providerId: 'fixture-provider', modelId: 'fixture-model' }];
  f.api.listModels = vi.fn(async () => modelCatalog);
  f.view.modelSelection.desired = { id: 'selection:pending', run_id: 'ui-run', revision: 1, binding_id: 'binding:pending', status: 'ready', failure: null, credential_scope: null,
    configuration: { providerId: 'other-provider', providerFamily: 'openai', model: 'other-model', endpoint: 'https://model.example.test/v1',
      allowAnonymous: true, credentialEnvironment: null, configurationGeneration: 3, maxOutputTokens: 100 } };
  let request: McpInteractionView = { record: { id: 'sampling:original', revision: 1, runId: 'ui-run', threadId: identity.threadId, branchId: identity.branchId,
    mode: 'sampling', availability: 'live', choice: null, delivery: 'not_started', completionReported: false, deliveryReleased: true, problem: null,
    sampling: { generationOperationId: null, review: 'request' }, binding: { operationId: 'operation:original-tool',
      executionOwner: { kind: 'external', identity: 'original-owner', epoch: 'original-epoch' }, connectionId: 'original-connection',
      source: { kind: 'server_request', requestId: 9, relation: { kind: 'rpc_response_stream', outgoingRequestId: 3 } },
      endpoint: { server: 'Original sampling server', resourceKey: 'original-resource', configurationVersion: 'original-configuration', credentialVersion: 'original-credential' } } },
    presentation: { mode: 'sampling', message: 'Review isolated generation' }, response: null,
    request: { messages: [{ role: 'user', content: { type: 'text', text: 'Original private request body' } }], maxTokens: 80, modelPreferences: { hints: [{ name: 'other-model' }] } },
    sampling: { editedRequest: null, output: null, providerOutput: null, receipt: null, snapshot: null } };
  f.api.listMcpInteractions = vi.fn(async () => ({ items: [structuredClone({ record: request.record, presentation: request.presentation, response: request.response,
    ...(request.generation ? { generation: request.generation } : {}) })], nextCursor: null }));
  f.api.readMcpInteraction = vi.fn(async () => structuredClone(request));
  f.api.respondMcpInteraction = vi.fn();
  f.api.reviewMcpSamplingRequest = vi.fn(async input => {
    request = { ...request, record: { ...request.record, revision: 2, sampling: { generationOperationId: 'operation:sample', review: 'request' } },
      generation: { operationId: 'operation:sample', phase: 'running', outcome: null, cancelRequested: false, dispatch: 'started',
        model: { providerId: 'fixture-provider', providerFamily: 'openai', model: 'fixture-model', maxTokens: 80 },
        usage: { measurement: 'missing', inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null }, problem: null },
      sampling: { ...request.sampling!, editedRequest: input.editedRequest ?? null } };
    return structuredClone(request);
  });
  f.api.reviewMcpSamplingOutput = vi.fn(async input => {
    request = { ...request, record: { ...request.record, revision: 4, choice: input.action, delivery: 'sending', sampling: { generationOperationId: 'operation:sample', review: 'closed' } } };
    return structuredClone(request);
  });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(f.api.readMcpInteraction).not.toHaveBeenCalled(); expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Original private request body');
  await act(async () => button('Review sampling request').click());
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Sampling model"]')!.value).toBe(JSON.stringify(['fixture-provider', 'fixture-model']));
  expect(container.textContent).toContain('Selected model: fixture-provider / fixture-model · Thinking: off · Temperature: 0');
  await submitForm(container.querySelector('[aria-label="Review sampling generation"]')!);
  expect(f.api.reviewMcpSamplingRequest).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original-tool', interactionId: 'sampling:original', expectedRevision: 1,
    action: 'generate', model: { providerId: 'fixture-provider', modelId: 'fixture-model', thinkingLevel: 'off', temperature: 0 }, editedRequest: request.request });
  expect(container.textContent).toContain('Actual model: fixture-provider / fixture-model · maxTokens: 80');
  expect(container.textContent).toContain('Usage: missing'); expect(button('Stop generation')).toBeDefined();
  request = { ...request, record: { ...request.record, revision: 3, sampling: { generationOperationId: 'operation:sample', review: 'output' } },
    generation: { ...request.generation!, phase: 'terminal', outcome: 'succeeded', dispatch: 'completed' },
    sampling: { ...request.sampling!, output: { role: 'assistant', model: 'fixture-model', content: { type: 'text', text: 'Reviewed generated response' } } } };
  f.view.eventCursor = 1;
  await act(async () => f.emit({ cursor: 1, subject: request.record.id, revision: 3, kind: 'mcp.sampling', data: {} }));
  expect(container.textContent).toContain('terminal · succeeded'); expect(button('Stop generation')).toBeUndefined();
  expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled();
  await act(async () => button('Refresh sampling review').click());
  expect(container.textContent).toContain('Reviewed generated response');
  expect(container.textContent).toContain('Accepting sends this exact result to MCP server: Original sampling server.');
  await act(async () => button('Accept and send to server').click());
  expect(f.api.reviewMcpSamplingOutput).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original-tool', interactionId: 'sampling:original', expectedRevision: 3, action: 'accept' });
  expect(container.textContent).toContain('Response delivery started'); expect(container.textContent).not.toContain('Response transport confirmed');
  expect(f.api.respondMcpInteraction).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

it('projects a delegated rerank request independently of its cheap query, preserving unknown usage after Stop', async () => {
  const f = fixture(true);
  const source = { ...f.view.activeRun!, state: 'cancelled' as const, cancel_requested: true };
  f.view.activeRun = null;
  f.view.thread.branches[0]!.active_run_id = null;
  f.view.thread.branches[0]!.latest_run = source;
  const operation: ThreadSnapshot['operations'][number] = {
    id: 'inference:original-query:1', run_id: 'ui-run', epoch: 1, revision: 1, phase: 'running', outcome: null,
    effect: 'dispatched', cancel_requested: false, lifetime: 'run', handed_off: true,
    executor: 'inference.http.v1', execution_owner: { kind: 'external', identity: 'host.inference', epoch: 'original' },
    external_receipt: null, call_completion: null, waiting_on: null,
    intent: { kind: 'inference_request_v1', parentOperationId: 'original-query', binding: {
      purpose: 'code-retrieval-rerank', providerId: 'rank-provider', modelId: 'rank-model', requestKind: 'model_compute',
    } }, result: { kind: 'control', value: { dispatched: true, recovered: false } },
  };
  f.view.operations = [operation];
  const cancel = vi.fn<ThreadsAPI['cancelOperation']>(async id => {
    expect(id).toBe(operation.id);
    operation.cancel_requested = true;
    return operation;
  });
  f.api.cancelOperation = cancel;
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.textContent).toContain('code-retrieval-rerank');
  expect(container.textContent).toContain('Local executor stop unconfirmed');
  await act(async () => button('Stop inference request').click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith(operation.id);
  expect(container.textContent).toContain('Local executor stop unconfirmed');
  operation.phase = 'terminal'; operation.outcome = 'cancelled'; operation.effect = 'confirmed'; operation.revision++;
  operation.result = { kind: 'control', value: { dispatched: true, recovered: false, receipt: {
    requestStarted: true, providerCompleted: true, localExecutorStopped: true,
    usage: { measurement: 'missing', inputTokens: null, outputTokens: null }, httpStatus: 200, problem: null,
  } } };
  await act(async () => f.emit({ cursor: 1, subject: operation.id, revision: operation.revision, kind: 'inference.settled', data: {} }));
  expect(container.textContent).toContain('Local executor stopped');
  expect(container.textContent).toContain('Input tokens: unknown');
  expect(container.textContent).toContain('Output tokens: unknown');
  expect(container.textContent).toContain('does not establish input/output token usage or cost');
});


it('keeps sleeping Bot history readable without composer or execution mutations', async () => {
  const f = fixture(true);
  f.view.history = [{ id: 'saved', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'user', content: { text: 'Retained Bot history' }, provider: null }];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} readOnly />));
  expect(container.textContent).toContain('Retained Bot history');
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[aria-label="Message thread"]')).toBeNull();
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Stop run')).toBe(false);
  expect(f.submit).not.toHaveBeenCalled(); expect(f.cancelRun).not.toHaveBeenCalled();
});


it('uses the Host-resolved Bot default for its first native message without choosing a catalog fallback', async () => {
  const f = fixture(false);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} preferredModel={{ providerId: 'fixture-provider', modelId: 'fixture-model' }} />));
  expect(f.submit).not.toHaveBeenCalled();
  await edit('[aria-label="Message thread"]', 'Start Bot work');
  await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ ...identity, text: 'Start Bot work', model: { providerId: 'fixture-provider', modelId: 'fixture-model', thinkingLevel: 'off' } }));
});

it('applies a changed Bot model to the next draft after a cancelled Run and preserves later draft choices', async () => {
  const f = fixture(true);
  await f.cancelRun();
  f.api.listModels = async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model' }, { providerId: 'replacement-provider', modelId: 'replacement-model' }];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} preferredModel={{ providerId: 'fixture-provider', modelId: 'fixture-model' }} />));
  const renderChangedProfile = () => root.render(<ThreadConversation api={f.api} identity={identity} preferredModel={{ providerId: 'replacement-provider', modelId: 'replacement-model' }} />);
  await act(async () => renderChangedProfile());
  await edit('[aria-label="Message thread"]', 'Use the changed Bot model');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenLastCalledWith(expect.objectContaining({ model: { providerId: 'replacement-provider', modelId: 'replacement-model', thinkingLevel: 'off' } }));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await act(async () => renderChangedProfile());
  await edit('[aria-label="Message thread"]', 'Use my later draft selection');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenLastCalledWith(expect.objectContaining({ model: { providerId: 'fixture-provider', modelId: 'fixture-model', thinkingLevel: 'off' } }));
});

function navigationFixture() {
  const f = fixture();
  const user = { id: 'restore-user', thread_id: identity.threadId, run_id: 'finished-run', parent: 'retained-assistant', source: 'user' as const, provider: null, content: { text: 'Original user instruction', attachments: [storedImage] } };
  const assistant = { ...user, id: 'retained-assistant', parent: null, source: 'assistant' as const, content: { id: 'retained-assistant', content: { kind: 'text', text: 'Retained assistant answer' } } };
  f.view.history = [assistant, user]; f.view.historyPage.head = user.id; f.view.thread.branches[0]!.head = user.id;
  const prepareNavigation = vi.fn<ThreadsAPI['prepareNavigation']>(async input => ({ expectedHeadId: user.id, targetHeadId: assistant.id, removedEntryIds: [user.id],
    ...(input.entryId === user.id ? { editorText: user.content.text, editorImages: [{ data: imageData, mimeType: 'image/png' }] } : {}) }));
  const navigate = vi.fn<ThreadsAPI['navigate']>(async input => {
    f.view.history = input.targetHeadId === user.id ? [assistant, user] : [assistant];
    f.view.historyPage.head = input.targetHeadId; f.view.thread.branches[0]!.head = input.targetHeadId;
    return { threadId: input.threadId, branchId: input.branchId, previousHeadId: input.expectedHeadId, headId: input.targetHeadId, key: input.key, alreadyApplied: false };
  });
  const navigationReceipt = vi.fn<ThreadsAPI['navigationReceipt']>(async () => null);
  const recoverySource = vi.fn<ThreadsAPI['recoverySource']>(async () => ({ resourceOwner: { kind: 'local' }, workspaceId: 'actual-source-owner', mode: 'materialized', runId: 'finished-run' }));
  const fork = vi.fn<ThreadsAPI['fork']>(async () => identity);
  Object.assign(f.api, { prepareNavigation, navigate, navigationReceipt, recoverySource, fork });
  return { ...f, user, assistant, prepareNavigation, navigate, navigationReceipt, recoverySource, fork };
}

function combinedFixture(f: ReturnType<typeof navigationFixture>, patch: Partial<WorkspaceCombinedRecoveryPlan> = {}) {
  const plan: WorkspaceCombinedRecoveryPlan = { id: 'original-recovery', revision: 'original-revision', workspaceId: 'actual-source-owner',
    conversation: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId }, entryId: f.user.id,
    expectedLeafId: f.user.id, targetLeafId: f.assistant.id, removedEntryIds: [f.user.id], affectedPaths: ['result.txt'], changedBytes: 4,
    conflicts: [], coverage: 'ready', uncoveredPaths: [], uncoveredReasons: [], createdAt: '2026-10-12T00:00:00Z', ...patch };
  const operation: WorkspaceCombinedRecoveryOperation = { id: plan.id, revision: plan.revision, workspaceId: plan.workspaceId, conversation: plan.conversation,
    entryId: plan.entryId, expectedLeafId: plan.expectedLeafId, targetLeafId: plan.targetLeafId, state: 'complete', fileState: 'restored', conversationState: 'navigated',
    affectedPathCount: 1, appliedPathCount: 1, createdAt: plan.createdAt, updatedAt: plan.createdAt, editorText: f.user.content.text, editorImages: [] };
  const prepareCombinedRecovery = vi.fn<WorkspaceRecoveryAPI['prepareCombinedRecovery']>(async () => ({ status: 'ready', plan }));
  const applyCombinedRecovery = vi.fn<WorkspaceRecoveryAPI['applyCombinedRecovery']>(async input => {
    f.view.history = [f.assistant]; f.view.historyPage.head = plan.targetLeafId; f.view.thread.branches[0]!.head = plan.targetLeafId;
    return { status: 'ready', operation: { ...operation, id: input.operationId } };
  });
  const getCombinedOperation = vi.fn<WorkspaceRecoveryAPI['getCombinedOperation']>(async () => ({ status: 'ready', operation }));
  const cancelCombinedOperation = vi.fn<WorkspaceRecoveryAPI['cancelCombinedOperation']>(async () => ({ status: 'ready', operation: { ...operation, state: 'aborted', fileState: 'unchanged', conversationState: 'unchanged' } }));
  const prepareCombinedUndo = vi.fn<WorkspaceRecoveryAPI['prepareCombinedUndo']>(async () => ({ status: 'ready', plan: { ...plan, id: 'undo-recovery', undoOf: plan.id } }));
  recoveryService.api = { prepareCombinedRecovery, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation, prepareCombinedUndo } as unknown as WorkspaceRecoveryAPI;
  return { plan, operation, prepareCombinedRecovery, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation, prepareCombinedUndo };
}

it('thread recovery restores the owner-selected head and original image draft, then undoes the same branch without running work', async () => {
  const f = navigationFixture();
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} onBranchCreated={vi.fn()} />));
  await edit('[aria-label="Message thread"]', 'Current draft');
  await act(async () => button('Restore before this message').click());
  expect(f.prepareNavigation).toHaveBeenCalledWith({ ...identity, entryId: f.user.id });
  expect(f.navigate).toHaveBeenCalledWith({ ...identity, key: expect.any(String), expectedHeadId: f.user.id, targetHeadId: f.assistant.id });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Original user instruction');
  expect(container.querySelector('img')).not.toBeNull();
  expect(container.querySelectorAll('article')).toHaveLength(1);
  const original = f.navigate.mock.calls[0]![0];
  await act(async () => button('Undo conversation recovery').click());
  expect(f.navigate.mock.calls[1]![0]).toMatchObject({ ...identity, expectedHeadId: f.assistant.id, targetHeadId: f.user.id, undoOf: original.key });
  expect(f.navigate.mock.calls[1]![0].key).not.toBe(original.key);
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.fork).not.toHaveBeenCalled(); expect(f.api.goals.start).not.toHaveBeenCalled();
});

it('thread recovery retains assistant content and current draft while respecting the owner-selected boundary', async () => {
  const f = navigationFixture();
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Message thread"]', 'Keep this draft');
  await act(async () => button('Open conversation history').click());
  const assistant = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(value => value.textContent?.includes('Retained assistant answer'))!;
  await act(async () => assistant.dispatchEvent(new window.Event('dblclick', { bubbles: true })));
  expect(f.prepareNavigation).toHaveBeenCalledWith({ ...identity, entryId: f.assistant.id });
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.textContent).toContain('Retained assistant answer');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Keep this draft');
});

it('thread recovery freezes an uncertain navigation and retries the original key and head after reading its receipt', async () => {
  const f = navigationFixture(); f.navigate.mockRejectedValueOnce(new Error('Response lost'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Message thread"]', 'Unsaved current draft');
  await act(async () => button('Restore before this message').click());
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Unsaved current draft');
  expect(button('Send').disabled).toBe(true);
  await act(async () => button('Retry conversation recovery').click());
  expect(f.prepareNavigation).toHaveBeenCalledOnce(); expect(f.navigate).toHaveBeenCalledTimes(2);
  expect(f.navigate.mock.calls[1]![0]).toEqual(f.navigate.mock.calls[0]![0]);
  expect(f.navigationReceipt).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll('article')).toHaveLength(1);
});

it('thread recovery reads an applied receipt after a lost response without sending navigation again', async () => {
  const f = navigationFixture(); const originalNavigate = f.navigate.getMockImplementation()!;
  f.navigate.mockImplementationOnce(async input => {
    const receipt = await originalNavigate(input);
    f.navigationReceipt.mockResolvedValue({ ...receipt, alreadyApplied: true });
    throw new Error('Reply lost after commit');
  });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(f.navigate).toHaveBeenCalledOnce(); expect(f.navigationReceipt).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Original user instruction');
});

it.each(['thread', 'host'] as const)('thread recovery cannot submit a late prepared selection after switching %s', async changed => {
  const f = navigationFixture(); let resolve!: (selection: Awaited<ReturnType<ThreadsAPI['prepareNavigation']>>) => void;
  f.prepareNavigation.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  const next = { ...identity, threadId: changed === 'thread' ? 'another-thread' : identity.threadId };
  if (changed === 'host') { endpoint.generation += 1; await act(async () => endpoint.listeners.forEach(listener => listener())); }
  else await act(async () => root.render(<ThreadConversation api={f.api} identity={next} />));
  await act(async () => resolve({ expectedHeadId: f.user.id, targetHeadId: f.assistant.id, removedEntryIds: [f.user.id], editorText: 'Old conversation' }));
  expect(f.navigate).not.toHaveBeenCalled(); expect(f.recoverySource).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).not.toBe('Old conversation');
});

it.each(['local', 'managed_host'] as const)('thread recovery uses the actual %s materialized source owner for combined restore and operation-based undo', async kind => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  if (kind === 'managed_host') f.recoverySource.mockResolvedValue({ resourceOwner: { kind, hostId: 'resource-host', connectionId: 'paired-resource', endpointIdentity: 'https://resource-host.test' }, workspaceId: 'actual-source-owner', mode: 'materialized', runId: 'finished-run' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/unrelated-sidebar" />));
  await act(async () => button('Restore before this message').click());
  expect(recovery.prepareCombinedRecovery).toHaveBeenCalledWith({ workspaceId: 'actual-source-owner', conversation: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId }, entryId: f.user.id });
  expect(recovery.applyCombinedRecovery).toHaveBeenCalledWith({ operationId: recovery.plan.id, expectedRevision: recovery.plan.revision, conflictPolicy: 'abort', confirmedConflicts: [] });
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(f.navigate).not.toHaveBeenCalled();
  expect(container.querySelectorAll('article')).toHaveLength(1);
  await act(async () => button('Undo conversation and file recovery').click());
  expect(recovery.prepareCombinedUndo).toHaveBeenCalledWith('original-recovery');
  expect(recovery.applyCombinedRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'undo-recovery' }));
});

it('thread recovery keeps fixed-branch sources conversation-only even when combined recovery is preferred', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  f.recoverySource.mockResolvedValue({ resourceOwner: { kind: 'local' }, workspaceId: 'read-only-source', mode: 'fixed_branch', runId: 'finished-run' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(f.navigate).toHaveBeenCalledOnce(); expect(recovery.prepareCombinedRecovery).not.toHaveBeenCalled();
});

it('thread recovery observes the original combined operation after uncertain file and history commits', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  recovery.applyCombinedRecovery.mockRejectedValueOnce(new Error('Connection lost'));
  recovery.getCombinedOperation.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('');
  f.view.history = [f.assistant]; f.view.historyPage.head = f.assistant.id;
  await act(async () => button('Check recovery status').click());
  expect(recovery.getCombinedOperation).toHaveBeenLastCalledWith('original-recovery');
  expect(recovery.prepareCombinedRecovery).toHaveBeenCalledOnce(); expect(recovery.applyCombinedRecovery).toHaveBeenCalledOnce();
  expect(f.navigate).not.toHaveBeenCalled(); expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Original user instruction');
});

it('thread recovery previews the exact dirty buffer and cancels the unused file plan before conversation-only navigation', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f, { conflicts: [{ kind: 'dirty-buffer', path: 'result.txt', message: 'Unsaved editor', fingerprint: 'dirty-revision' }] });
  useUIStore.setState({ recoveryPreference: 'both' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(container.textContent).toContain('result.txt: Unsaved editor');
  expect(container.textContent).toContain('They are preserved for undo');
  const combined = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.both.label'))!;
  expect(combined.disabled).toBe(false);
  expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled();
  const conversation = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.conversation.label'))!;
  await act(async () => conversation.click());
  expect(recovery.cancelCombinedOperation).toHaveBeenCalledWith('original-recovery');
  expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled(); expect(f.navigate).toHaveBeenCalledOnce();
  expect(recovery.cancelCombinedOperation.mock.invocationCallOrder[0]).toBeLessThan(f.navigate.mock.invocationCallOrder[0]!);
});

it('thread recovery retains its key when a kernel disconnect is returned as HTTP 400 and receipt observation is unavailable', async () => {
  const f = navigationFixture();
  f.navigate.mockRejectedValueOnce(new ThreadRequestError(400, 'kernel-response-discarded'));
  f.navigationReceipt.mockRejectedValueOnce(new Error('Kernel unavailable'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(button('Retry conversation recovery')).toBeDefined();
  expect(button('Send').disabled).toBe(true);
  await act(async () => button('Retry conversation recovery').click());
  expect(f.navigate.mock.calls[1]![0]).toEqual(f.navigate.mock.calls[0]![0]);
  expect(f.prepareNavigation).toHaveBeenCalledOnce();
});

it('thread recovery preserves incomplete combined operation facts without moving the displayed history', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  recovery.applyCombinedRecovery.mockResolvedValueOnce({ status: 'ready', operation: { ...recovery.operation, state: 'needs-attention', fileState: 'needs-attention', conversationState: 'unchanged', appliedPathCount: 1 } });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(container.textContent).toContain('needs-attention');
  expect(container.textContent).toContain('conversation: unchanged');
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(f.navigate).not.toHaveBeenCalled(); expect(button('Check recovery status')).toBeDefined();
});

it('thread recovery freezes a confirmed conflict acknowledgement and observes that operation after the modal is dismissed', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f, { coverage: 'partial', uncoveredPaths: [{ path: 'shell.txt', source: 'shell' }],
    conflicts: [{ kind: 'content-changed', path: 'result.txt', message: 'External edit', fingerprint: 'external-revision' }] });
  useUIStore.setState({ recoveryPreference: 'both' });
  recovery.applyCombinedRecovery.mockRejectedValueOnce(new Error('Reply lost'));
  recovery.getCombinedOperation.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(container.textContent).toContain('shell.txt');
  const apply = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.both.label'))!;
  await act(async () => apply.click());
  expect(recovery.applyCombinedRecovery).toHaveBeenCalledWith({ operationId: recovery.plan.id, expectedRevision: recovery.plan.revision, conflictPolicy: 'overwrite-confirmed', confirmedConflicts: [{ path: 'result.txt', fingerprint: 'external-revision' }] });
  const conversation = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.conversation.label'))!;
  expect(conversation.disabled).toBe(true);
  await act(async () => button('sessions.sidebar.dialogs.cancel').click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  recovery.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: { ...recovery.operation, state: 'planned', conversationState: 'unchanged', fileState: 'unchanged' } });
  await act(async () => button('Check recovery status').click());
  expect(recovery.prepareCombinedRecovery).toHaveBeenCalledOnce();
  expect(recovery.applyCombinedRecovery.mock.calls[1]![0]).toEqual(recovery.applyCombinedRecovery.mock.calls[0]![0]);
});

it('thread recovery refuses conversation-only navigation when cancellation of its prepared file operation is unconfirmed', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'ask' });
  recovery.cancelCombinedOperation.mockRejectedValueOnce(new Error('Cancellation unconfirmed'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  const conversation = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.conversation.label'))!;
  await act(async () => conversation.click());
  expect(f.navigate).not.toHaveBeenCalled(); expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Cancellation unconfirmed');
});

it('thread recovery keeps an uncertain conversation-only choice after its file dialog has closed', async () => {
  const f = navigationFixture(); combinedFixture(f); useUIStore.setState({ recoveryPreference: 'ask' });
  f.navigate.mockRejectedValueOnce(new Error('Navigation response lost'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  const conversation = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.conversation.label'))!;
  await act(async () => conversation.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(button('Retry conversation recovery')).toBeDefined(); expect(button('Send').disabled).toBe(true);
  await act(async () => button('Retry conversation recovery').click());
  expect(f.navigate.mock.calls[1]![0]).toEqual(f.navigate.mock.calls[0]![0]);
});

it('thread recovery runs one combined action for repeated modal clicks and survives strict effect replay', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'ask' });
  let resolve!: (result: Awaited<ReturnType<WorkspaceRecoveryAPI['applyCombinedRecovery']>>) => void;
  recovery.applyCombinedRecovery.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<React.StrictMode><ThreadConversation api={f.api} identity={identity} /></React.StrictMode>));
  await act(async () => button('Restore before this message').click());
  expect(recovery.cancelCombinedOperation).not.toHaveBeenCalled();
  const apply = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('settings.varin.recovery.preference.both.label'))!;
  await act(async () => { apply.click(); apply.click(); });
  expect(recovery.applyCombinedRecovery).toHaveBeenCalledOnce();
  await act(async () => resolve({ status: 'ready', operation: recovery.operation }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('thread recovery does not publish a late committed navigation into another conversation draft', async () => {
  const f = navigationFixture(); let resolve!: (receipt: Awaited<ReturnType<ThreadsAPI['navigate']>>) => void;
  f.navigate.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  const request = f.navigate.mock.calls[0]![0];
  await act(async () => root.render(<ThreadConversation api={f.api} identity={{ ...identity, threadId: 'new-conversation' }} />));
  await edit('[aria-label="Message thread"]', 'New conversation draft');
  await act(async () => resolve({ threadId: request.threadId, branchId: request.branchId, key: request.key, previousHeadId: request.expectedHeadId, headId: request.targetHeadId, alreadyApplied: false }));
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('New conversation draft');
  expect(container.textContent).not.toContain('Conversation restored.');
});

it('thread recovery never sends an old operation readback to a newly selected Host', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  let reject!: (error: Error) => void;
  recovery.applyCombinedRecovery.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  endpoint.generation += 1; await act(async () => endpoint.listeners.forEach(listener => listener()));
  await edit('[aria-label="Message thread"]', 'New Host draft');
  await act(async () => reject(new Error('Old Host disconnected')));
  expect(recovery.getCombinedOperation).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('New Host draft');
  expect(container.textContent).not.toContain('Old Host disconnected');
});

it('thread recovery resumes a stopped nonterminal combined operation using its original revision and acknowledgement', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  const interrupted = { ...recovery.operation, state: 'navigating-conversation' as const, conversationState: 'unchanged' as const };
  recovery.applyCombinedRecovery.mockResolvedValueOnce({ status: 'ready', operation: interrupted });
  recovery.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: interrupted });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(container.querySelectorAll('article')).toHaveLength(2);
  await act(async () => button('Check recovery status').click());
  expect(recovery.prepareCombinedRecovery).toHaveBeenCalledOnce();
  expect(recovery.applyCombinedRecovery.mock.calls[1]![0]).toEqual(recovery.applyCombinedRecovery.mock.calls[0]![0]);
  expect(f.navigate).not.toHaveBeenCalled(); expect(container.querySelectorAll('article')).toHaveLength(1);
});

it.each([false, true])('thread recovery rebuilds independent navigation Undo after reopening with combined recovery unavailable=%s', async combinedUnavailable => {
  const f = navigationFixture();
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  const receipt = await f.navigate.mock.results[0]!.value;
  f.view.recovery = { navigation: receipt, operations: [], ...(combinedUnavailable ? { combinedUnavailable: 'Managed file recovery is unavailable. Conversation navigation remains available.' } : {}) };
  await act(async () => { root.unmount(); }); root = createRoot(container);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Original user instruction');
  expect(f.navigate).toHaveBeenCalledOnce();
  await edit('[aria-label="Message thread"]', 'Fresh draft after reopening');
  await act(async () => button('Undo conversation recovery').click());
  expect(f.navigate.mock.calls[1]![0]).toMatchObject({ undoOf: receipt.key, expectedHeadId: receipt.headId, targetHeadId: receipt.previousHeadId });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Fresh draft after reopening');
});

it('thread recovery reopens combined recovery through its original operation and never offers a conversation-only undo for it', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  f.view.recovery = { navigation: null, operations: [recovery.operation] };
  await act(async () => { root.unmount(); }); root = createRoot(container);
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(button('Undo conversation recovery')).toBeUndefined();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Original user instruction');
  await act(async () => button('Undo saved conversation and file recovery').click());
  expect(recovery.prepareCombinedUndo).toHaveBeenCalledWith(recovery.operation.id);
  expect(f.navigate).not.toHaveBeenCalled();
});

it('thread recovery rediscovers and reconciles an interrupted combined operation after reopening without replaying the old user draft', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f);
  const interrupted = { ...recovery.operation, state: 'files-restored' as const, conversationState: 'unchanged' as const };
  f.view.recovery = { navigation: null, operations: [interrupted] };
  recovery.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: interrupted });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Message thread"]', 'New draft while reviewing recovery');
  expect(button('Send').disabled).toBe(true);
  expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled();
  await act(async () => button('Resume saved recovery').click());
  expect(recovery.applyCombinedRecovery).toHaveBeenCalledWith({ operationId: interrupted.id, expectedRevision: interrupted.revision, conflictPolicy: 'abort', confirmedConflicts: [] });
  expect(recovery.prepareCombinedRecovery).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('New draft while reviewing recovery');
});

it('thread recovery never applies a rediscovered inert file plan without its conflict review', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f);
  const planned = { ...recovery.operation, state: 'planned' as const, conversationState: 'unchanged' as const, fileState: 'unchanged' as const };
  f.view.recovery = { navigation: null, operations: [planned] };
  recovery.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: planned });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Check saved recovery').click());
  expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
  expect(container.textContent).toContain('This plan has not been applied.');
  await act(async () => button('Cancel saved recovery').click());
  expect(recovery.cancelCombinedOperation).toHaveBeenCalledWith(planned.id);
});

it('thread recovery offers an explicit conversation-only choice when file preparation is unavailable', async () => {
  const f = navigationFixture(); useUIStore.setState({ recoveryPreference: 'both' });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(f.navigate).not.toHaveBeenCalled(); expect(container.textContent).toContain('Recovery unavailable');
  await act(async () => button('Restore conversation only').click());
  expect(f.navigate).toHaveBeenCalledOnce(); expect(f.prepareNavigation).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('article')).toHaveLength(1);
});


it('keeps an unavailable managed file owner explicit and preserves conversation-only navigation', async () => {
  const f = navigationFixture(); const recovery = combinedFixture(f); useUIStore.setState({ recoveryPreference: 'both' });
  f.recoverySource.mockResolvedValue({ resourceOwner: { kind: 'managed_host', hostId: 'host-b', connectionId: 'b', endpointIdentity: 'sha256-b' },
    workspaceId: 'same-path-on-b', mode: 'materialized', runId: 'finished-run' });
  recovery.prepareCombinedRecovery.mockRejectedValueOnce(new Error('Original file Host is offline'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Restore before this message').click());
  expect(recovery.prepareCombinedRecovery).toHaveBeenCalledWith({ workspaceId: 'same-path-on-b', conversation: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId }, entryId: f.user.id }); expect(f.navigate).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Original file Host is offline');
  const conversation = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Restore conversation only'));
  expect(conversation).toBeDefined();
  await act(async () => conversation!.click());
  expect(f.navigate).toHaveBeenCalledOnce(); expect(recovery.prepareCombinedRecovery).toHaveBeenCalledOnce(); expect(recovery.applyCombinedRecovery).not.toHaveBeenCalled();
});


it.each([[413, 'http-body-too-large'], [400, 'model-images-unsupported']] as const)('allows corrected images and model after explicit pre-admission rejection %s', async (status, code) => {
  const f = fixture();
  f.api.listModels = async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model' }, { providerId: 'fixture-provider', modelId: 'replacement' }];
  f.submit.mockRejectedValueOnce(new ThreadRequestError(status, code, 'not_started'));
  const key = threadIdentityKey(threadHostKey(), identity);
  useThreadDraftStore.getState().patch(key, { text: 'Original', images: [{ mimeType: 'image/png', data: imageData }], model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await submitForm(container.querySelector('form')!);
  expect(useThreadDraftStore.getState().drafts[key].pendingInput).toBeUndefined();
  await act(async () => container.querySelector<HTMLButtonElement>('form button[aria-label="chat.fileAttachment.actions.removeImage"]')!.click());
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'replacement']), 'change');
  await edit('[aria-label="Message thread"]', 'Corrected');
  await submitForm(container.querySelector('form')!);
  const [original, corrected] = f.submit.mock.calls.map(call => call[0]);
  expect(corrected.key).not.toBe(original.key);
  expect(corrected).toMatchObject({ text: 'Corrected', images: [], model: { modelId: 'replacement' } });
});

it('keeps an uncertain queued input through an unrelated 409 and a later pre-admission rejection', async () => {
  const f = fixture(true);
  f.enqueue.mockRejectedValueOnce(new Error('reply lost')).mockRejectedValueOnce(new ThreadRequestError(400, 'model-images-unsupported', 'not_started'));
  f.cancelRun.mockRejectedValueOnce(new ThreadRequestError(409, 'thread-conflict'));
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await edit('[aria-label="Message thread"]', 'Original queue');
  await submitForm(container.querySelector('form')!);
  await act(async () => button('Stop run').click());
  await edit('[aria-label="Message thread"]', 'Newer draft');
  await submitForm(container.querySelector('form')!);
  expect(button('Retry delivery')).toBeDefined();
  await submitForm(container.querySelector('form')!);
  expect(f.enqueue.mock.calls[1]).toEqual(f.enqueue.mock.calls[0]);
  expect(f.enqueue.mock.calls[2]).toEqual(f.enqueue.mock.calls[0]);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')?.value).toBe('Newer draft');
});

it('localizes known terminal failures, preserves unknown owner messages, and distinguishes cancellation from a requested stop', async () => {
  translations.dictionary = zhCN;
  const f = fixture(true);
  const run = f.view.activeRun!;
  run.state = 'failed';
  f.view.activeRun = null;
  f.view.thread.branches[0]!.active_run_id = null;
  f.view.thread.branches[0]!.latest_run = run;
  f.view.runFailure = { runId: run.id, cursor: 7, code: 'context_candidate_capacity', message: 'The context summary does not fit. The original history remains unchanged.' };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  expect(container.querySelector('[aria-label="Run failed"]')?.textContent).toContain('上下文摘要和保留的历史超出模型的上下文预算。原始历史未改变。');
  expect(container.querySelector('[aria-label="Run failed"]')?.textContent).not.toContain(f.view.runFailure.message);
  expect(container.querySelector('[aria-label="Run cancelled"]')).toBeNull();
  f.view.runFailure = { ...f.view.runFailure, code: 'future_owner_failure', message: 'Safe failure from a newer owner.' };
  await act(async () => f.emit({ cursor: 8, subject: run.id, revision: 2, kind: 'run.changed', data: {} }));
  expect(container.querySelector('[aria-label="Run failed"]')?.textContent).toContain('Safe failure from a newer owner.');
  f.view.runFailure = { ...f.view.runFailure, runId: 'another-run', message: 'Another Run failure' };
  await act(async () => f.emit({ cursor: 9, subject: run.id, revision: 3, kind: 'run.changed', data: {} }));
  expect(container.querySelector('[aria-label="Run failed"]')?.textContent).toBe('失败');
  run.state = 'generating'; run.cancel_requested = true;
  f.view.activeRun = run;
  f.view.thread.branches[0]!.active_run_id = run.id;
  await act(async () => f.emit({ cursor: 10, subject: run.id, revision: 4, kind: 'run.changed', data: {} }));
  expect(container.querySelector('[aria-label="Run failed"]')).toBeNull();
  expect(container.querySelector('[aria-label="Run cancelled"]')).toBeNull();
  run.state = 'cancelled'; f.view.activeRun = null;
  f.view.thread.branches[0]!.active_run_id = null;
  await act(async () => f.emit({ cursor: 11, subject: run.id, revision: 5, kind: 'run.changed', data: {} }));
  expect(container.querySelector('[aria-label="Run cancelled"]')?.textContent).toBe('已取消');
  expect(container.querySelector('[aria-label="Run failed"]')).toBeNull();
  expect(f.cancelRun).not.toHaveBeenCalled();
});
