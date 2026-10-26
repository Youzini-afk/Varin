import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';

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
