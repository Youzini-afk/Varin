import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { hashJson, hashDirectory, validateBenchmarkRequest, validateWorkload, readIsolatedRequest, summarizeRun } from './benchmark-contract.mjs';
import { dispatchBenchmarkInput, publicRendererSample, remoteTargetExpression } from './benchmark-driver.mjs';
import { planTemplate, preflight, compareRuns, runBenchmark, measureRun } from './benchmark-desktop.mjs';

const pageSource = await fs.readFile(new URL('./benchmark-page.js', import.meta.url), 'utf8');
const workload = steps => ({ name: 'workspace-transitions', motion: 'full', timeoutMs: 10000, readyTimeoutMs: 500,
  ready: [{ selector: '[data-varin-workbench-switcher]', visible: true }], steps });
const request = steps => {
  const value = workload(steps);
  return { schema: 1, product: 'varin-desktop-benchmark-request', nonce: randomUUID(), sourceSha: 'a'.repeat(40), version: '1.2.3',
    sampleIntervalMs: 100, scenarioSha256: hashJson(value), inputs: { frontendSha256: 'b'.repeat(64), dataSha256: 'c'.repeat(64), configurationSha256: 'd'.repeat(64) }, workload: value };
};
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-benchmark-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

// This browser harness tests the observer state machine. It is deliberately not
// saved as a product trace, nor accepted as evidence of native rendering/input.
function browserHarness({ ready = true, motion = 'full' } = {}) {
  let now = 0, frame, observerCallback, observerDisconnected = false;
  const elements = new Map(), listeners = new Map();
  const element = () => ({ contains: () => false, scrollTop: 0, disabled: false, attrs: new Map(), textContent: '', getClientRects: () => [1],
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }), getAttribute(name) { return this.attrs.get(name) ?? null; } });
  if (ready) elements.set('[data-varin-workbench-switcher]', element());
  const context = { console, AbortController, innerWidth: 1440, innerHeight: 1000, devicePixelRatio: 1,
    performance: { now: () => now }, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; },
    PerformanceObserver: class { static supportedEntryTypes = ['event', 'first-input']; constructor(callback) { observerCallback = callback; } observe() {} disconnect() { observerDisconnected = true; } },
    document: { readyState: 'complete', visibilityState: 'visible', documentElement: { dataset: { motion } },
      querySelector: selector => elements.get(selector) ?? null, querySelectorAll: selector => elements.has(selector) ? [elements.get(selector)] : [],
      addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name),
    }, __VARIN_RUNTIME_APIS__: {}, __VARIN_DESKTOP__: {} };
  context.window = context; vm.runInNewContext(pageSource, context);
  const api = context.__varinDesktopBenchmark;
  return { api, context, elements, element, advance(ms) { now += ms; }, frame(ms) { now += ms; frame?.(now); },
    emit(name, trusted = true) { listeners.get(name)?.({ isTrusted: trusted }); },
    timing(values) { observerCallback({ getEntries: () => values }); },
    get stopped() { return !frame && !listeners.size && observerDisconnected; } };
}

test('request identity binds full workload and rejects executable, reduced or empty replay', () => {
  const valid = request([{ id: 'observe', action: 'wait', durationMs: 50 }]);
  assert.equal(validateBenchmarkRequest(valid), valid);
  for (const mutate of [value => { value.workload.motion = 'off'; }, value => { value.workload.steps = []; },
    value => { value.workload.steps[0].expression = 'window.location = "https://example.com"'; },
    value => { value.inputs.frontendSha256 = ''; }, value => { value.scenarioSha256 = 'f'.repeat(64); }]) {
    const changed = structuredClone(valid); mutate(changed); assert.throws(() => validateBenchmarkRequest(changed));
  }
  assert.throws(() => validateWorkload(workload([{ id: 'input', action: 'click', selector: '#button' }])));
  assert.throws(() => validateWorkload({ ...workload([{ id: 'idle', action: 'wait', durationMs: 20 }]), name: 'repeated-lifecycle' }));
});

test('content hash covers empty directories and every file; input symlinks are rejected', async t => {
  const dir = await temporary(t); await fs.writeFile(path.join(dir, 'data'), 'original');
  const before = await hashDirectory(dir); await fs.writeFile(path.join(dir, 'data'), 'changed');
  assert.notEqual(await hashDirectory(dir), before);
  const changed = await hashDirectory(dir); await fs.mkdir(path.join(dir, 'empty'));
  assert.notEqual(await hashDirectory(dir), changed);
  if (process.platform !== 'win32') { await fs.symlink(path.join(dir, 'data'), path.join(dir, 'alias')); await assert.rejects(hashDirectory(dir), /symbolic/u); }
});

test('isolated marker requires an explicit temporary regular directory and bound request', async t => {
  const dir = await temporary(t), value = request([{ id: 'observe', action: 'wait', durationMs: 100 }]);
  await fs.writeFile(path.join(dir, 'benchmark-request.json'), JSON.stringify(value));
  assert.equal((await readIsolatedRequest(dir)).request.nonce, value.nonce);
  await assert.rejects(readIsolatedRequest('.'), /absolute/u);
  await assert.rejects(readIsolatedRequest(os.tmpdir()), /new real child/u);
  if (process.platform !== 'win32') {
    const parent = await temporary(t), alias = path.join(parent, 'alias'); await fs.symlink(dir, alias);
    await assert.rejects(readIsolatedRequest(alias), /real child/u);
  }
});

test('observer refuses a blank/auth-only page and never turns reduced motion into a pass', () => {
  const harness = browserHarness({ ready: false, motion: undefined });
  harness.api.start(workload([{ id: 'idle', action: 'wait', durationMs: 20 }]));
  assert.equal(harness.api.poll().status, 'waiting-ready');
  harness.advance(501); assert.equal(harness.api.poll().status, 'failed');
  const reduced = browserHarness({ motion: 'reduced' }); reduced.api.start(workload([{ id: 'idle', action: 'wait', durationMs: 20 }]));
  assert.equal(reduced.api.poll().status, 'failed');
  assert.equal(reduced.context.document.documentElement.dataset.motion, 'reduced');
});

test('replay needs actual post-input commit and settlement; synthetic JS events are not accepted', () => {
  const h = browserHarness(); h.elements.set('#open', h.element());
  h.api.start(workload([{ id: 'open-panel', action: 'click', selector: '#open', expect: [{ selector: '#panel', visible: true }], settleMs: 30 }]));
  assert.equal(h.api.poll().status, 'running');
  const action = h.api.poll().pendingAction; assert.equal(action.action, 'click');
  assert.equal(h.elements.has('#panel'), false);
  h.api.dispatched(action.id); h.elements.set('#panel', h.element()); h.emit('pointerdown', false);
  h.advance(40); assert.equal(h.api.poll().status, 'running');
  h.emit('pointerdown', true); h.api.poll(); h.advance(29); assert.equal(h.api.poll().status, 'running');
  h.advance(1); const done = h.api.poll(); assert.equal(done.status, 'completed');
  assert.equal(done.receipts[0].trustedInputs, 1); assert.equal(done.receipts[0].settledMs - done.receipts[0].committedMs, 30);
  assert.equal(h.api.poll().receipts.length, 0);
  h.api.stop(); assert.equal(h.stopped, true);
});

test('an already satisfied input postcondition cannot masquerade as a new UI commit', () => {
  const h = browserHarness(); h.elements.set('#open', h.element()); h.elements.set('#panel', h.element());
  h.api.start(workload([{ id: 'open-panel', action: 'click', selector: '#open', expect: [{ selector: '#panel', visible: true }] }]));
  h.api.poll(); assert.equal(h.api.poll().status, 'failed');
});

test('observations retain real RAF intervals, thresholded Event Timing and manual native coverage gaps', () => {
  const h = browserHarness(); h.api.start(workload([{ id: 'browser-control', action: 'manual', durationMs: 40, expect: [{ selector: '[data-varin-workbench-switcher]', visible: true }] }]));
  h.api.poll(); h.frame(16); h.frame(24);
  h.timing([{ entryType: 'event', startTime: 10, duration: 32, processingStart: 18, processingEnd: 22, interactionId: 1 }]);
  assert.equal(h.api.poll().status, 'running');
  h.api.externalInputs(1); const observed = h.api.poll(); assert.equal(observed.status, 'completed');
  assert.equal(observed.receipts[0].nativeCoverage, 'operator-observation-still-required');
  assert.throws(() => h.api.externalInputs(0));
  const passive = browserHarness(); passive.api.start({ passive: true }); passive.frame(16); passive.frame(17);
  const data = passive.api.poll(); assert.deepEqual([...data.frameTimesMs], [17]); assert.equal(data.status, 'observing');
  assert.deepEqual([...passive.api.poll().frameTimesMs], []);
});

test('native replay dispatches renderer input only and removes text from persisted samples', async () => {
  const commands = []; const send = async (method, params) => { commands.push({ method, params }); return {}; };
  await dispatchBenchmarkInput(send, { id: 'open', action: 'click', x: 20, y: 30 });
  assert.deepEqual(commands.map(item => item.params.type), ['mousePressed', 'mouseReleased']);
  await dispatchBenchmarkInput(send, { id: 'submit', action: 'key', key: 'Enter' });
  assert.equal(commands.at(-1).method, 'Input.dispatchKeyEvent');
  await assert.rejects(dispatchBenchmarkInput(send, { id: 'unsafe', action: 'Runtime.evaluate' }), /Unknown/u);
  const sample = publicRendererSample({ pendingAction: { text: 'not recorded' }, frameTimesMs: [16], status: 'running' });
  assert.equal('pendingAction' in sample, false);
});

test('whole-tree CPU accounting follows identities, includes exited counters and never subtracts a disappearing tree', () => {
  const p = (pid, startIdentity, cpuTimeMs, memoryBytes = 100) => ({ pid, startIdentity, cpuTimeMs, memoryBytes });
  const run = { startupMs: 20, samples: [
    { monotonicMs: 0, processes: [p(1, 'a', 100), p(2, 'b', 50)] },
    { monotonicMs: 100, processes: [p(1, 'a', 150), p(3, 'c', 30)], coverage: { exitedProcesses: [p(2, 'b', 70)] } },
    { monotonicMs: 200, processes: [p(1, 'a', 180), p(3, 'c', 60)] },
  ] };
  const summary = summarizeRun(run); assert.equal(summary.cpuTimeMs, 160); assert.equal(summary.cpuCoreEquivalent, .8);
  assert.equal(summary.memoryMedianBytes, 200); assert.equal(summary.inputP95Ms, null);
  const incomplete = structuredClone(run); incomplete.samples[1].processes[0].memoryBytes = null;
  assert.equal(summarizeRun(incomplete).memoryMedianBytes, null);
  incomplete.samples[1].processes[0].cpuTimeMs = null; assert.equal(summarizeRun(incomplete).cpuTimeMs, null);
});

test('comparison rejects frontend/data/source/accounting mismatches and never auto-accepts numeric fixtures', () => {
  const plan = { sourceSha: 'a'.repeat(40), version: '1.2.3', target: 'linux-x64', repetitions: 1 }, checked = { environment: {}, scenarios: [] };
  const base = { ...plan, iteration: 0, scenario: 'remote-idle', scenarioSha256: 'a'.repeat(64), inputs: { frontendSha256: 'a', dataSha256: 'b', configurationSha256: 'c' },
    memoryMetric: 'proportional-set-bytes', cacheCondition: 'fresh-profile-os-cache-uncontrolled', status: 'measured-awaiting-review', samples: [] };
  const runs = [{ ...base, shell: 'electron' }, { ...base, shell: 'tauri' }];
  checked.scenarios.push({ name: 'remote-idle', scenarioSha256: base.scenarioSha256, inputs: structuredClone(base.inputs) });
  const comparison = compareRuns(plan, checked, runs); assert.equal(comparison.status, 'not-qualified');
  assert.ok(comparison.scenarios.every(scenario => scenario.assessment.accepted === false));
  assert.equal(comparison.scenarios[0].pairs[0].status, 'incomplete');
  assert.ok(comparison.issues.includes('remote-idle:0:incomplete-pair'));
  for (const field of ['sourceSha', 'scenarioSha256', 'memoryMetric', 'cacheCondition']) {
    const changed = structuredClone(runs); changed[1][field] = 'different'; assert.throws(() => compareRuns(plan, checked, changed), /mismatched/u);
  }
  const changed = structuredClone(runs); changed[1].inputs.dataSha256 = 'different'; assert.throws(() => compareRuns(plan, checked, changed), /mismatched/u);
});

test('unprepared full-product A/B persists explicit preflight blockers without launching a substitute', async t => {
  const dir = await temporary(t), plan = planTemplate();
  const result = await preflight(plan);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.some(item => item.code === 'tauri-candidate-unavailable'));
  assert.ok(result.blockers.some(item => item.code === 'disposable-os-user-required'));
  const output = path.join(dir, 'blocked');
  assert.equal((await runBenchmark(plan, { output })).status, 'blocked');
  assert.equal((await readJson(path.join(output, 'preflight.json'))).qualification, 'not-accepted');
  assert.deepEqual(await fs.readdir(output), ['preflight.json']);
});
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }


test('empty, single-point and unreadable process windows cannot claim zero usage', () => {
  for (const samples of [[], [{ monotonicMs: 0, processes: [] }],
    [{ monotonicMs: 0, processes: [] }, { monotonicMs: 100, processes: [] }]]) {
    const summary = summarizeRun({ samples });
    assert.equal(summary.cpuTimeMs, null);
    assert.equal(summary.memoryMedianBytes, null);
    assert.equal(summary.memoryPeakObservedBytes, null);
  }
  const p = { pid: 1, startIdentity: 'a', memoryBytes: 100, cpuTimeMs: 20 };
  const samples = [{ monotonicMs: 0, processes: [p] }, { monotonicMs: 100, processes: [p], coverage: { processCountersComplete: false } }];
  assert.equal(summarizeRun({ samples }).cpuTimeMs, null);
  assert.equal(summarizeRun({ samples }).memoryMedianBytes, null);
});

test('startup renderer frames are not pooled into the measured workload', () => {
  const result = summarizeRun({ samples: [], rendererSamples: [
    { targets: [{ label: 'application:main', status: 'waiting-ready', frameTimesMs: [999] }] },
    { targets: [{ label: 'application:main', status: 'running', frameTimesMs: [16] }] },
    { targets: [{ label: 'application:main', status: 'completed', frameTimesMs: [17] }] },
  ] });
  assert.equal(result.frameCount, 2);
  assert.equal(result.frameP95Ms, 17);
});

test('readiness has its own budget and drains pre-workload frame observations', () => {
  const h = browserHarness({ ready: false });
  h.api.start({ ...workload([{ id: 'idle', action: 'wait', durationMs: 100 }]), readyTimeoutMs: 1000, timeoutMs: 200 });
  h.frame(16); h.frame(500);
  assert.equal(h.api.poll().status, 'waiting-ready');
  h.elements.set('[data-varin-workbench-switcher]', h.element());
  const ready = h.api.poll(); assert.equal(ready.status, 'running'); assert.equal(ready.frameTimesMs.length, 0);
  h.advance(100); assert.equal(h.api.poll().status, 'completed');
  h.api.stop(); assert.equal(h.stopped, true);
});

test('unknown scenario selection is rejected before creating or launching a run', async t => {
  const dir = await temporary(t), output = path.join(dir, 'unknown');
  await assert.rejects(runBenchmark(planTemplate(), { output, selected: ['typo'] }), /known product scenarios/u);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});


test('Electron baseline verification binds every full-product file, not only the launcher', async t => {
  const { verifyElectronBaseline } = await import('./benchmark-build.mjs');
  const { engineInventory } = await import('./build-candidate.mjs');
  const { hashFile } = await import('./benchmark-contract.mjs');
  const dir = await temporary(t), payload = path.join(dir, 'payload'), frontendDirectory = path.join(payload, 'resources', 'web-dist');
  await fs.mkdir(frontendDirectory, { recursive: true });
  const executable = path.join(payload, 'varin');
  await fs.writeFile(executable, 'synthetic launcher, not executable product evidence');
  await fs.writeFile(path.join(frontendDirectory, 'index.html'), 'synthetic frontend');
  const record = { schema: 1, product: 'varin-electron-benchmark-baseline', sourceSha: 'a'.repeat(40), version: '1.2.3', target: 'linux-x64',
    buildMode: 'normal-product-package-dir', sourceDirty: false, payload, executable, frontendDirectory,
    executableSha256: await hashFile(executable), frontendSha256: await hashDirectory(frontendDirectory), files: await engineInventory(payload) };
  const manifest = path.join(dir, 'baseline.json'); await fs.writeFile(manifest, JSON.stringify(record));
  await verifyElectronBaseline(manifest, record);
  await fs.writeFile(path.join(payload, 'resources', 'extra.js'), 'different application behavior');
  await assert.rejects(verifyElectronBaseline(manifest, record), /changed after packaging/u);
});


test('measureRun retains isolated data when setup or teardown cannot prove service exit', async t => {
  const dir = await temporary(t), fixtureDirectory = path.join(dir, 'fixture');
  await fs.mkdir(path.join(fixtureDirectory, 'data'), { recursive: true });
  await fs.mkdir(path.join(fixtureDirectory, 'home'));
  await fs.writeFile(path.join(fixtureDirectory, 'data', 'owner-state'), 'must remain while ownership is unresolved');
  const scenario = { name: 'remote-idle', fixtureDirectory, workload: { ...workload([{ id: 'idle', action: 'wait', durationMs: 20 }]), name: 'remote-idle' } };
  const plan = { sourceSha: 'a'.repeat(40), version: '1.2.3', intervalMs: 100, electron: { executable: process.execPath, frontendDirectory: fixtureDirectory } };
  const bound = { name: scenario.name, inputs: { frontendSha256: 'b'.repeat(64), dataSha256: await hashDirectory(fixtureDirectory), configurationSha256: 'c'.repeat(64) }, scenarioSha256: hashJson(scenario.workload) };
  const checked = { scenarios: [bound], electronArtifact: { sha256: 'd'.repeat(64) } };
  for (const phase of ['setup', 'teardown', 'confirmed-stop']) {
    let copiedRoot;
    const result = await measureRun(plan, checked, scenario, 'electron', phase, dir, {
      beforeRun({ root }) { copiedRoot = root; throw Object.assign(new Error('Injected pre-launch setup failure'), { cleanupUncertain: phase === 'setup' }); },
      afterRun() { if (phase === 'teardown') throw Object.assign(new Error('Injected unresolved original-owner exit'), { cleanupUncertain: true }); },
    });
    const persisted = await readJson(path.join(dir, `electron-${phase}.json`));
    assert.equal(result.status, 'failed'); assert.equal(result.rootPid, null); // Never launches a substitute product.
    if (phase === 'confirmed-stop') {
      assert.equal(result.retainedPrivateDirectory, undefined);
      await assert.rejects(fs.access(copiedRoot), { code: 'ENOENT' });
    } else {
      t.after(() => fs.rm(copiedRoot, { recursive: true, force: true })); // No actual process was launched by this injection.
      assert.equal(result.cleanupUncertain, true);
      assert.equal(persisted.retainedPrivateDirectory, copiedRoot);
      assert.equal(await fs.readFile(path.join(copiedRoot, 'data', 'owner-state'), 'utf8'), 'must remain while ownership is unresolved');
      const comparison = compareRuns({ ...plan, repetitions: 1 }, checked, [{ ...result, scenario: scenario.name }]);
      assert.equal(comparison.cleanupUncertain, true);
      assert.equal(comparison.retainedPrivateDirectories[0].path, copiedRoot); // Preserved even with an interrupted/missing pair.
    }
  }
});

test('file automation only selects the private fixture through Chromium, never an arbitrary DOM script', async () => {
  const calls = [];
  const send = async (method, params) => { calls.push({ method, params }); return method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeId: 2 }; };
  await dispatchBenchmarkInput(send, { id: 'fixture-upload', action: 'file' }, { uploadFile: '/private/benchmark-upload.txt' });
  assert.deepEqual(calls.map(row => row.method), ['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
  assert.equal(calls[1].params.selector, '#upload-input');
  assert.deepEqual(calls[2].params.files, ['/private/benchmark-upload.txt']);
  await assert.rejects(dispatchBenchmarkInput(send, { id: 'fixture-upload', action: 'file' }), /not prepared/u);
  assert.throws(() => validateWorkload(workload([{ id: 'arbitrary-file', action: 'file', selector: '#upload-input' }])), /confined/u);
});

test('local process completion and stop require original writer and operation receipts, not a terminal Run alone', async () => {
  const h = browserHarness(); let processes = [], operations = [];
  Object.assign(h.context, { URL, AbortSignal, __VARIN_API_BASE_URL__: 'http://127.0.0.1:1234', __VARIN_CLIENT_TOKEN__: 'synthetic' });
  h.context.__VARIN_RUNTIME_APIS__.threads = { snapshot: async () => ({ activeRun: { id: 'run', state: 'completed' }, operations }) };
  h.context.fetch = async () => ({ ok: true, json: async () => ({ processes }) });
  h.api.start({ ...workload([{ id: 'exit-proof', action: 'wait', durationMs: 1, owner: 'process-completed' }, { id: 'stop-proof', action: 'wait', durationMs: 1, owner: 'process-stopped' }]),
    name: 'local-hybrid-execution', ownerIdentity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, workspace: '/synthetic' });
  h.api.poll(); h.advance(10); await h.api.observeOwner(); assert.equal(h.api.poll().stepIndex, 0);
  processes = [{ processId: 'short', kernelEpoch: 'epoch', pid: 101, status: 'running', writerActive: true }];
  await h.api.observeOwner(); assert.equal(h.api.poll().stepIndex, 0);
  processes[0] = { ...processes[0], status: 'exited', exitCode: 0, writerActive: true };
  await h.api.observeOwner(); assert.equal(h.api.poll().stepIndex, 0);
  processes[0].writerActive = false; await h.api.observeOwner(); assert.equal(h.api.poll().stepIndex, 1);
  processes.push({ processId: 'held', kernelEpoch: 'epoch', pid: 102, status: 'running', writerActive: true });
  await h.api.observeOwner(); h.advance(10); assert.equal(h.api.poll().status, 'running');
  operations = [{ id: 'original-job', managed_process: {}, phase: 'terminal', outcome: 'cancelled', cancel_requested: true }];
  await h.api.observeOwner(); assert.equal(h.api.poll().status, 'running');
  processes[1] = { ...processes[1], status: 'exited', writerActive: false, signal: 'SIGTERM' };
  await h.api.observeOwner(); assert.equal(h.api.poll().status, 'completed');
});

test('Browser owner download proof requires native replay completion and exact completed-file bytes', async () => {
  const { webcrypto, createHash } = await import('node:crypto');
  const h = browserHarness(), expected = Buffer.from('expected download'); let state = 'progressing', bytes = Buffer.from('wrong download');
  Object.assign(h.context, { URL, AbortSignal, crypto: webcrypto, Uint8Array, __VARIN_API_BASE_URL__: 'http://127.0.0.1:1234', __VARIN_CLIENT_TOKEN__: 'synthetic' });
  h.context.fetch = async url => ({ ok: true, json: async () => url.pathname === '/api/browsers' ? { pages: [{ pageId: 'original-page', url: 'http://127.0.0.1:4321/site' }] }
    : [{ downloadId: 'original-download', state, name: 'benchmark-download.txt' }], arrayBuffer: async () => bytes });
  h.api.start({ ...workload([{ id: 'download-proof', action: 'wait', durationMs: 1, owner: 'browser-download-completed' }]), name: 'browser-interaction',
    browser: { url: 'http://127.0.0.1:4321/site', downloadSha256: createHash('sha256').update(expected).digest('hex') } });
  h.api.poll(); h.advance(10); await h.api.observeOwner(); assert.equal(h.api.poll().status, 'running');
  state = 'completed'; await h.api.observeOwner(); assert.equal(h.api.poll().status, 'running');
  bytes = expected; await h.api.observeOwner(); assert.equal(h.api.poll().status, 'running');
  h.api.nativeCompletion(true); const completed = h.api.poll(); assert.equal(completed.status, 'completed');
  assert.equal(completed.ownerObservation.pageId, 'original-page');
  assert.equal(completed.ownerObservation.download.source, 'original-native-download-owner-completed-file-read');
});

test('remote terminal Run is read by its retained original ID after activeRun disappears', async () => {
  const h = browserHarness(); let active = true;
  Object.assign(h.context, { URL, AbortSignal, __VARIN_API_BASE_URL__: 'http://127.0.0.1:4321', __VARIN_CLIENT_TOKEN__: 'synthetic' });
  const lookedUp = [];
  h.context.__VARIN_RUNTIME_APIS__.threads = {
    snapshot: async () => ({ activeRun: active ? { id: 'original-remote-run', state: 'running' } : null, operations: [] }),
    run: async id => { lookedUp.push(id); return { id, state: 'cancelled' }; },
  };
  h.context.fetch = async () => ({ ok: true, json: async () => ({ processes: [] }) });
  h.api.start({ ...workload([{ id: 'original-remote-stop', action: 'wait', durationMs: 1, owner: 'run-cancelled' }]),
    ownerIdentity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, workspace: '/synthetic' });
  h.api.poll(); h.advance(10); await h.api.observeOwner(); assert.equal(h.api.poll().status, 'running');
  active = false; await h.api.observeOwner(); assert.equal(h.api.poll().status, 'completed');
  assert.deepEqual(lookedUp, ['original-remote-run']);
});


test('remote native window binding normalizes trailing slash but never adopts another Host', () => {
  const expression = remoteTargetExpression('http://127.0.0.1:4321');
  const run = base => vm.runInNewContext(expression, { URL, window: { __VARIN_RUNTIME_APIS__: {}, __VARIN_API_BASE_URL__: base } });
  assert.equal(run('http://127.0.0.1:4321/'), true);
  assert.equal(run('http://127.0.0.1:4321'), true);
  assert.equal(run('http://127.0.0.1:4322/'), false);
  assert.equal(run(undefined), false);
  assert.throws(() => remoteTargetExpression('https://example.com'), /loopback/u);
});

test('observer identity rejects passive-as-active and active restart never replays dispatched input', () => {
  const passive = browserHarness();
  passive.api.start({ passive: true });
  const active = workload([{ id: 'click-once', action: 'click', selector: '#button', expect: [{ selector: '#done', visible: true }] }]);
  assert.equal(passive.api.matchesWorkload(active), false);
  assert.throws(() => passive.api.start(active), /workload changed/u);
  assert.equal(passive.api.poll().status, 'observing');
  const h = browserHarness(); h.elements.set('#button', h.element());
  h.api.start(active);
  h.api.poll();
  h.advance(1);
  const pending = h.api.poll().pendingAction;
  assert.equal(pending.id, 'click-once');
  h.api.dispatched(pending.id);
  assert.equal(h.api.start(structuredClone(active)).resumed, true);
  assert.equal(h.api.matchesWorkload(active), true);
  assert.equal(h.api.poll().pendingAction, null);
  h.emit('pointerdown'); h.elements.set('#done', h.element());
  h.api.poll(); h.advance(1); h.api.poll();
  assert.equal(h.api.start(active).resumed, true);
  assert.equal(h.api.poll().status, 'completed');
  h.api.stop(); assert.equal(h.api.matchesWorkload(active), false);
  assert.throws(() => h.api.start(active), /ended/u);
});

test('companion diagnostic distinguishes real paint coverage from asset traversal and closes bitmaps on draw failure', async () => {
  const { webcrypto, createHash } = await import('node:crypto');
  for (const failDraw of [false, true]) {
    const h = browserHarness();
    const bundle = { packages: [{ id: 'synthetic-action', canvas: [8,8], pages: [{ file: 'atlas.png' }], frames: [{ page: 0, rect: [0,0,8,8], offset: [0,0] }] }] };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle)), epoch = createHash('sha256').update(bytes).digest('hex');
    let closed = 0, draws = 0;
    const pixels = new Uint8ClampedArray(8*8*4); pixels.fill(255);
    const canvas = { width: 8, height: 8, getBoundingClientRect: () => ({ left: 0, top: 0, width: 8, height: 8 }),
      getContext: () => ({ getImageData: () => ({ data: pixels }) }),
      __varinCompanionAssetBase: 'varin-companion://localhost/varin/version/',
      __varinCompanionEvidence: { epoch, paints: 0, lastSuccessfulPaint: { epoch, packageId: 'static-pose', source: 'original-painter-successful-commit' }, notCovered: ['synthetic-action'] } };
    h.elements.set('canvas', canvas);
    Object.assign(h.context, { crypto: webcrypto, Uint8Array, TextDecoder, URL, setTimeout, location: { href: 'varin-ui://app/companion.html?companionPack=varin&companionVersion=test-version' }, screenX: 0, screenY: 0, outerWidth: 8, outerHeight: 8,
      fetch: async url => ({ ok: true, arrayBuffer: async () => bytes.buffer, blob: async () => ({}) }),
      createImageBitmap: async () => ({ width: 8, height: 8, close: () => { closed++; } }),
      OffscreenCanvas: class { constructor(w,h) { this.width=w; this.height=h; } getContext() { return { clearRect() {}, drawImage() { draws++; if (failDraw) throw new Error('decode succeeded but draw failed'); }, getImageData() {}, isContextLost: () => false }; } },
    });
    const api = h.context.__varinCompanionBenchmark;
    api.start({ epoch, version: 'test-version', packageCount: 1, idleMs: 1, files: [{ path: 'atlas.png' }] });
    assert.throws(() => api.recordDrag({ complete: true, released: true }), /precede drag/);
    api.poll(); h.advance(2); assert.equal(api.poll().status, 'waiting-system-drag');
    api.recordDrag({ complete: true, released: true });
    for (let i=0; i<100 && api.poll().status === 'asset-diagnostic'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    const result = api.poll(); assert.equal(result.status, failDraw ? 'failed' : 'completed');
    assert.equal(result.diagnostic.packages.length, failDraw ? 0 : 1);
    assert.equal(result.diagnostic.failed.length, failDraw ? 1 : 0);
    assert.deepEqual([...result.normal.notCovered], ['synthetic-action']);
    assert.equal(closed, 1); assert.equal(draws, 1); assert.equal(result.diagnostic.released, true);
    const elapsed = result.normalObservationMs; h.advance(1000); assert.equal(api.poll().normalObservationMs, elapsed);
    vm.runInNewContext(pageSource, h.context); assert.equal(h.context.__varinCompanionBenchmark, api);
    assert.equal((await api.stop()).settled, true);
  }
});

test('companion verification and diagnostics never enter normal counter deltas or renderer quantiles', () => {
  const record = (phase, sequence, cpu, memory = 100) => ({ phase, rendererSequence: sequence, monotonicMs: sequence * 100, processes: [{ pid: 1, startIdentity: 'original', cpuTimeMs: cpu, memoryBytes: memory }] });
  const renderer = (sequence, status, frame) => ({ sequence, targets: [{ label: 'application:main', status: 'running', frameTimesMs: [frame] },
    { label: 'companion:original', surfaceRole: 'companion', companion: { status, normal: { paints: 1 } }, frameTimesMs: [frame] }] });
  const summary = summarizeRun({ scenario: 'companion-drag', samples: [record('companion-idle', 0, 10), record('companion-idle', 1, 20),
    record('companion-verification', 2, 1000, 9999), record('companion-input', 3, 1100), record('companion-input', 4, 1120), record('companion-asset-diagnostic', 5, 9000, 9999)],
    rendererSamples: [renderer(0, 'waiting-ready', 999), renderer(1, 'waiting-ready', 16), renderer(2, 'waiting-system-drag', 999),
      renderer(3, 'waiting-system-drag', 999), renderer(4, 'waiting-system-drag', 20), renderer(5, 'asset-diagnostic', 999)] });
  assert.equal(summary.cpuTimeMs, 30); assert.equal(summary.durationMs, 200); assert.equal(summary.resourceIntervals, 2);
  assert.equal(summary.memoryPeakObservedBytes, 100); assert.equal(summary.frameP95Ms, 20); assert.equal(summary.byTarget.companion.frames, 2);
});

test('isolated resource samples cannot claim a measured CPU window across an excluded phase', () => {
  const sample = (phase, monotonicMs) => ({ phase, monotonicMs, processes: [{ pid: 1, startIdentity: 'original', cpuTimeMs: monotonicMs, memoryBytes: 100 }] });
  const summary = summarizeRun({ samples: [sample('companion-idle', 0), sample('companion-verification', 100), sample('companion-input', 200)] });
  assert.equal(summary.cpuTimeMs, null); assert.equal(summary.cpuCoreEquivalent, null); assert.equal(summary.durationMs, 0);
});

test('an absent optional UI control still requires its committed product postcondition', () => {
  const h = browserHarness(); const pack = h.element(); h.elements.set('#pack', pack);
  h.api.start(workload([{ id: 'select-if-needed', action: 'click', optional: true, durationMs: 10, selector: '#select', expect: [{ selector: '#pack', attribute: 'data-selected', equals: 'true' }] }]));
  h.api.poll(); h.advance(11); assert.equal(h.api.poll().status, 'running');
  pack.attrs.set('data-selected', 'true'); assert.equal(h.api.poll().status, 'completed');
});

test('companion stop joins an in-flight decode and closes its bitmap without painting after cancellation', async () => {
  const { webcrypto, createHash } = await import('node:crypto');
  const h = browserHarness();
  const bundle = { packages: [{ id: 'action', canvas: [8, 8], pages: [{ file: 'atlas.png' }], frames: [{ page: 0, rect: [0, 0, 8, 8], offset: [0, 0] }] }] };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle)), epoch = createHash('sha256').update(bytes).digest('hex');
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(255);
  const canvas = { width: 8, height: 8, getBoundingClientRect: () => ({ left: 0, top: 0, width: 8, height: 8 }), getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    __varinCompanionAssetBase: 'varin-companion://localhost/varin/version/', __varinCompanionEvidence: { epoch, paints: 1 } };
  h.elements.set('canvas', canvas);
  let finishDecode, closed = 0, draws = 0, decodeStarted;
  const decoding = new Promise(resolve => { decodeStarted = resolve; });
  Object.assign(h.context, { crypto: webcrypto, Uint8Array, TextDecoder, URL, setTimeout,
    location: { href: 'varin-ui://app/companion.html?companionPack=varin&companionVersion=test-version' }, screenX: 0, screenY: 0, outerWidth: 8, outerHeight: 8,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer, blob: async () => ({}) }),
    createImageBitmap: () => new Promise(resolve => { finishDecode = resolve; decodeStarted(); }),
    OffscreenCanvas: class { getContext() { return { drawImage() { draws++; } }; } },
  });
  const api = h.context.__varinCompanionBenchmark;
  api.start({ epoch, version: 'test-version', packageCount: 1, idleMs: 1, files: [{ path: 'atlas.png' }] });
  api.poll(); h.advance(2); api.poll(); api.recordDrag({ complete: true, released: true }); await decoding;
  let settled = false; const stop = api.stop().then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  finishDecode({ width: 8, height: 8, close() { closed++; } });
  assert.equal((await stop).released, true); assert.equal(closed, 1); assert.equal(draws, 0); assert.equal(api.poll().status, 'failed');
  assert.throws(() => api.start({}), /interrupted/u);
});
