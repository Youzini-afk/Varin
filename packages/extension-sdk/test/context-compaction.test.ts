import assert from 'node:assert/strict';
import test from 'node:test';
import { provideContextCompaction, type VarinHostServiceHandler } from '../src/index.js';
import { runHostExtensionConformance } from '../src/testing.js';
import { VARIN_CONTEXT_COMPACTION_CONTRACT, VARIN_CONTEXT_COMPACTION_SERVICE, type JsonValue } from '@varin/extension-contract';
const input = () => ({ sourceCutHash: 'cut', sources: [{ sourceId: 'source', item: { id: 'quoted',
  provenance: { kind: 'external_data', source: 'history:original' }, content: { kind: 'text', text: 'quoted evidence' }, opaque: null } }],
  modelBudget: { contextWindowTokens: null, maxOutputTokens: null, sourceBudgetTokens: null } });
test('actual author registration freezes detached quoted input/configuration and returns validated detached candidates', async () => {
  await runHostExtensionConformance({ dependencies: [], extensionId: 'review.compaction', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => {
      assert.deepEqual(descriptor, VARIN_CONTEXT_COMPACTION_SERVICE); handler = implementation; provide(descriptor, implementation);
    };
    const configuration = { mode: 'extractive' };
    let calls = 0;
    const candidate = { kind: 'text' as const, sourceCutHash: 'cut', text: 'evidence' };
    provideContextCompaction(context, { identity: { name: 'extractive', version: '1' }, configuration,
      prepare(value, _signal, config) {
        calls++;
        assert.equal(Object.isFrozen(value.sources[0]!.item.content), true);
        assert.equal(Object.isFrozen(value.modelBudget), true);
        assert.equal(Object.isFrozen(config), true);
        assert.deepEqual(config, { mode: 'extractive' });
        return candidate;
      },
    });
    configuration.mode = 'later';
    const call = { signal: new AbortController().signal, callId: 'compaction', capabilities: context.capabilities };
    const raw = input();
    const result = await handler.prepare!([raw as JsonValue], call);
    assert.deepEqual(result, candidate); assert.notEqual(result, candidate);
    assert.equal(Object.isFrozen(raw.sources[0]!.item), false);
    assert.deepEqual(await handler.inspect!([], call), VARIN_CONTEXT_COMPACTION_CONTRACT);
    await assert.rejects(async () => handler.prepare!([{ ...input(), model: 'hidden inference' }], call), /Invalid context compaction input/);
    assert.equal(calls, 1);
    candidate.sourceCutHash = 'stale';
    await assert.rejects(async () => handler.prepare!([raw], call), /source cut/);
  } });
});
test('the actual SDK discards cancelled late preparation without exposing capabilities to the algorithm callback', async () => {
  await runHostExtensionConformance({ dependencies: [], extensionId: 'review.compaction-cancel', activation: async context => {
    let handler!: VarinHostServiceHandler;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => { handler = implementation; provide(descriptor, implementation); };
    const controller = new AbortController();
    provideContextCompaction(context, { identity: { name: 'cancel', version: '1' }, configuration: null,
      prepare(value) { controller.abort(); return { kind: 'text', sourceCutHash: value.sourceCutHash, text: 'late' }; },
    });
    await assert.rejects(async () => handler.prepare!([input()], { signal: controller.signal, callId: 'cancel', capabilities: context.capabilities }), { name: 'AbortError' });
  } });
});
