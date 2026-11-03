/** Shared measurement protocol. A workload is data, never JavaScript, a CDP
 * method, a reduced-motion override, or a replacement application. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { canonicalJson } from '../../../scripts/desktop-update-signatures.mjs';
import { performanceScenarios } from './performance-evidence.mjs';

export const collectorVersion = '1';
export const scenarioRequirements = {
  'remote-idle': ['real-workbench-ready', 'no-local-host-or-database', 'cold-and-warm-startup'],
  'long-chat-stream': ['long-history', 'stream-completed', 'scroll-and-compose', 'image-release'],
  'workspace-transitions': ['workbench-ide-bot', 'reverse-in-flight', 'committed-target', 'full-motion'],
  'companion-drag': ['complete-actions', 'physical-multi-display-drag', 'pointer-passthrough', 'transparent-composition'],
  'browser-interaction': ['same-native-page', 'native-user-input', 'login', 'upload', 'download', 'viewport-consistency'],
  'local-hybrid-execution': ['local-host-kernel', 'remote-owner', 'task-completed', 'stop-and-drain'],
  'repeated-lifecycle': ['panels-windows-tasks', 'settled-cycles', 'subscriptions-handles-textures', 'no-unowned-growth'],
};
export const hashJson = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** No ignored names, mtime shortcuts, symlink traversal, or stale build receipts. */
export async function hashDirectory(directory) {
  const files = [];
  const walk = async relative => {
    const absolute = path.join(directory, relative), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Benchmark input must not contain symbolic links');
    if (stat.isDirectory()) {
      files.push({ path: relative.replaceAll(path.sep, '/'), kind: 'directory' });
      for (const name of (await fs.readdir(absolute)).sort()) await walk(path.join(relative, name));
    } else if (stat.isFile()) files.push({ path: relative.replaceAll(path.sep, '/'), size: stat.size, executable: !!(stat.mode & 0o111), sha256: await hashFile(absolute) });
    else throw new Error('Benchmark input contains a special file');
  };
  await walk('');
  return hashJson(files);
}
const positive = value => Number.isFinite(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0;
function condition(value) {
  if (!value || !text(value.selector) || value.selector.length > 2048) throw new Error('A commit condition needs a bounded DOM selector');
  const keys = Object.keys(value);
  if (keys.some(key => !['selector', 'visible', 'attribute', 'equals', 'count', 'minTextLength', 'focused', 'textIncludes', 'value', 'fileCount', 'textEquals'].includes(key))) throw new Error('Unknown DOM observation');
  if (value.textEquals !== undefined && (typeof value.textEquals !== 'string' || value.textEquals.length > 4096)
    || value.fileCount !== undefined && (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0)
    || value.value !== undefined && (typeof value.value !== 'string' || value.value.length > 4096)
    || value.textIncludes !== undefined && (typeof value.textIncludes !== 'string' || !value.textIncludes.length || value.textIncludes.length > 4096)
    || value.focused !== undefined && typeof value.focused !== 'boolean'
    || value.visible !== undefined && typeof value.visible !== 'boolean'
    || value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count < 0)
    || value.minTextLength !== undefined && (!Number.isSafeInteger(value.minTextLength) || value.minTextLength < 0)
    || value.attribute !== undefined && (!/^(aria-[a-z0-9-]+|data-[a-z0-9-]+|disabled|role)$/u.test(value.attribute) || typeof value.equals !== 'string')) throw new Error('Invalid DOM observation');
}
export function validateWorkload(workload) {
  if (!workload || !performanceScenarios.includes(workload.name) || workload.motion !== 'full'
    || !positive(workload.timeoutMs) || !positive(workload.readyTimeoutMs)
    || !Array.isArray(workload.ready) || !workload.ready.length
    || !Array.isArray(workload.steps) || !workload.steps.length) throw new Error('A complete full-motion workload and real readiness observations are required');
  if (workload.ownerIdentity && (workload.ownerIdentity.runtime !== 'agent' || !text(workload.ownerIdentity.threadId) || !text(workload.ownerIdentity.branchId)
    || !path.isAbsolute(workload.workspace ?? ''))) throw new Error('Owner observation needs the original Thread and an absolute synthetic workspace');
  if (workload.remote) {
    const endpoint = new URL(workload.remote.origin);
    if (workload.name !== 'local-hybrid-execution' || workload.remote.remote || workload.remote.browser || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Remote replay requires the same isolated loopback Host');
    validateWorkload(workload.remote);
  }
  if (workload.browser) {
    if (workload.name !== 'browser-interaction' || workload.browser.surface !== 'fixture-browser' || workload.browser.browser) throw new Error('Only one original Browser fixture surface is allowed');
    const url = new URL(workload.browser.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/site' || url.search || url.hash || !isHash(workload.browser.downloadSha256)) throw new Error('Browser workload must bind the local synthetic fixture and download bytes');
    validateWorkload(workload.browser);
  }
  workload.ready.forEach(condition);
  const ids = new Set();
  for (const step of workload.steps) {
    if (!step || !text(step.id) || ids.has(step.id)
      || !['wait', 'click', 'key', 'text', 'scroll', 'checkpoint', 'manual', 'file'].includes(step.action)) throw new Error('Every replay action needs one unique ID and a supported operation');
    ids.add(step.id);
    if (step.action === 'file' && (workload.surface !== 'fixture-browser' || step.selector !== '#upload-input')) throw new Error('File automation is confined to the synthetic Browser fixture');
    if (step.optional !== undefined && (step.optional !== true || step.action !== 'click' || step.selector !== '[data-permission-tool="process_spawn"] [data-permission-choice="allow_once"]')) throw new Error('Only the bounded synthetic process permission may be conditionally acknowledged');
    if (step.owner !== undefined && !['process-running', 'process-completed', 'process-stopped', 'run-completed', 'browser-download-completed', 'browser-page-opened', 'run-cancelled', 'remote-completed'].includes(step.owner)) throw new Error('Unknown read-only owner observation');
    if (Object.keys(step).some(key => !['id', 'action', 'selector', 'expect', 'timeoutMs', 'settleMs', 'durationMs', 'key', 'modifiers', 'text', 'deltaX', 'deltaY', 'cycle', 'milestone', 'owner', 'optional'].includes(key))) throw new Error('Unknown replay field; executable expressions are forbidden');
    if (step.selector !== undefined && (!text(step.selector) || step.selector.length > 2048)) throw new Error('Invalid replay selector');
    if (['click', 'scroll'].includes(step.action) && !step.selector) throw new Error('Pointer replay requires an actual product element');
    if (step.action === 'key' && !['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Backspace', 'Delete', 'a'].includes(step.key)) throw new Error('Unsupported replay key');
    if (step.modifiers !== undefined && (!Number.isInteger(step.modifiers) || step.modifiers < 0 || step.modifiers > 15)) throw new Error('Invalid key modifiers');
    if (step.action === 'text' && (!text(step.text) || step.text.length > 4096)) throw new Error('Only bounded synthetic fixture text is accepted');
    if (step.action === 'scroll' && ![step.deltaX ?? 0, step.deltaY].every(Number.isFinite)) throw new Error('Invalid scroll delta');
    if (['wait', 'manual'].includes(step.action) && !positive(step.durationMs)) throw new Error('Observation duration must be explicit');
    if (step.settleMs !== undefined && (!Number.isFinite(step.settleMs) || step.settleMs < 0)
      || step.timeoutMs !== undefined && !positive(step.timeoutMs)) throw new Error('Invalid action timing');
    if (step.action === 'checkpoint' && (!Number.isSafeInteger(step.cycle) || step.cycle < 0)) throw new Error('Lifecycle checkpoint requires a cycle number');
    if (step.expect !== undefined) { if (!Array.isArray(step.expect)) throw new Error('Invalid commit conditions'); step.expect.forEach(condition); }
    if (['click', 'key', 'text', 'manual', 'file'].includes(step.action) && !step.expect?.length) throw new Error('An input dispatch is not a commit: supply observable postconditions');
  }
  if (workload.name === 'repeated-lifecycle' && new Set(workload.steps.filter(step => step.action === 'checkpoint').map(step => step.cycle)).size < 3) throw new Error('Lifecycle measurement needs a baseline and at least two settled cycle checkpoints');
  return workload;
}
export function validateBenchmarkRequest(request) {
  if (request?.schema !== 1 || request.product !== 'varin-desktop-benchmark-request'
    || !/^[a-f0-9-]{36}$/u.test(request.nonce ?? '') || !/^[a-f0-9]{40}$/u.test(request.sourceSha ?? '')
    || !text(request.version) || !isHash(request.scenarioSha256)
    || !['frontendSha256', 'dataSha256', 'configurationSha256'].every(key => isHash(request.inputs?.[key]))
    || !positive(request.sampleIntervalMs)) throw new Error('Invalid benchmark request identity');
  validateWorkload(request.workload);
  if (hashJson(request.workload) !== request.scenarioSha256) throw new Error('Benchmark workload changed after binding');
  return request;
}
export async function readIsolatedRequest(dataDirectory) {
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('Benchmark requires explicit absolute VARIN_DATA_DIR');
  const os = await import('node:os');
  const stat = await fs.lstat(dataDirectory), directory = await fs.realpath(dataDirectory), temporary = await fs.realpath(os.tmpdir());
  if (!stat.isDirectory() || stat.isSymbolicLink() || directory === temporary || !directory.startsWith(temporary + path.sep)) throw new Error('Benchmark data must be a new real child of the OS temporary directory');
  const marker = path.join(directory, 'benchmark-request.json'), markerStat = await fs.lstat(marker);
  // Bounded local protocol, not a file/code execution endpoint.
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024 * 1024) throw new Error('Benchmark request is not a bounded regular file');
  return { directory, request: validateBenchmarkRequest(JSON.parse(await fs.readFile(marker, 'utf8'))) };
}
export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarizeRun(run) {
  const samples = (run.samples ?? []).filter(sample => !sample.phase || sample.phase === 'workload');
  const totals = samples.map(sample => sample.processes.reduce((sum, process) => sum + (process.memoryBytes ?? 0), 0));
  const seen = new Map(); let cpuMs = 0, cpuComplete = samples.length > 1 && samples.every(sample => sample.processes.length > 0 && sample.coverage?.processCountersComplete !== false);
  for (const [index, sample] of samples.entries()) for (const process of [...sample.processes, ...(sample.coverage?.exitedProcesses ?? [])]) {
    if (!Number.isFinite(process.cpuTimeMs)) { cpuComplete = false; continue; }
    const key = `${process.pid}:${process.startIdentity}`, before = seen.get(key);
    if (before !== undefined) cpuMs += Math.max(0, process.cpuTimeMs - before);
    else if (index > 0) cpuMs += process.cpuTimeMs; // New child: its own lifetime, never cutime/cstime.
    seen.set(key, process.cpuTimeMs);
  }
  const durationMs = samples.length > 1 ? samples.at(-1).monotonicMs - samples[0].monotonicMs : 0;
  const targetSamples = run.rendererSamples?.filter(sample => sample.targets?.some(target => ['main', 'application:main'].includes(target.label) && ['running', 'completed'].includes(target.status))).flatMap(sample => sample.targets ?? []);
  const render = targetSamples ?? samples;
  const frames = render.flatMap(sample => sample.frameTimesMs ?? []), inputs = render.flatMap(sample => sample.inputLatenciesMs ?? []);
  const byTarget = Object.fromEntries([...new Set((targetSamples ?? []).map(sample => sample.surfaceRole ?? sample.label))].map(label => {
    const rows = targetSamples.filter(sample => (sample.surfaceRole ?? sample.label) === label), frame = rows.flatMap(sample => sample.frameTimesMs ?? []), input = rows.flatMap(sample => sample.inputLatenciesMs ?? []);
    return [label, { frames: frame.length, frameP95Ms: quantile(frame, .95), inputs: input.length, inputP95Ms: quantile(input, .95), unavailableSamples: rows.filter(row => row.status === 'document-ended-or-unavailable').length }];
  }));
  return { sampleCount: samples.length, observedProcessIdentities: seen.size, durationMs, cpuTimeMs: cpuComplete ? cpuMs : null,
    cpuCoreEquivalent: durationMs && cpuComplete ? cpuMs / durationMs : null,
    memoryMedianBytes: samples.length && samples.every(sample => sample.processes.length && sample.coverage?.processCountersComplete !== false && sample.processes.every(process => Number.isFinite(process.memoryBytes))) ? quantile(totals, .5) : null,
    memoryPeakObservedBytes: totals.length && samples.every(sample => sample.processes.length && sample.coverage?.processCountersComplete !== false && sample.processes.every(process => Number.isFinite(process.memoryBytes))) ? Math.max(...totals) : null,
    frameCount: frames.length, frameP50Ms: quantile(frames, .5), frameP95Ms: quantile(frames, .95), frameP99Ms: quantile(frames, .99),
    inputCount: inputs.length, inputP50Ms: quantile(inputs, .5), inputP95Ms: quantile(inputs, .95), startupMs: run.startupMs ?? null,
    byTarget, quantiles: 'nearest-rank; pooled renderer totals are descriptive only, compare named surfaces independently; observed samples, not an inferred peak or display presentation latency' };
}
