import {
  parseVarinContextBudgetDescription, parseVarinContextBudgetInput, parseVarinContextBudgetDecision,
  VARIN_CONTEXT_BUDGET_SERVICE, VARIN_CONTEXT_BUDGET_CONTRACT,
  type JsonValue, type VarinContextBudgetDescription, type VarinContextBudgetInput, type VarinContextBudgetDecision,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';
export interface VarinContextBudgetImplementation extends VarinContextBudgetDescription {
  /** Pure metadata-only decision. Return a core-supplied ancestor and optional summary guidance.
   * Do not call models, tools, retrieval or external services here. Core owns generation and usage. */
  decide(input: Readonly<VarinContextBudgetInput>, signal: AbortSignal, configuration: JsonValue): VarinContextBudgetDecision | Promise<VarinContextBudgetDecision>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function provideContextBudget(context: VarinBrokeredHostContext, implementation: VarinContextBudgetImplementation): void {
  const description = freeze(parseVarinContextBudgetDescription({ identity: implementation.identity, configuration: implementation.configuration }));
  context.services.provide(structuredClone(VARIN_CONTEXT_BUDGET_SERVICE), {
    inspect: args => {
      if (args.length) throw new Error('Context budget inspect takes no arguments');
      return structuredClone(VARIN_CONTEXT_BUDGET_CONTRACT) as unknown as JsonValue;
    },
    describe: args => {
      if (args.length) throw new Error('Context budget describe takes no arguments');
      return structuredClone(description) as unknown as JsonValue;
    },
    decide: async (args, call) => {
      if (args.length !== 1) throw new Error('Context budget decide takes one metadata view');
      call.signal.throwIfAborted();
      const result = await implementation.decide(freeze(parseVarinContextBudgetInput(args[0])), call.signal, description.configuration);
      call.signal.throwIfAborted();
      return parseVarinContextBudgetDecision(result) as unknown as JsonValue;
    },
  });
}
