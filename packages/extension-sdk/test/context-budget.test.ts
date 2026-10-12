import assert from 'node:assert/strict';
import test from 'node:test';
import { provideContextBudget, type VarinHostServiceHandler } from '../src/index.js';
import { runHostExtensionConformance } from '../src/testing.js';
import { VARIN_CONTEXT_BUDGET_CONTRACT, parseVarinContextBudgetInput, type JsonValue } from '@varin/extension-contract';

const input = () => ({ boundary: 'before_model_dispatch', requestId: 'request',
  estimate: { estimatedTokens: 120, unmeasuredMedia: 1, unmeasuredProviderItems: 1, method: 'fixture estimate' },
  capacityTokens: 200, inputBudgetTokens: 150,
  settings: { reserveTokens: 50, keepRecentTokens: 40, backgroundPreparation: true, preparationWaterline: 0.75 },
  candidates: [{ throughId: 'input', prefixEstimatedTokens: 90, retainedEstimatedTokens: 30 }],
});
test('the author Decision receives detached frozen metadata and exposes its real service contract', async () => {
  await runHostExtensionConformance({ extensionId: 'review.context-budget', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    const configuration = { preference: 'decisions and pending work' };
    let calls = 0;
    provideContextBudget(context, { identity: { name: 'continuation', version: '1' }, configuration,
      decide(value, _signal, config) {
        calls++;
        assert.equal(Object.isFrozen(value.candidates[0]), true);
        assert.equal(Object.isFrozen(value.settings), true);
        assert.deepEqual(config, { preference: 'decisions and pending work' });
        return { kind: 'compact', throughId: value.candidates[0]!.throughId, mode: 'background', summaryInstructions: 'Preserve decision provenance.' };
      },
    });
    configuration.preference = 'later mutable value';
    const call = { signal: new AbortController().signal, callId: 'budget', capabilities: context.capabilities };
    const raw = input();
    assert.deepEqual(await handler.decide!([raw as JsonValue], call), { kind: 'compact', throughId: 'input', mode: 'background', summaryInstructions: 'Preserve decision provenance.' });
    assert.equal(Object.isFrozen(raw), false);
    assert.deepEqual(await handler.inspect!([], call), VARIN_CONTEXT_BUDGET_CONTRACT);
    await assert.rejects(async () => handler.decide!([{ ...input(), history: ['not a capability'] }], call), /Invalid context budget input/);
    assert.equal(calls, 1);
  } });
});
test('cancellation discards late budget output and malformed estimates never enter the callback', async () => {
  await runHostExtensionConformance({ extensionId: 'review.context-budget-cancel', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    const controller = new AbortController();
    provideContextBudget(context, { identity: { name: 'cancel', version: '1' }, configuration: null,
      async decide() { controller.abort(); return { kind: 'continue' }; },
    });
    await assert.rejects(async () => handler.decide!([input() as JsonValue], { signal: controller.signal, callId: 'cancel', capabilities: context.capabilities }), { name: 'AbortError' });
  } });
  assert.throws(() => parseVarinContextBudgetInput({ ...input(), candidates: [input().candidates[0], input().candidates[0]] }), /Invalid context budget candidates/);
  assert.throws(() => parseVarinContextBudgetInput({ ...input(), estimate: { ...input().estimate, estimatedTokens: Number.MAX_SAFE_INTEGER + 1 } }), /Invalid context estimate/);
});
