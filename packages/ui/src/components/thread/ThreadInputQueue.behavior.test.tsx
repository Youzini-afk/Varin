import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueuedInput } from '@varin/protocol';
import { ThreadInputQueue } from './ThreadQueuedInput';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./ThreadContent', () => ({ ThreadContent: () => null }));
vi.mock('./ThreadSkillMaterials', () => ({ ThreadSkillMaterials: () => null }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
const original: QueuedInput = { id: 'input', thread_id: 'thread', branch_id: 'branch', run_id: 'run', mode: 'boundary', state: 'queued', revision: 3, content: { text: 'Original' }, cursor: 1 };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)!;
const edit = async (text: string) => {
  const textarea = container.querySelector('textarea')!;
  await act(async () => { textarea.value = text; textarea.dispatchEvent(new window.Event('input', { bubbles: true })); });
};

it('keeps an edited queue draft after a newer revision and after delivery, without overwriting either', async () => {
  const onSave = vi.fn(async () => true), onCancel = vi.fn(async () => {});
  const render = async (inputs: QueuedInput[]) => act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity} inputs={inputs} pending={false} onSave={onSave} onCancel={onCancel} />));
  await render([original]); await act(async () => button('chat.queuedMessage.edit').click()); await edit('Unsaved correction');
  await render([{ ...original, revision: 4, content: { text: 'Changed elsewhere' } }]);
  expect(container.querySelector('textarea')?.value).toBe('Unsaved correction');
  expect(container.textContent).toContain('chat.queuedMessage.editStale');
  expect(button('settings.common.actions.saveChanges').disabled).toBe(true);
  await render([]);
  expect(container.querySelector('textarea')?.value).toBe('Unsaved correction');
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(onSave).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  await act(async () => button('settings.common.actions.cancel').click());
  expect(container.querySelector('section')).toBeNull();
});

it('saves the originally opened revision, preserves the draft after failure, and closes only after success', async () => {
  const onSave = vi.fn(async () => true).mockResolvedValueOnce(false);
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity} inputs={[original]} pending={false} onSave={onSave} onCancel={async () => {}} />));
  await act(async () => button('chat.queuedMessage.edit').click()); await edit('Correction');
  const submit = async () => act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await submit(); expect(container.querySelector('textarea')?.value).toBe('Correction');
  expect(onSave).toHaveBeenCalledWith(original, 'Correction', undefined);
  await submit(); expect(container.querySelector('textarea')).toBeNull();
});

it('leaves IME confirmation in the editor and admits one save for repeated submit keys', async () => {
  let finish!: (saved: boolean) => void;
  const onSave = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity} inputs={[original]} pending={false} onSave={onSave} onCancel={async () => {}} />));
  await act(async () => button('chat.queuedMessage.edit').click()); await edit('未保存的修改');
  // linkedom has no input event capability probe; React uses its focused-input fallback.
  const textarea = container.querySelector('textarea')!;
  Object.assign(textarea, { attachEvent() {}, detachEvent() {} });
  await act(async () => textarea.dispatchEvent(new window.Event('focusin', { bubbles: true })));
  const key = (isComposing: boolean) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: 'Enter' }, ctrlKey: { value: true }, isComposing: { value: isComposing } });
    container.querySelector('textarea')!.dispatchEvent(event);
    return event;
  };
  await act(async () => { expect(key(true).defaultPrevented).toBe(false); });
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => { key(false); key(false); });
  expect(onSave).toHaveBeenCalledExactlyOnceWith(original, '未保存的修改', undefined);
  await act(async () => finish(true));
  expect(container.querySelector('textarea')).toBeNull();
});
