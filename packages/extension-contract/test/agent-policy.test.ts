import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { parseVarinAgentPolicyDecision, parseVarinAgentPolicyInput, VARIN_AGENT_POLICY_CONTRACT } from '../src/index.js';

// Compile the actual discoverable service schemas, then exercise the same public parser used
// at the private Host bridge. This guards the wire boundary, not merely TypeScript literals.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv as any)({ strict: false });
const validateInput = ajv.compile(VARIN_AGENT_POLICY_CONTRACT.decide.inputSchema);
const validateDecision = ajv.compile(VARIN_AGENT_POLICY_CONTRACT.decide.outputSchema);
const reference = { action_id: 'graph-a', node_id: 'save', content_ref: 'sha256-result' };
const input = (completion: unknown) => ({
  view: { run_id: 'run-a', state: 'runnable', history_count: 1, history_head_id: 'input-a', pending_tool_calls: 0, model_capabilities: [] },
  event: { kind: 'tool_graph_completed', action_id: 'graph-a', receipts: [{ node_id: 'save', completion }] }, state: null,
});

test('policy graph boundary distinguishes non-dispatch, committed results and accepted jobs', () => {
  for (const completion of [
    { kind: 'not_dispatched', reason: 'Permission denied' },
    { kind: 'result', outcome: 'succeeded', effect: 'confirmed', output: reference },
    { kind: 'result', outcome: 'cancelled', effect: 'partial', output: reference },
    { kind: 'result', outcome: 'indeterminate', effect: 'unknown', output: reference },
    { kind: 'job_accepted', operation_id: 'graph-a:node:save', phase: 'running', effect: 'dispatched', lifetime: 'environment' },
  ]) {
    const raw = input(completion);
    assert.equal(validateInput([raw]), true, JSON.stringify(validateInput.errors));
    const parsed = parseVarinAgentPolicyInput(raw);
    assert.notEqual(parsed, raw);
    assert.notEqual(parsed.event, raw.event);
    assert.deepEqual(parsed, raw);
  }
  for (const completion of [
    { kind: 'not_dispatched', reason: 'Denied', output: reference },
    { kind: 'result', outcome: 'succeeded', effect: 'confirmed', output: null },
    { kind: 'result', outcome: 'succeeded', effect: 'confirmed' },
    { kind: 'result', outcome: 'succeeded', output: reference },
    { kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'run', outcome: 'succeeded' },
    { kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'run', output: reference },
    { kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'extension' },
  ]) {
    assert.equal(validateInput([input(completion)]), false);
    assert.throws(() => parseVarinAgentPolicyInput(input(completion)), /Invalid policy graph receipts/);
  }
});

test('policy v2 rejects obsolete graphs and receipts without losing JSON-null tool arguments', () => {
  const decision = { action: { kind: 'tool_graph', nodes: [{ id: 'save', depends_on: [], call: { call_id: 'save', name: 'memory', schema_version: '1', arguments: null } }] }, state: null };
  assert.equal(validateDecision(decision), true, JSON.stringify(validateDecision.errors));
  assert.deepEqual(parseVarinAgentPolicyDecision(decision), decision);
  const oldDecision = { ...decision, action: { ...decision.action, kind: 'read_graph' } };
  assert.equal(validateDecision(oldDecision), false);
  assert.throws(() => parseVarinAgentPolicyDecision(oldDecision), /Unknown agent policy action/);
  const oldInput = input({ kind: 'result', outcome: 'succeeded', effect: 'none', output: reference });
  for (const event of [
    { ...oldInput.event, kind: 'read_graph_completed' },
    { ...oldInput.event, receipts: [{ node_id: 'save', outcome: 'succeeded', output: reference, non_execution: null }] },
  ]) {
    assert.equal(validateInput([{ ...oldInput, event }]), false);
    assert.throws(() => parseVarinAgentPolicyInput({ ...oldInput, event }));
  }
});

test('policy delivery and pause preserve text while validating their distinct receipts', () => {
  for (const value of ['', '  ', '正文\n\u0000🙂']) {
    for (const action of [{ kind: 'deliver', text: value }, { kind: 'pause', reason: value }]) {
      const raw = { action, state: null };
      assert.equal(validateDecision(raw), true, JSON.stringify(validateDecision.errors));
      assert.deepEqual(parseVarinAgentPolicyDecision(raw), raw);
    }
  }
  for (const action of [{ kind: 'deliver' }, { kind: 'deliver', text: null }, { kind: 'pause', reason: 0 }, { kind: 'pause', reason: 'Review', wait_id: 'private-wait' }]) {
    assert.equal(validateDecision({ action, state: null }), false);
    assert.throws(() => parseVarinAgentPolicyDecision({ action, state: null }));
  }
  for (const event of [{ kind: 'delivered', action_id: 'delivery', item_id: 'history' }, { kind: 'resumed', action_id: 'pause', wait_id: 'pause-wait' }]) {
    const raw = { ...input({}), event };
    assert.equal(validateInput([raw]), true, JSON.stringify(validateInput.errors));
    assert.deepEqual(parseVarinAgentPolicyInput(raw), raw);
    for (const malformed of [{ ...event, action_id: '' }, { ...event, cursor: 1 }, { kind: event.kind, action_id: event.action_id }]) {
      assert.equal(validateInput([{ ...raw, event: malformed }]), false);
      assert.throws(() => parseVarinAgentPolicyInput({ ...raw, event: malformed }));
    }
  }
});
