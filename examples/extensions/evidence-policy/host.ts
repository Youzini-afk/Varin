import { defineHostExtension, provideAgentPolicy } from '@varin/extension-sdk';
import type { JsonValue, VarinAgentPolicyEvidenceRef, VarinAgentPolicyReadNode } from '@varin/extension-contract';

// These are this example's declared research budgets, not runtime limits.
const configuration = { modelBudget: 8, indexPath: 'evidence-index.json', indexBytes: 16 * 1024 };
interface State {
  phase: 'index' | 'index_content' | 'evidence' | 'answer';
  modelRequests: number;
  evidence: VarinAgentPolicyEvidenceRef[];
  indexChunks: number[];
  nextChunk: number;
}
const asJson = (state: State): JsonValue => state as unknown as JsonValue;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function read(id: string, path: string, length?: number): VarinAgentPolicyReadNode {
  return { id, depends_on: [], call: { call_id: id, name: 'file_read', schema_version: '1', arguments: { path, ...(length === undefined ? {} : { length }) } } };
}
function restore(value: JsonValue): State {
  if (!record(value) || !['index', 'index_content', 'evidence', 'answer'].includes(String(value.phase))
    || !Number.isSafeInteger(value.modelRequests) || !Array.isArray(value.evidence)
    || !Array.isArray(value.indexChunks) || !Number.isSafeInteger(value.nextChunk)) throw new Error('Incompatible evidence policy checkpoint');
  return structuredClone(value) as unknown as State;
}
export default defineHostExtension({
  activate(context) {
    provideAgentPolicy(context, {
      identity: { name: 'bounded-evidence', version: '2' },
      configuration,
      decide(input, signal, declaredConfiguration) {
        signal.throwIfAborted();
        const config = declaredConfiguration as typeof configuration;
        const state: State = input.state === null
          ? { phase: 'index', modelRequests: 0, evidence: [], indexChunks: [], nextChunk: 0 }
          : restore(input.state);
        const fail = (reason: string) => ({ action: { kind: 'fail' as const, reason }, state: asJson(state) });
        const answer = () => {
          if (state.modelRequests >= config.modelBudget) return fail('Evidence model budget exhausted');
          state.modelRequests += 1;
          state.phase = 'answer';
          return { action: { kind: 'request_model_with_evidence' as const, evidence: state.evidence }, state: asJson(state) };
        };
        const event = input.event;
        // Always settle the actual model exchange. Policy reads never manufacture such an exchange.
        if (event.kind === 'model_completed') {
          if (event.tool_calls > 0) return { action: { kind: 'execute_tools' }, state: asJson(state) };
          return event.reason === 'stop' ? { action: { kind: 'complete' }, state: asJson(state) }
            : fail('Research model did not finish a complete answer');
        }
        if (event.kind === 'tools_completed') {
          if (event.results.some(result => record(result.completion) && result.completion.outcome === 'indeterminate')) {
            return fail('Evidence collection has an unknown effect; reconcile the original operation');
          }
          return answer();
        }
        if (event.kind === 'read_graph_completed') {
          const receipt = event.receipts.find(receipt => receipt.node_id === (state.phase === 'index' ? 'index' : 'evidence'));
          if (!receipt || receipt.outcome !== 'succeeded' || !receipt.output) return fail('The evidence read did not commit a successful result');
          state.evidence.push(receipt.output);
          if (state.phase === 'evidence') return answer();
          if (state.phase !== 'index') return fail('Unexpected evidence graph boundary');
          state.phase = 'index_content';
          state.nextChunk = 0;
          return { action: { kind: 'read_result', reference: receipt.output, index: 0 }, state: asJson(state) };
        }
        if (event.kind === 'result_chunk') {
          const reference = state.evidence[0];
          if (state.phase !== 'index_content' || !reference || reference.action_id !== event.reference.action_id || reference.node_id !== event.reference.node_id || reference.content_ref !== event.reference.content_ref
            || event.index !== state.nextChunk) return fail('Unexpected evidence index chunk');
          // Only this small, explicitly bounded index is parsed by the policy. Evidence bodies
          // stay in the core content store, regardless of their size, and enter the model by reference.
          state.indexChunks = state.indexChunks.concat(event.bytes);
          state.nextChunk += 1;
          if (state.nextChunk < event.total_chunks) return {
            action: { kind: 'read_result', reference, index: state.nextChunk }, state: asJson(state),
          };
          let result: unknown;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(state.indexChunks))); }
          catch { return fail('Evidence index result is not valid UTF-8 JSON'); }
          state.indexChunks = [];
          if (!record(result) || result.missing !== false || !record(result.source) || typeof result.source.branchId !== 'string'
            || !Number.isSafeInteger(result.source.revision) || !record(result.content)
            || typeof result.content.text !== 'string') return fail('Evidence index is missing or is not a UTF-8 file');
          let index: unknown;
          try { index = JSON.parse(result.content.text); } catch { return fail('Evidence index must contain a complete JSON object within its declared byte budget'); }
          if (!record(index) || typeof index.nextFile !== 'string' || !index.nextFile.trim()) return fail('Evidence index requires nextFile');
          state.phase = 'evidence';
          return { action: { kind: 'read_graph', nodes: [read('evidence', index.nextFile)] }, state: asJson(state) };
        }
        if (state.phase === 'index') return {
          action: { kind: 'read_graph', nodes: [read('index', config.indexPath, config.indexBytes)] }, state: asJson(state),
        };
        if (state.phase === 'answer') return answer();
        return fail('Evidence collection requires its committed graph or chunk event');
      },
    });
  },
});
