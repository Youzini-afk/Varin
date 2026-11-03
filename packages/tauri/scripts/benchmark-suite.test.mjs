import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixtureWorker } from './benchmark-services.mjs';
import { startControlledService, responseRecipe, seedAnswer } from './benchmark-fixture-service.mjs';
import { productWorkloads, manualScenarios } from './benchmark-workloads.mjs';
import { validateWorkload } from './benchmark-contract.mjs';
import { fixtureApi, awaitRun } from './benchmark-seed.mjs';
import { runSuite } from './benchmark-suite.mjs';

test('all seven actual product workloads are nonempty and physical operations are explicit', () => {
  const workloads = productWorkloads({ runtime: 'agent', threadId: 'thread-fixture', branchId: 'branch-fixture' }, { workspace: os.tmpdir() });
  assert.equal(Object.keys(workloads).length, 7);
  for (const workload of Object.values(workloads)) {
    assert.equal(validateWorkload(workload), workload);
    assert.ok(workload.steps.length > 0);
    assert.equal(workload.motion, 'full');
  }
  for (const name of manualScenarios) assert.ok(workloads[name].steps.some(step => step.action === 'manual'));
  assert.ok(workloads['long-chat-stream'].steps.some(step => step.text === 'VARIN_BENCHMARK_STREAM'));
  assert.equal(workloads['repeated-lifecycle'].steps.filter(step => step.action === 'checkpoint').length, 6);
  assert.throws(() => productWorkloads({ threadId: '"] arbitrary' }), /real product Thread/u);
});

test('controlled fixture is a real HTTP SSE endpoint and login/upload/download owner', async () => {
  const service = await startControlledService();
  try {
    const response = await fetch(service.origin + '/v1/responses', { method: 'POST', body: JSON.stringify({ input: 'VARIN_BENCHMARK_SEED:1' }) });
    const stream = await response.text(); assert.ok(stream.includes('event: response.completed'));
    assert.ok(stream.includes('Synthetic answer 1.'));
    assert.equal(service.inspect().completed, 1);
    const denied = await fetch(service.origin + '/upload', { method: 'POST', body: 'not authenticated' }); assert.equal(denied.status, 404);
    const logged = await fetch(service.origin + '/login', { method: 'POST', body: 'name=benchmark&password=synthetic-only', redirect: 'manual' });
    assert.equal(logged.status, 303);
    const cookie = logged.headers.get('set-cookie').split(';')[0];
    const uploaded = await fetch(service.origin + '/upload', { method: 'POST', headers: { cookie }, body: 'synthetic upload' });
    assert.equal((await uploaded.json()).bytes, 16);
    const downloaded = await fetch(service.origin + '/download', { headers: { cookie } }); assert.match(await downloaded.text(), /synthetic native-browser download/u);
    assert.deepEqual([service.inspect().logins, service.inspect().uploads.length, service.inspect().downloads], [1, 1, 1]);
  } finally { await service.stop(); }
  await assert.rejects(fetch(service.origin));
});

test('fixture process waits for original owner stop and observed process-tree exit', async () => {
  const worker = await startFixtureWorker({ node: process.execPath, env: process.env, configuration: { mode: 'provider' }, timeoutMs: 10000 });
  const response = await fetch(worker.origin + '/v1/models'); assert.equal(response.status, 200); await response.text();
  const observed = await worker.sample(); assert.ok(observed.processes.some(p => p.pid === worker.pid));
  const result = await worker.stop();
  assert.equal(result.drained, true); assert.equal(result.forced, false); assert.equal(result.exit.code, 0); assert.equal(result.final.processes.length, 0);
  await assert.rejects(fetch(worker.origin));
});

test('seed accepts only an actual completed Run and refuses external credential destinations', async () => {
  assert.throws(() => fixtureApi('https://example.com', { clientToken: 'synthetic' }), /loopback/u);
  for (const state of ['failed', 'cancelled']) await assert.rejects(awaitRun(async () => ({ state }), 'run'), new RegExp(state, 'u'));
  await assert.rejects(awaitRun(async () => ({}), null), /real Run/u);
  assert.equal((await awaitRun(async () => ({ state: 'completed' }), 'run')).state, 'completed');
  const recipe = responseRecipe({ input: 'VARIN_BENCHMARK_SEED:3' }); assert.equal(recipe.text, seedAnswer(3));
});

test('suite persists a missing-product blocker, never a substitute measured result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-suite-test-'));
  try {
    const output = path.join(root, 'result');
    const result = await runSuite({ pairFile: path.join(root, 'missing.json'), output });
    assert.equal(result.status, 'blocked'); assert.equal(result.qualification, 'not-accepted');
    assert.equal(result.scenarios.length, 0);
    assert.deepEqual(await fs.readdir(output), ['suite.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('same-source candidate reuse rejects a different immutable source before touching runtime artifacts', async () => {
  const { verifyTauriBenchmarkCandidate } = await import('./benchmark-desktop.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-candidate-reuse-test-'));
  try {
    const candidate = path.join(root, 'candidate.json');
    await fs.writeFile(candidate, JSON.stringify({ schema: 1, sourceSha: 'a'.repeat(40), version: '1', target: `${process.platform}-${process.arch}`, runtime: path.join(root, 'never-read') }));
    await assert.rejects(verifyTauriBenchmarkCandidate(candidate, { sourceSha: 'b'.repeat(40), version: '1', target: `${process.platform}-${process.arch}` }), /source\/version\/target mismatch/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
