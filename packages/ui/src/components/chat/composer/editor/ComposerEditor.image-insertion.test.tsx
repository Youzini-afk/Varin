import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { EditorView } from '@codemirror/view';
import { undo, redo, deleteCharBackward, deleteCharForward } from '@codemirror/commands';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { draftImageReferences } from '@/lib/images/references';
import { composerDraftChange, saveComposerState } from '@/lib/agent-editor/contentReferences';
import type { ComposerMarkerObject } from './markers';
import type { ComposerReference } from './references';
import { removeDraftImage } from '../imageAttachments';

let root: Root;
const editor = React.createRef<ComposerEditorHandle>();
beforeEach(() => {
  const { document, window } = parseHTML('<html><body><div id="editor"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '20px' }));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.assign(document, { getSelection: () => null, hasFocus: () => false });
  root = createRoot(document.querySelector('#editor')!);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

function Harness() {
  const [value, setValue] = React.useState('之前之后');
  return <ComposerEditor ref={editor} value={value} onChange={change => setValue(change.value)} languageContext={{
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [],
  }} />;
}

it('treats an attached image label as one deletion and restores it with editor undo', async () => {
  function ImageHarness() {
    const [value, setValue] = React.useState('前[图片1]后');
    const [references, setReferences] = React.useState<readonly ComposerReference[]>([{ id: 'image-one', host: 0, from: 1, to: 6, text: '[图片1]', target: { kind: 'image', imageId: 'one' } }]);
    const objects: ComposerMarkerObject[] = [{ id: 'one', kind: 'image', number: 1, label: '[图片1]', host: 0, payload: { kind: 'image', image: { data: 'YQ==', mimeType: 'image/png', reference: 1 } } }];
    return <ComposerEditor ref={editor} value={value} references={references} markerObjects={objects} onChange={change => { setValue(change.value); setReferences(change.references); }} languageContext={{
      inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [], imageReferences: [1],
    }} />;
  }
  await act(async () => root.render(<ImageHarness />));
  const view = EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
  act(() => editor.current!.setSelection(6));
  act(() => { deleteCharBackward(view); });
  expect(editor.current!.getValue()).toBe('前后');
  act(() => { undo(view); });
  expect(editor.current!.getValue()).toBe('前[图片1]后');
  act(() => { redo(view); });
  expect(editor.current!.getValue()).toBe('前后');
  act(() => { undo(view); editor.current!.setSelection(1); deleteCharForward(view); });
  expect(editor.current!.getValue()).toBe('前后');
  act(() => { undo(view); editor.current!.setSelection(3, 4); deleteCharBackward(view); });
  expect(editor.current!.getValue()).toBe('前后');
});

it('renumbers multiple labels without losing an intervening object reference or moving its caret', async () => {
  const text = '[图片1] @task [图片10] [图片12]', from = text.indexOf('@task');
  useThreadDraftStore.getState().patch('renumber', { text, images: Array.from({ length: 12 }, (_, i) => ({ data: 'YQ==', mimeType: 'image/png', reference: i + 1 })),
    references: [{ id: 'task', from, to: from + 5, text: '@task', host: 0, target: { kind: 'thread', identity: { runtime: 'agent', threadId: 'task', branchId: 'main' } } }] });
  const initial = useThreadDraftStore.getState().drafts.renumber;
  const markerObjects: ComposerMarkerObject[] = initial.images.map((image, i) => ({ id: `image-${i+1}`, host: 0, kind: 'image', number: i+1, label: `[图片${i+1}]`, payload: { kind: 'image', image } }));
  const bound: ComposerReference[] = [1, 10, 12].map(number => { const label = `[图片${number}]`, position = text.indexOf(label); return { id: `occurrence-${number}`, host: 0, from: position, to: position + label.length, text: label, target: { kind: 'image', imageId: `image-${number}` } }; });
  useThreadDraftStore.getState().patch('renumber', { markerObjects, references: [...initial.references!, ...bound] });
  function DraftHarness() {
    const draft = useThreadDraftStore(state => state.drafts.renumber);
    return <ComposerEditor ref={editor} draftKey="renumber" value={draft.text} references={draft.references} markerObjects={draft.markerObjects}
      onEditorStateChange={state => saveComposerState('renumber', state)}
      onChange={change => useThreadDraftStore.getState().patch('renumber', draft => composerDraftChange(draft, change.value, change.references, change.interactions, change.markerObjects))}
      languageContext={{ inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [], imageReferences: draftImageReferences(draft) }} />;
  }
  try {
    await act(async () => root.render(<DraftHarness />));
    act(() => editor.current!.setSelection(from + 5));
    act(() => removeDraftImage('renumber', 0));
    expect(editor.current!.getValue()).toBe(' @task [图片9] [图片11]');
    expect(editor.current!.getSelection()).toEqual({ start: 6, end: 6 });
    expect(useThreadDraftStore.getState().drafts.renumber.references?.find(reference => reference.id === 'task')).toMatchObject({ id: 'task', from: 1, to: 6, text: '@task' });
    expect(useThreadDraftStore.getState().drafts.renumber.images.map(image => image.reference)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  } finally { await act(async () => root.render(null)); useThreadDraftStore.getState().remove('renumber'); }
});

it('keeps a delayed image at the original paste position while later typing and cursor movement continue', async () => {
  await act(async () => root.render(<Harness />));
  act(() => editor.current!.setSelection(2));
  const insertion = editor.current!.captureInsertion();
  act(() => editor.current!.insertText('新输入'));
  act(() => editor.current!.setSelection(editor.current!.getValue().length));
  act(() => editor.current!.insertText('末尾'));
  act(() => { insertion.insertText('[图片1]'); insertion.insertText('[图片2]'); });
  expect(editor.current!.getValue()).toBe('之前[图片1][图片2]新输入之后末尾');
  expect(editor.current!.getSelection().start).toBe(editor.current!.getValue().length);
  insertion.dispose();
  act(() => insertion.insertText('已取消的读取'));
  expect(editor.current!.getValue()).not.toContain('已取消');
});

it('does not replace text typed over the original selection while an image is being read', async () => {
  await act(async () => root.render(<Harness />));
  act(() => editor.current!.setSelection(0, 2));
  const insertion = editor.current!.captureInsertion();
  act(() => editor.current!.insertText('自己的说明'));
  act(() => insertion.insertText('[图片1]'));
  expect(editor.current!.getValue()).toBe('自己的说明[图片1]之后');
  insertion.dispose();
});

it('fills at the last cursor without replacing selection and only updates an untouched source span', async () => {
  await act(async () => root.render(<Harness />));
  act(() => editor.current!.setSelection(0, 2));
  await act(async () => { await editor.current!.composeInteraction('choice', '短发'); });
  expect(editor.current!.getValue()).toBe('之前\n\n短发\n\n之后');
  await act(async () => { await editor.current!.composeInteraction('choice', '长发'); });
  expect(editor.current!.getValue()).toBe('之前\n\n长发\n\n之后');
  act(() => editor.current!.replaceRange(4, 6, '自己的发型'));
  act(() => editor.current!.setSelection(editor.current!.getValue().length));
  await act(async () => { await editor.current!.composeInteraction('choice', '卷发'); });
  expect(editor.current!.getValue()).toBe('之前\n\n自己的发型\n\n之后\n\n卷发');
});

it('defers interaction insertion until composition ends without focusing the editor', async () => {
  await act(async () => root.render(<Harness />));
  const content = document.querySelector<HTMLElement>('.cm-content')!;
  const focus = vi.spyOn(content, 'focus');
  act(() => content.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  let completed = false;
  const pending = editor.current!.composeInteraction('choice', '选择结果').then(() => { completed = true; });
  expect(completed).toBe(false);
  expect(editor.current!.getValue()).toBe('之前之后');
  await act(async () => {
    content.dispatchEvent(new window.Event('compositionend', { bubbles: true }));
    await pending;
  });
  expect(editor.current!.getValue()).toContain('选择结果');
  expect(focus).not.toHaveBeenCalled();
});

it('finishes an IME-deferred fill in the original draft after navigating away', async () => {
  const { composeUiResult, registerUiComposer } = await import('@/lib/interactive-ui/compose');
  const { useThreadDraftStore } = await import('@/stores/useThreadDraftStore');
  const { threadComposerKey, threadHostKey } = await import('@/stores/useThreadStore');
  const { getRuntimeEndpointGeneration } = await import('@varin/application-client');
  const identity = { runtime: 'agent' as const, threadId: 'old-thread', branchId: 'old-branch' };
  const key = threadComposerKey(threadHostKey(), identity);
  useThreadDraftStore.getState().patch(key, { text: '之前之后' });
  function DraftHarness() {
    const draft = useThreadDraftStore(state => state.drafts[key]!);
    React.useLayoutEffect(() => registerUiComposer(key, editor.current!), []);
    return <ComposerEditor ref={editor} value={draft.text} interactions={draft.interactions}
      onChange={change => useThreadDraftStore.getState().patch(key, { text: change.value, interactions: change.interactions })}
      languageContext={{ inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [] }} />;
  }
  await act(async () => root.render(<DraftHarness />));
  act(() => editor.current!.setSelection(2));
  act(() => document.querySelector('.cm-content')!.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  const pending = composeUiResult({ identity, host: getRuntimeEndpointGeneration(), sourceKey: 'choice', text: '原会话的选择' });
  await act(async () => { root.render(<div>Other conversation</div>); });
  await expect(pending).resolves.toEqual({ status: 'filled', updated: false });
  expect(useThreadDraftStore.getState().drafts[key]?.text).toBe('之前\n\n原会话的选择\n\n之后');
});

it('does not apply a deferred action after its Host lease has changed', async () => {
  await act(async () => root.render(<Harness />));
  const content = document.querySelector<HTMLElement>('.cm-content')!;
  act(() => content.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  let current = true;
  const pending = editor.current!.composeInteraction('choice', 'stale host', () => current);
  const rejected = expect(pending).rejects.toThrow('Interaction source changed');
  current = false;
  await act(async () => { content.dispatchEvent(new window.Event('compositionend', { bubbles: true })); await rejected; });
  expect(editor.current!.getValue()).toBe('之前之后');
});

it('finishes a composition-deferred bound image in its original draft after navigation', async () => {
  const { beginImageInsertion } = await import('../imageAttachments');
  useThreadDraftStore.getState().patch('original-images', { text: '前文后文' });
  function DraftHarness() {
    const draft = useThreadDraftStore(state => state.drafts['original-images']);
    return <ComposerEditor ref={editor} draftKey="original-images" value={draft.text} references={draft.references} markerObjects={draft.markerObjects}
      onEditorStateChange={state => saveComposerState('original-images', state)}
      onChange={change => useThreadDraftStore.getState().patch('original-images', draft => composerDraftChange(draft, change.value, change.references, change.interactions, change.markerObjects))}
      languageContext={{ inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [] }} />;
  }
  await act(async () => root.render(<DraftHarness />));
  act(() => editor.current!.setSelection(2));
  const insertion = beginImageInsertion('original-images', editor.current, number => `[图片${number}]`);
  act(() => document.querySelector('.cm-content')!.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  const pending = insertion.append({ data: 'YQ==', mimeType: 'image/png' });
  await act(async () => root.render(<div>Other conversation</div>));
  await pending;
  const draft = useThreadDraftStore.getState().drafts['original-images'];
  expect(draft.text).toBe('前文[图片1]后文');
  expect(draft.markerObjects).toHaveLength(1);
  expect(draft.references?.[0]).toMatchObject({ from: 2, to: 7, target: { kind: 'image', imageId: draft.markerObjects![0].id } });
  insertion.dispose(); useThreadDraftStore.getState().remove('original-images');
});
