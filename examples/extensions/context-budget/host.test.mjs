import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  parseVarinExtensionManifest,
  VARIN_CONTEXT_BUDGET_SERVICE,
} from '../../../packages/extension-contract/dist/index.js';

const require = createRequire(import.meta.url);
const manifest = parseVarinExtensionManifest(JSON.parse(
  await readFile(new URL('./varin.extension.json', import.meta.url), 'utf8'),
));
const extension = require(`./${manifest.entrypoints.host.file}`).default;
const registrations = [];
await extension.activate({ services: { provide: (...args) => registrations.push(args) } });
const [declaration, handlers] = registrations[0];
const call = { signal: new AbortController().signal };
const input = () => ({
  boundary: 'before_model_dispatch', requestId: 'request-1',
  estimate: { estimatedTokens: 7_500, unmeasuredMedia: 1, unmeasuredProviderItems: 0, method: 'fixture-estimate' },
  capacityTokens: 10_000, inputBudgetTokens: 8_000,
  settings: { reserveTokens: 2_000, keepRecentTokens: 2_000, backgroundPreparation: true, preparationWaterline: 0.8 },
  candidates: [
    { throughId: 'early', prefixEstimatedTokens: 1_000, retainedEstimatedTokens: 5_000 },
    { throughId: 'near-target', prefixEstimatedTokens: 3_800, retainedEstimatedTokens: 2_200 },
    { throughId: 'late', prefixEstimatedTokens: 5_500, retainedEstimatedTokens: 500 },
  ],
});

test('installable manifest and real bundled SDK registration share the authoritative contract', async () => {
  assert.equal(registrations.length, 1);
  assert.deepEqual(manifest.provides.services, [VARIN_CONTEXT_BUDGET_SERVICE]);
  assert.deepEqual(declaration, manifest.provides.services[0]);
  const description = await handlers.describe([], call);
  assert.equal(description.identity.version, manifest.version);
  const decision = await handlers.decide([input()], call);
  assert.equal(decision.summaryInstructions, description.configuration.summaryInstructions);
  assert.match(decision.summaryInstructions, /source references/);
  assert.match(decision.summaryInstructions, /uncertain/);
});

test('current waterline and input budget choose continue, background or blocking', async () => {
  const view = input();
  const before = structuredClone(view);
  const background = await handlers.decide([view], call);
  assert.equal(background.kind, 'compact');
  assert.equal(background.throughId, 'near-target');
  assert.equal(background.mode, 'background');
  assert.deepEqual(view, before);
  view.estimate.estimatedTokens = view.inputBudgetTokens * view.settings.preparationWaterline;
  assert.deepEqual(await handlers.decide([view], call), { kind: 'continue' });
  view.settings.backgroundPreparation = false;
  view.estimate.estimatedTokens = view.inputBudgetTokens;
  assert.deepEqual(await handlers.decide([view], call), { kind: 'continue' });
  view.estimate.estimatedTokens += 1;
  assert.equal((await handlers.decide([view], call)).mode, 'blocking');
});

test('legal candidates follow the retention target and ties retain more history', async () => {
  const view = input();
  view.settings.keepRecentTokens = 3_000;
  view.candidates = [
    { throughId: 'less-history', prefixEstimatedTokens: 4_000, retainedEstimatedTokens: 2_000 },
    { throughId: 'more-history', prefixEstimatedTokens: 2_000, retainedEstimatedTokens: 4_000 },
  ];
  assert.equal((await handlers.decide([view], call)).throughId, 'more-history');
  view.settings.keepRecentTokens = 2_000;
  assert.equal((await handlers.decide([view], call)).throughId, 'less-history');
  view.candidates = [];
  assert.deepEqual(await handlers.decide([view], call), { kind: 'continue' });
  view.candidates = input().candidates;
  view.inputBudgetTokens = 0;
  assert.deepEqual(await handlers.decide([view], call), { kind: 'continue' });
});

test('the actual SDK rejects non-metadata input and cancelled decisions', async () => {
  await assert.rejects(handlers.decide([{ ...input(), history: 'must not be delivered' }], call), /Invalid context budget input/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled by owner'));
  await assert.rejects(handlers.decide([input()], { signal: controller.signal }), /cancelled by owner/);
});

 test('a later capacity decision applies the already accepted source and instructions', async () => {
  const view = input();
  view.estimate.estimatedTokens = view.inputBudgetTokens + 1;
  view.acceptedCandidate = { throughId: 'early', mode: 'background', summaryInstructions: 'Original guidance' };
  const decision = await handlers.decide([view], call);
  assert.deepEqual(decision, { kind: 'compact', throughId: 'early', mode: 'blocking', summaryInstructions: 'Original guidance' });
});
