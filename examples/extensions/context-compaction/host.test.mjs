import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parseVarinExtensionManifest, parseVarinContextCompactionPlan, VARIN_CONTEXT_COMPACTION_SERVICE } from '../../../packages/extension-contract/dist/index.js';

const require = createRequire(import.meta.url);
const manifest = parseVarinExtensionManifest(JSON.parse(await readFile(new URL('./varin.extension.json', import.meta.url), 'utf8')));
const extension = require(`./${manifest.entrypoints.host.file}`).default;
const registrations = [];
await extension.activate({ services: { provide: (...args) => registrations.push(args) } });
const [declaration, handlers] = registrations[0];
const call = { signal: new AbortController().signal };
const source = (sourceId, text) => ({ sourceId, item: { id: `quoted:${sourceId}`, provenance: { kind: 'external_data', source: `history:${sourceId}` }, content: { kind: 'text', text }, opaque: null } });
const input = sources => ({ sourceCutHash: 'original-cut', sources,
  modelBudget: { contextWindowTokens: 16000, maxOutputTokens: 1000, sourceBudgetTokens: 10000 } });

test('installable manifest, real bundled SDK and declared algorithm identity agree', async () => {
  assert.equal(registrations.length, 1);
  assert.deepEqual(manifest.provides.services, [VARIN_CONTEXT_COMPACTION_SERVICE]);
  assert.deepEqual(declaration, VARIN_CONTEXT_COMPACTION_SERVICE);
  assert.equal((await handlers.describe([], call)).identity.version, manifest.version);
});
test('independent source leaves feed a nonlinear merge tree, never a prior-output fold', async () => {
  const view = input(Array.from({ length: 5 }, (_, index) => source(`source-${index}`, `Quoted original role and evidence ${index}. `.repeat(20))));
  const before = structuredClone(view);
  const plan = await handlers.prepare([view], call);
  assert.deepEqual(parseVarinContextCompactionPlan(plan, view), plan);
  assert.equal(plan.kind, 'model_plan');
  assert.equal(plan.nodes.length, 9);
  for (const [index, node] of plan.nodes.slice(0, 5).entries()) {
    assert.deepEqual(node.inputs, [{ kind: 'source', sourceId: `source-${index}`, range: null }]);
  }
  assert.deepEqual(plan.nodes[5].inputs, [{ kind: 'node_output', nodeId: 'leaf-0' }, { kind: 'node_output', nodeId: 'leaf-1' }]);
  assert.deepEqual(plan.nodes[6].inputs, [{ kind: 'node_output', nodeId: 'leaf-2' }, { kind: 'node_output', nodeId: 'leaf-3' }]);
  assert.equal(plan.finalNodeId, plan.nodes.at(-1).id);
  assert.deepEqual(view, before);
});
test('oversized Unicode quotations have exact UTF-8 chunks; media remains whole', async () => {
  const original = source('unicode', '原文🙂'.repeat(1400));
  const media = { sourceId: 'image', item: { id: 'quoted-image', provenance: { kind: 'external_data', source: 'history:image' }, opaque: null,
    content: { kind: 'media', media: { media_type: 'image/png', data_base64: 'AA==', source: { kind: 'conversation', provenance: { kind: 'user_instruction', input_id: 'user' } } } } } };
  const view = input([original, media]);
  const plan = await handlers.prepare([view], call);
  assert.equal(plan.kind, 'model_plan');
  parseVarinContextCompactionPlan(plan, view);
  const leaves = plan.nodes.filter(node => node.inputs[0].kind === 'source');
  const ranges = leaves.flatMap(node => node.inputs).filter(reference => reference.sourceId === 'unicode');
  const bytes = Buffer.from(original.item.content.text);
  assert.equal(ranges[0].range.start, 0);
  assert.equal(ranges.at(-1).range.end, bytes.length);
  assert.equal(ranges.map(reference => bytes.subarray(reference.range.start, reference.range.end).toString('utf8')).join(''), original.item.content.text);
  assert.deepEqual(leaves.at(-1).inputs, [{ kind: 'source', sourceId: 'image', range: null }]);
});
test('small textual cuts use the pure extractive zero-model candidate; cancellation rejects', async () => {
  const view = input([source('one', '{"provenance":{"kind":"assistant"},"content":{"kind":"text","text":"Observed result"}}')]);
  const plan = await handlers.prepare([view], call);
  assert.equal(plan.kind, 'text');
  assert.equal(plan.sourceCutHash, view.sourceCutHash);
  assert.match(plan.text, /Observed result/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(handlers.prepare([view], { signal: controller.signal }), { name: 'AbortError' });
});
