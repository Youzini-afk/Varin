import {
  parseVarinContextCompactionDescription, parseVarinContextCompactionInput, parseVarinContextCompactionPlan,
  VARIN_CONTEXT_COMPACTION_SERVICE, VARIN_CONTEXT_COMPACTION_CONTRACT,
  type JsonValue, type VarinContextCompactionDescription, type VarinContextCompactionInput, type VarinContextCompactionPlan,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';
export interface VarinContextCompactionImplementation extends VarinContextCompactionDescription {
  /** Pure computation over quoted source data. No model calls, tools, retrieval or history writes.
   * Return direct text or a model plan; the original ContextJob executes and commits it. */
  prepare(input: Readonly<VarinContextCompactionInput>, signal: AbortSignal, configuration: JsonValue): VarinContextCompactionPlan | Promise<VarinContextCompactionPlan>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function provideContextCompaction(context: VarinBrokeredHostContext, implementation: VarinContextCompactionImplementation): void {
  const description = freeze(parseVarinContextCompactionDescription({ identity: implementation.identity, configuration: implementation.configuration }));
  context.services.provide(structuredClone(VARIN_CONTEXT_COMPACTION_SERVICE), {
    inspect: args => {
      if (args.length) throw new Error('Context compaction inspect takes no arguments');
      return structuredClone(VARIN_CONTEXT_COMPACTION_CONTRACT) as unknown as JsonValue;
    },
    describe: args => {
      if (args.length) throw new Error('Context compaction describe takes no arguments');
      return structuredClone(description) as unknown as JsonValue;
    },
    prepare: async (args, call) => {
      if (args.length !== 1) throw new Error('Context compaction prepare takes one source cut');
      call.signal.throwIfAborted();
      const input = freeze(parseVarinContextCompactionInput(args[0]));
      const result = await implementation.prepare(input, call.signal, description.configuration);
      call.signal.throwIfAborted();
      return parseVarinContextCompactionPlan(result, input) as unknown as JsonValue;
    },
  });
}
