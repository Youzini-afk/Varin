import { afterEach, expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import { getRuntimeEndpointGeneration, parseContentReferenceInput, projectContentReferenceText, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { composerReferences } from '@/components/chat/composer/editor/references';
import { moveComposerMarker } from '@/components/chat/composer/editor/markers';
import { acknowledgeDraftMarkers, freezeDraftContentReferences, insertDraftMarker, referenceMarkerObject, removeDraftMarker, restoreDraftReferences, saveComposerState } from './contentReferences';
import { beginContentReferenceInsertion } from './attachments';
import { useI18nStore } from '@/lib/i18n';
import { dict as enDictionary } from '@/lib/i18n/messages/en';
import { dict as zhDictionary } from '@/lib/i18n/messages/zh-CN';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'chat', branchId: 'main' };
const key = () => threadComposerKey(threadHostKey(), identity);
const reference = (ref: string, text: string): ContentReference => ({ ref, title: 'Varin', label: 'Varin', text,
  source: { kind: 'chat', thread: identity, itemId: `entry:${ref}`, passages: [], role: 'assistant' } });
afterEach(() => { useThreadDraftStore.setState({ drafts: {} }); useI18nStore.setState({ locale: 'en', dictionary: enDictionary }); });

it('freezes explicit occurrences in original text order while retaining markerless content once', async () => {
  const store = useThreadDraftStore.getState(); store.patch(key(), { text: 'literal [Reference 1]: ' });
  const first = referenceMarkerObject(reference('quote-one', 'First fixed source'));
  const second = referenceMarkerObject(reference('quote-two', 'Second fixed source'));
  await insertDraftMarker(key(), first); await insertDraftMarker(key(), second); await insertDraftMarker(key(), first);
  let draft = store.drafts[key()] ?? useThreadDraftStore.getState().drafts[key()];
  const original = freezeDraftContentReferences(draft);
  expect(original.contentReferences?.map(value => value.text)).toEqual(['First fixed source', 'Second fixed source']);
  expect(original.contentReferenceOccurrences).toHaveLength(3);
  expect(original.contentReferenceOccurrences?.[0]?.start).toBe('literal [Reference 1]: '.length);
  let state = draft.editorState!;
  const last = state.field(composerReferences).at(-1)!;
  state = state.update(moveComposerMarker(state, last.id, 0)!).state; saveComposerState(key(), state);
  draft = useThreadDraftStore.getState().drafts[key()];
  expect(freezeDraftContentReferences(draft).contentReferenceOccurrences?.map(value => value.kind === 'content' && value.ref)).toEqual(['quote-one', 'quote-one', 'quote-two']);
  expect(original.contentReferenceOccurrences?.[0]?.start).toBe('literal [Reference 1]: '.length);
  // Removing a position doesn't remove the independently retained source object.
  const occurrence = state.field(composerReferences).find(value => value.target.kind === 'quote' && value.target.quoteId === 'quote-two')!;
  saveComposerState(key(), state.update({ changes: { from: occurrence.from, to: occurrence.to } }).state);
  expect(freezeDraftContentReferences(useThreadDraftStore.getState().drafts[key()]).contentReferences).toHaveLength(2);
});

it('keeps source objects and visible numbering together through attachment removal and undo', async () => {
  await insertDraftMarker(key(), referenceMarkerObject(reference('one', 'First')));
  await insertDraftMarker(key(), referenceMarkerObject(reference('two', 'Second')));
  const before = useThreadDraftStore.getState().drafts[key()];
  removeDraftMarker(key(), 'one');
  let after = useThreadDraftStore.getState().drafts[key()];
  expect(after.markerObjects?.map(object => [object.id, object.number])).toEqual([['two', 1]]);
  let state = after.editorState!;
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  saveComposerState(key(), state); after = useThreadDraftStore.getState().drafts[key()];
  expect(after.text).toBe(before.text);
  expect(freezeDraftContentReferences(after)).toEqual(freezeDraftContentReferences(before));
});

it('consumes only the accepted occurrences and leaves newly inserted references in a changed draft', async () => {
  const object = referenceMarkerObject(reference('same', 'Original'));
  await insertDraftMarker(key(), object);
  const original = useThreadDraftStore.getState().drafts[key()];
  useThreadDraftStore.getState().patch(key(), draft => ({ text: `${draft.text} later ` }));
  await insertDraftMarker(key(), object);
  const current = useThreadDraftStore.getState().drafts[key()];
  const ack = acknowledgeDraftMarkers(current, original.text, original.markerObjects?.map(object => object.id), original.references?.map(reference => reference.id));
  useThreadDraftStore.getState().patch(key(), ack);
  const retained = useThreadDraftStore.getState().drafts[key()];
  expect(retained.text).toBe(` later ${object.label}`);
  expect(retained.references).toHaveLength(1);
  expect(retained.markerObjects).toHaveLength(1);
  expect(freezeDraftContentReferences(retained).contentReferences?.[0]?.text).toBe('Original');
});

it('maps asynchronous capture to its original unmounted draft and never a newly selected conversation', async () => {
  const store = useThreadDraftStore.getState(); store.patch(key(), { text: 'before' });
  const insertion = beginContentReferenceInsertion(identity);
  store.patch(key(), { text: 'edited before' });
  store.patch('another-chat', { text: 'unrelated' });
  insertion.add(reference('async', 'Captured at click')); insertion.dispose();
  await Promise.resolve();
  const draft = useThreadDraftStore.getState().drafts[key()];
  expect(draft.text).toBe('edited before[Reference 1]');
  expect(useThreadDraftStore.getState().drafts['another-chat'].text).toBe('unrelated');
});

it('restores attachment image bindings without inventing image bytes or matching literal marker names', () => {
  const ref = 'attachment:original';
  const restored = restoreDraftReferences({ editorText: '[Image 5] and literal [Image 5]', editorAttachments: [{ ref, filename: 'source.png', mimeType: 'image/png', byteLength: 42 }],
    editorAttachmentImageReferences: { [ref]: 5 }, editorContentReferenceOccurrences: [{ kind: 'image', reference: 5, start: 0, end: 9 }] });
  expect(restored.markerObjects?.[0]).toMatchObject({ host: getRuntimeEndpointGeneration(), kind: 'image', number: 5, payload: { kind: 'attachment-image', attachment: { ref } } });
  expect(restored.references).toHaveLength(1);
  expect(restored.images).toEqual([]);
  expect(freezeDraftContentReferences({ text: restored.text!, references: restored.references, markerObjects: restored.markerObjects }).contentReferenceOccurrences).toEqual([{ kind: 'image', reference: 5, start: 0, end: 9 }]);
});

it('keeps a newly reinserted occurrence even when its text equals the accepted snapshot', async () => {
  const object = referenceMarkerObject(reference('same-label', 'Fixed content'));
  await insertDraftMarker(key(), object);
  const original = useThreadDraftStore.getState().drafts[key()];
  const range = original.references![0]!;
  saveComposerState(key(), original.editorState!.update({ changes: { from: range.from, to: range.to } }).state);
  await insertDraftMarker(key(), object);
  const current = useThreadDraftStore.getState().drafts[key()];
  expect(current.text).toBe(original.text);
  expect(current.references![0]!.id).not.toBe(range.id);
  useThreadDraftStore.getState().patch(key(), acknowledgeDraftMarkers(current, original.text, [object.id], [range.id]));
  expect(useThreadDraftStore.getState().drafts[key()].text).toBe(original.text);
  expect(useThreadDraftStore.getState().drafts[key()].markerObjects).toHaveLength(1);
});

it.each(['en', 'zh-CN'] as const)('admits actual %s editor-generated quote and image ranges with Unicode and literal lookalikes', async locale => {
  useI18nStore.setState({ locale, dictionary: locale === 'en' ? enDictionary : zhDictionary });
  const prefix = '🧭中文 e\u0301 literal [Reference 1] / [引用点 1] / [Image 1]：';
  useThreadDraftStore.getState().patch(key(), { text: prefix });
  const quoted = { ...reference('locale-quote', 'Exact selected paragraph'), source: { kind: 'chat' as const, thread: identity,
    itemId: 'private-item-id', href: 'private-source-url', passages: [], role: 'assistant' as const } };
  const quoteObject = referenceMarkerObject(quoted);
  const imageObject = referenceMarkerObject({ ...reference('locale-image', ''), image: { mimeType: 'image/png', data: 'AQID' } });
  await insertDraftMarker(key(), quoteObject); await insertDraftMarker(key(), imageObject);
  const draft = useThreadDraftStore.getState().drafts[key()];
  expect(draft.text).toBe(prefix + quoteObject.label + imageObject.label);
  const frozen = freezeDraftContentReferences(draft);
  const parsed = parseContentReferenceInput(frozen, draft.text);
  expect(parsed).toMatchObject(frozen);
  expect(parsed.contentReferenceOccurrences).toEqual([
    { kind: 'content', ref: quoted.ref, start: prefix.length, end: prefix.length + quoteObject.label.length },
    { kind: 'image', reference: 1, start: prefix.length + quoteObject.label.length, end: draft.text.length },
  ]);
  expect(parsed.contentReferences?.find(item => item.ref === 'locale-image')?.imageReference).toBe(1);
  expect(draft.images[0]).toMatchObject({ mimeType: 'image/png', data: 'AQID', reference: 1 });
  const model = projectContentReferenceText(draft.text, parsed);
  expect(model).toContain('Exact selected paragraph');
  expect(model).not.toContain('private-item-id'); expect(model).not.toContain('private-source-url'); expect(model).not.toContain('locale-quote');
  expect(model.startsWith(prefix)).toBe(true);
});

it('keeps the retained file selection when a later occurrence still uses the accepted image object', async () => {
  const restored = restoreDraftReferences({ identity, editorText: '[Image 4]', editorAttachments: [{ ref: 'attachment:kept', filename: 'fixed.png', mimeType: 'image/png', byteLength: 9 }],
    editorAttachmentImageReferences: { 'attachment:kept': 4 }, editorContentReferenceOccurrences: [{ kind: 'image', reference: 4, start: 0, end: 9 }] });
  useThreadDraftStore.getState().patch(key(), restored);
  const original = useThreadDraftStore.getState().drafts[key()];
  useThreadDraftStore.getState().patch(key(), { text: `${original.text} later ` });
  await insertDraftMarker(key(), original.markerObjects![0]!);
  const current = useThreadDraftStore.getState().drafts[key()];
  useThreadDraftStore.getState().patch(key(), acknowledgeDraftMarkers(current, original.text, original.markerObjects?.map(object => object.id), original.references?.map(reference => reference.id), { selectedAttachmentIds: original.selectedAttachments?.map(file => file.id) }));
  const next = useThreadDraftStore.getState().drafts[key()];
  expect(next.markerObjects).toHaveLength(1);
  expect(next.selectedAttachments?.[0]?.selection).toEqual({ ref: 'attachment:kept' });
  expect(freezeDraftContentReferences(next).contentReferences?.[0]).toMatchObject({ imageReference: 4, attachment: { ref: 'attachment:kept' } });
});
