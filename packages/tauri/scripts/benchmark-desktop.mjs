#!/usr/bin/env node
/** Same-product A/B controller. The default output is a measurement record with
 * pending assessment, not a production acceptance. Missing measurements stay null. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashDirectory, hashFile, hashJson, isHash, validateWorkload, summarizeRun, isResourceSample, scenarioRequirements, collectorVersion } from './benchmark-contract.mjs';
import { performanceScenarios } from './performance-evidence.mjs';
import { createProcessCollector } from './benchmark-processes.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { verifyInstalledCompanion, dragOriginalCompanion, startCompanionInputTask, companionSamplePhase } from './benchmark-companion.mjs';
import { engineInventory } from './build-candidate.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readOptional = async file => fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
async function save(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function executable(candidate) { return path.join(candidate.payload, process.platform === 'darwin' ? 'Contents/MacOS/varin' : process.platform === 'win32' ? 'varin.exe' : 'varin'); }
export function environmentProbe() {
  const cpus = os.cpus();
  return { os: process.platform, osVersion: os.release(), architecture: process.arch, cpu: cpus[0]?.model ?? 'unavailable',
    logicalCpus: cpus.length, memoryBytes: os.totalmem(), displayAvailable: process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    gpu: null, display: null, collectedAt: new Date().toISOString(),
    limitations: ['GPU and display identity must come from the actual native runner, not this headless probe', 'CPU/memory totals are host-reported; record VM/container quotas separately'] };
}
/** Example actions operate the authoritative shared workbench, not a demo route.
 * Other scenarios deliberately require a prepared real fixture and observations. */
export function planTemplate() {
  const ready = [{ selector: '[data-varin-workbench-switcher]', visible: true }];
  return { schema: 1, product: 'varin-desktop-benchmark-plan', sourceSha: null, version: null, target: `${process.platform}-${process.arch}`,
    intervalMs: 250, repetitions: 4, cacheCondition: 'fresh-profile-os-cache-uncontrolled', disposableOsUser: false,
    environment: { gpu: null, display: null, powerMode: null, backgroundLoad: null, monitorCount: null },
    electron: { executable: null, artifact: null, frontendDirectory: null }, tauri: { candidate: null },
    scenarios: performanceScenarios.map(name => ({ name, fixtureDirectory: null, syntheticFixture: true,
      configuration: { motion: 'full', width: 1440, height: 1000, locale: 'en', localHost: name === 'local-hybrid-execution' },
      requirements: scenarioRequirements[name], workload: { name, motion: 'full', readyTimeoutMs: 60000, timeoutMs: 180000, ready,
        steps: name === 'remote-idle' ? [{ id: 'idle', action: 'wait', durationMs: 30000 }]
          : name === 'workspace-transitions' ? [
            { id: 'choose-mode', action: 'click', selector: '[data-varin-workbench-switcher]', expect: [{ selector: '[role="menuitemradio"]', count: 3 }] },
            { id: 'commit-ide', action: 'click', selector: '[role="menuitemradio"]:nth-of-type(3)', expect: [{ selector: '[data-workbench-chrome="ide"]', visible: true }], settleMs: 1000, milestone: 'committed-target' },
          ] : [] } })),
  };
}
export async function verifyTauriBenchmarkCandidate(candidateFile, identity) {
  const value = await readJson(candidateFile);
  if (value.schema !== 1 || value.sourceSha !== identity.sourceSha || value.version !== identity.version || value.target !== identity.target) throw new Error('Candidate source/version/target mismatch');
  const runtime = await verifyRuntimeManifest(value.runtime, { platform: process.platform, architecture: process.arch });
  if (runtime.sources?.sourceSha !== identity.sourceSha || runtime.sources?.sourceDirty !== false) throw new Error('Candidate runtime was not built from the same immutable source');
  if (await hashFile(path.join(value.assets, value.runtimeManifest.name)) !== value.runtimeManifest.sha256
    || await hashFile(path.join(value.assets, value.engineManifest.name)) !== value.engineManifest.sha256) throw new Error('Candidate manifests changed');
  const engine = await readJson(path.join(value.assets, value.engineManifest.name));
  if (hashJson(engine.files) !== hashJson(await engineInventory(value.payload, { exclude: process.platform === 'darwin' ? 'Contents/Resources/runtime' : process.platform === 'linux' ? 'usr/lib/Varin/runtime' : 'runtime' }))) throw new Error('Native engine payload differs from its exact candidate inventory');
  const relative = path.relative(value.payload, executable(value)).replaceAll(path.sep, '/');
  if (!engine.files?.some(file => file.path === relative && isHash(file.sha256))) throw new Error('Native executable is missing from its engine inventory');
  const entry = engine.files.find(file => file.path === relative);
  if (await hashFile(executable(value)) !== entry.sha256) throw new Error('Native executable differs from the qualified payload');
  return value;
}
export async function preflight(plan) {
  const blockers = [], environment = environmentProbe();
  const check = async (code, fn) => { try { return await fn(); } catch (error) { blockers.push({ code, reason: error.code ?? error.message }); return null; } };
  if (!environment.displayAvailable) blockers.push({ code: 'native-display-unavailable', reason: 'No DISPLAY or WAYLAND_DISPLAY; no GUI launch or substitute display is attempted' });
  if (plan?.disposableOsUser !== true) blockers.push({ code: 'disposable-os-user-required', reason: 'The full product can register OS handlers. HOME isolation alone is insufficient on macOS/Windows' });
  if (plan?.schema !== 1 || plan.product !== 'varin-desktop-benchmark-plan') blockers.push({ code: 'invalid-plan', reason: 'Use a versioned benchmark plan' });
  if (plan?.target !== `${process.platform}-${process.arch}`) blockers.push({ code: 'wrong-native-target', reason: 'Run each architecture on its matching machine' });
  if (!/^[a-f0-9]{40}$/u.test(plan?.sourceSha ?? '') || typeof plan?.version !== 'string') blockers.push({ code: 'source-not-bound', reason: 'Pin the same committed source and product version' });
  if (!Number.isFinite(plan?.intervalMs) || plan.intervalMs <= 0 || !Number.isSafeInteger(plan?.repetitions) || plan.repetitions < 1) blockers.push({ code: 'invalid-sampling-plan', reason: 'Sampling interval and repetitions must be positive' });
  for (const field of ['gpu', 'display', 'powerMode', 'backgroundLoad']) if (typeof plan?.environment?.[field] !== 'string' || !plan.environment[field].trim()) blockers.push({ code: `missing-${field}`, reason: 'Record the actual measurement machine and conditions' });
  if (!Array.isArray(plan?.scenarios) || plan.scenarios.length !== performanceScenarios.length || new Set(plan.scenarios.map(s => s.name)).size !== performanceScenarios.length) blockers.push({ code: 'missing-scenarios', reason: 'The plan must retain all seven design scenarios; a run may select a subset explicitly' });
  const candidate = await check('tauri-candidate-unavailable', () => verifyTauriBenchmarkCandidate(plan.tauri.candidate, plan));
  const frontendSha256 = await check('frontend-parity-unavailable', async () => {
    const actualElectronDirectory = process.platform === 'darwin' ? path.resolve(path.dirname(plan.electron.executable), '../Resources/web-dist') : path.join(path.dirname(plan.electron.executable), 'resources/web-dist');
    if (await fs.realpath(plan.electron.frontendDirectory) !== await fs.realpath(actualElectronDirectory)) throw new Error('Frontend must be the actual installed Electron resources/web-dist, not an unrelated copy');
    const electron = await hashDirectory(plan.electron.frontendDirectory), tauri = await hashDirectory(path.join(candidate.runtime, 'frontend'));
    if (electron !== tauri) throw new Error('Electron and Tauri must use byte-identical complete frontend trees');
    return electron;
  });
  const electronArtifact = await check('electron-package-unavailable', async () => {
    const { verifyElectronBaseline } = await import('./benchmark-build.mjs');
    const baseline = await verifyElectronBaseline(plan.electron.artifact, plan);
    if (await fs.realpath(baseline.executable) !== await fs.realpath(plan.electron.executable)
      || await fs.realpath(baseline.frontendDirectory) !== await fs.realpath(plan.electron.frontendDirectory)) throw new Error('Plan paths do not identify the verified complete Electron baseline');
    return { sha256: await hashFile(plan.electron.artifact), executableSha256: baseline.executableSha256 };
  });
  let tauriArtifact = null;
  if (candidate) tauriArtifact = await check('tauri-package-unavailable', async () => {
    const record = candidate.packaged?.update;
    if (!record || await hashFile(path.join(candidate.assets, record.name)) !== record.sha256) throw new Error('Complete Tauri candidate artifact is missing or changed');
    return record;
  });
  const scenarios = [];
  for (const scenario of Array.isArray(plan?.scenarios) ? plan.scenarios : []) await check(`scenario-${scenario.name}`, async () => {
    if (scenario.syntheticFixture !== true) throw new Error('Use prepared disposable synthetic product data, never the real user profile');
    validateWorkload(scenario.workload);
    if (scenario.name !== scenario.workload.name || !performanceScenarios.includes(scenario.name)
      || hashJson(scenario.requirements) !== hashJson(scenarioRequirements[scenario.name])
      || scenario.configuration?.motion !== 'full') throw new Error('Scenario coverage or normal animation contract was altered');
    const dataSha256 = await hashDirectory(scenario.fixtureDirectory);
    await fs.access(path.join(scenario.fixtureDirectory, 'data'));
    await fs.access(path.join(scenario.fixtureDirectory, 'home'));
    scenarios.push({ name: scenario.name, inputs: { frontendSha256, dataSha256, configurationSha256: hashJson(scenario.configuration) }, scenarioSha256: hashJson(scenario.workload) });
  });
  return { schema: 1, product: 'varin-desktop-benchmark-preflight', status: blockers.length ? 'blocked' : 'ready-to-measure', blockers,
    environment: { ...environment, ...plan?.environment }, sourceSha: plan?.sourceSha, version: plan?.version, target: plan?.target,
    candidate, electronArtifact, tauriArtifact, scenarios, qualification: 'not-accepted' };
}
function launchEnvironment(root, candidate, shell) {
  const home = path.join(root, 'home'), env = { ...process.env, HOME: home, USERPROFILE: home, VARIN_DATA_DIR: path.join(root, 'data'),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    VARIN_ELECTRON_DEV: '', VARIN_ELECTRON_PROFILE: '' };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'VARIN_DESKTOP_RUNTIME_DIR', 'APPDIR', 'VARIN_ELECTRON_LOAD_SERVER_UI', 'VARIN_SERVER_URL', 'VARIN_SKIP_LOCAL_SERVER', 'VARIN_WORKSPACE_ROOT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  if (shell === 'tauri') { env.VARIN_DESKTOP_RUNTIME_DIR = candidate.runtime; if (process.platform === 'linux') env.APPDIR = candidate.payload; }
  return env;
}
async function stopTimedOut(child) {
  // Only the newly launched isolated benchmark group. Forced termination is
  // always a failure and never evidence of normal lifecycle cleanup.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill(); }
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export async function measureRun(plan, preflightResult, scenario, shell, iteration, directory, hooks = {}) {
  const bound = preflightResult.scenarios.find(item => item.name === scenario.name);
  if (!bound || !isHash(bound.inputs.frontendSha256)) throw new Error('Scenario inputs were not verified');
  const collector = await createProcessCollector(); // Prepare native helper before the launch clock.
  let root;
  try { root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-desktop-benchmark-')); }
  catch (error) { await collector.close(); throw error; }
  const nonce = randomUUID(), request = { schema: 1, product: 'varin-desktop-benchmark-request', nonce, sourceSha: plan.sourceSha, frontendDirectory: shell === 'electron' ? plan.electron.frontendDirectory : path.join(preflightResult.candidate.runtime, 'frontend'),
    version: plan.version, inputs: bound.inputs, scenarioSha256: bound.scenarioSha256, sampleIntervalMs: plan.intervalMs, workload: scenario.workload };
  const samples = [], issues = [], lifecycle = []; let child, exit = null, timedOut = false, startupMs = null, receipt = null, productComplete = false;
  let rendererSequence = -1, companionTask = null, companionAcknowledged = false, lastCompanion = null;
  let services;
  const execution = { shell, scenario: scenario.name, sourceSha: plan.sourceSha, version: plan.version, inputs: bound.inputs, scenarioSha256: bound.scenarioSha256,
    artifactSha256: shell === 'electron' ? preflightResult.electronArtifact.sha256 : preflightResult.tauriArtifact.sha256,
    executableSha256: null,
    rootPid: null, iteration, cacheCondition: plan.cacheCondition, memoryMetric: collector.memoryMetric, startupMs: null, samples, status: 'pending', coverage: issues };
  try {
    execution.executableSha256 = await hashFile(shell === 'electron' ? plan.electron.executable : executable(preflightResult.candidate));
    if (await hashDirectory(scenario.fixtureDirectory) !== bound.inputs.dataSha256) throw new Error('Fixture changed after preflight');
    await fs.cp(scenario.fixtureDirectory, root, { recursive: true, force: false, errorOnExist: false });
    if (await hashDirectory(root) !== bound.inputs.dataSha256) throw new Error('Copied fixture differs from its content-addressed source');
    const data = path.join(root, 'data');
    await fs.writeFile(path.join(data, 'benchmark-request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    services = await hooks.beforeRun?.({ root, scenario, shell, iteration });
    const started = performance.now();
    child = spawn(shell === 'electron' ? plan.electron.executable : executable(preflightResult.candidate), ['--varin-desktop-benchmark'], {
      cwd: shell === 'electron' ? path.dirname(plan.electron.executable) : preflightResult.candidate.payload,
      env: launchEnvironment(root, preflightResult.candidate, shell), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: false,
    });
    // Application output may contain prompt bodies or local paths. Do not copy it
    // into a performance report. Numeric native receipts are a separate protocol.
    child.stdout.resume(); child.stderr.resume();
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('exit', (code, signal) => { exit = { code, signal, elapsedMs: performance.now() - started }; });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    execution.rootPid = child.pid;
    await collector.setRoot(child.pid);
    const deadline = scenario.workload.timeoutMs + scenario.workload.readyTimeoutMs + 30000;
    while (performance.now() - started <= deadline) {
      if (spawnError) throw spawnError;
      if (exit && companionTask && !companionTask.state.settled) { companionTask.cancel(); throw new Error('Product exited during owned companion input'); }
      const sampledAt = performance.now(), observed = await collector.sample();
      const live = await readOptional(path.join(data, 'benchmark-live.json'));
      let targets = [];
      if (live && live.nonce === nonce && Number.isSafeInteger(live.sequence) && live.sequence > rendererSequence) {
        rendererSequence = live.sequence; targets = live.targets;
        const main = targets.find(target => ['main', 'application:main'].includes(target.label));
        if (main?.readyAt !== null && main?.readyAt !== undefined && startupMs === null) startupMs = performance.now() - started;
        if (main?.status === 'completed' || main?.status === 'failed') productComplete = true;
        for (const checkpoint of main?.receipts ?? []) if (checkpoint.action === 'checkpoint') lifecycle.push({ cycle: checkpoint.cycle, monotonicMs: sampledAt - started,
          processCount: observed.processes.length, handles: observed.processes.every(p => Number.isFinite(p.handles)) ? observed.processes.reduce((sum, p) => sum + p.handles, 0) : null,
          memoryBytes: observed.processes.every(p => Number.isFinite(p.memoryBytes)) ? observed.processes.reduce((sum, p) => sum + p.memoryBytes, 0) : null,
          gpuBytes: observed.gpuBytes, rendererTargets: targets.length });
      }
      const companion = targets.find(target => target.companion)?.companion ?? lastCompanion;
      if (companion) lastCompanion = companion;
      if (scenario.workload.companion && companion?.systemDrag && !companionTask) {
        companionTask = startCompanionInputTask({ verify: () => verifyInstalledCompanion(data, shell, scenario.workload.companion),
          drive: signal => dragOriginalCompanion(companion.systemDrag, observed.processes.map(row => row.pid), { signal }) });
      }
      if (companionTask?.state.error) throw companionTask.state.error;
      if (companion?.diagnostic) execution.companionEvidence = companion;
      samples.push({ ...observed, monotonicMs: sampledAt - started, phase: startupMs === null ? 'startup' : exit ? 'exit-observation' : productComplete ? 'post-workload' : scenario.workload.companion ? companionSamplePhase(companion, companionTask?.state, companionAcknowledged) : 'workload',
        frameTimesMs: targets.flatMap(target => target.frameTimesMs ?? []), inputLatenciesMs: targets.flatMap(target => target.inputLatenciesMs ?? []),
        rendererSequence: targets.length ? rendererSequence : null, companionTaskPhase: companionTask?.state.phase ?? null });
      // Capture the terminal input sample BEFORE authorizing the independent diagnostic.
      if (companionTask?.state.phase === 'completed' && !companionAcknowledged) {
        execution.companionInstallation = companionTask.state.installation; execution.companionDrag = companionTask.state.result;
        const temporary = path.join(data, '.benchmark-companion-drag.tmp');
        await fs.writeFile(temporary, JSON.stringify({ nonce, result: execution.companionDrag }), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path.join(data, 'benchmark-companion-drag.json')); companionAcknowledged = true;
      }
      receipt = await readOptional(path.join(data, 'benchmark-receipt.json'));
      if (exit && !observed.processes.length && observed.coverage?.rootState === 'exited' && observed.coverage?.processCountersComplete) break;
      await sleep(Math.max(0, plan.intervalMs - (performance.now() - sampledAt)));
    }
    if (!exit || samples.at(-1)?.processes.length || samples.at(-1)?.coverage?.rootState !== 'exited' || !samples.at(-1)?.coverage?.processCountersComplete) {
      timedOut = true; issues.push('process-tree-did-not-drain-before-observation-deadline'); await stopTimedOut(child);
    }
    execution.startupMs = startupMs; execution.exit = exit; execution.timedOut = timedOut; execution.lifecycle = lifecycle;
    execution.rendererReceipt = receipt;
    if (!receipt || receipt.nonce !== nonce || receipt.sourceSha !== plan.sourceSha || receipt.version !== plan.version || receipt.scenarioSha256 !== bound.scenarioSha256
      || hashJson(receipt.inputs) !== hashJson(bound.inputs) || receipt.complete !== true) issues.push('missing-or-failed-bound-product-receipt');
    if (exit?.code !== 0) issues.push('product-exit-not-successful');
    if (startupMs === null) issues.push('real-product-startup-not-observed');
    const activeSamples = samples.filter(isResourceSample);
    if (activeSamples.length < 2 || activeSamples.some(sample => !sample.processes.length)) issues.push('workload-process-window-insufficient');
    if (!activeSamples.length || activeSamples.some(sample => sample.gpuBytes === null)) issues.push('gpu-accounting-incomplete');
    if (samples.some(sample => sample.coverage?.processCountersComplete === false)) issues.push('process-counter-coverage-incomplete');
    if (receipt?.steps?.some(step => step.action === 'manual')) issues.push('physical-platform-observations-require-separate-review');
    execution.recordings = {};
    for (const name of ['benchmark-renderer.jsonl', 'benchmark-receipt.json']) {
      try {
        const destination = path.join(directory, `${shell}-${iteration}-${name}`);
        await fs.copyFile(path.join(data, name), destination);
        execution.recordings[name] = { name: path.basename(destination), sha256: await hashFile(destination) };
        if (name.endsWith('.jsonl')) {
          execution.rendererSamples = (await fs.readFile(destination, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
          if (execution.rendererSamples.some((sample, index) => sample.nonce !== nonce || sample.sequence !== index)) throw new Error('Renderer stream identity or sequence is incomplete');
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (scenario.workload.companion) execution.companionEvidence = execution.rendererSamples?.flatMap(record => record.targets ?? []).map(target => target.companion).filter(value => value?.diagnostic).at(-1) ?? execution.companionEvidence;
    if (scenario.workload.companion && (!execution.companionInstallation?.verified || !execution.companionDrag?.complete || execution.companionEvidence?.status !== 'completed')) issues.push('companion-install-drag-or-diagnostic-incomplete');
    const rendered = execution.rendererSamples?.flatMap(sample => sample.targets) ?? [];
    if (!execution.rendererSamples?.length) issues.push('renderer-recording-missing');
    if (scenario.name !== 'remote-idle' && !rendered.some(sample => sample.inputLatenciesMs?.length)) issues.push('actual-input-timing-not-observed');
    if (scenario.name !== 'remote-idle' && !rendered.some(sample => sample.frameTimesMs?.length)) issues.push('actual-frame-timing-not-observed');
    if (rendered.some(sample => sample.status === 'document-ended-or-unavailable')) issues.push('renderer-observation-gaps');
    execution.status = issues.length ? 'incomplete' : 'measured-awaiting-review';
    if (await hashDirectory(scenario.fixtureDirectory) !== bound.inputs.dataSha256) throw new Error('Source fixture was changed during the run');
    return execution;
  } catch (error) { execution.cleanupUncertain ||= error.cleanupUncertain === true; execution.status = 'failed'; issues.push(`measurement-failed:${error.code ?? error.message}`); return execution; }
  finally {
    if (companionTask) {
      companionTask.cancel(); const task = await companionTask.join();
      execution.companionInputTask = { phase: task.phase, settled: task.settled, released: task.result?.released ?? task.error?.pointerReleased ?? null };
      execution.cleanupUncertain ||= task.error?.cleanupUncertain === true;
      if (task.error) { execution.status = 'failed'; issues.push('companion-input-task-failed-or-cancelled'); }
    }
    if (child && !exit && !timedOut) await stopTimedOut(child);
    try {
      await collector.close();
      try { execution.fixtureServices = await hooks.afterRun?.({ services, root, scenario, shell, iteration }); }
      catch (error) { execution.cleanupUncertain ||= error.cleanupUncertain === true; execution.status = 'failed'; issues.push(`fixture-drain-failed:${error.code ?? error.message}`); }
      if (execution.cleanupUncertain) {
        execution.status = 'failed';
        execution.retainedPrivateDirectory = root;
        issues.push('fixture-process-ownership-unresolved-private-directory-retained');
      }
      execution.summary = summarizeRun(execution);
      await save(path.join(directory, `${shell}-${iteration}.json`), execution);
    } finally {
      // These are only newly created private benchmark copies, never source data.
      if (!execution.cleanupUncertain) await fs.rm(root, { recursive: true, force: true });
    }
  }
}
export async function runBenchmark(plan, { output, selected = performanceScenarios, hooks = {} } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.some(name => !performanceScenarios.includes(name))) throw new Error('Select known product scenarios explicitly');
  output = path.resolve(output); await fs.mkdir(output, { recursive: false });
  const checked = await preflight(plan); await save(path.join(output, 'preflight.json'), checked);
  if (checked.blockers.length) return { status: 'blocked', output, blockers: checked.blockers };
  const runs = [];
  measurement: for (const scenario of plan.scenarios.filter(scenario => selected.includes(scenario.name))) {
    const directory = path.join(output, scenario.name); await fs.mkdir(directory);
    for (let iteration = 0; iteration < plan.repetitions; iteration++) {
      const order = iteration % 2 === 0 ? ['electron', 'tauri'] : ['tauri', 'electron'];
      for (const shell of order) {
        const run = { scenario: scenario.name, ...(await measureRun(plan, checked, scenario, shell, iteration, directory, hooks)) };
        runs.push(run);
        // The isolated service port/source may still be owned. Do not start a
        // subsequent pair or erase the shared seed workspace while uncertain.
        if (run.cleanupUncertain) break measurement;
      }
    }
  }
  const comparison = compareRuns(plan, checked, runs);
  await save(path.join(output, 'comparison.json'), comparison);
  return comparison;
}
export function compareRuns(plan, checked, runs) {
  const issues = [], scenarios = [];
  for (const name of performanceScenarios) {
    const pairs = [];
    for (let iteration = 0; iteration < plan.repetitions; iteration++) {
      const electron = runs.filter(run => run.scenario === name && run.shell === 'electron' && run.iteration === iteration), tauri = runs.filter(run => run.scenario === name && run.shell === 'tauri' && run.iteration === iteration);
      if (electron.length !== 1 || tauri.length !== 1) { issues.push(`${name}:${iteration}:missing-pair`); continue; }
      const a = electron[0], b = tauri[0];
      const bound = checked.scenarios?.find(scenario => scenario.name === name);
      if (a.sourceSha !== b.sourceSha || a.version !== b.version || a.sourceSha !== plan.sourceSha || a.version !== plan.version || a.scenarioSha256 !== b.scenarioSha256
        || !bound || a.scenarioSha256 !== bound.scenarioSha256 || hashJson(a.inputs) !== hashJson(bound.inputs)
        || hashJson(a.inputs) !== hashJson(b.inputs) || a.memoryMetric !== b.memoryMetric || a.cacheCondition !== b.cacheCondition) throw new Error('Refusing mismatched A/B source, frontend, data, config, workload, cache condition or memory accounting');
      const summaries = { electron: summarizeRun(a), tauri: summarizeRun(b) };
      const hasWindow = summary => summary.sampleCount >= 2 && summary.durationMs > 0 && summary.observedProcessIdentities > 0
        && summary.cpuTimeMs !== null && summary.memoryMedianBytes !== null;
      const measured = [a, b].every(run => run.status === 'measured-awaiting-review' && run.rendererReceipt?.complete === true)
        && Object.values(summaries).every(hasWindow);
      if (!measured) issues.push(`${name}:${iteration}:incomplete-pair`);
      pairs.push({ iteration, ...summaries, status: measured ? 'measured-awaiting-review' : 'incomplete',
        coverage: { electron: a.coverage, tauri: b.coverage }, lifecycle: { electron: a.lifecycle ?? [], tauri: b.lifecycle ?? [] } });
    }
    scenarios.push({ name, pairs, requirements: scenarioRequirements[name], assessment: { accepted: false, method: 'paired same-input complete-product observations; expert/native-platform review required', result: 'pending' } });
  }
  return { schema: 1, product: 'varin-desktop-benchmark-comparison', sourceSha: plan.sourceSha, version: plan.version, target: plan.target,
    measurement: { collector: 'varin-native-whole-tree', version: collectorVersion, clock: 'monotonic', scope: 'all-observed-owned-desktop-processes', intervalMs: plan.intervalMs },
    environment: checked.environment, status: 'not-qualified', issues, scenarios,
    cleanupUncertain: runs.some(run => run.cleanupUncertain === true),
    retainedPrivateDirectories: runs.filter(run => run.cleanupUncertain && run.retainedPrivateDirectory).map(run => ({ scenario: run.scenario, shell: run.shell, iteration: run.iteration, path: run.retainedPrivateDirectory })),
    limitations: ['No automatic acceptance or invented saving percentage', 'RAF is renderer scheduling, not compositor/panel presentation', 'Event Timing below 16ms is censored; absent events do not mean zero latency', 'Polling misses very short-lived processes and requires reconciliation with native owner lifecycle evidence'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0], get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const output = get('--output');
  if (command === 'template' && output) await save(path.resolve(output), planTemplate());
  else if (command === 'probe' && output) await save(path.resolve(output), { ...environmentProbe(), status: 'not-a-product-measurement', qualification: 'not-accepted' });
  else if (['preflight', 'run'].includes(command) && output && get('--plan')) {
    const plan = await readJson(path.resolve(get('--plan')));
    const result = command === 'preflight' ? await preflight(plan) : await runBenchmark(plan, { output, selected: get('--scenario') ? [get('--scenario')] : undefined });
    if (command === 'preflight') await save(path.resolve(output), result);
    process.stdout.write(JSON.stringify({ status: result.status, blockers: result.blockers?.map(item => item.code), output: path.resolve(output) }) + '\n');
    if (['blocked', 'not-qualified'].includes(result.status)) process.exitCode = 2;
  } else throw new Error('Usage: benchmark-desktop.mjs template|probe --output FILE; preflight --plan FILE --output FILE; run --plan FILE --output NEW-DIR [--scenario NAME]');
}
