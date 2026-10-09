import {
  parseVarinAgentPolicyDecision, parseVarinAgentPolicyIdentity, parseVarinAgentPolicyInput,
  VARIN_AGENT_POLICY_CONTRACT, VARIN_AGENT_POLICY_SERVICE_ID, VARIN_AGENT_POLICY_VERSION,
  type JsonValue, type VarinAgentPolicyIdentity, type VarinAgentPolicyInput, type VarinAgentPolicyDecision,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';
export interface VarinAgentPolicyImplementation {
  identity: VarinAgentPolicyIdentity;
  configuration: JsonValue;
  /** Pure bounded decision. Request model/tool work through returned actions, never perform it here.
   * Inputs are detached and recursively frozen; private state advances only when core commits it.
   * read_graph runs trusted fixed-source reads before/between models; read_result retrieves a
   * committed own-Run chunk. Pass references to request_model_with_evidence instead of copying
   * whole evidence bodies into the checkpoint or model instructions. */
  decide(input: Readonly<VarinAgentPolicyInput>, signal: AbortSignal, configuration: JsonValue): VarinAgentPolicyDecision | Promise<VarinAgentPolicyDecision>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function provideAgentPolicy(context: VarinBrokeredHostContext, implementation: VarinAgentPolicyImplementation): void {
  const identity = parseVarinAgentPolicyIdentity(implementation.identity);
  const configuration = freeze(structuredClone(implementation.configuration));
  context.services.provide({ id: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, multiple: true }, {
    inspect: args => { if (args.length) throw new Error('Policy inspect takes no arguments'); return structuredClone(VARIN_AGENT_POLICY_CONTRACT) as unknown as JsonValue; },
    describe: args => { if (args.length) throw new Error('Policy describe takes no arguments'); return { identity: { ...identity }, configuration }; },
    decide: async (args, call) => {
      if (args.length !== 1) throw new Error('Policy decide requires one immutable event view');
      call.signal.throwIfAborted();
      const result = await implementation.decide(freeze(parseVarinAgentPolicyInput(args[0])), call.signal, configuration);
      call.signal.throwIfAborted();
      return parseVarinAgentPolicyDecision(result) as unknown as JsonValue;
    },
  });
}
