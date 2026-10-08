import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeThreadRequestError } from '@varin/application-client';
import type { NativeThreadIdentity, NativeThreadSnapshot, NativeThreadSubmit, NativeThreadsAPI } from '@varin/application-client';
import { NativeThreadConversation } from './NativeThreadConversation';
import { AgentWorkspaceShell } from '@/workbenches/agent/AgentWorkspaceShell';

const runtimeState = vi.hoisted(() => ({ api: undefined as NativeThreadsAPI | undefined }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ nativeThreads: runtimeState.api }) }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: { subscribe: () => () => {} } }));
vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: ({ renderConversation }: { renderConversation: (active: boolean) => React.ReactNode }) => <div>{renderConversation(true)}</div> }));
vi.mock('@/components/views/RegularChatView', () => ({ RegularChatView: () => <div data-testid="existing-conversations" /> }));
vi.mock('@/apps/mobileWorkspaceShell', () => ({ MobileWorkspaceShell: () => null }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));

const identity: NativeThreadIdentity = { runtime: 'nativeThread', threadId: 'nativeThread:ui-fixture', branchId: 'nativeBranch:ui-fixture' };
function initialSnapshot(active = false): NativeThreadSnapshot {
  const run = { id: 'ui-run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: { providerId: 'fixture-provider', model: 'fixture-model' }, cancel_requested: false, waiting_on: null };
  return { identity, thread: { thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, head: null, active_run_id: active ? run.id : null, latest_run: active ? run : null }] }, activeRun: active ? run : null,
    history: [], inputs: [], operations: [], launch: null };
}
function fixture(active = false) {
  const view = initialSnapshot(active);
  const submit = vi.fn(async (_input: NativeThreadSubmit) => ({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', input_id: 'sent', cursor: 1 }));
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
  const unused = async (): Promise<never> => { throw new Error('unused fixture API'); };
  const api: NativeThreadsAPI = { listModels: async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model' }], list: async () => [view.thread], create: async () => identity,
    snapshot: async () => structuredClone(view), submit, enqueue, editInput, cancelInput, cancelRun,
    run: unused, operation: unused, cancelOperation: unused, resume: unused, events: async () => [],
    observe: async (_cursor, _listener, { signal }) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }),
  };
  return { api, view, submit, enqueue, editInput, cancelInput, cancelRun };
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

it('renders the native composer and retries an uncertain send with the same request identity and text', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(new Error('temporary transport failure'));
  await act(async () => { root.render(<NativeThreadConversation api={f.api} identity={identity} />); });
  expect(container.querySelector('[aria-label="Native thread conversation"]')).not.toBeNull();
  await edit('[aria-label="Registered model"]', JSON.stringify(['fixture-provider', 'fixture-model']), 'change');
  await edit('[aria-label="Message native thread"]', 'keep this user message');
  await submitForm(container.querySelector('form')!);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporary transport failure');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message native thread"]')?.value).toBe('keep this user message');
  await submitForm(container.querySelector('form')!);
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]);
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ ...identity, text: 'keep this user message', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message native thread"]')?.value).toBe('');
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('active-thread controls queue the chosen mode, save/cancel queued text, and stop the selected Run', async () => {
  const f = fixture(true);
  f.view.inputs.push({ id: 'queued-existing', thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', mode: 'boundary', state: 'queued', revision: 3, content: { text: 'original queued text' }, cursor: 1 });
  await act(async () => { root.render(<NativeThreadConversation api={f.api} identity={identity} />); });
  await edit('[aria-label="Input delivery"]', 'interrupt', 'change');
  await edit('[aria-label="Message native thread"]', 'new queued instructions');
  await submitForm(container.querySelector<HTMLTextAreaElement>('[aria-label="Message native thread"]')!.closest('form')!);
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


it('Agent workspace entry opens an explicit native conversation and switches back to existing conversations', async () => {
  const f = fixture();
  const create = vi.fn(f.api.create);
  f.api.create = create;
  runtimeState.api = f.api;
  await act(async () => { root.render(<AgentWorkspaceShell />); });
  expect(container.querySelector('[data-testid="existing-conversations"]')).not.toBeNull();
  await act(async () => { button('New native thread').click(); });
  expect(create).toHaveBeenCalledOnce();
  expect(typeof create.mock.calls[0]![0]).toBe('string');
  expect(container.querySelector('[aria-label="Native thread conversation"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="existing-conversations"]')).toBeNull();
  await edit('[aria-label="Conversation runtime"]', '', 'change');
  expect(container.querySelector('[aria-label="Native thread conversation"]')).toBeNull();
  expect(container.querySelector('[data-testid="existing-conversations"]')).not.toBeNull();
});


it('shared file picker previews image-only input, retains bytes/key on failure, and supports removing a selected image', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(new NativeThreadRequestError(400, 'kernel-frame-too-large'));
  f.submit.mockImplementationOnce(async input => {
    f.view.history.push({ id: 'accepted-image', thread_id: identity.threadId, parent: null, source: 'user', provider: null, content: { text: input.text, attachments: input.images?.map(image => ({ media_type: image.mimeType, content_ref: `data:${image.mimeType};base64,${image.data}`, source: 'user-upload' })) } });
    return { thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'ui-run', input_id: 'sent', cursor: 1 };
  });
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhC0AAAAASUVORK5CYII=';
  const file = new File([Uint8Array.from(Buffer.from(data, 'base64'))], 'fixture.png', { type: 'image/png' });
  await act(async () => { root.render(<NativeThreadConversation api={f.api} identity={identity} />); });
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
