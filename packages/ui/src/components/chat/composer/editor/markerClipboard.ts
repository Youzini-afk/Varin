import { ChangeSet, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { subscribeRuntimeEndpointWillChange, type ContentReference } from '@varin/application-client';
import { EditorView } from '@codemirror/view';
import { composerReferences, composerMarkerObjectId, isComposerMarker, mapComposerReferences, setComposerReferences, type ComposerReference } from './references';
import { composerMarkerObjects, renumberMarkerObject, setComposerMarkerObjects, type ComposerMarkerObject } from './markers';

export const COMPOSER_MARKER_MIME = 'application/x-varin-composer-markers';
interface MarkerClipboard { token: string; text: string; references: ComposerReference[]; objects: ComposerMarkerObject[] }
// Only our latest clipboard write retains resource objects. Binary Blobs never become JSON or
// an untrusted pasted resource grant. Cross-process clipboard falls back to readable plain text.
let copied: MarkerClipboard | undefined;
const clipboardListeners = new Set<(previous: readonly ContentReference[]) => void>();
export function composerClipboardReferences(): ContentReference[] {
  return (copied?.objects ?? []).flatMap(object => { const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference; return reference ? [reference] : []; });
}
export function subscribeComposerClipboard(listener: (previous: readonly ContentReference[]) => void): () => void {
  clipboardListeners.add(listener); return () => { clipboardListeners.delete(listener); };
}
export function clearComposerClipboard(): void { setClipboard(undefined); }
function setClipboard(value: MarkerClipboard | undefined) {
  const previous = composerClipboardReferences(); copied = value;
  for (const listener of clipboardListeners) listener(previous);
}
subscribeRuntimeEndpointWillChange(clearComposerClipboard);
export function composerMarkerClipboard(options: { host?: () => number | undefined; onError?: (message: string) => void; validate?: (objects: readonly ComposerMarkerObject[]) => string | undefined } = {}) {
  function copy(event: ClipboardEvent, view: EditorView, cut: boolean) {
    const selection = view.state.selection.main;
    if (selection.empty || !event.clipboardData) return false;
    const refs = view.state.field(composerReferences).filter(reference => isComposerMarker(reference) && reference.from < selection.to && reference.to > selection.from);
    if (!refs.length) { clearComposerClipboard(); return false; }
    const from = Math.min(selection.from, ...refs.map(reference => reference.from)), to = Math.max(selection.to, ...refs.map(reference => reference.to));
    const ids = new Set(refs.map(composerMarkerObjectId));
    const objects = view.state.field(composerMarkerObjects).filter(object => ids.has(object.id));
    const text = view.state.sliceDoc(from, to);
    let readable = '', end = from;
    for (const reference of refs) {
      const object = objects.find(object => object.id === composerMarkerObjectId(reference));
      readable += view.state.sliceDoc(end, reference.from) + reference.text;
      if (object?.sourceLabel) readable += ` · ${object.sourceLabel}`;
      if (object?.excerpt) readable += `\n> ${object.excerpt.replace(/\n/g, '\n> ')}\n`;
      end = reference.to;
    }
    readable += view.state.sliceDoc(end, to);
    const value = { token: crypto.randomUUID(), text, references: refs.map(reference => ({ ...reference, from: reference.from - from, to: reference.to - from })), objects };
    setClipboard(value);
    event.clipboardData.setData('text/plain', readable);
    event.clipboardData.setData(COMPOSER_MARKER_MIME, JSON.stringify({ version: 1, token: value.token }));
    event.preventDefault();
    if (cut) view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, annotations: isolateHistory.of('full'), userEvent: 'delete.cut' });
    return true;
  }
  return EditorView.domEventHandlers({
    copy: (event, view) => copy(event, view, false),
    cut: (event, view) => copy(event, view, true),
    paste(event, view) {
      const raw = event.clipboardData?.getData(COMPOSER_MARKER_MIME);
      if (!raw || !copied || view.composing) return false;
      try { const data: unknown = JSON.parse(raw); if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('token' in data) || data.token !== copied.token) return false; } catch { return false; }
      const host = options.host?.();
      if (host !== undefined && copied.objects.some(object => object.host !== host)) {
        options.onError?.('This content belongs to another Host. Copy it from its original conversation after switching back.');
        // Do not silently bind foreign resources to a coincidentally matching number.
        return false;
      }
      const error = options.validate?.(copied.objects);
      if (error) { options.onError?.(error); event.preventDefault(); return true; }
      view.dispatch(pasteMarkerClipboard(view, copied)); event.preventDefault(); return true;
    },
  });
}
function pasteMarkerClipboard(view: EditorView, value: MarkerClipboard): TransactionSpec {
  const existing = view.state.field(composerMarkerObjects), objects = [...existing];
  const mapped = new Map<string, ComposerMarkerObject>();
  for (const object of value.objects) {
    let target = objects.find(candidate => candidate.id === object.id && candidate.host === object.host && candidate.kind === object.kind);
    if (!target) {
      target = renumberMarkerObject(object, Math.max(0, ...objects.filter(candidate => candidate.kind === object.kind).map(candidate => candidate.number)) + 1);
      objects.push(target);
    }
    mapped.set(object.id, target);
  }
  let text = '', end = 0;
  const inserted: ComposerReference[] = [];
  for (const reference of value.references) {
    const object = mapped.get(composerMarkerObjectId(reference)!);
    if (!object) continue;
    text += value.text.slice(end, reference.from);
    const from = text.length;
    text += object.label;
    inserted.push({ ...reference, id: crypto.randomUUID(), from, to: text.length, text: object.label });
    end = reference.to;
  }
  text += value.text.slice(end);
  const selection = view.state.selection.main;
  // Selection ranges may come from native accessibility APIs, not just atomic cursor motion.
  const hit = view.state.field(composerReferences).filter(reference => isComposerMarker(reference) && reference.from < selection.to && reference.to > selection.from);
  const from = Math.min(selection.from, ...hit.map(reference => reference.from)), to = Math.max(selection.to, ...hit.map(reference => reference.to));
  const changes = ChangeSet.of({ from, to, insert: text }, view.state.doc.length);
  return { changes, selection: { anchor: from + text.length }, effects: [setComposerMarkerObjects.of(objects),
    setComposerReferences.of([...mapComposerReferences(view.state.field(composerReferences), changes), ...inserted.map(reference => ({ ...reference, from: reference.from + from, to: reference.to + from }))])], annotations: isolateHistory.of('full'), userEvent: 'input.paste' };
}
