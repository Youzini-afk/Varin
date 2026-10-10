import {
  parseVarinAgentPolicyDecision, parseVarinAgentPolicyIdentity, parseVarinAgentPolicyInput,
  parseVarinAgentPolicyTransitionInput, parseVarinAgentPolicyTransition, parseVarinAgentPolicyDescription,
  VARIN_AGENT_POLICY_CONTRACT, VARIN_AGENT_POLICY_SERVICE_ID, VARIN_AGENT_POLICY_VERSION,
  type JsonValue, type VarinAgentPolicyIdentity, type VarinAgentPolicyInput, type VarinAgentPolicyDecision,
  type VarinAgentPolicyTransitionInput, type VarinAgentPolicyTransition,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';
export interface VarinAgentPolicyImplementation {
  identity: VarinAgentPolicyIdentity;
  configuration: JsonValue;
  /** Explicit model duties. Omit when the policy does not use auxiliary inference. */
  modelRoles?: readonly 'agentPlanning'[];
  /** Explicitly translate source private state. This grants no action or I/O capability.
   * Omission is incompatible even for null state. The implementation owns compatibility semantics;
   * core captures the exact source checkpoint and publishes only at a closed decision boundary. */
  transitionState?(input: Readonly<VarinAgentPolicyTransitionInput>, signal: AbortSignal, configuration: JsonValue): VarinAgentPolicyTransition | Promise<VarinAgentPolicyTransition>;
  /** Pure bounded decision. Request model/tool work through returned actions, never perform it here.
   * Inputs are detached and recursively frozen; private state advances only when core commits it.
   * tool_graph submits calls through the trusted executor before/between models. Check each
   * tagged completion: result carries a required output reference (including JSON null),
   * job_accepted confirms admission, not the eventual job outcome; not_dispatched has no
   * output. Effects and job lifetimes come from the trusted capability. read_result retrieves a
   * committed own-Run chunk. Pass references to request_model_with_evidence instead of copying
   * whole evidence bodies into the checkpoint or model instructions. request_model_job selects
   * an admitted capability_id; core freezes context, executes tool-free inference, and returns a
   * committed model_job_completed receipt. Read its output with read_result. Model output is
   * untrusted data, never user authorization. deliver appends assistant text with policy
   * provenance, without a fake ModelStep. pause commits an explicit-resume Wait; input and
   * background completion do not clear it. Advance from delivered/resumed receipts, not a
   * private timer or checkpoint flag. Never open provider connections in decide(). */
  decide(input: Readonly<VarinAgentPolicyInput>, signal: AbortSignal, configuration: JsonValue): VarinAgentPolicyDecision | Promise<VarinAgentPolicyDecision>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function provideAgentPolicy(context: VarinBrokeredHostContext, implementation: VarinAgentPolicyImplementation): void {
  const identity = parseVarinAgentPolicyIdentity(implementation.identity);
  const configuration = freeze(structuredClone(implementation.configuration));
  const description = freeze(parseVarinAgentPolicyDescription({ identity, configuration,
    modelRoles: [...(implementation.modelRoles ?? [])], stateTransition: implementation.transitionState ? 'explicit' : 'unsupported' }));
  context.services.provide({ id: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, multiple: true }, {
    inspect: args => { if (args.length) throw new Error('Policy inspect takes no arguments'); return structuredClone(VARIN_AGENT_POLICY_CONTRACT) as unknown as JsonValue; },
    describe: args => { if (args.length) throw new Error('Policy describe takes no arguments'); return structuredClone(description) as unknown as JsonValue; },
    transitionState: async (args, call) => {
      if (args.length !== 1) throw new Error('Policy transition requires one immutable source checkpoint view');
      call.signal.throwIfAborted();
      const input = freeze(parseVarinAgentPolicyTransitionInput(args[0]));
      const result = implementation.transitionState
        ? await implementation.transitionState(input, call.signal, configuration)
        : { kind: 'incompatible' as const, reason: 'Policy does not implement state compatibility' };
      call.signal.throwIfAborted();
      return parseVarinAgentPolicyTransition(result) as unknown as JsonValue;
    },
    decide: async (args, call) => {
      if (args.length !== 1) throw new Error('Policy decide requires one immutable event view');
      call.signal.throwIfAborted();
      const result = await implementation.decide(freeze(parseVarinAgentPolicyInput(args[0])), call.signal, configuration);
      call.signal.throwIfAborted();
      return parseVarinAgentPolicyDecision(result) as unknown as JsonValue;
    },
  });
}
