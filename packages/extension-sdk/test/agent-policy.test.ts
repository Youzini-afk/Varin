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

test('registered v3 policy gets immutable typed completions and passes only result references to inference', async () => {
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
    const call = { signal: new AbortController().signal, callId: 'decision', capabilities: context.capabilities };
    const completion = { kind: 'result', outcome: 'succeeded', effect: 'confirmed', output: reference };
    const decision = await handler.decide!([input(completion)], call);
    assert.deepEqual(decision, { action: { kind: 'request_model_with_evidence', evidence: [reference] }, state: null });
    assert.deepEqual(await handler.decide!([input({ kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'run' })], call), { action: { kind: 'complete' }, state: null });
    await assert.rejects(async () => handler.decide!([input({ ...completion, output: null })], call), /Invalid policy graph receipts/);
    assert.equal(calls, 2);
    const inspection = await handler.inspect!([], call) as { version: number };
    assert.equal(inspection.version, 3);
  } });
  assert.deepEqual(result.providedServiceIds, ['varin.agent.policy@3']);
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
    await assert.rejects(async () => handler.decide!([input({ kind: 'not_dispatched', reason: 'Denied' })], { signal: abort.signal, callId: 'decision', capabilities: context.capabilities }), { name: 'AbortError' });
  } });
});

test('state transition is explicit, immutable and independently cancellable', async () => {
  await runHostExtensionConformance({ extensionId: 'review.policy-transition', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    let calls = 0;
    provideAgentPolicy(context, { identity: { name: 'new', version: '2' }, configuration: { stateVersion: 2 },
      transitionState(value, _signal, config) {
        calls++;
        assert.equal(Object.isFrozen(value.from.identity), true);
        assert.equal(Object.isFrozen(value.state), true);
        assert.equal(Object.isFrozen(config), true);
        return value.from.declaredIdentity?.version === '1'
          ? { kind: 'compatible', state: { migrated: value.state } }
          : { kind: 'incompatible', reason: 'Unrecognized implementation state' };
      }, decide() { throw new Error('Transition must not decide'); },
    });
    const raw = { ...(input({ kind: 'not_dispatched', reason: 'Denied' }) as object),
      from: { identity: { name: 'old-exact', version: 'hash' }, declaredIdentity: { name: 'old', version: '1' } }, state: { stage: 1 } };
    const call = { signal: new AbortController().signal, callId: 'transition', capabilities: context.capabilities };
    assert.deepEqual(await handler.transitionState!([raw], call), { kind: 'compatible', state: { migrated: { stage: 1 } } });
    assert.equal(calls, 1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(async () => handler.transitionState!([raw], { ...call, signal: abort.signal }), { name: 'AbortError' });
    assert.equal(calls, 1);
  } });
});

test('missing compatibility hook rejects even null source state', async () => {
  await runHostExtensionConformance({ extensionId: 'review.policy-no-transition', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    provideAgentPolicy(context, { identity: { name: 'new', version: '1' }, configuration: null, decide() { throw new Error('Must not decide'); } });
    const call = { signal: new AbortController().signal, callId: 'transition', capabilities: context.capabilities };
    const description = await handler.describe!([], call) as { stateTransition: string; modelRoles: unknown[] };
    assert.equal(description.stateTransition, 'unsupported'); assert.deepEqual(description.modelRoles, []);
    const result = await handler.transitionState!([{ ...(input({ kind: 'not_dispatched', reason: 'Denied' }) as object),
      from: { identity: { name: 'default', version: '1' }, declaredIdentity: null } }], call) as { kind: string };
    assert.equal(result.kind, 'incompatible');
  } });
});
