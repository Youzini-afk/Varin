import { defineHostExtension, provideAgentPolicy } from '@varin/extension-sdk';

// A product policy budget, not a platform limit. Edit the package to choose a different budget.
const MODEL_BUDGET = 8;
export default defineHostExtension({
  activate(context) {
    provideAgentPolicy(context, {
      identity: { name: 'bounded-evidence', version: '1' },
      configuration: { modelBudget: MODEL_BUDGET },
      decide(input) {
        const state = input.state === null ? { modelRequests: 0, evidenceBatches: 0 } : input.state;
        if (!state || typeof state !== 'object' || Array.isArray(state)
          || !Number.isSafeInteger(state.modelRequests) || !Number.isSafeInteger(state.evidenceBatches)) {
          throw new Error('Incompatible evidence policy checkpoint');
        }
        const next = { modelRequests: Number(state.modelRequests), evidenceBatches: Number(state.evidenceBatches) };
        const event = input.event;
        // Always settle the registered exchange before evaluating the next model budget.
        if (event.kind === 'model_completed' && event.tool_calls > 0) return { action: { kind: 'execute_tools' }, state: next };
        if (event.kind === 'model_completed') return {
          action: event.reason === 'stop' ? { kind: 'complete' } : { kind: 'fail', reason: 'Research model did not finish a complete answer' }, state: next,
        };
        if (event.kind === 'tools_completed') {
          for (const result of event.results) {
            const completion = result.completion;
            if (completion && typeof completion === 'object' && !Array.isArray(completion)
              && completion.kind === 'result' && completion.outcome === 'indeterminate') {
              return { action: { kind: 'fail', reason: 'Evidence collection has an unknown effect; reconcile the original operation' }, state: next };
            }
          }
          next.evidenceBatches += 1;
        }
        if (next.modelRequests >= MODEL_BUDGET) return { action: { kind: 'fail', reason: 'Evidence model budget exhausted; review collected evidence before starting another run' }, state: next };
        next.modelRequests += 1;
        return { action: { kind: 'request_model' }, state: next };
      },
    });
  },
});
