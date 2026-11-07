import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import type { ThreadDraft } from '@/stores/useThreadDraftStore';
import { mapComposerReferences } from '@/components/chat/composer/editor/references';
import { mapInteractionRanges } from '@/components/chat/composer/editor/interactionRanges';

export function imageReferenceRanges(text: string) {
  return [...text.matchAll(/\[(Image |图片|圖片)([1-9]\d*)\]/g)].map(match => ({
    from: match.index!, to: match.index! + match[0].length, number: Number(match[2]), prefix: match[1]!, text: match[0],
  }));
}
export function draftImageReferences(draft: Pick<ThreadDraft, 'images' | 'files'>): number[] {
  return [...draft.images.map(image => image.reference), ...(draft.files ?? []).map(file => file.imageReference)].filter((number): number is number => number !== undefined).sort((a, b) => a - b);
}
export const nextImageReference = (draft: Pick<ThreadDraft, 'images' | 'files'>) => Math.max(0, ...draftImageReferences(draft)) + 1;

/** Only the current unsent attachments change labels; accepted inputs retain their identities. */
export function renumberDraftImages(draft: ThreadDraft, retained: Pick<ThreadDraft, 'images' | 'files'>): Partial<ThreadDraft> {
  const numbers = new Map(draftImageReferences(retained).map((number, index) => [number, index + 1]));
  const original = new Set(draftImageReferences(draft));
  const edits = imageReferenceRanges(draft.text).flatMap(token => {
    if (!original.has(token.number)) return [];
    const next = numbers.get(token.number);
    return next === token.number ? [] : [{ from: token.from, to: token.to, insert: next === undefined ? '' : `[${token.prefix}${next}]` }];
  });
  const changes = ChangeSet.of(edits, draft.text.length);
  let text = draft.text;
  for (const edit of [...edits].reverse()) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return {
    images: retained.images.map(image => image.reference === undefined || numbers.get(image.reference) === image.reference ? image : { ...image, reference: numbers.get(image.reference)! }),
    files: retained.files?.map(file => file.imageReference === undefined || numbers.get(file.imageReference) === file.imageReference ? file : { ...file, imageReference: numbers.get(file.imageReference)! }),
    text,
    ...(draft.references ? { references: mapComposerReferences(draft.references, changes) } : {}),
    ...(draft.interactions ? { interactions: mapInteractionRanges(draft.interactions, changes) } : {}),
  };
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
