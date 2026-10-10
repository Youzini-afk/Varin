import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue, VarinAgentPolicyDecision } from '@varin/extension-contract';
import { provideAgentPolicy, type VarinHostServiceHandler } from '../src/index.js';
import { runHostExtensionConformance } from '../src/testing.js';

const reference = { action_id: 'graph', node_id: 'save', content_ref: 'sha256-result' };
const input = (completion: JsonValue): JsonValue => ({
  view: { run_id: 'run', state: 'runnable', history_count: 1, history_head_id: 'input', pending_tool_calls: 0, model_capabilities: [] },
  event: { kind: 'tool_graph_completed', action_id: 'graph', receipts: [{ node_id: 'save', completion }] }, state: null,
});

test('registered v2 policy gets immutable typed completions and passes only result references to inference', async () => {
  let calls = 0;
  const result = await runHostExtensionConformance({ extensionId: 'review.policy-contract', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    const configuration = { path: 'notes' };
    provideAgentPolicy(context, {
      identity: { name: 'typed-completions', version: '1' }, configuration,
      decide(value, _signal, config): VarinAgentPolicyDecision {
        calls++;
        assert.equal(Object.isFrozen(value.event), true);
        assert.equal(Object.isFrozen(config), true);
        assert.deepEqual(config, { path: 'notes' });
        assert.equal(value.event.kind, 'tool_graph_completed');
        if (value.event.kind !== 'tool_graph_completed') throw new Error('Expected graph event');
        const completion = value.event.receipts[0]!.completion;
        assert.equal(Object.isFrozen(completion), true);
        return { action: completion.kind === 'result' && completion.outcome === 'succeeded'
          ? { kind: 'request_model_with_evidence', evidence: [completion.output] } : { kind: 'complete' }, state: null };
      },
    });
    configuration.path = 'mutated';
    const call = { signal: new AbortController().signal, callId: 'decision' };
    const completion = { kind: 'result', outcome: 'succeeded', effect: 'confirmed', output: reference };
    const decision = await handler.decide!([input(completion)], call);
    assert.deepEqual(decision, { action: { kind: 'request_model_with_evidence', evidence: [reference] }, state: null });
    assert.deepEqual(await handler.decide!([input({ kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'run' })], call), { action: { kind: 'complete' }, state: null });
    await assert.rejects(async () => handler.decide!([input({ ...completion, output: null })], call), /Invalid policy graph receipts/);
    assert.equal(calls, 2);
    const inspection = await handler.inspect!([], call) as { version: number };
    assert.equal(inspection.version, 2);
  } });
  assert.deepEqual(result.providedServiceIds, ['varin.agent.policy@2']);
});

test('cancellation after an awaited policy decision discards its returned graph', async () => {
  await runHostExtensionConformance({ extensionId: 'review.policy-cancel', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    const abort = new AbortController();
    provideAgentPolicy(context, { identity: { name: 'cancelled', version: '1' }, configuration: null,
      async decide() { await Promise.resolve(); abort.abort(); return { action: { kind: 'tool_graph', nodes: [] }, state: null }; },
    });
    await assert.rejects(async () => handler.decide!([input({ kind: 'not_dispatched', reason: 'Denied' })], { signal: abort.signal, callId: 'decision' }), { name: 'AbortError' });
  } });
});
