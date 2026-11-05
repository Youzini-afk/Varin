import { StateEffect, StateField, type ChangeDesc, type TransactionSpec } from '@codemirror/state';
import { invertedEffects, isolateHistory } from '@codemirror/commands';

export class ComposerClosedError extends Error {
  constructor(readonly cursor: number) { super('Composer closed during composition'); }
}

/** Editable text and its source are deliberately separate: editing drops automatic
 * replacement, not the already captured source attachment. */
export interface InteractionRange { sourceKey: string; from: number; to: number; text: string }
export const setInteractionRanges = StateEffect.define<readonly InteractionRange[]>();
export const upsertInteractionRange = StateEffect.define<InteractionRange>();
export function mapInteractionRanges(values: readonly InteractionRange[], changes: ChangeDesc): InteractionRange[] {
  return values.flatMap(value => {
    let edited = false;
    changes.iterChangedRanges((from, to) => {
      if (from === to ? from > value.from && from < value.to : from < value.to && to > value.from) edited = true;
    });
    return edited ? [] : [{ ...value, from: changes.mapPos(value.from, 1), to: changes.mapPos(value.to, -1) }];
  });
}
export const interactionRanges = StateField.define<readonly InteractionRange[]>({
  create: () => [],
  update(values, transaction) {
    let next = transaction.docChanged ? mapInteractionRanges(values, transaction.changes) : values;
    for (const effect of transaction.effects) {
      if (effect.is(setInteractionRanges)) next = effect.value;
      if (effect.is(upsertInteractionRange)) next = [...next.filter(value => value.sourceKey !== effect.value.sourceKey), effect.value];
    }
    return next.filter(value => value.from >= 0 && value.to <= transaction.newDoc.length && value.from < value.to
      && transaction.newDoc.sliceString(value.from, value.to) === value.text);
  },
});
export const interactionHistory = invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(upsertInteractionRange))
  ? [setInteractionRanges.of(transaction.startState.field(interactionRanges))] : []);

export function interactionInsertion(doc: string, values: readonly InteractionRange[], sourceKey: string, text: string, cursor = doc.length): {
  spec: TransactionSpec; range: InteractionRange; updated: boolean;
} {
  const previous = values.find(value => value.sourceKey === sourceKey && doc.slice(value.from, value.to) === value.text);
  const from = previous?.from ?? Math.min(Math.max(cursor, 0), doc.length), to = previous?.to ?? from;
  const prefix = previous || from === 0 || doc.slice(0, from).endsWith('\n\n') ? '' : doc[from - 1] === '\n' ? '\n' : '\n\n';
  const suffix = previous || to === doc.length || doc.slice(to).startsWith('\n\n') ? '' : doc[to] === '\n' ? '\n' : '\n\n';
  const range = { sourceKey, from: from + prefix.length, to: from + prefix.length + text.length, text };
  return { updated: Boolean(previous), range, spec: { changes: { from, to, insert: prefix + text + suffix },
    effects: upsertInteractionRange.of(range), annotations: isolateHistory.of('full'), userEvent: 'input.interaction' } };
}
