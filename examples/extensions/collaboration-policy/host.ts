import { defineHostExtension, provideAgentPolicy } from '@varin/extension-sdk';
import type { JsonValue, VarinAgentPolicyEvidenceRef, VarinAgentPolicyToolNode } from '@varin/extension-contract';

// This task and path belong to the example, not to the runtime's child-task contract.
const configuration = {
  task: 'Inspect source.txt in the fixed source and report your findings. Do not change files.',
  parentReadPath: 'source.txt',
};
interface State {
  phase: 'dispatch' | 'parent_read' | 'waiting' | 'answer';
  childOperationId: string | null;
  evidence: VarinAgentPolicyEvidenceRef[];
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const asJson = (state: State): JsonValue => state as unknown as JsonValue;
function restore(value: JsonValue): State {
  if (!record(value) || !['dispatch', 'parent_read', 'waiting', 'answer'].includes(String(value.phase))
    || !(value.childOperationId === null || typeof value.childOperationId === 'string' && value.childOperationId.length > 0)
    || !Array.isArray(value.evidence) || value.evidence.some(item => !record(item)
      || !['action_id', 'node_id', 'content_ref'].every(key => typeof item[key] === 'string' && item[key].length > 0))) {
    throw new Error('Incompatible collaboration policy checkpoint');
  }
  return structuredClone(value) as unknown as State;
}
function node(id: string, name: string, args: JsonValue): VarinAgentPolicyToolNode {
  return { id, depends_on: [], call: { call_id: id, name, schema_version: '1', arguments: args } };
}
export default defineHostExtension({
  activate(context) {
    provideAgentPolicy(context, {
      identity: { name: 'fixed-source-collaboration', version: '1' },
      configuration,
      decide(input, signal, declaredConfiguration) {
        signal.throwIfAborted();
        const config = declaredConfiguration as typeof configuration;
        const state: State = input.state === null
          ? { phase: 'dispatch', childOperationId: null, evidence: [] }
          : restore(input.state);
        const fail = (reason: string) => ({ action: { kind: 'fail' as const, reason }, state: asJson(state) });
        const answer = () => {
          state.phase = 'answer';
          return { action: { kind: 'request_model_with_evidence' as const, evidence: state.evidence }, state: asJson(state) };
        };
        const event = input.event;
        if (event.kind === 'model_completed') {
          if (state.phase !== 'answer') return fail('Unexpected parent model boundary');
          if (event.tool_calls > 0) return { action: { kind: 'execute_tools' }, state: asJson(state) };
          return event.reason === 'stop' ? { action: { kind: 'complete' }, state: asJson(state) }
            : fail('Parent model did not finish an answer');
        }
        if (event.kind === 'tools_completed') {
          if (state.phase !== 'answer' || event.results.some(result => record(result.completion) && result.completion.outcome === 'indeterminate')) {
            return fail('Unexpected or indeterminate parent tool exchange');
          }
          return answer();
        }
        if (event.kind === 'tool_graph_completed') {
          const expected = { dispatch: 'dispatch', parent_read: 'parent-read', waiting: 'wait-child', answer: '' }[state.phase];
          const receipt = event.receipts[0];
          if (event.receipts.length !== 1 || receipt?.node_id !== expected) return fail('Unexpected collaboration graph boundary');
          if (state.phase === 'dispatch') {
            if (receipt.completion.kind !== 'job_accepted' || receipt.completion.phase !== 'preparing_child'
              || receipt.completion.lifetime !== 'thread') return fail('Child dispatch was not durably accepted');
            // Acceptance is only the original call receipt. It is not a child terminal result.
            state.childOperationId = receipt.completion.operation_id;
            state.phase = 'parent_read';
            return { action: { kind: 'tool_graph', nodes: [node('parent-read', 'file_read', { path: config.parentReadPath })] }, state: asJson(state) };
          }
          if (state.phase === 'parent_read') {
            if (!state.childOperationId || receipt.completion.kind !== 'result' || receipt.completion.outcome !== 'succeeded') {
              return fail('The independent parent read did not commit successfully');
            }
            state.evidence = [receipt.completion.output];
            state.phase = 'waiting';
            return { action: { kind: 'tool_graph', nodes: [node('wait-child', 'wait_child', { operationId: state.childOperationId })] }, state: asJson(state) };
          }
          if (state.phase === 'waiting') {
            if (receipt.completion.kind !== 'job_accepted' || receipt.completion.phase !== 'awaiting_child'
              || receipt.completion.lifetime !== 'thread') return fail('Child observation was not durably accepted');
            // Core parks the Run before invoking this decision while its real Wait is pending.
            // On resumption, core has delivered either the actual report or observation cancellation
            // to parent history. The unchanged JobAccepted receipt does not say which occurred.
            return answer();
          }
          return fail('Unexpected graph after the parent answer began');
        }
        if (input.state === null && (event.kind === 'started' || event.kind === 'input_delivered')) return {
          action: { kind: 'tool_graph', nodes: [node('dispatch', 'dispatch', { task: config.task, model: 'parent', profile: 'read_only' })] }, state: asJson(state),
        };
        return fail('Collaboration policy requires its committed operation event');
      },
    });
  },
});
