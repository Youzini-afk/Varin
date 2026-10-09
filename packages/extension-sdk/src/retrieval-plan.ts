import {
  parseVarinRetrievalPlan, VARIN_RETRIEVAL_PLAN_CONTRACT, VARIN_RETRIEVAL_PLAN_METHOD,
  VARIN_RETRIEVAL_PLAN_SERVICE_ID, VARIN_RETRIEVAL_PLAN_VERSION, type VarinRetrievalPlan,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';

/** Publish an immutable declaration through the ordinary Host owner/permission lifecycle.
 * describe receives no question, source text, path, credentials or model capability. */
export function provideRetrievalPlan(context: VarinBrokeredHostContext, plan: VarinRetrievalPlan): void {
  const prepared = Object.freeze(parseVarinRetrievalPlan(plan));
  context.services.provide({ id: VARIN_RETRIEVAL_PLAN_SERVICE_ID, version: VARIN_RETRIEVAL_PLAN_VERSION, multiple: true }, {
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
