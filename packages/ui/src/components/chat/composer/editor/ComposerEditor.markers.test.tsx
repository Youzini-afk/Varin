import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, deleteCharBackward } from '@codemirror/commands';
import { ComposerEditor, type ComposerChange, type ComposerEditorHandle } from './ComposerEditor';
import { composerMarkerObjects, type ComposerMarkerObject } from './markers';
import { composerReferences } from './references';
import { COMPOSER_MARKER_MIME } from './markerClipboard';
import { MARKER_HOLD_MS } from './markerDrag';
import { EMPTY_CONTEXT } from './composerLanguage';
import type { EditorState } from '@codemirror/state';

let root: Root;
const editor = React.createRef<ComposerEditorHandle>();
const object: ComposerMarkerObject = { id: 'quote', kind: 'quote', number: 1, label: '[引用点1]', host: 0, sourceLabel: 'Varin', excerpt: 'The frozen quote',
  payload: { kind: 'quote', reference: { ref: 'quote', title: 'Quote', text: 'The frozen quote', source: { kind: 'ui', snapshotRef: 'snapshot' } } } };
let lastState: EditorState | undefined;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const open = vi.fn();
beforeEach(() => {
  const { document, window } = parseHTML('<html><body><div id="editor"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('MutationObserver', window.MutationObserver); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '20px', color: 'blue', font: '14px sans-serif' }));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  Object.assign(document, { getSelection: () => null, hasFocus: () => false });
  root = createRoot(document.querySelector('#editor')!); lastState = undefined; open.mockClear();
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Harness({ initial = '前文后文', restored }: { initial?: string; restored?: EditorState }) {
  const [change, setChange] = React.useState<Partial<ComposerChange>>({ value: restored?.doc.toString() ?? initial,
    references: restored?.field(composerReferences), markerObjects: restored?.field(composerMarkerObjects) });
  return <ComposerEditor ref={editor} host={0} value={change.value!} references={change.references} markerObjects={change.markerObjects} editorState={restored}
    onEditorStateChange={state => { lastState = state; }} onChange={setChange} onMarkerActivate={open} languageContext={EMPTY_CONTEXT} />;
}
const view = () => EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
const marker = () => document.querySelector<HTMLElement>('[data-composer-marker]')!;
function pointer(type: string, target: EventTarget, x: number, y = 20) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y }); target.dispatchEvent(event); return event;
}
function clipboard(type: string, values: Map<string, string>) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: { setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) ?? '', files: [] } });
  view().contentDOM.dispatchEvent(event); return event;
}
const geometry = () => {
  vi.spyOn(view().scrollDOM, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 200, top: 0, bottom: 100, height: 100, width: 200, x: 0, y: 0, toJSON: () => ({}) });
  vi.spyOn(view(), 'posAtCoords').mockImplementation(coords => Math.min(view().state.doc.length, Math.round(coords.x / 10)));
  vi.spyOn(view(), 'coordsAtPos').mockImplementation(pos => ({ left: pos * 10, right: pos * 10, top: 10, bottom: 30 }));
};

it('distinguishes typed lookalikes from actual bound markers in the editor and preserves a selected phrase', async () => {
  await act(async () => root.render(<Harness initial="[引用点1] user text" />));
  act(() => editor.current!.setSelection(7, 11));
  await act(async () => editor.current!.insertMarker(object));
  expect(editor.current!.getValue()).toBe('[引用点1] user[引用点1] text');
  expect(view().state.field(composerReferences)).toHaveLength(1);
  expect(marker().getAttribute('aria-label')).toBe('[引用点1] · Varin');
  act(() => editor.current!.setSelection(6)); act(() => { deleteCharBackward(view()); });
  expect(editor.current!.getValue()).toBe('[引用点1 user[引用点1] text');
  expect(view().state.field(composerReferences)).toHaveLength(1);
});
it('copies structured occurrences within the editor and readable quote material externally, allocating target numbers', async () => {
  await act(async () => root.render(<Harness initial="" />));
  await act(async () => editor.current!.insertMarker(object));
  const values = new Map<string, string>();
  act(() => { editor.current!.selectAll(); clipboard('copy', values); });
  expect(values.get('text/plain')).toContain('Varin\n> The frozen quote');
  expect(values.get('text/plain')).not.toContain('snapshot');
  expect(values.has(COMPOSER_MARKER_MIME)).toBe(true);
  const first = view().state.field(composerReferences)[0].id;
  act(() => { editor.current!.setSelection(editor.current!.getValue().length); clipboard('paste', values); });
  expect(editor.current!.getValue()).toBe('[引用点1][引用点1]');
  expect(view().state.field(composerMarkerObjects)).toHaveLength(1);
  expect(view().state.field(composerReferences)[1].id).not.toBe(first);
  act(() => { undo(view()); }); expect(editor.current!.getValue()).toBe('[引用点1]');
  act(() => { editor.current!.selectAll(); clipboard('cut', values); });
  expect(editor.current!.getValue()).toBe(''); expect(view().state.field(composerMarkerObjects)).toHaveLength(1);
  act(() => { clipboard('paste', values); }); expect(editor.current!.getValue()).toBe('[引用点1]');
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness initial="" />));
  await act(async () => editor.current!.insertMarker({ ...object, id: 'other', payload: { kind: 'quote', reference: { ref: 'other', title: 'Other quote', text: 'Other', source: { kind: 'ui', snapshotRef: 'other' } } } }));
  act(() => { clipboard('paste', values); });
  expect(editor.current!.getValue()).toBe('[引用点1][引用点2]');
  expect(view().state.field(composerMarkerObjects).map(item => item.id)).toEqual(['other', 'quote']);
});
it('restores history and original resource objects across editor remount', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => editor.current!.insertMarker(object));
  act(() => editor.current!.removeMarkerObject('quote'));
  expect(editor.current!.getValue()).toBe('前文后文');
  const saved = lastState;
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness restored={saved} />));
  act(() => { undo(view()); });
  expect(editor.current!.getValue()).toBe('前文后文[引用点1]');
  expect(view().state.field(composerMarkerObjects)[0]).toEqual(object);
  act(() => { redo(view()); }); expect(editor.current!.getValue()).toBe('前文后文');
});
it('defers marker insertion during composition at its mapped original anchor without replacing a selection', async () => {
  await act(async () => root.render(<Harness />));
  act(() => editor.current!.setSelection(0, 2));
  const anchor = editor.current!.captureMarkerInsertion();
  act(() => view().contentDOM.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  let done = false;
  const insertion = anchor.insertMarker(object).then(() => { done = true; });
  act(() => editor.current!.replaceRange(0, 0, '新'));
  expect(done).toBe(false);
  await act(async () => { view().contentDOM.dispatchEvent(new window.Event('compositionend', { bubbles: true })); await insertion; });
  expect(editor.current!.getValue()).toBe('新前文[引用点1]后文'); anchor.dispose();
});
it('long-press moves once, Escape and outside drops cancel without history, and a completed drag suppresses preview', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => editor.current!.insertMarker(object));
  geometry(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const depth = undoDepth(view().state), original = editor.current!.getValue();
  act(() => { pointer('pointerdown', marker(), 45); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointermove', document, 0); pointer('pointerup', document, 0); });
  expect(editor.current!.getValue()).toBe('[引用点1]前文后文');
  expect(undoDepth(view().state)).toBe(depth + 1);
  act(() => marker().click()); expect(open).not.toHaveBeenCalled();
  act(() => { undo(view()); }); expect(editor.current!.getValue()).toBe(original);
  const afterUndo = undoDepth(view().state);
  act(() => { pointer('pointerdown', marker(), 45); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointermove', document, 0);
    const event = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(event, { key: 'Escape' }); document.dispatchEvent(event); pointer('pointerup', document, 0); });
  expect(editor.current!.getValue()).toBe(original); expect(undoDepth(view().state)).toBe(afterUndo);
  act(() => { pointer('pointerdown', marker(), 45); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointerup', document, 300); });
  expect(editor.current!.getValue()).toBe(original); expect(undoDepth(view().state)).toBe(afterUndo);
});
it('does not capture ordinary pointer motion, and edge scrolling only moves the editor viewport', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => editor.current!.insertMarker(object));
  geometry(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); frames.clear(); view().scrollDOM.scrollTop = 0;
  const original = editor.current!.getValue();
  act(() => { pointer('pointerdown', marker(), 45); pointer('pointermove', document, 60); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointerup', document, 0); });
  expect(editor.current!.getValue()).toBe(original);
  act(() => { pointer('pointerdown', marker(), 45); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointermove', document, 50, 99); });
  const before = view().scrollDOM.scrollTop || 0;
  act(() => { for (const [id, frame] of [...frames]) { frames.delete(id); frame(16); } });
  expect(view().scrollDOM.scrollTop).toBeGreaterThan(before);
  act(() => pointer('pointercancel', document, 50, 99));
  const cancelled = view().scrollDOM.scrollTop;
  act(() => { for (const [id, frame] of [...frames]) { frames.delete(id); frame(32); } });
  expect(view().scrollDOM.scrollTop).toBe(cancelled); expect(editor.current!.getValue()).toBe(original);
});

it('preserves pre-hold touch scrolling and consumes only an active touch drag even after pointer cancellation', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => editor.current!.insertMarker(object));
  geometry(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const touch = (type: string, target: EventTarget, x: number) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    const item = { identifier: 42, clientX: x, clientY: 20 };
    Object.assign(event, { touches: type === 'touchend' ? [] : [item], targetTouches: type === 'touchend' ? [] : [item], changedTouches: [item] });
    target.dispatchEvent(event); return event;
  };
  const original = editor.current!.getValue();
  act(() => { expect(touch('touchstart', marker(), 45).defaultPrevented).toBe(false); expect(touch('touchmove', document, 60).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(MARKER_HOLD_MS); touch('touchend', document, 60); });
  expect(editor.current!.getValue()).toBe(original);
  act(() => { touch('touchstart', marker(), 45); vi.advanceTimersByTime(MARKER_HOLD_MS); pointer('pointercancel', document, 45);
    expect(touch('touchmove', document, 0).defaultPrevented).toBe(true); touch('touchend', document, 0); });
  expect(editor.current!.getValue()).toBe('[引用点1]前文后文');
  act(() => { undo(view()); }); expect(editor.current!.getValue()).toBe(original);
});

it('opens the explicitly focused marker on Enter and Space without editing the document', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => editor.current!.insertMarker(object));
  const element = marker(), text = editor.current!.getValue();
  Object.defineProperty(document, 'activeElement', { configurable: true, value: element });
  for (const key of ['Enter', ' ']) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(event, { key, keyCode: key === 'Enter' ? 13 : 32 });
    act(() => element.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  }
  expect(open).toHaveBeenCalledTimes(2); expect(open).toHaveBeenLastCalledWith(object);
  expect(editor.current!.getValue()).toBe(text);
});

it('fills editable interaction text and its fixed source in one undo step, replacing only an untouched fill', async () => {
  await act(async () => root.render(<Harness />));
  act(() => editor.current!.setSelection(2));
  const depth = undoDepth(view().state);
  await act(async () => editor.current!.composeInteraction('choice', '选择 A', undefined, { position: 2, marker: object }));
  const first = editor.current!.getValue();
  expect(first).toBe('前文\n\n选择 A[引用点1]\n\n后文');
  expect(undoDepth(view().state)).toBe(depth + 1);
  act(() => { undo(view()); });
  expect(editor.current!.getValue()).toBe('前文后文'); expect(view().state.field(composerMarkerObjects)).toHaveLength(0);
  act(() => { redo(view()); }); expect(editor.current!.getValue()).toBe(first);
  const next = { ...object, id: 'updated', excerpt: 'New frozen choice', payload: { kind: 'quote' as const, reference: { ref: 'updated', title: 'Choice', text: 'New frozen choice', source: { kind: 'ui' as const, snapshotRef: 'updated' } } } };
  await act(async () => editor.current!.composeInteraction('choice', '选择 B', undefined, { marker: next, replaceMarkerId: object.id }));
  expect(editor.current!.getValue()).toBe('前文\n\n选择 B[引用点1]\n\n后文');
  expect(view().state.field(composerMarkerObjects).map(item => item.id)).toEqual(['updated']);
  act(() => { undo(view()); }); expect(editor.current!.getValue()).toBe(first); expect(view().state.field(composerMarkerObjects)).toEqual([object]);
});

it('drops the accepted draft history when its owner clears editorState, retaining newly written text', async () => {
  let clear!: () => void;
  function ResetHarness() {
    const [draft, setDraft] = React.useState<{ value: string; references: ComposerChange['references']; markerObjects: ComposerChange['markerObjects']; state?: EditorState }>({ value: 'Draft', references: [], markerObjects: [] });
    clear = () => setDraft({ value: 'New text', references: [], markerObjects: [], state: undefined });
    return <ComposerEditor ref={editor} value={draft.value} references={draft.references} markerObjects={draft.markerObjects} editorState={draft.state}
      onChange={change => setDraft(current => ({ ...current, value: change.value, references: change.references, markerObjects: change.markerObjects }))}
      onEditorStateChange={state => setDraft(current => ({ ...current, state }))} languageContext={EMPTY_CONTEXT} />;
  }
  await act(async () => root.render(<ResetHarness />));
  await act(async () => editor.current!.insertMarker(object));
  expect(undoDepth(view().state)).toBeGreaterThan(0);
  act(() => clear());
  expect(editor.current!.getValue()).toBe('New text');
  expect(undoDepth(view().state)).toBe(0);
  act(() => { expect(undo(view())).toBe(false); });
  expect(view().state.field(composerMarkerObjects)).toHaveLength(0);
});
