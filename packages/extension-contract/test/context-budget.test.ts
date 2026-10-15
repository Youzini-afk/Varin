import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import { VARIN_CONTEXT_BUDGET_CONTRACT, parseVarinContextBudgetDecision, parseVarinContextBudgetInput } from '../src/index.js';
const ajv = new Ajv({ strict: false });
const validate = ajv.compile(VARIN_CONTEXT_BUDGET_CONTRACT.decide.outputSchema);
test('the discoverable budget contract and parser reject non-decisions and added authority', () => {
  for (const value of [{ kind: 'continue' }, { kind: 'compact', throughId: 'ancestor', mode: 'blocking', summaryInstructions: '' }]) {
    assert.equal(validate(value), true);
    assert.deepEqual(parseVarinContextBudgetDecision(value), value);
  }
  for (const value of [{ kind: 'compact', throughId: 'ancestor', mode: 'manual' },
    { kind: 'continue', tools: ['shell'] }, { kind: 'compact', throughId: ' ', mode: 'blocking' },
    { kind: 'compact', throughId: 'ancestor', mode: 'blocking', summaryInstructions: null }]) {
    assert.equal(validate(value), false);
    assert.throws(() => parseVarinContextBudgetDecision(value));
  }
});

test('accepted-candidate metadata retains the exact original source and instructions', () => {
  const input = { boundary: 'before_model_dispatch', requestId: 'request',
    estimate: { estimatedTokens: 900, unmeasuredMedia: 0, unmeasuredProviderItems: 0, method: 'local' },
    capacityTokens: 1000, inputBudgetTokens: 800,
    settings: { reserveTokens: 200, keepRecentTokens: 100, backgroundPreparation: true, preparationWaterline: 0.75 },
    candidates: [{ throughId: 'source', prefixEstimatedTokens: 600, retainedEstimatedTokens: 100 }],
    acceptedCandidate: { throughId: 'source', mode: 'background', summaryInstructions: 'Exact original guidance' } };
  const inputValid = ajv.compile(VARIN_CONTEXT_BUDGET_CONTRACT.decide.inputSchema);
  assert.equal(inputValid([input]), true);
  assert.deepEqual(parseVarinContextBudgetInput(input), input);
  assert.throws(() => parseVarinContextBudgetInput({ ...input, acceptedCandidate: { ...input.acceptedCandidate, throughId: 'other-source' } }));
  assert.throws(() => parseVarinContextBudgetInput({ ...input, acceptedCandidate: { ...input.acceptedCandidate, summaryInstructions: null } }));
});
