import {
  parseVarinContextFragments, VARIN_CONTEXT_FRAGMENTS_METHOD, VARIN_CONTEXT_FRAGMENTS_CONTRACT,
  VARIN_CONTEXT_FRAGMENTS_SERVICE,
  type VarinContextFragments,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';

/** Register a frozen declarative Transform through the ordinary owner/permission lifecycle.
 * No callbacks, model calls, network, filesystem access or mutable conversation objects are
 * accepted by this author contract. Package activation itself remains a trust boundary.
 */
export function provideContextFragments(context: VarinBrokeredHostContext, fragments: VarinContextFragments): void {
  const prepared = parseVarinContextFragments(fragments);
  context.services.provide(JSON.parse(JSON.stringify(VARIN_CONTEXT_FRAGMENTS_SERVICE)), {
    inspect: args => {
      if (args.length !== 0) throw new Error('Context fragments inspect takes no arguments');
      return JSON.parse(JSON.stringify(VARIN_CONTEXT_FRAGMENTS_CONTRACT));
    },
    [VARIN_CONTEXT_FRAGMENTS_METHOD]: args => {
      if (args.length !== 0) throw new Error('Context fragments describe takes no arguments');
      return { sections: prepared.sections.map(section => ({ ...section })) };
    },
  });
}
