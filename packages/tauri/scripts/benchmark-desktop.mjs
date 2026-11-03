#!/usr/bin/env node
/** Same-product A/B controller. The default output is a measurement record with
 * pending assessment, not a production acceptance. Missing measurements stay null. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashDirectory, hashFile, hashJson, isHash, validateWorkload, summarizeRun, isResourceSample, scenarioRequirements, collectorVersion } from './benchmark-contract.mjs';
import { performanceScenarios } from './performance-evidence.mjs';
import { createProcessCollector } from './benchmark-processes.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { verifyInstalledCompanion, dragOriginalCompanion, startCompanionInputTask, companionSamplePhase } from './benchmark-companion.mjs';
import { engineInventory } from './build-candidate.mjs';
import { launchOwned, prepareNativeProcessOwner } from './native-process-owner.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readOptional = async file => {
  let content;
  try { content = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(content); } catch (error) { throw Object.assign(error, { cleanupUncertain: true }); }
};
// Exceptions can contain private paths, argv or parser excerpts. Persist only
// fixed categories, never arbitrary error messages or application output.
export const failureReason = error => error instanceof SyntaxError ? 'invalid-json'
  : ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EEXIST', 'EIO', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET'].includes(error?.code) ? error.code : 'operation-failed';
// Private observations may contain exception text or future fields. Public
// evidence is a typed projection, never a copy of application JSON.
const invalidObservation = () => Object.assign(new Error('Invalid private benchmark observation'), { cleanupUncertain: true });
const scalar = predicate => value => { if (!predicate(value)) throw invalidObservation(); return value; };
const number = scalar(Number.isFinite), boolean = scalar(value => typeof value === 'boolean');
const identity = scalar(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(value));
const choice = (...values) => scalar(value => values.includes(value));
const hash = scalar(isHash);
const reason = value => value == null ? null : 'operation-failed';
function project(value, schema) {
  if (value === null) return null;
  if (typeof schema === 'function') return schema(value);
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw invalidObservation();
    return Array.from(value, item => project(item, schema[0]));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidObservation();
  return Object.fromEntries(Object.entries(schema).filter(([key]) => Object.hasOwn(value, key))
    .map(([key, shape]) => [key, project(value[key], shape)]));
}
const geometry = { x: number, y: number, width: number, height: number };
const windowGeometry = { X: number, Y: number, WIDTH: number, HEIGHT: number, SCREEN: number, WINDOW: number };
const dragShape = { complete: boolean, input: choice('X11-system-pointer'), windowId: identity,
  before: windowGeometry, after: windowGeometry, settled: windowGeometry, released: boolean,
  physicalDisplayQualified: boolean, attemptedInputs: [choice('hover', 'tap', 'repeat-tap', 'drag-release')] };
const asset = { file: identity, width: number, height: number };
const assetPackage = { id: identity, frames: number, expectedFrames: number, paintedFrames: number };
const companionShape = {
  status: choice('waiting-ready', 'waiting-system-drag', 'asset-diagnostic', 'failed', 'completed'), surfaceRole: choice('companion'),
  systemDrag: { point: { x: number, y: number }, bounds: geometry }, drag: dragShape,
  normalObservationMs: number, idleMinimumMs: number,
  notQualified: [choice('physical-cross-display', 'physical-GPU-composition', 'OS-click-through', 'all-normal-action-paths')],
  normal: { enabled: boolean, startedAt: number, startupHistory: choice('not-observed-before-enable'),
    preObservationLiveBitmaps: choice('unknown'), epoch: hash, paints: number, closed: boolean, releases: number,
    lastSuccessfulPaint: { epoch: hash, packageId: identity, frame: number, at: number, source: choice('original-painter-successful-commit') },
    observedLiveBitmaps: number, decoded: [asset], packages: [assetPackage], notCovered: [identity] },
  diagnostic: { epoch: hash, mode: choice('independent-offscreen-asset-decode-draw-not-production-action-playback', 'independent-asset-diagnostic'),
    packages: [assetPackage], failed: value => value === true ? true : project(value, [assetPackage]), decoded: [asset], closedBitmaps: number, released: boolean },
};
const ownerObservationShape = {
  error: reason, pageId: identity,
  download: { downloadId: identity, state: choice('completed'), bytes: number, sha256: hash, source: choice('original-native-download-owner-completed-file-read') },
  run: { id: identity, state: choice('accepted', 'preparing', 'runnable', 'generating', 'executing', 'waiting', 'completed', 'failed', 'cancelled') },
  processes: [{ processId: identity, kernelEpoch: value => typeof value === 'number' ? number(value) : identity(value), pid: number,
    status: choice('running', 'exited', 'released', 'failed', 'starting'), writerActive: boolean, exitCode: number,
    signal: value => typeof value === 'number' ? number(value) : choice('SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV')(value), outputComplete: boolean, wasRunning: boolean }],
  operations: [{ id: identity, phase: choice('accepted', 'preparing', 'queued', 'running', 'waiting', 'settling', 'terminal'),
    outcome: choice('succeeded', 'failed', 'cancelled', 'indeterminate'), cancelRequested: boolean }],
};
const stepsFor = workload => [...(workload.steps ?? []), ...(workload.remote?.steps ?? []), ...(workload.browser?.steps ?? [])];
function stepShape(workload) {
  const steps = stepsFor(workload);
  return { id: choice(...steps.map(step => step.id)), action: choice('wait', 'click', 'key', 'text', 'scroll', 'checkpoint', 'manual', 'file'),
    cycle: number, milestone: choice(...steps.map(step => step.milestone).filter(value => value != null)),
    startedMs: number, committedMs: number, settledMs: number, trustedInputs: number, externalTrustedInputs: number,
    nativeCoverage: choice('operator-observation-still-required') };
}
const label = scalar(value => typeof value === 'string' && /^(main|application:main|(?:application|browser|companion):[a-zA-Z0-9_.:-]+)$/u.test(value));
export function publicRendererRecord(value, { nonce, workload }, sequence) {
  if (!value || value.schema !== 1 || value.nonce !== nonce || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || sequence !== undefined && value.sequence !== sequence || !Number.isFinite(value.elapsedMs) || !Array.isArray(value.targets)) throw invalidObservation();
  const targets = value.targets.map(target => {
    if (!target || typeof target.status !== 'string' || typeof target.label !== 'string') throw invalidObservation();
    return project(target, { label, surfaceRole: choice('main-workbench', 'remote-workbench', 'native-browser', 'companion', 'browser', 'application:mini', 'passive'),
      status: choice('waiting-ready', 'running', 'observing', 'failed', 'completed', 'document-ended-or-unavailable'), error: reason,
      readyAt: number, monotonicMs: number, visibility: choice('visible', 'hidden', 'prerender'), motion: choice('full', 'reduced'),
      ownerObservation: ownerObservationShape, viewport: { width: number, height: number, scale: number }, trustedInputs: number,
      frameTimesMs: [number], inputLatenciesMs: [number], inputEvents: [{ entryType: choice('event', 'first-input'), startTime: number, duration: number,
        inputDelayMs: number, processingMs: number, interactionId: number }], receipts: [stepShape(workload)], stepIndex: number,
      framesObserved: number, eventTimingAvailable: boolean, companion: companionShape });
  });
  return { schema: 1, nonce, sequence: value.sequence, elapsedMs: value.elapsedMs, targets };
}
export function publicProductReceipt(value, request, shell) {
  if (!value || value.schema !== 1 || value.product !== 'varin-desktop-benchmark-receipt' || value.shell !== shell
    || value.nonce !== request.nonce || value.sourceSha !== request.sourceSha || value.version !== request.version
    || value.scenarioSha256 !== request.scenarioSha256 || !value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs) || hashJson(value.inputs) !== hashJson(request.inputs)
    || typeof value.complete !== 'boolean' || shell === 'tauri' && typeof value.nativeDrain !== 'boolean') throw invalidObservation();
  const result = project(value, { complete: boolean, reason, steps: [stepShape(request.workload)], rendererTargets: [label], sequence: number,
    inputDriver: choice('chromium-devtools-input'), nativeInputVerified: boolean, companionComplete: boolean, fixtureComplete: boolean,
    remoteComplete: boolean, fileSelectionDriver: choice('chromium-DOM-setFileInputFiles-not-OS-chooser'),
    nativeDrain: choice(true, false, 'verify-external-process-exit'),
    coverage: [choice('requestAnimationFrame-is-not-display-presentation', 'event-timing-is-16ms-thresholded', 'physical-input-and-cross-screen-require-platform-evidence')] });
  return { schema: 1, product: 'varin-desktop-benchmark-receipt', shell, nonce: request.nonce, sourceSha: request.sourceSha,
    version: request.version, scenarioSha256: request.scenarioSha256, inputs: request.inputs, ...result };
}
async function save(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function executable(candidate) { return path.join(candidate.payload, process.platform === 'darwin' ? 'Contents/MacOS/varin' : process.platform === 'win32' ? 'varin.exe' : 'varin'); }
function requireControlledLaunchEnvironment() {
  // These runs launch unpacked products, not an AppImage or a caller-selected
  // sandbox. Even an empty CHROME_DEVEL_SANDBOX changes Chromium's behavior.
  for (const key of ['APPIMAGE', 'CHROME_DEVEL_SANDBOX']) {
    if (Object.hasOwn(process.env, key)) throw new Error(`Unpacked product benchmarks refuse inherited ${key}`);
  }
}
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
  const check = async (code, fn) => { try { return await fn(); } catch (error) { blockers.push({ code, reason: failureReason(error) }); return null; } };
  await check('uncontrolled-launch-environment', requireControlledLaunchEnvironment);
  if (!['linux', 'win32'].includes(process.platform)) blockers.push({ code: 'native-process-ownership-unsupported', reason: 'No launch-bound native owner is available on this platform' });
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
  if (!blockers.length) await check('native-process-owner-unavailable', prepareNativeProcessOwner);
  return { schema: 1, product: 'varin-desktop-benchmark-preflight', status: blockers.length ? 'blocked' : 'ready-to-measure', blockers,
    environment: { ...environment, ...plan?.environment }, sourceSha: plan?.sourceSha, version: plan?.version, target: plan?.target,
    candidate, electronArtifact, tauriArtifact, scenarios, qualification: 'not-accepted' };
}
function launchEnvironment(root, candidate, shell) {
  requireControlledLaunchEnvironment();
  const home = path.join(root, 'home'), env = { ...process.env, HOME: home, USERPROFILE: home, VARIN_DATA_DIR: path.join(root, 'data'),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    VARIN_ELECTRON_DEV: '', VARIN_ELECTRON_PROFILE: '' };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'VARIN_DESKTOP_RUNTIME_DIR', 'APPDIR', 'VARIN_ELECTRON_LOAD_SERVER_UI', 'VARIN_SERVER_URL', 'VARIN_SKIP_LOCAL_SERVER', 'VARIN_WORKSPACE_ROOT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  if (shell === 'tauri') { env.VARIN_DESKTOP_RUNTIME_DIR = candidate.runtime; if (process.platform === 'linux') env.APPDIR = candidate.payload; }
  return env;
}
export async function measureRun(plan, preflightResult, scenario, shell, iteration, directory, hooks = {}) {
  requireControlledLaunchEnvironment();
  const bound = preflightResult.scenarios.find(item => item.name === scenario.name);
  if (!bound || !isHash(bound.inputs.frontendSha256)) throw new Error('Scenario inputs were not verified');
  const helperExecutable = await prepareNativeProcessOwner(); // Unsupported ownership fails before a private copy or launch.
  const collector = await createProcessCollector(); // Prepare both native helpers before the launch clock.
  let root;
  try { root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-desktop-benchmark-')); }
  catch (error) { await collector.close(); throw error; }
  const nonce = randomUUID(), request = { schema: 1, product: 'varin-desktop-benchmark-request', nonce, sourceSha: plan.sourceSha, frontendDirectory: shell === 'electron' ? plan.electron.frontendDirectory : path.join(preflightResult.candidate.runtime, 'frontend'),
    version: plan.version, inputs: bound.inputs, scenarioSha256: bound.scenarioSha256, sampleIntervalMs: plan.intervalMs, workload: scenario.workload };
  const samples = [], issues = [], lifecycle = []; let owner, ownerResult = null, ownerError = false, launchAttempted = false, exit = null, timedOut = false, observedCounterScopeEmpty = false, startupMs = null, receipt = null, productComplete = false;
  let receiptHash = null, rendererSequence = -1, companionTask = null, companionAcknowledged = false, lastCompanion = null;
  let services;
  const execution = { shell, scenario: scenario.name, sourceSha: plan.sourceSha, version: plan.version, inputs: bound.inputs, scenarioSha256: bound.scenarioSha256,
    artifactSha256: shell === 'electron' ? preflightResult.electronArtifact.sha256 : preflightResult.tauriArtifact.sha256,
    executableSha256: null,
    rootPid: null, cleanupUncertain: false, iteration, cacheCondition: plan.cacheCondition, memoryMetric: collector.memoryMetric, startupMs: null, samples, status: 'pending', coverage: issues };
  try {
    execution.executableSha256 = await hashFile(shell === 'electron' ? plan.electron.executable : executable(preflightResult.candidate));
    if (await hashDirectory(scenario.fixtureDirectory) !== bound.inputs.dataSha256) throw new Error('Fixture changed after preflight');
    await fs.cp(scenario.fixtureDirectory, root, { recursive: true, force: false, errorOnExist: false });
    if (await hashDirectory(root) !== bound.inputs.dataSha256) throw new Error('Copied fixture differs from its content-addressed source');
    const data = path.join(root, 'data');
    await fs.writeFile(path.join(data, 'benchmark-request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    services = await hooks.beforeRun?.({ root, scenario, shell, iteration });
    const started = performance.now();
    launchAttempted = true;
    try {
      owner = await launchOwned({ executable: shell === 'electron' ? plan.electron.executable : executable(preflightResult.candidate), args: ['--varin-desktop-benchmark'],
        cwd: shell === 'electron' ? path.dirname(plan.electron.executable) : preflightResult.candidate.payload,
        env: launchEnvironment(root, preflightResult.candidate, shell), nonce }, { helperExecutable });
    } catch (error) {
      owner = error.owner; ownerError = true; execution.cleanupUncertain = true;
      throw error;
    }
    // The launch gate captured the OS birth identity before exec. Never bind a
    // reused PID when a very short-lived root exits before its first sample.
    execution.rootPid = owner.rootPid; execution.rootStartIdentity = owner.rootStartIdentity;
    owner.rootExit.then(value => { exit = { ...value, elapsedMs: performance.now() - started }; }, () => { ownerError = true; });
    const deadline = scenario.workload.timeoutMs + scenario.workload.readyTimeoutMs + 30000;
    void owner.settle({ timeoutMs: Math.min(3_600_000, Math.ceil(deadline)) }).then(value => { ownerResult = value; }, () => { ownerError = true; });
    await collector.setRoot(owner.rootPid, owner.rootStartIdentity);
    while (performance.now() - started <= deadline) {
      if (ownerError || ownerResult?.ownershipDrainConfirmed === false) throw new Error('Original process ownership became unavailable');
      if (exit && companionTask && !companionTask.state.settled) { companionTask.cancel(); throw new Error('Product exited during owned companion input'); }
      const sampledAt = performance.now(), observed = await collector.sample();
      const privateLive = await readOptional(path.join(data, 'benchmark-live.json'));
      const live = privateLive === undefined ? null : publicRendererRecord(privateLive, request);
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
      const privateReceipt = await readOptional(path.join(data, 'benchmark-receipt.json'));
      receipt = privateReceipt === undefined ? null : publicProductReceipt(privateReceipt, request, shell);
      receiptHash = privateReceipt === undefined ? null : hashJson(privateReceipt);
      if (exit && !observed.processes.length && observed.coverage?.rootState === 'exited' && observed.coverage?.processCountersComplete) observedCounterScopeEmpty = true;
      // Sampling is diagnostic only. A fork/reparent between polls stays owned
      // by the original kernel scope even when the observed counter set is empty.
      if (ownerResult?.ownershipDrainConfirmed) break;
      await sleep(Math.max(0, plan.intervalMs - (performance.now() - sampledAt)));
    }
    if (!ownerResult?.ownershipDrainConfirmed) {
      timedOut = true;
      issues.push('process-tree-did-not-drain-before-observation-deadline');
    }
    execution.startupMs = startupMs; execution.exit = exit; execution.timedOut = timedOut; execution.lifecycle = lifecycle;
    execution.rendererReceipt = receipt;
    if (!receipt || receipt.schema !== 1 || receipt.product !== 'varin-desktop-benchmark-receipt' || receipt.shell !== shell
      || shell === 'tauri' && receipt.nativeDrain !== true || receipt.nonce !== nonce || receipt.sourceSha !== plan.sourceSha || receipt.version !== plan.version || receipt.scenarioSha256 !== bound.scenarioSha256
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
        // Validate private bytes, then publish only the typed projection. Keep
        // both hashes so the public artifact remains bound to the private source.
        const content = await fs.readFile(path.join(data, name), 'utf8');
        let published;
        if (name.endsWith('.jsonl')) {
          const records = content.trim().split('\n').filter(Boolean).map((line, index) => publicRendererRecord(JSON.parse(line), request, index));
          execution.rendererSamples = records;
          published = records.map(record => JSON.stringify(record)).join('\n') + '\n';
        } else {
          const value = JSON.parse(content);
          if (hashJson(value) !== receiptHash) throw invalidObservation();
          published = JSON.stringify(publicProductReceipt(value, request, shell)) + '\n';
        }
        try {
          await fs.writeFile(destination, published, { mode: 0o600 });
          execution.recordings[name] = { name: path.basename(destination), sha256: await hashFile(destination), sourceSha256: createHash('sha256').update(content).digest('hex') };
        } catch (error) { throw Object.assign(error, { reportWriteFailed: true }); }
      } catch (error) { if (error.code !== 'ENOENT' || error.reportWriteFailed) { if (error instanceof SyntaxError) error.cleanupUncertain = true; throw error; } }
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
  } catch (error) { execution.cleanupUncertain ||= error.cleanupUncertain === true || error.reportWriteFailed === true; execution.status = 'failed'; issues.push(`measurement-failed:${failureReason(error)}`); return execution; }
  finally {
    execution.observedCounterScopeEmpty = observedCounterScopeEmpty;
    execution.ownershipDrainConfirmed = false;
    execution.startupMs = startupMs; execution.exit = exit; execution.timedOut = timedOut; execution.lifecycle = lifecycle;
    try {
      if (companionTask) {
        companionTask.cancel(); const task = await companionTask.join();
        execution.companionInputTask = { phase: task.phase, settled: task.settled, released: task.result?.released ?? task.error?.pointerReleased ?? null };
        execution.cleanupUncertain ||= task.error?.cleanupUncertain === true;
        if (task.error) { execution.status = 'failed'; issues.push('companion-input-task-failed-or-cancelled'); }
      }
      if (owner) {
        // A root can exit before collector registration. Give the original
        // receipt stream one bounded turn before attempting unnecessary control.
        if (!ownerResult?.ownershipDrainConfirmed) {
          try { ownerResult = await owner.settle({ timeoutMs: 100 }); } catch { ownerError = true; }
        }
        // Only the retained private control channel may request termination.
        // A stop request, including forced cleanup, can never pass the workload.
        if (!ownerResult?.ownershipDrainConfirmed) {
          try {
            const stopped = await owner.requestStop({ forceAfterMs: 1_000 });
            if (!stopped.requested) { ownerError = true; issues.push('desktop-process-control-unconfirmed'); }
          } catch { ownerError = true; issues.push('desktop-process-control-unconfirmed'); }
          try { ownerResult = await owner.settle({ timeoutMs: 30_000 }); }
          catch { ownerError = true; }
        }
        execution.ownershipDrainConfirmed = ownerResult?.ownershipDrainConfirmed === true;
        execution.processOwner = { ownershipDrainConfirmed: execution.ownershipDrainConfirmed,
          clean: ownerResult?.clean === true, forced: ownerResult?.forced === true,
          reason: !execution.ownershipDrainConfirmed ? 'scope-unconfirmed' : ownerResult.clean ? 'clean' : ownerResult.forced ? 'forced-cleanup' : 'root-exit-failed' };
        if (ownerResult?.forced || ownerResult?.clean === false) {
          execution.status = 'failed'; issues.push('measurement-failed:native-owner-workload-not-clean');
        }
      }
      if (launchAttempted && (!execution.ownershipDrainConfirmed || ownerError)) {
        execution.cleanupUncertain = true;
        issues.push('desktop-process-ownership-unresolved');
      }
      try { await collector.close(); }
      catch (error) { execution.cleanupUncertain = true; issues.push(`collector-close-failed:${failureReason(error)}`); }
      try { execution.fixtureServices = await hooks.afterRun?.({ services, root, scenario, shell, iteration }); }
      catch (error) { execution.cleanupUncertain ||= error.cleanupUncertain === true; execution.status = 'failed'; issues.push(`fixture-drain-failed:${failureReason(error)}`); }
      if (execution.cleanupUncertain) {
        execution.status = 'failed';
        execution.retainedPrivateDirectory = root;
        issues.push('fixture-process-ownership-unresolved-private-directory-retained');
      }
      execution.exit = exit; // A direct-child exit may arrive while other owners finish teardown.
      execution.summary = summarizeRun(execution);
      await save(path.join(directory, `${shell}-${iteration}.json`), execution);
    } catch (error) {
      // If evidence cannot be persisted, retain the private copy and propagate
      // the suite's stop/retention obligation even after a confirmed OS drain.
      execution.cleanupUncertain = true;
      Object.assign(error, { message: `benchmark-finalization-failed:${failureReason(error)}`, cleanupUncertain: true,
        ownershipDrainConfirmed: execution.ownershipDrainConfirmed, retainedPrivateDirectory: root,
        retainedPrivateDirectories: [{ scenario: scenario.name, shell, iteration, path: root }] });
      throw error;
    } finally {
      // These are only newly created private benchmark copies, never source data.
      if (!execution.cleanupUncertain) {
        try { await fs.rm(root, { recursive: true, force: true }); }
        catch (error) {
          execution.status = 'failed'; execution.cleanupUncertain = true; execution.retainedPrivateDirectory = root;
          issues.push(`private-copy-release-failed:${failureReason(error)}`);
          let category = failureReason(error);
          try { await save(path.join(directory, `${shell}-${iteration}.json`), execution); }
          catch (writeError) { category = failureReason(writeError); }
          throw Object.assign(new Error(`benchmark-copy-release-failed:${category}`), { cleanupUncertain: true,
            ownershipDrainConfirmed: execution.ownershipDrainConfirmed, retainedPrivateDirectory: root,
            retainedPrivateDirectories: [{ scenario: scenario.name, shell, iteration, path: root }] });
        }
      }
    }
  }
}
export async function runBenchmark(plan, { output, selected = performanceScenarios, hooks = {} } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.some(name => !performanceScenarios.includes(name))) throw new Error('Select known product scenarios explicitly');
  output = path.resolve(output); await fs.mkdir(output, { recursive: false });
  const checked = await preflight(plan);
  try { await save(path.join(output, 'preflight.json'), checked); }
  catch (error) { throw Object.assign(error, { message: `benchmark-preflight-publication-failed:${failureReason(error)}`, cleanupUncertain: true, retainedPrivateDirectories: [] }); }
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
  try {
    const comparison = compareRuns(plan, checked, runs);
    await save(path.join(output, 'comparison.json'), comparison);
    return comparison;
  } catch (error) {
    // Preserve the suite's shared seed if its evidence cannot be committed.
    Object.assign(error, { message: `benchmark-comparison-failed:${failureReason(error)}`, cleanupUncertain: true,
      retainedPrivateDirectories: runs.filter(run => run.retainedPrivateDirectory).map(run => ({ scenario: run.scenario, shell: run.shell, iteration: run.iteration, path: run.retainedPrivateDirectory })) });
    throw error;
  }
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
      const measured = [a, b].every(run => run.status === 'measured-awaiting-review' && run.rendererReceipt?.complete === true
        && run.exit?.success === true && run.ownershipDrainConfirmed === true && run.processOwner?.clean === true && run.cleanupUncertain !== true)
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
