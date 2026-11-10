import { ChangeSet, EditorState, StateEffect, StateField, Transaction, type TransactionSpec } from '@codemirror/state';
import { history, invertedEffects, isolateHistory } from '@codemirror/commands';
import type { StoredMedia, OutputMediaHolder, Attachment } from '@varin/protocol';
import type { ContentReference, ThreadIdentity } from '@varin/application-client';
import type { EditableImageAttachment } from '@/lib/images/annotations';
import { interactionRanges, interactionHistory, type InteractionRange } from './interactionRanges';
import type { DraftFileAttachment } from '@/stores/useThreadDraftStore';
import { composerReferences, composerMarkerObjectId, isComposerMarker, mapComposerReferences, referenceHistory, setComposerReferences, type ComposerReference } from './references';

/** Object identity is independent of both its displayed number and each occurrence. */
export interface ComposerMarkerObject {
  id: string;
  kind: 'quote' | 'image';
  number: number;
  label: string;
  host: number;
  /** Accepted file holder may differ from the content's original navigation source. */
  attachmentOwner?: ThreadIdentity;
  sourceLabel?: string;
  excerpt?: string;
  payload: { kind: 'quote'; reference: ContentReference }
    | { kind: 'image'; image: EditableImageAttachment; contentReference?: ContentReference }
    | { kind: 'attachment-image'; attachment: Attachment; identity?: ThreadIdentity; contentReference?: ContentReference }
    | { kind: 'stored-image'; media: StoredMedia; identity: ThreadIdentity; holder: OutputMediaHolder; partIndex: number; contentReference?: ContentReference }
    | { kind: 'file-image'; file: DraftFileAttachment; contentReference?: ContentReference };
}
export function sameComposerMarkerObjects(left: readonly ComposerMarkerObject[], right: readonly ComposerMarkerObject[]): boolean {
  return left === right || left.length === right.length && left.every((object, index) => {
    const other = right[index]!;
    if (object === other) return true;
    if (object.payload.kind === 'file-image' && other.payload.kind === 'file-image' && object.payload.file.data !== other.payload.file.data) return false;
    return JSON.stringify(object) === JSON.stringify(other);
  });
}

export const setComposerMarkerObjects = StateEffect.define<readonly ComposerMarkerObject[]>();
export const composerMarkerObjects = StateField.define<readonly ComposerMarkerObject[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setComposerMarkerObjects)) value = effect.value;
    return value;
  },
});
export const markerObjectHistory = invertedEffects.of(transaction => transaction.effects.some(effect => effect.is(setComposerMarkerObjects))
  ? [setComposerMarkerObjects.of(transaction.startState.field(composerMarkerObjects))] : []);
const markerTransaction = StateEffect.define<boolean>();

/** Prevent partial user deletion/replacement, including selections beginning inside a marker.
 * Generated marker transactions already provide their complete, explicitly bound ranges. */
export const atomicMarkerEditing = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || transaction.effects.some(effect => effect.is(markerTransaction)) || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
  const markers = transaction.startState.field(composerReferences).filter(isComposerMarker);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  let expanded = false;
  transaction.changes.iterChanges((from, to, _a, _b, insert) => {
    let start = from, end = to;
    for (const marker of markers) {
      if (from === to) {
        if (from > marker.from && from < marker.to) { start = end = marker.to; expanded = true; }
      } else if (from < marker.to && to > marker.from) {
        start = Math.min(start, marker.from); end = Math.max(end, marker.to);
      }
    }
    expanded ||= start !== from || end !== to;
    const previous = edits.at(-1);
    if (previous && previous.to > start) { previous.to = Math.max(previous.to, end); previous.insert += insert.toString(); }
    else edits.push({ from: start, to: end, insert: insert.toString() });
  });
  if (!expanded) return transaction;
  const changes = ChangeSet.of(edits, transaction.startState.doc.length);
  const last = edits.at(-1)!;
  return { changes, selection: { anchor: changes.mapPos(last.from, -1) + last.insert.length }, effects: transaction.effects,
    annotations: transaction.annotation(Transaction.userEvent) ? Transaction.userEvent.of(transaction.annotation(Transaction.userEvent)!) : [], scrollIntoView: transaction.scrollIntoView };
});

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Resolve to a Unicode grapheme boundary, then to the nearest edge of a bound marker. */
export function snapMarkerPosition(state: EditorState, position: number): number {
  const text = state.doc.toString();
  let at = Math.max(0, Math.min(Math.round(position), text.length));
  const line = state.doc.lineAt(at);
  for (const segment of segmenter.segment(line.text)) {
    const from = line.from + segment.index, to = from + segment.segment.length;
    if (at > from && at < to) { at = at - from < to - at ? from : to; break; }
  }
  for (const marker of state.field(composerReferences)) if (isComposerMarker(marker) && at > marker.from && at < marker.to) {
    at = at - marker.from < marker.to - at ? marker.from : marker.to; break;
  }
  return at;
}

export function renumberMarkerObject(object: ComposerMarkerObject, number: number): ComposerMarkerObject {
  if (object.number === number && (object.payload.kind === 'quote' || object.payload.kind === 'stored-image' || object.payload.kind === 'attachment-image' || object.payload.kind === 'image' && object.payload.image.reference === number || object.payload.kind === 'file-image' && object.payload.file.imageReference === number)) return object;
  const label = /\d+\]$/.test(object.label) ? object.label.replace(/\d+\]$/, `${number}]`) : object.kind === 'image' ? `[图片${number}]` : `[引用点${number}]`;
  const payload = object.payload.kind === 'quote' ? { ...object.payload, reference: { ...object.payload.reference, number } }
    : object.payload.kind === 'image' ? { ...object.payload, image: { ...object.payload.image, reference: number } }
      : object.payload.kind === 'file-image' ? { ...object.payload, file: { ...object.payload.file, imageReference: number } } : object.payload;
  return { ...object, number, label, payload };
}

export function insertComposerMarker(state: EditorState, incoming: ComposerMarkerObject, position = state.selection.main.head, occurrenceId: string = crypto.randomUUID()): TransactionSpec {
  const objects = state.field(composerMarkerObjects);
  const existing = objects.find(object => object.id === incoming.id && object.kind === incoming.kind && object.host === incoming.host);
  const object = existing ?? renumberMarkerObject(incoming, Math.max(0, ...objects.filter(object => object.kind === incoming.kind).map(object => object.number)) + 1);
  const from = snapMarkerPosition(state, position), text = object.label;
  const changes = ChangeSet.of({ from, insert: text }, state.doc.length);
  const reference: ComposerReference = { id: occurrenceId, host: object.host, from, to: from + text.length, text,
    target: object.kind === 'quote' ? { kind: 'quote', quoteId: object.id } : { kind: 'image', imageId: object.id } };
  return { changes, selection: { anchor: reference.to }, effects: [markerTransaction.of(true),
    setComposerReferences.of([...mapComposerReferences(state.field(composerReferences), changes), reference]),
    ...(existing ? [] : [setComposerMarkerObjects.of([...objects, object])])], annotations: isolateHistory.of('full'), userEvent: 'input.marker' };
}

export function moveComposerMarker(state: EditorState, id: string, destination: number): TransactionSpec | null {
  const reference = state.field(composerReferences).find(item => item.id === id && isComposerMarker(item));
  if (!reference) return null;
  const to = snapMarkerPosition(state, destination);
  if (to >= reference.from && to <= reference.to) return null;
  const changes = ChangeSet.of([{ from: reference.from, to: reference.to, insert: '' }, { from: to, insert: reference.text }], state.doc.length);
  const from = to > reference.to ? to - reference.text.length : to;
  return { changes, selection: { anchor: from + reference.text.length },
    effects: [markerTransaction.of(true), setComposerReferences.of([...mapComposerReferences(state.field(composerReferences), changes), { ...reference, from, to: from + reference.text.length }])],
    annotations: isolateHistory.of('full'), userEvent: 'move.marker' };
}

/** Object removal and all corresponding relabels are one reversible transaction. */
export function replaceComposerMarkerObjects(state: EditorState, incoming: readonly ComposerMarkerObject[], options: { renumber?: boolean } = {}): TransactionSpec | null {
  const counters = { quote: 0, image: 0 };
  const objects = options.renumber === false ? [...incoming] : incoming.map(object => renumberMarkerObject(object, ++counters[object.kind]));
  const byId = new Map(objects.map(object => [object.id, object]));
  const references = state.field(composerReferences);
  const edits = references.filter(isComposerMarker).flatMap(reference => {
    const object = byId.get(composerMarkerObjectId(reference)!);
    const insert = object?.label ?? '';
    return insert === reference.text ? [] : [{ from: reference.from, to: reference.to, insert }];
  });
  if (!edits.length && sameComposerMarkerObjects(objects, state.field(composerMarkerObjects))) return null;
  const changes = ChangeSet.of(edits, state.doc.length);
  const next = references.flatMap(reference => {
    if (!isComposerMarker(reference)) return mapComposerReferences([reference], changes);
    const object = byId.get(composerMarkerObjectId(reference)!);
    if (!object) return [];
    const from = changes.mapPos(reference.from, -1);
    return [{ ...reference, from, to: from + object.label.length, text: object.label }];
  });
  return { changes, effects: [markerTransaction.of(true), setComposerMarkerObjects.of(objects), setComposerReferences.of(next)], annotations: isolateHistory.of('full'), userEvent: 'delete.attachment' };
}

/** Also used when async preparation finishes after its editor has unmounted. */
export function createComposerMarkerState(draft: { text: string; references?: readonly ComposerReference[]; markerObjects?: readonly ComposerMarkerObject[]; interactions?: readonly InteractionRange[] }): EditorState {
  return EditorState.create({ doc: draft.text, extensions: [history(), composerReferences.init(() => draft.references ?? []), referenceHistory,
    composerMarkerObjects.init(() => draft.markerObjects ?? []), markerObjectHistory, interactionRanges.init(() => draft.interactions ?? []), interactionHistory, atomicMarkerEditing] });
}
