import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import { VARIN_CONTEXT_BUDGET_CONTRACT, parseVarinContextBudgetDecision } from '../src/index.js';
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
