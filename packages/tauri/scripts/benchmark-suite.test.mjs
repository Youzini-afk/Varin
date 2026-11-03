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
  assert.equal(result.drained, true); assert.equal(result.forced, false); assert.equal(result.ownerStopAcknowledged, true);
  assert.equal(result.exit.code, 0); assert.equal(result.final.processes.length, 0);
  await assert.rejects(fetch(worker.origin));
});

test('fixture setup and stop failures retain unresolved writers without unbound process-tree kills', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-fixture-lifetime-test-'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exists = file => fs.access(file).then(() => true, () => false);
  const until = async (check, description) => {
    const deadline = performance.now() + 10000;
    while (!await check() && performance.now() < deadline) await pause(25);
    assert.ok(await check(), description);
  };
  t.after(async () => {
    for (const phase of ['setup', 'stop']) {
      const directory = path.join(root, phase);
      if (!await exists(path.join(directory, 'writer-ready'))) continue;
      await fs.writeFile(path.join(directory, 'stop-writer'), 'stop');
      await until(() => exists(path.join(directory, 'writer-closed')), 'Original test writer closed its file before cleanup');
      await until(() => exists(path.join(directory, 'root-closed')), 'Original test worker reached its explicit exit');
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const phase of ['setup', 'stop']) {
    const directory = path.join(root, phase), runtime = path.join(directory, 'runtime');
    const server = path.join(runtime, 'host/node_modules/@varin/web/server');
    await fs.mkdir(server, { recursive: true });
    await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
    await fs.writeFile(path.join(directory, 'original-state'), 'original worker owns this data');
    // A real process fixture, not a substitute Host or product acceptance.
    // The writer is born only after initial process registration and must keep
    // its existing file after setup/stop reports an unconfirmed outcome.
    const writer = `const fs=require('node:fs'),path=require('node:path'),root=process.env.VARIN_DATA_DIR;
      const file=fs.openSync(path.join(root,'writer-progress'),'a');let ticks=0;
      fs.writeFileSync(path.join(root,'writer-ready'),'ready');
      const timer=setInterval(()=>{fs.writeSync(file,String(++ticks)+'\\n');
        if(fs.existsSync(path.join(root,'stop-writer'))||ticks>400){clearInterval(timer);fs.closeSync(file);fs.writeFileSync(path.join(root,'writer-closed'),'closed');}},25);`;
    await fs.writeFile(path.join(server, 'index.js'), `import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
      const root=process.env.VARIN_DATA_DIR;
      async function fail(){const child=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});child.unref();
        while(!await fs.access(path.join(root,'writer-ready')).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));
        setTimeout(async()=>{await fs.writeFile(path.join(root,'root-closed'),'closed');process.exit(0)},500);
        throw new Error('Controlled original owner failure');}
      export async function startWebUiServer(){${phase === 'setup' ? 'await fail();' : ''}
        return {getPort:()=>1,getDesktopLocalCredentials:async()=>({clientToken:'synthetic'}),isReady:()=>true,stop:fail};}
    `);
    let failure;
    try {
      const worker = await startFixtureWorker({ node: process.execPath,
        env: { ...process.env, VARIN_DATA_DIR: directory }, configuration: { mode: 'host', runtime, providerOrigin: 'http://127.0.0.1:1' }, timeoutMs: 10000 });
      await worker.stop();
    } catch (error) { failure = error; }
    assert.ok(failure, 'The controlled owner must fail');
    assert.equal(failure.cleanupUncertain, true);
    assert.equal(failure.fixtureCleanup.drained, false);
    assert.equal(failure.fixtureCleanup.forced, false);
    assert.equal(failure.fixtureCleanup.ownerStopAcknowledged, false);
    await until(() => exists(path.join(directory, 'writer-progress')), 'Original writer started');
    const first = (await fs.stat(path.join(directory, 'writer-progress'))).size;
    await pause(100);
    assert.ok((await fs.stat(path.join(directory, 'writer-progress'))).size > first, 'No numeric PID/group kill may terminate the unresolved writer');
    assert.equal(await fs.readFile(path.join(directory, 'original-state'), 'utf8'), 'original worker owns this data');
  }
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
