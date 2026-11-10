import { type ChangeSpec } from '@codemirror/state';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { createComposerMarkerState, replaceComposerMarkerObjects, composerMarkerObjects, type ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { composerReferences } from '@/components/chat/composer/editor/references';
import { interactionRanges } from '@/components/chat/composer/editor/interactionRanges';
import type { ThreadDraft } from '@/stores/useThreadDraftStore';

export function imageReferenceRanges(text: string) {
  return [...text.matchAll(/\[(Image |图片|圖片)([1-9]\d*)\]/g)].map(match => ({
    from: match.index!, to: match.index! + match[0].length, number: Number(match[2]), prefix: match[1]!, text: match[0],
  }));
}
export function draftImageReferences(draft: Pick<ThreadDraft, 'images' | 'files' | 'markerObjects'>): number[] {
  return [...new Set([...draft.images.map(image => image.reference), ...(draft.files ?? []).map(file => file.imageReference), ...(draft.markerObjects ?? []).filter(object => object.kind === 'image').map(object => object.number)].filter((number): number is number => number !== undefined))].sort((a, b) => a - b);
}
export const nextImageReference = (draft: Pick<ThreadDraft, 'images' | 'files' | 'markerObjects'>) => Math.max(0, ...draftImageReferences(draft)) + 1;

/** Existing attachment owners seed objects once. No regex grants a typed label object identity. */
export function draftImageMarkerObjects(draft: ThreadDraft, label = (number: number) => `[图片${number}]`): ComposerMarkerObject[] {
  const objects = [...(draft.markerObjects ?? [])];
  for (const image of draft.images) {
    const index = objects.findIndex(object => object.payload.kind === 'image' && (object.payload.image === image || image.draftId === object.id));
    if (index >= 0) {
      const object = objects[index]!;
      if (object.payload.kind === 'image' && object.payload.image !== image) objects[index] = { ...object, payload: { ...object.payload, image } };
      continue;
    }
    const id = image.draftId ?? crypto.randomUUID(), number = image.reference ?? 1;
    objects.push({ id, kind: 'image', number, label: label(number), host: getRuntimeEndpointGeneration(), payload: { kind: 'image', image: { ...image, draftId: id } } });
  }
  for (const file of draft.files ?? []) {
    if (file.imageReference === undefined) continue;
    const index = objects.findIndex(object => object.payload.kind === 'file-image' && object.payload.file.id === file.id);
    if (index >= 0) {
      const object = objects[index]!;
      if (object.payload.kind === 'file-image' && object.payload.file !== file) objects[index] = { ...object, payload: { ...object.payload, file } };
      continue;
    }
    objects.push({ id: file.id, kind: 'image', number: file.imageReference, label: label(file.imageReference), host: getRuntimeEndpointGeneration(), payload: { kind: 'file-image', file } });
  }
  return objects.sort((a, b) => a.kind === b.kind ? a.number - b.number : a.kind === 'quote' ? -1 : 1);
}

/** Only explicit bound ranges are relabeled. Typed examples always remain user text. */
export function renumberDraftImages(draft: ThreadDraft, retained: Pick<ThreadDraft, 'images' | 'files'>): Partial<ThreadDraft> {
  const objects = draftImageMarkerObjects(draft);
  const retainedImages = new Set(retained.images), retainedIds = new Set(retained.images.map(image => image.draftId).filter(Boolean)), retainedFiles = new Set(retained.files?.map(file => file.id));
  const keep = objects.filter(object => {
    const payload = object.payload;
    if (payload.kind === 'image') return retainedImages.has(payload.image) || retainedIds.has(object.id)
      || draft.images.some(image => retainedImages.has(image) && (image.draftId === object.id || image === payload.image || !image.draftId && image.reference === object.number));
    return payload.kind !== 'file-image' || retainedFiles.has(payload.file.id);
  });
  const state = createComposerMarkerState({ ...draft, markerObjects: objects });
  const spec = replaceComposerMarkerObjects(state, keep), next = spec ? state.update(spec).state : state;
  const markerObjects = next.field(composerMarkerObjects);
  return { text: next.doc.toString(), references: next.field(composerReferences), interactions: next.field(interactionRanges), markerObjects,
    images: markerObjects.flatMap(object => object.payload.kind === 'image' ? [object.payload.image] : []),
    files: retained.files?.map(file => markerObjects.find(object => object.payload.kind === 'file-image' && object.payload.file.id === file.id)?.payload).map((payload, i) => payload?.kind === 'file-image' ? payload.file : retained.files![i]!), editorState: next };
}

/** Apply relabeling as separate edits so intervening @ references and the caret keep their positions. */
export function imageReferenceTextChanges(before: string, after: string): ChangeSpec[] | undefined {
  const split = (text: string) => {
    const groups: Array<{ offset: number; from: number; to: number; text: string }> = [];
    let plain = '', end = 0;
    for (const token of imageReferenceRanges(text)) {
      plain += text.slice(end, token.from);
      const last = groups.at(-1);
      if (last?.to === token.from) { last.to = token.to; last.text += token.text; }
      else groups.push({ offset: plain.length, from: token.from, to: token.to, text: token.text });
      end = token.to;
    }
    return { plain: plain + text.slice(end), groups };
  };
  const a = split(before), b = split(after);
  if (a.plain !== b.plain) return undefined;
  return [...new Set([...a.groups, ...b.groups].map(group => group.offset))].sort((a, b) => a - b).flatMap(offset => {
    const old = a.groups.find(group => group.offset === offset), next = b.groups.find(group => group.offset === offset);
    if (old?.text === next?.text) return [];
    const from = old?.from ?? offset + a.groups.filter(group => group.offset < offset).reduce((sum, group) => sum + group.text.length, 0);
    return [{ from, to: old?.to ?? from, insert: next?.text ?? '' }];
  });
}
