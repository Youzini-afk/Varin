import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { composerMarkerObjects } from '@/components/chat/composer/editor/markers';
import { composerReferences } from '@/components/chat/composer/editor/references';
import type { QueuedInput } from '@varin/protocol';
import { ThreadInputQueue } from './ThreadQueuedInput';

vi.mock('@/lib/i18n', async original => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./ThreadContent', () => ({ ThreadContent: () => null }));
vi.mock('./ThreadMedia', () => ({ ThreadMedia: ({ imageReference }: { imageReference: number }) => <div>Stored image {imageReference}</div> }));
vi.mock('./DraftContentReferences', () => ({ DraftMarkerPreview: () => null }));
vi.mock('./ThreadSkillMaterials', () => ({ ThreadSkillMaterials: () => null }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
const original: QueuedInput = { id: 'input', thread_id: 'thread', branch_id: 'branch', run_id: 'run', mode: 'boundary', state: 'queued', revision: 3, content: { text: 'Original' }, cursor: 1 };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Node', window.Node); vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '20px' }));
  Object.assign(document, { getSelection: () => null, hasFocus: () => false });
  vi.stubGlobal('FileReader', class {
    result: string | null = null; onload?: () => void; onerror?: () => void;
    readAsDataURL(file: File) { void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }); }
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)!;
const editor = () => { const dom = container.querySelector<HTMLElement>('.cm-content'); return dom ? EditorView.findFromDOM(dom) : null; };
const edit = async (text: string) => { await act(async () => { const view = editor()!; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' }); }); };
const emptyQuotes = { contentReferences: [], contentReferenceOccurrences: [] };

it('shows accepted current-task input separately from a queued next Run', async () => {
  const interjection: QueuedInput = { ...original, id: 'interjection', mode: 'interrupt', content: { text: 'Add to current work' } };
  const next: QueuedInput = { ...original, id: 'next', mode: 'next_run', run_id: 'later-run', content: { text: 'A separate next turn' } };
  const onSendNow = vi.fn(async () => {});
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity}
    inputs={[interjection, next]} pending={false} onSave={async () => true} onCancel={async () => {}} onSendNow={onSendNow} />));
  const currentRow = container.querySelector('[data-queued-input="interjection"]')!;
  const nextRow = container.querySelector('[data-queued-input="next"]')!;
  expect(currentRow.textContent).toContain('Add to current work');
  expect(currentRow.textContent).toContain('bot.workspace.accepted');
  expect(currentRow.textContent).not.toContain('chat.queuedMessage.sendNow');
  expect(nextRow.textContent).toContain('bot.workspace.queued');
  expect(nextRow.textContent).toContain('chat.queuedMessage.sendNow');
  await act(async () => currentRow.querySelector<HTMLButtonElement>('[aria-label="chat.queuedMessage.edit"]')!.click());
  expect(container.querySelector('label')?.textContent).toBe('chat.queuedMessage.steering');
  expect(onSendNow).not.toHaveBeenCalled();
});

it('keeps an edited queue draft after a newer revision and after delivery, without overwriting either', async () => {
  const onSave = vi.fn(async () => true), onCancel = vi.fn(async () => {});
  const render = async (inputs: QueuedInput[]) => act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity} inputs={inputs} pending={false} onSave={onSave} onCancel={onCancel} />));
  await render([original]); await act(async () => button('chat.queuedMessage.edit').click()); await edit('Unsaved correction');
  await render([{ ...original, revision: 4, content: { text: 'Changed elsewhere' } }]);
  expect(editor()?.state.doc.toString()).toBe('Unsaved correction');
  expect(container.textContent).toContain('chat.queuedMessage.editStale');
  expect(button('settings.common.actions.saveChanges').disabled).toBe(true);
  await render([]);
  expect(editor()?.state.doc.toString()).toBe('Unsaved correction');
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
  await submit(); expect(editor()?.state.doc.toString()).toBe('Correction');
  expect(onSave).toHaveBeenCalledWith(original, 'Correction', undefined, emptyQuotes);
  await submit(); expect(container.querySelector('.cm-content')).toBeNull();
});

it('leaves IME confirmation in the editor and admits one save for repeated submit keys', async () => {
  let finish!: (saved: boolean) => void;
  const onSave = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead: vi.fn() }} identity={identity} inputs={[original]} pending={false} onSave={onSave} onCancel={async () => {}} />));
  await act(async () => button('chat.queuedMessage.edit').click()); await edit('未保存的修改');
  const key = (isComposing: boolean) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: 'Enter' }, keyCode: { value: 13 }, ctrlKey: { value: true }, isComposing: { value: isComposing } });
    container.querySelector('.cm-content')!.dispatchEvent(event);
    return event;
  };
  await act(async () => { expect(key(true).defaultPrevented).toBe(false); });
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => { key(false); key(false); });
  expect(onSave).toHaveBeenCalledExactlyOnceWith(original, '未保存的修改', undefined, emptyQuotes);
  await act(async () => finish(true));
  expect(container.querySelector('.cm-content')).toBeNull();
});

it('removes queued image objects and only their bound occurrences as one undo step without reading original bytes', async () => {
  const image = { media_type: 'image/png', content_ref: { content_object: 'sha256-original' }, source: { kind: 'operation', operation_id: 'capture' } };
  const input = { ...original, content: { text: '[图片3] example [图片3] and [图片5]', imageReferences: [3, 5], attachments: [image, image],
    contentReferenceOccurrences: [{ kind: 'image', reference: 3, start: 14, end: 19 }, { kind: 'image', reference: 5, start: 24, end: 29 }] } } as QueuedInput;
  const onSave = vi.fn<React.ComponentProps<typeof ThreadInputQueue>['onSave']>(async () => false), mediaRead = vi.fn();
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead }} identity={identity} inputs={[input]} pending={false} onSave={onSave} onCancel={async () => {}} />));
  await act(async () => button('chat.queuedMessage.edit').click());
  const text = editor()!.state.doc.toString();
  expect(editor()!.state.field(composerMarkerObjects).map(object => object.number)).toEqual([3, 5]);
  expect(mediaRead).not.toHaveBeenCalled();
  await act(async () => button('Remove queued images').click());
  expect(editor()!.state.field(composerMarkerObjects)).toHaveLength(0);
  expect(editor()!.state.doc.toString()).toBe('[图片3] example  and ');
  await act(async () => { undo(editor()!); });
  expect(editor()!.state.doc.toString()).toBe(text);
  expect(editor()!.state.field(composerMarkerObjects).map(object => object.number)).toEqual([3, 5]);
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(onSave.mock.calls[0]?.[2]).toBeUndefined(); expect(mediaRead).not.toHaveBeenCalled();
  await act(async () => { redo(editor()!); });
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(onSave.mock.calls[1]?.[2]).toEqual([]);
  expect(onSave.mock.calls[1]?.[3]).toEqual(emptyQuotes);
});

it('replaces queued image bytes in the same bound objects and undo restores the exact original holder', async () => {
  const image = { media_type: 'image/png', content_ref: { content_object: 'sha256-original' }, source: { kind: 'operation', operation_id: 'capture' } };
  const input = { ...original, content: { text: 'Use [图片3]', imageReferences: [3], attachments: [image], contentReferenceOccurrences: [{ kind: 'image', reference: 3, start: 4, end: 9 }] } } as QueuedInput;
  const onSave = vi.fn<React.ComponentProps<typeof ThreadInputQueue>['onSave']>(async () => false), mediaRead = vi.fn();
  await act(async () => root.render(<ThreadInputQueue api={{ mediaRead }} identity={identity} inputs={[input]} pending={false} onSave={onSave} onCancel={async () => {}} />));
  await act(async () => button('chat.queuedMessage.edit').click());
  const originalObject = editor()!.state.field(composerMarkerObjects)[0];
  const picker = container.querySelector<HTMLInputElement>('[aria-label="Replace queued images"]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File([new Uint8Array([1, 2, 3])], 'new.png', { type: 'image/png' })] });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(editor()!.state.field(composerMarkerObjects)[0]).toMatchObject({ id: originalObject.id, number: 3, payload: { kind: 'image', image: { data: 'AQID' } } });
  expect(editor()!.state.field(composerReferences)[0].target).toMatchObject({ imageId: originalObject.id });
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(onSave.mock.calls[0]?.[2]).toEqual([{ mimeType: 'image/png', data: 'AQID', reference: 3 }]);
  expect(mediaRead).not.toHaveBeenCalled();
  await act(async () => { undo(editor()!); });
  expect(editor()!.state.field(composerMarkerObjects)[0]).toEqual(originalObject);
  expect(container.textContent).toContain('Stored image 3');
});
