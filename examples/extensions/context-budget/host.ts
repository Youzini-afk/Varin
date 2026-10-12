import { defineHostExtension, provideContextBudget } from '@varin/extension-sdk';
import type { VarinContextBudgetCandidate } from '@varin/extension-contract';
import metadata from './package.json';

const configuration = {
  summaryInstructions: 'Preserve source references, concrete outcomes and comparison baselines. '
    + 'Distinguish observed evidence from hypotheses and unresolved questions. '
    + 'Keep unverified sources and uncertain results explicitly uncertain; do not invent evidence.',
};

export default defineHostExtension({
  activate(context) {
    provideContextBudget(context, {
      identity: { name: 'closest-recent-evidence', version: metadata.version },
      configuration,
      decide(input, signal, declaredConfiguration) {
        signal.throwIfAborted();
        const { estimatedTokens } = input.estimate;
        const { inputBudgetTokens, settings } = input;
        // Use the current core settings, including the same strict waterline crossing.
        // A zero input budget has no meaningful preparation waterline.
        if (inputBudgetTokens === 0) return { kind: 'continue' };
        const mode = estimatedTokens > inputBudgetTokens ? 'blocking'
          : settings.backgroundPreparation
            && estimatedTokens > inputBudgetTokens * settings.preparationWaterline ? 'background'
            : undefined;
        if (!mode) return { kind: 'continue' };

        // Core supplies legal, tool-pair-safe prefixes. Do not infer boundaries from IDs
        // or mutate their order. Equal distances favor retaining more recent history.
        let selected: VarinContextBudgetCandidate | undefined;
        for (const candidate of input.candidates) {
          const distance = Math.abs(candidate.retainedEstimatedTokens - settings.keepRecentTokens);
          const previousDistance = selected
            ? Math.abs(selected.retainedEstimatedTokens - settings.keepRecentTokens) : Infinity;
          if (distance < previousDistance
            || distance === previousDistance && selected
              && candidate.retainedEstimatedTokens > selected.retainedEstimatedTokens) {
            selected = candidate;
          }
        }
        if (!selected) return { kind: 'continue' };

        // The SDK freezes this exact JSON declaration. Core generates the actual summary.
        const { summaryInstructions } = declaredConfiguration as typeof configuration;
        return { kind: 'compact', throughId: selected.throughId, mode, summaryInstructions };
      },
    });
  },
});
