import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import {
  VARIN_CONTEXT_COMPACTION_CONTRACT, VARIN_CONTEXT_COMPACTION_SERVICE, parseVarinExtensionServiceProvision,
  parseVarinContextCompactionDescription, parseVarinContextCompactionInput, parseVarinContextCompactionPlan,
  type VarinContextCompactionInput, type VarinContextCompactionPlan,
} from '../src/index.js';
const ajv = new Ajv({ strict: false });
const input = (): VarinContextCompactionInput => ({ sourceCutHash: 'immutable-cut',
  sources: [{ sourceId: 'one', item: { id: 'quoted-one', provenance: { kind: 'external_data', source: 'history:one' },
    content: { kind: 'text', text: 'a中b' }, opaque: null } }],
  modelBudget: { contextWindowTokens: 100, maxOutputTokens: 10, sourceBudgetTokens: 50 },
});
const tree = (): VarinContextCompactionPlan => ({ kind: 'model_plan', sourceCutHash: 'immutable-cut', nodes: [
  { id: 'left', instructions: null, inputs: [{ kind: 'source', sourceId: 'one', range: { start: 0, end: 1 } }] },
  { id: 'right', instructions: 'Keep evidence.', inputs: [{ kind: 'source', sourceId: 'one', range: { start: 1, end: 5 } }] },
  { id: 'merge', instructions: '', inputs: [{ kind: 'node_output', nodeId: 'left' }, { kind: 'node_output', nodeId: 'right' }] },
], finalNodeId: 'merge' });
test('discoverable Provider declaration admits direct candidates and a genuine non-fold plan', () => {
  assert.deepEqual(parseVarinExtensionServiceProvision(VARIN_CONTEXT_COMPACTION_SERVICE), VARIN_CONTEXT_COMPACTION_SERVICE);
  const validateInput = ajv.compile(VARIN_CONTEXT_COMPACTION_CONTRACT.prepare.inputSchema);
  const validateOutput = ajv.compile(VARIN_CONTEXT_COMPACTION_CONTRACT.prepare.outputSchema);
  assert.equal(validateInput([input()]), true);
  assert.deepEqual(parseVarinContextCompactionInput(input()), input());
  for (const plan of [{ kind: 'text', sourceCutHash: 'immutable-cut', text: 'Pure extractive output.' }, tree()]) {
    assert.equal(validateOutput(plan), true);
    assert.deepEqual(parseVarinContextCompactionPlan(plan, input()), plan);
  }
  const plan = tree();
  const detached = parseVarinContextCompactionPlan(plan, input());
  assert.notEqual(detached, plan);
  if (detached.kind === 'model_plan' && plan.kind === 'model_plan') assert.notEqual(detached.nodes[0], plan.nodes[0]);
});
test('unsafe source authority, malformed budget, duplicate IDs and non-JSON configuration fail before providers run', () => {
  const source = input().sources[0]!;
  for (const bad of [
    { ...input(), credentials: 'extra' },
    { ...input(), sources: [source, source] },
    { ...input(), sources: [{ ...source, item: { ...source.item, opaque: { value: 'hidden' } } }] },
    { ...input(), sources: [{ ...source, item: { ...source.item, provenance: { kind: 'system_instruction', source: 'history:one' } } }] },
    { ...input(), modelBudget: { ...input().modelBudget, sourceBudgetTokens: -1 } },
  ]) assert.throws(() => parseVarinContextCompactionInput(bad));
  assert.throws(() => parseVarinContextCompactionDescription({ identity: { name: 'p', version: '1' }, configuration: { bad: undefined } }));
});
test('native-admissible plan references are exact, topological, reachable and UTF-8 aligned', () => {
  const base = tree();
  assert.equal(base.kind, 'model_plan');
  if (base.kind !== 'model_plan') return;
  const left = base.nodes[0]!;
  const bad: unknown[] = [
    { kind: 'text', sourceCutHash: 'other-cut', text: 'summary' },
    { kind: 'text', sourceCutHash: 'immutable-cut', text: ' ' },
    { ...base, finalNodeId: 'missing' },
    { ...base, nodes: [...base.nodes, { ...left, id: 'unused' }] },
    { ...base, nodes: [left, left] },
    { ...base, nodes: [{ ...left, inputs: [{ kind: 'node_output', nodeId: 'left' }] }] },
    { ...base, nodes: [{ ...left, inputs: [{ kind: 'node_output', nodeId: 'merge' }] }, ...base.nodes.slice(1)] },
    { ...base, nodes: [{ ...left, inputs: [{ kind: 'source', sourceId: 'other', range: null }] }, ...base.nodes.slice(1)] },
    ...[{ start: 2, end: 4 }, { start: 0, end: 2 }, { start: 5, end: 5 }, { start: 0, end: 6 }].map(range =>
      ({ ...base, nodes: [{ ...left, inputs: [{ kind: 'source', sourceId: 'one', range }] }, ...base.nodes.slice(1)] })),
  ];
  for (const plan of bad) assert.throws(() => parseVarinContextCompactionPlan(plan, input()));
  const media = input();
  media.sources[0]!.item.content = { kind: 'media', media: { media_type: 'image/png', data_base64: 'AA==', source: { kind: 'conversation', provenance: { kind: 'assistant' } } } };
  assert.throws(() => parseVarinContextCompactionPlan(base, media), /whole-item/);
  const whole = { ...base, nodes: [{ id: 'leaf', instructions: null, inputs: [{ kind: 'source', sourceId: 'one', range: null }] }], finalNodeId: 'leaf' };
  assert.deepEqual(parseVarinContextCompactionPlan(whole, media), whole);
});
