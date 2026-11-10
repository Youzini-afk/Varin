import { StateEffect, StateField, type ChangeDesc } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView } from '@codemirror/view';
import type { ThreadIdentity, ThreadSkillLocator } from '@varin/application-client';

export type ComposerReferenceTarget =
  | { kind: 'quote'; quoteId: string }
  | { kind: 'image'; imageId: string }
  | { kind: 'skill'; version: string; resourceId: string; locator?: ThreadSkillLocator }
  | { kind: 'thread'; identity: ThreadIdentity }
  | { kind: 'file' | 'directory'; path: string; workspacePath: string; sourceKey?: string }
  | { kind: 'attachment'; attachment: import('@varin/protocol').Attachment }
  | { kind: 'draft-file'; fileId: string }
  | { kind: 'backend-command'; name: string; backend: string };
export interface ComposerReference {
  id: string;
  from: number;
  to: number;
  text: string;
  /** A reference is valid only on the Host that produced its candidate. */
  host: number;
  target: ComposerReferenceTarget;
}
export const isComposerMarker = (reference: ComposerReference): boolean => reference.target.kind === 'quote' || reference.target.kind === 'image';
export const composerMarkerObjectId = (reference: ComposerReference): string | undefined => reference.target.kind === 'quote' ? reference.target.quoteId : reference.target.kind === 'image' ? reference.target.imageId : undefined;

export const setComposerReferences = StateEffect.define<readonly ComposerReference[]>({ map: (value, changes) => mapComposerReferences(value, changes) });
export const addComposerReference = StateEffect.define<ComposerReference>();

export function mapComposerReferences(references: readonly ComposerReference[], changes: ChangeDesc): ComposerReference[] {
  return references.flatMap(reference => {
    let touched = false;
    changes.iterChangedRanges((from, to) => {
      if (from === to ? from > reference.from && from < reference.to : from < reference.to && to > reference.from) touched = true;
    });
    if (touched) return [];
    return [{ ...reference, from: changes.mapPos(reference.from, 1), to: changes.mapPos(reference.to, -1) }];
  });
}
export const composerReferences = StateField.define<readonly ComposerReference[]>({
  create: () => [],
  update(value, transaction) {
    let next = transaction.docChanged ? mapComposerReferences(value, transaction.changes) : value;
    for (const effect of transaction.effects) {
      if (effect.is(setComposerReferences)) next = effect.value;
      if (effect.is(addComposerReference)) next = [...next, effect.value];
    }
    return next.filter(item => item.from >= 0 && item.to <= transaction.newDoc.length && item.from < item.to
      && transaction.newDoc.sliceString(item.from, item.to) === item.text).sort((a, b) => a.from - b.from);
  },
  provide: field => [EditorView.decorations.from(field, references => Decoration.set(references.map(item => Decoration.mark({
    class: isComposerMarker(item) ? 'cm-bound-marker' : item.target.kind === 'skill' ? 'text-[var(--primary)]' : item.target.kind === 'thread' ? 'text-[var(--status-success)]' : 'text-[var(--status-info)]',
    attributes: { 'data-composer-reference': item.id, ...(isComposerMarker(item) ? { 'data-composer-marker': 'true', tabindex: '0', role: 'button', 'aria-label': item.text } : {}) },
  }).range(item.from, item.to)), true)), EditorView.atomicRanges.of(view => Decoration.set(view.state.field(field).filter(isComposerMarker).map(item => Decoration.mark({}).range(item.from, item.to)), true))],
});
export const referenceHistory = invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(setComposerReferences) || effect.is(addComposerReference))
  ? [setComposerReferences.of(transaction.startState.field(composerReferences))] : []);
