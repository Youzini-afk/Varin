import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import type { ContextCheckpoint, ThreadIdentity, ThreadSnapshot, ThreadSubmit, ThreadsAPI } from '@varin/application-client';
import { ThreadConversation } from './ThreadConversation';
import { AgentWorkspaceShell } from '@/workbenches/agent/AgentWorkspaceShell';

const runtimeState = vi.hoisted(() => ({ api: undefined as ThreadsAPI | undefined }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: runtimeState.api }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (selector: (state: { currentDirectory: string }) => unknown) => selector({ currentDirectory: '/workspace/project' }) }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: { subscribe: () => () => {} } }));
vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: ({ renderConversation }: { renderConversation: (active: boolean) => React.ReactNode }) => <div>{renderConversation(true)}</div> }));
vi.mock('@/components/views/RegularChatView', () => ({ RegularChatView: () => <div data-testid="existing-conversations" /> }));
vi.mock('@/apps/mobileWorkspaceShell', () => ({ MobileWorkspaceShell: () => null }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:ui-fixture', branchId: 'branch:ui-fixture' };
function initialSnapshot(active = false): ThreadSnapshot {
  const run = { id: 'ui-run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: { providerId: 'fixture-provider', model: 'fixture-model' }, cancel_requested: false, waiting_on: null };
  return { identity, eventCursor: 0, thread: { thread_id: identity.threadId, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: active ? run.id : null, latest_run: active ? run : null }] }, activeRun: active ? run : null,
    history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], launch: null, modelSelection: {desired:null,active:null}, policySelection: null, context: { checkpoint: null, jobs: [] } };
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
  const api: ThreadsAPI = { resources: { refresh: unused }, followups: { register: unused, list: unused, control: unused }, listModels: async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model' }], list: async () => [view.thread], create: async () => identity,
    snapshot: async () => structuredClone(view), submit, enqueue, editInput, cancelInput, cancelRun,
    inspectTools: unused, inspectPolicy: unused, restartPolicy: unused, cancelPolicyUpdate: unused, selectModel: unused, decidePermission: unused, answerQuestion: unused, prepareSource: unused, fork: unused, compact: unused, publishContext: unused, cancelContext: unused, resumeContext: unused, historyPage: unused, run: unused, operation: unused, cancelOperation: unused, resume: unused, retryPreparation: unused, events: async () => [],
    observe: async (_cursor, onEvent, { signal }) => new Promise<void>(resolve => { listener = onEvent; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }),
  };
  return { api, view, submit, enqueue, editInput, cancelInput, cancelRun, emit: (event: Parameters<ThreadsAPI['observe']>[1] extends (value: infer T) => void ? T : never) => listener?.(event) };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  runtimeState.api = undefined;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('FileReader', class {
    result: string | null = null; error: Error | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    readAsDataURL(file: File) {
      void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }, error => { this.error = error; this.onerror?.(); });
    }
  });
  vi.stubGlobal('FormData', class { constructor(private form: HTMLFormElement) {} get(name: string) { return this.form.querySelector<HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? null; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const edit = async (selector: string, value: string, event = 'input') => {
  const element = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event(event, { bubbles: true })); });
};
const submitForm = async (form: HTMLFormElement) => { await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;

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
  expect(container.textContent).toContain('Applies to the next model request');
  expect(f.view.activeRun?.configuration).toMatchObject({model:'fixture-model'});
  f.view.activeRun!.configuration = f.view.modelSelection.desired!.configuration;
  f.view.modelSelection.desired!.status = 'active';
  f.view.modelSelection.active = f.view.modelSelection.desired;
  await act(async()=>f.emit({cursor:1,subject:'ui-run',revision:2,kind:'run.model_activated',data:{}}));
  expect(selector.value).toBe(JSON.stringify(['replacement-provider','replacement-model']));
  expect(container.textContent).not.toContain('Applies to the next model request');
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
});

it('active-thread controls queue the chosen mode, save/cancel queued text, and stop the selected Run', async () => {
  const f = fixture(true);
  f.view.inputs.push({ id: 'queued-existing', thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', mode: 'boundary', state: 'queued', revision: 3, content: { text: 'original queued text' }, cursor: 1 });
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Input delivery"]', 'interrupt', 'change');
  await edit('[aria-label="Message thread"]', 'new queued instructions');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!);
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ...identity, mode: 'interrupt', text: 'new queued instructions' }));
  await edit('[aria-label="Edit queued input"]', 'edited queued text');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit queued input"]')!.closest('form')!);
  expect(f.editInput).toHaveBeenCalledWith('queued-existing', 3, 'edited queued text');
  await act(async () => { button('Cancel queued input').click(); });
  expect(f.cancelInput).toHaveBeenCalledWith('queued-existing', 4);
  expect(container.querySelector('[aria-label="Edit queued input"]')).toBeNull();
  await act(async () => { button('Stop run').click(); });
  expect(f.cancelRun).toHaveBeenCalledWith('ui-run');
  expect(container.textContent).toContain('cancelled');
  expect(button('Stop run')).toBeUndefined();
});

it('registers one process follow-up through an uncertain reply and controls only its current definition', async () => {
  const f = fixture(true);
  f.view.operations = [{ id: 'process:original', run_id: 'ui-run', epoch: 1, revision: 1,
    phase: 'running', outcome: null, effect: 'dispatched', cancel_requested: false,
    lifetime: 'environment', handed_off: true, executor: 'process_spawn', waiting_on: null,
    intent: {}, result: null, external_receipt: null, call_completion: {
      kind: 'job_accepted', operation_id: 'process:original', phase: 'running', effect: 'dispatched', lifetime: 'environment',
    }, execution_owner: null }];
  const followup: ThreadSnapshot['followups'][number] = { id: 'followup:one', revision: 1, generation: 1,
    thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'ui-run', operation_id: 'process:original', state: 'active',
    wait: { id: 'wait:process', kind: 'process_stopped', after_cursor: 1, trigger_cursor: null, state: 'waiting' }, occurrence: null };
  const register = vi.fn<ThreadsAPI['followups']['register']>().mockRejectedValueOnce(new Error('uncertain follow-up reply'))
    .mockImplementation(async () => { f.view.followups = [followup]; return followup; });
  const control = vi.fn<ThreadsAPI['followups']['control']>(async input => {
    expect(input.expectedRevision).toBe(followup.revision);
    followup.revision += 1;
    followup.state = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'cancelled';
    return structuredClone(followup);
  });
  const resumeRun = vi.fn(f.api.resume); f.api.resume = resumeRun;
  f.api.followups = { register, control, list: async () => f.view.followups };
  await act(async () => root.render(<ThreadConversation api={f.api} identity={identity} />));
  await act(async () => button('Continue once when process ends').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('uncertain follow-up reply');
  await act(async () => button('Continue once when process ends').click());
  expect(register.mock.calls[1]![0]).toEqual(register.mock.calls[0]![0]);
  expect(register.mock.calls[0]![0]).toMatchObject({ ...identity, runId: 'ui-run', operationId: 'process:original' });
  expect(button('Continue once when process ends')).toBeUndefined();
  await act(async () => button('Pause follow-up').click());
  await act(async () => button('Resume follow-up').click());
  expect(control.mock.calls.map(([input]) => [input.action, input.expectedRevision])).toEqual([['pause', 1], ['resume', 2]]);
  expect(resumeRun).not.toHaveBeenCalled();
  followup.wait = { ...followup.wait, state: 'consumed', trigger_cursor: 4 };
  followup.occurrence = { id: 'occurrence:one', generation: 1, trigger_cursor: 4, receipt_identity: 'receipt:process', receipt_epoch: 'kernel:original',
    state: 'admitted', hold_reason: null, receipt: { thread_id: identity.threadId, branch_id: identity.branchId,
      run_id: 'continuation:run', input_id: 'environment:input', cursor: 5 } };
  await act(async () => f.emit({ cursor: 5, subject: followup.id, revision: 4, kind: 'followup.admitted', data: { run_id: 'continuation:run' } }));
  expect(container.querySelector('[aria-label="Pending process follow-up"]')).toBeNull();
  expect(button('Cancel follow-up')).toBeUndefined();
  expect(container.textContent).toContain('continuation run continuation:run');
  expect(f.cancelRun).not.toHaveBeenCalled();
});


it('Agent workspace entry opens an explicit conversation and switches back to existing conversations', async () => {
  const f = fixture();
  const create = vi.fn(f.api.create);
  f.api.create = create;
  runtimeState.api = f.api;
  await act(async () => { root.render(<AgentWorkspaceShell />); });
  expect(container.querySelector('[data-testid="existing-conversations"]')).not.toBeNull();
  await act(async () => { button('New conversation').click(); });
  expect(create).toHaveBeenCalledOnce();
  expect(typeof create.mock.calls[0]![0]).toBe('string');
  expect(container.querySelector('[aria-label="Thread conversation"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="existing-conversations"]')).toBeNull();
  await edit('[aria-label="Conversation runtime"]', '', 'change');
  expect(container.querySelector('[aria-label="Thread conversation"]')).toBeNull();
  expect(container.querySelector('[data-testid="existing-conversations"]')).not.toBeNull();
});


it('shared file picker previews image-only input, retains bytes/key on failure, and supports removing a selected image', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(new ThreadRequestError(400, 'kernel-frame-too-large'));
  f.submit.mockImplementationOnce(async input => {
    f.view.history.push({ id: 'accepted-image', thread_id: identity.threadId, parent: null, source: 'user', provider: null, content: { text: input.text, attachments: input.images?.map(image => ({ media_type: image.mimeType, content_ref: `data:${image.mimeType};base64,${image.data}`, source: 'user-upload' })) } });
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
  expect(container.querySelector('article img')?.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
  await choose();
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="chat.fileAttachment.actions.removeImage"]')!.click(); });
  expect(container.querySelector('form img')).toBeNull();
  expect(button('Send').disabled).toBe(true);
});


it('loads earlier images under a pinned head while live controls continue, then returns to latest messages', async () => {
  const f = fixture(true);
  const item = (id: string, text: string) => ({ id, thread_id: identity.threadId, parent: null, source: 'assistant' as const, content: { text }, provider: null });
  f.view.history = [item('message-2', 'middle message'), item('message-3', 'pinned newest message')];
  f.view.historyPage = { head: 'message-3', previous: 'message-2' };
  f.view.thread.branches[0]!.head = 'message-3';
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=';
  const earlier = { ...item('message-1', 'oldest image message'), content: { text: 'oldest image message', attachments: [{ media_type: 'image/png', content_ref: `data:image/png;base64,${imageData}`, source: 'user-upload' }] } };
  const historyPage = vi.fn(async () => ({ head: 'message-3', previous: null, items: [earlier] }));
  f.api.historyPage = historyPage;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  await act(async () => { button('Load earlier history').click(); });
  expect(historyPage).toHaveBeenCalledWith(identity, { headId: 'message-3', beforeId: 'message-2' });
  expect(container.textContent).toContain('oldest image message');
  expect(container.querySelector('article img')?.getAttribute('src')).toBe(`data:image/png;base64,${imageData}`);
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
  await act(async () => { resolvePage({ head: 'old-head', previous: null, items: [{ id: 'old-message', thread_id: identity.threadId, parent: null, source: 'user', content: { text: 'history from the previous branch' }, provider: null }] }); });
  expect(container.textContent).not.toContain('history from the previous branch');
  expect(container.textContent).not.toContain('Viewing saved history');
  expect(container.textContent).not.toContain('Loading earlier history');
});

it('retries a conversation fork with the same request key and opens only the accepted branch', async () => {
  const f = fixture();
  f.view.history = [{ id: 'selected-message', thread_id: identity.threadId, parent: null, source: 'user', content: { text: 'branch point' }, provider: null }];
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
  f.view.history = [{ id: 'selected-message', thread_id: identity.threadId, parent: null, source: 'user', content: { text: 'branch point' }, provider: null }];
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

it('keeps frozen resource metadata on conflict and refreshes once with the current checkpoint revision', async () => {
  const f = fixture(true);
  const instruction = { origin: 'project' as const, kind: 'project-instruction' as const, appliesTo: '.',
    reference: { domainId: 'project:fixture', viewId: 'source:fixed', path: 'AGENTS.md', canonicalId: 'resource:instructions', version: 'instructions:one' } };
  const skill = { id: 'skill:review', name: 'review-code', description: 'Review code', disableModelInvocation: false, requiresProjectTrust: true,
    origin: 'project' as const, basePath: '.pi/skills/review', baseCanonicalId: 'resource:review', priority: 1,
    reference: { ...instruction.reference, path: '.pi/skills/review/SKILL.md', canonicalId: 'resource:review:skill', version: 'skill:one' } };
  const checkpoint: ContextCheckpoint = { id: 'context:original', revision: 3,
    proposal: { key: 'context:original', branch_id: identity.branchId, through_id: null, expected_revision: 2,
      summary: '', effective_system_prompt: 'Private composed prompt', instruction_sources: [], memory_checkpoint: null },
    resources: {
      source: { workspace_id: 'workspace:fixture', execution_workspace_id: 'workspace:fixture', branch_id: 'source:branch', revision: 7, mode: 'fixed_branch', live_root: null },
      snapshot: { id: 'resources:original', scope: { threadId: identity.threadId, branchId: identity.branchId, mode: 'agent', threadRole: 'main',
        projectId: 'project:fixture', sourceIdentity: 'source:fixed', cwd: '/workspace/project', projectTrusted: true, projectRoot: '/workspace/project' },
        readers: [{ domainId: 'project:fixture', viewId: 'source:fixed', consistency: 'immutable' }],
        project: { domainId: 'project:fixture', viewId: 'source:fixed', cwd: '.' }, configurationDigest: 'configuration:one', shadowedContextCanonicalIds: [],
        system: null, appendSystem: null, instructions: [instruction], instructionScopes: [], skills: [skill],
        diagnostics: [{ kind: 'read', status: 'missing', message: 'Optional resource is missing', location: { domainId: 'project:fixture', viewId: 'source:fixed', path: '.pi/skills/optional' } }],
        capturedFiles: [{ reference: instruction.reference, content: 'Private instruction body' }, { reference: skill.reference, content: 'Private skill body' }], observations: [] },
    },
  };
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
  f.view.history = [{ id: 'summary-cut', thread_id: identity.threadId, parent: null, source: 'user', content: { text: 'original full message' }, provider: null }];
  f.view.historyPage = { head: 'summary-cut', previous: null };
  const run = { ...initialSnapshot(true).activeRun!, id: 'summary-run', state: 'completed' as const };
  const compact = vi.fn<ThreadsAPI['compact']>().mockRejectedValueOnce(new Error('uncertain summary acceptance')).mockImplementation(async input => {
    const job = { request: { key: input.key, branch_id: input.branchId, through_id: input.throughId, expected_revision: input.expectedRevision, effective_system_prompt: '', instruction_sources: [], memory_checkpoint: null }, receipt: { thread_id: 'context-job-thread:fixture', branch_id: 'context-job-branch:fixture', run_id: run.id, input_id: 'summary-input', cursor: 2 } };
    f.view.context.jobs = [{ job, run }];
    return job;
  });
  f.api.compact = compact;
  const publish = vi.fn<ThreadsAPI['publishContext']>(async () => {
    const request = f.view.context.jobs[0]!.job.request;
    const checkpoint = { id: request.key, revision: 1, proposal: { ...request, summary: 'continuation summary' } };
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
  const prepared = { path: '/workspace/project', source: { workspaceId: 'captured-workspace', executionWorkspaceId: 'captured-workspace', branchId: 'captured-branch', revision: 0, mode: 'fixed_branch' as const, tools: ['file_read' as const] } };
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
  expect(calls[0]![0]).toMatchObject({ ...identity, path: '/workspace/project', mode: 'fixed_branch' });
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
  await act(async () => { resolvePrepare({ path: '/old-host/project', source: { workspaceId: 'old-host-workspace', executionWorkspaceId: 'old-host-workspace', branchId: 'old-host-source', revision: 0, mode: 'fixed_branch', tools: ['file_read'] } }); });
  expect(container.querySelector('[aria-label="Prepared workspace"]')).toBeNull();
  expect(button('Preparing workspace snapshot')).toBeUndefined();
});

it('does not silently discard a prepared workspace when a live run appears before send', async () => {
  const f = fixture();
  f.api.prepareSource = vi.fn().mockResolvedValue({ path: '/workspace/project', source: { workspaceId: 'prepared-ws', executionWorkspaceId: 'prepared-ws', branchId: 'prepared-source', revision: 0, mode: 'materialized', tools: ['file_read', 'file_write'] } });
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

it('requires an explicit answer send, keeps the draft on failure and disables a stale question', async () => {
  const f = fixture(true);
  const operation: ThreadSnapshot['operations'][number] = { id: 'question-op', run_id: 'ui-run', epoch: 1, revision: 2, phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'thread', handed_off: true, executor: 'ask_user', waiting_on: 'question:question-op', intent: { call: { arguments: { question: 'Which approach?', options: ['Option A', 'Option B'] } } }, result: null, external_receipt: null, call_completion: null, execution_owner: null };
  f.view.activeRun!.state = 'waiting'; f.view.activeRun!.waiting_on = operation.waiting_on;
  f.view.operations = [operation];
  const answer = vi.fn<ThreadsAPI['answerQuestion']>().mockRejectedValueOnce(new Error('uncertain answer acceptance')).mockImplementation(async () => {
    f.view.operations[0] = { ...operation, phase: 'terminal', outcome: 'succeeded', result: { answer: 'Option B with detail' } };
    f.view.activeRun!.waiting_on = 'question:another-operation';
    return f.view.operations[0]!;
  });
  f.api.answerQuestion = answer;
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} />); });
  expect(answer).not.toHaveBeenCalled();
  await act(async () => { button('Option B').click(); });
  expect(answer).not.toHaveBeenCalled();
  await edit('[aria-label="Your answer"]', 'Option B with detail');
  await submitForm(container.querySelector<HTMLFormElement>('form[aria-label="Answer agent question"]')!);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Your answer"]')!.value).toBe('Option B with detail');
  expect(container.textContent).toContain('uncertain answer acceptance');
  await submitForm(container.querySelector<HTMLFormElement>('form[aria-label="Answer agent question"]')!);
  expect(answer.mock.calls[0]![0]).toEqual({ ...identity, operationId: operation.id, answer: 'Option B with detail' });
  expect(answer.mock.calls[1]![0]).toEqual(answer.mock.calls[0]![0]);
  expect(button('Send answer').disabled).toBe(true);
  expect(button('Option A').disabled).toBe(true);
  await submitForm(container.querySelector<HTMLFormElement>('form[aria-label="Answer agent question"]')!);
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
  expect(button('Send answer').disabled).toBe(true);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Your answer"]')!.disabled).toBe(true);
  expect(button('Cancel operation')).toBeUndefined();
  await submitForm(container.querySelector<HTMLFormElement>('form[aria-label="Answer agent question"]')!);
  expect(answer).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it('permission UI sends only an explicit one-action decision and cannot approve a sibling Run', async () => {
  const f = fixture(true);
  f.view.activeRun!.state = 'executing';
  const permission = { id: 'permission-1', call: { runId: 'ui-run', origin: { kind: 'model_step', request_id: 'request-1' }, operationId: 'request-1:tool:call-1', callId: 'call-1', name: 'mcp_send', schemaVersion: 'schema-1', arguments: { recipient: 'chosen-target', body: 'exact content' } }, scope: { ownerReference: 'mcp-owner', ownerGeneration: 4, toolSchemaVersion: 'schema-1', policyGeneration: 'policy-generation', reason: 'External effect' }, actor: { account: 'selected-account', authority: 'fixture-authority' }, decision: null, consumed: false };
  const operation: ThreadSnapshot['operations'][number] = { id: permission.call.operationId, run_id: 'ui-run', epoch: 1, revision: 2, phase: 'waiting', outcome: null, effect: 'none', cancel_requested: false, lifetime: 'run', handed_off: false, executor: 'mcp_send', waiting_on: 'permission:permission-1', intent: {}, result: { permission }, external_receipt: null, call_completion: null, execution_owner: null };
  f.view.operations = [operation];
  const answer = vi.fn<ThreadsAPI['answerQuestion']>(); f.api.answerQuestion = answer;
  const decide = vi.fn<ThreadsAPI['decidePermission']>().mockRejectedValueOnce(new Error('decision transport unavailable')).mockImplementation(async () => {
    f.view.operations = [{ ...operation, phase: 'accepted', waiting_on: null, result: { permission: { ...permission, decision: 'allow_once', consumed: true } } }]; return f.view.operations[0]!;
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
  const prepared = { path: '/workspace/project', source: { workspaceId: 'live-workspace', executionWorkspaceId: 'live-workspace', mode: 'live_root' as const,
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
  expect(f.api.prepareSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...identity, path: '/workspace/project', mode: 'live_root' }));
  expect(container.querySelector('[aria-label="Prepared workspace"]')?.textContent).toContain('Live files and commands');
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'work on these actual files');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: prepared.source, text: 'work on these actual files' }));
});

it.each(['fixed_branch', 'materialized'] as const)('reprepares %s from a live language-capable workspace without retaining live-only tools', async mode => {
  const f = fixture();
  const languageTools = ['language_definition', 'language_references', 'language_diagnostics'] as const;
  const live = { path: '/workspace/project', source: { workspaceId: 'selected-workspace', executionWorkspaceId: 'selected-workspace', mode: 'live_root' as const,
    liveRoot: { hostId: 'host', canonicalRoot: '/workspace/project', rootId: 'live-root' }, tools: ['file_read' as const, ...languageTools] } };
  const fixed = { path: '/workspace/project', source: { workspaceId: 'selected-workspace', executionWorkspaceId: 'selected-workspace', branchId: 'captured-source', revision: 0,
    mode, tools: mode === 'fixed_branch' ? ['file_read' as const] : ['file_read' as const, 'file_write' as const] } };
  f.api.prepareSource = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce(fixed);
  await act(async () => { root.render(<ThreadConversation api={f.api} identity={identity} initialWorkspacePath="/workspace/project" />); });
  await edit('[aria-label="Workspace access"]', 'live_root', 'change');
  await act(async () => { button('Prepare workspace').click(); });
  expect(f.api.prepareSource).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'live_root' }));
  expect(container.querySelector('[aria-label="Prepared workspace"]')?.textContent).toContain('Live files and commands');
  await edit('[aria-label="Workspace access"]', mode, 'change');
  await act(async () => { button('Prepare workspace').click(); });
  expect(f.api.prepareSource).toHaveBeenLastCalledWith(expect.objectContaining({ mode }));
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message thread"]', 'use the newly prepared source');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.closest('form')!);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: fixed.source }));
  for (const tool of languageTools) expect(f.submit.mock.calls[0]![0].source?.tools).not.toContain(tool);
});

function pauseView(view: ThreadSnapshot, waitId = 'wait:policy-one') {
  view.activeRun!.state = 'waiting'; view.activeRun!.waiting_on = waitId;
  view.launch = { run_id: view.activeRun!.id, revision: 1, policy_generation: 0, policy_preparable: false, policy_target: { kind: 'default' }, startable: false, requires_rebind: true, bound_epoch: null, preparation_failure: null,
    pause: { action_id: `action:${waitId}`, wait_id: waitId, reason: 'Review the first delivered result.' },
    selection: { extension_bindings: [], policy_models: [], mcp_binding: null, credential_scope: null, connection_identity: 'fixture', provider_family: 'fixture', model: 'fixture',
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
