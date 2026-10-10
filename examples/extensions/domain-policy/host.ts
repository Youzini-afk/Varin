import { defineHostExtension, provideAgentPolicy } from '@varin/extension-sdk';
import type { JsonValue, VarinAgentPolicyDecision, VarinAgentPolicyEvidenceRef, VarinAgentPolicyToolNode } from '@varin/extension-contract';

// The command runs in the admitted execution environment, not in this extension broker.
// The answer selects a fixed example action; it is never interpolated into a shell command.
const configuration = { command: 'node', args: ['-e', 'process.stdin.once("data", bytes => { process.stdout.write("Varin policy process probe: " + bytes); process.exit(0); }); process.stdin.resume();'] };
type Phase = 'plan_read' | 'plan_update' | 'question' | 'question_status' | 'spawn' | 'resize' | 'write' | 'wait_process'
  | 'process_status' | 'delivery' | 'pause' | 'final_delivery' | 'cancelled_delivery' | 'complete';
interface State {
  phase: Phase;
  questionId: string | null;
  processId: string | null;
  reading: VarinAgentPolicyEvidenceRef | null;
  nextChunk: number;
  bytes: number[];
}
const phases: Phase[] = ['plan_read', 'plan_update', 'question', 'question_status', 'spawn', 'resize', 'write', 'wait_process',
  'process_status', 'delivery', 'pause', 'final_delivery', 'cancelled_delivery', 'complete'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const reference = (value: unknown): boolean => record(value) && ['action_id', 'node_id', 'content_ref'].every(key => text(value[key]));
const asJson = (state: State): JsonValue => state as unknown as JsonValue;
function restore(value: JsonValue): State {
  if (!record(value) || !phases.includes(value.phase as Phase)
    || !(value.questionId === null || text(value.questionId)) || !(value.processId === null || text(value.processId))
    || !(value.reading === null || reference(value.reading))
    || !Number.isSafeInteger(value.nextChunk) || Number(value.nextChunk) < 0
    || !Array.isArray(value.bytes) || value.bytes.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Incompatible domain policy checkpoint');
  }
  return structuredClone(value) as unknown as State;
}
function node(name: string, args: JsonValue): VarinAgentPolicyToolNode {
  return { id: name, depends_on: [], call: { call_id: name, name, schema_version: '1', arguments: args } };
}
export default defineHostExtension({
  activate(context) {
    provideAgentPolicy(context, {
      identity: { name: 'plan-question-process', version: '2' },
      configuration,
      decide(input, signal, declaredConfiguration): VarinAgentPolicyDecision {
        signal.throwIfAborted();
        const config = declaredConfiguration as typeof configuration;
        const state: State = input.state === null
          ? { phase: 'plan_read', questionId: null, processId: null, reading: null, nextChunk: 0, bytes: [] }
          : restore(input.state);
        const fail = (reason: string): VarinAgentPolicyDecision => ({ action: { kind: 'fail', reason }, state: asJson(state) });
        const graph = (phase: Phase, name: string, args: JsonValue): VarinAgentPolicyDecision => {
          state.phase = phase;
          return { action: { kind: 'tool_graph', nodes: [node(name, args)] }, state: asJson(state) };
        };
        const deliver = (phase: Phase, message: string): VarinAgentPolicyDecision => {
          state.phase = phase;
          return { action: { kind: 'deliver', text: message }, state: asJson(state) };
        };
        const event = input.event;
        if (input.state === null && (event.kind === 'started' || event.kind === 'input_delivered')) {
          return graph('plan_read', 'todo', { action: 'read' });
        }
        if (event.kind === 'tool_graph_completed') {
          const names: Partial<Record<Phase, string>> = { plan_read: 'todo', plan_update: 'todo', question: 'ask_user', question_status: 'question_status',
            spawn: 'process_spawn', resize: 'process_resize', write: 'process_write', wait_process: 'wait_process', process_status: 'process_inspect' };
          const expected = names[state.phase];
          const receipt = event.receipts[0];
          if (event.receipts.length !== 1 || !expected || receipt?.node_id !== expected) return fail('Unexpected domain graph boundary');
          const completion = receipt.completion;
          if (state.phase === 'question' || state.phase === 'spawn' || state.phase === 'wait_process') {
            if (completion.kind !== 'job_accepted' || completion.lifetime !== 'thread') return fail('The domain job was not accepted');
            if (state.phase === 'question') {
              if (completion.phase !== 'awaiting_user') return fail('Unexpected question acceptance');
              state.questionId = completion.operation_id;
              // Core parks before calling the policy while the original question is unresolved.
              // Acceptance remains acceptance after the answer. Read the original question owner.
              return graph('question_status', 'question_status', { operationId: state.questionId });
            }
            if (state.phase === 'spawn') {
              state.processId = completion.operation_id;
              return graph('resize', 'process_resize', { processId: state.processId, cols: 111, rows: 41 });
            }
            if (completion.phase !== 'awaiting_process' || !state.processId) return fail('Unexpected process observation acceptance');
            // Observation cancellation is not process termination; inspect the actual process.
            return graph('process_status', 'process_inspect', { processId: state.processId });
          }
          if (completion.kind !== 'result' || completion.outcome !== 'succeeded') return fail('The domain action did not succeed; do not repeat an uncertain mutation');
          if (state.phase === 'resize' || state.phase === 'write') {
            if (completion.effect !== 'confirmed' || !state.processId) return fail('Process interaction lacks an actual applied receipt');
            if (state.phase === 'resize') return graph('write', 'process_write', { processId: state.processId, text: 'fixed policy input\n' });
            return graph('wait_process', 'wait_process', { processId: state.processId });
          }
          if (state.phase === 'plan_update') return graph('question', 'ask_user', {
            question: 'The example plan is recorded. Type run to execute the fixed Node process probe, or cancel this question to stop the example. Process permission is checked separately.',
            options: ['run', 'stop'],
          });
          state.reading = completion.output;
          state.nextChunk = 0;
          state.bytes = [];
          return { action: { kind: 'read_result', reference: completion.output, index: 0 }, state: asJson(state) };
        }
        if (event.kind === 'result_chunk') {
          const reference = state.reading;
          if (!reference || event.reference.action_id !== reference.action_id || event.reference.node_id !== reference.node_id
            || event.reference.content_ref !== reference.content_ref || event.index !== state.nextChunk) return fail('Unexpected result chunk');
          state.bytes = state.bytes.concat(event.bytes);
          state.nextChunk += 1;
          if (state.nextChunk < event.total_chunks) return { action: { kind: 'read_result', reference, index: state.nextChunk }, state: asJson(state) };
          let result: unknown;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(state.bytes))); }
          catch { return fail('The domain result is not complete UTF-8 JSON'); }
          state.bytes = [];
          state.reading = null;
          if (!record(result)) return fail('The domain result is not an object');
          if (state.phase === 'plan_read') {
            if (result.status !== 'ready' || !(result.plan === null || record(result.plan) && text(result.plan.ref))) return fail('The current plan is unavailable');
            return graph('plan_update', 'todo', { action: 'update', expectedRef: result.plan === null ? null : (result.plan as Record<string, string>).ref,
              items: [{ text: 'Review the question and optionally run the fixed process probe', status: 'in_progress' }] });
          }
          if (state.phase === 'question_status') {
            if (result.operationId !== state.questionId) return fail('Question result belongs to another operation');
            if (result.status === 'cancelled') return deliver('cancelled_delivery', 'The question was cancelled. This example did not start a process.');
            if (result.status !== 'answered' || typeof result.answer !== 'string' || !text(result.historyId)) return fail('No authentic answered question is available');
            if (result.answer.trim() !== 'run') return deliver('cancelled_delivery', 'The answer did not select the fixed process probe. No process was started.');
            return graph('spawn', 'process_spawn', { cwd: '', command: config.command, args: config.args, mode: 'pty' });
          }
          if (state.phase === 'process_status') {
            if (!text(result.status) || !(result.exitCode === null || typeof result.exitCode === 'number' && Number.isInteger(result.exitCode))) {
              return fail('The process owner did not return a lifecycle observation');
            }
            const message = result.status === 'exited' && result.exitCode === 0
              ? 'The original process owner reports that the fixed probe exited with code 0.'
              : `Observation ended. The original process owner reports status ${String(result.status)} and exit code ${String(result.exitCode)}; this is not a successful-stop assertion.`;
            return deliver('delivery', message);
          }
          return fail('Unexpected domain result phase');
        }
        if (event.kind === 'delivered') {
          if (state.phase === 'delivery') {
            state.phase = 'pause';
            return { action: { kind: 'pause', reason: 'Review the observed process result, then explicitly resume the run.' }, state: asJson(state) };
          }
          if (state.phase === 'final_delivery' || state.phase === 'cancelled_delivery') {
            state.phase = 'complete';
            return { action: { kind: 'complete' }, state: asJson(state) };
          }
        }
        if (event.kind === 'resumed' && state.phase === 'pause') return deliver('final_delivery', 'The explicit resume was received. The example is complete.');
        return fail('This policy requires its real committed domain or continuation event');
      },
    });
  },
});
