import {
  parseVarinRetrievalPlan, VARIN_RETRIEVAL_PLAN_CONTRACT, VARIN_RETRIEVAL_PLAN_METHOD,
  VARIN_RETRIEVAL_PLAN_SERVICE, type VarinRetrievalPlan,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';

/** @deprecated The native retrieval Agent no longer consumes staged retrieval plans.
 * Retained for source compatibility and explicit custom service consumers only; registration
 * does not change code_retrieval. Use ordinary Agent policy/context/tool contracts instead. */
export function provideRetrievalPlan(context: VarinBrokeredHostContext, plan: VarinRetrievalPlan): void {
  const prepared = Object.freeze(parseVarinRetrievalPlan(plan));
  context.services.provide(structuredClone(VARIN_RETRIEVAL_PLAN_SERVICE), {
    inspect: args => {
      if (args.length !== 0) throw new Error('Retrieval plan inspect takes no arguments');
      return JSON.parse(JSON.stringify(VARIN_RETRIEVAL_PLAN_CONTRACT));
    },
    [VARIN_RETRIEVAL_PLAN_METHOD]: args => {
      if (args.length !== 0) throw new Error('Retrieval plan describe takes no arguments');
      return { ...prepared };
    },
  });
}
