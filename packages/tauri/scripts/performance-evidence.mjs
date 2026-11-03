/** Qualification consumes observed A/B measurements, never a manually asserted
 * pass bit or a main-process-only memory number. Collection has a separate owner. */
import { canonicalJson } from '../../../scripts/desktop-update-signatures.mjs';
export const performanceScenarios = ['remote-idle', 'long-chat-stream', 'workspace-transitions', 'companion-drag', 'browser-interaction', 'local-hybrid-execution', 'repeated-lifecycle'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
export function verifyPerformanceEvidence(document, { target, sourceSha, version, runtimeManifestSha256, engineManifestSha256, artifacts }) {
  if (document.schema !== 1 || document.product !== 'varin-desktop-performance' || document.target !== target || document.sourceSha !== sourceSha
    || document.version !== version || document.runtimeManifestSha256 !== runtimeManifestSha256 || document.engineManifestSha256 !== engineManifestSha256
    || canonicalJson(document.artifacts) !== canonicalJson(artifacts)) throw new Error('Performance evidence belongs to another candidate');
  const environment = document.environment, measurement = document.measurement;
  if (!environment || !['os', 'osVersion', 'cpu', 'gpu', 'display'].every(key => text(environment[key])) || !integer(environment.logicalCpus)
    || environment.logicalCpus === 0 || !integer(environment.memoryBytes) || environment.memoryBytes === 0
    || !text(measurement?.collector) || !text(measurement?.version) || measurement.clock !== 'monotonic'
    || measurement.scope !== 'all-owned-desktop-processes' || !['private-bytes', 'proportional-set-bytes'].includes(measurement.memoryMetric)
    || !text(measurement.gpuAccounting) || !finite(measurement.intervalMs) || measurement.intervalMs === 0) throw new Error('Performance evidence lacks its environment or whole-tree accounting');
  if (!Array.isArray(document.scenarios) || document.scenarios.length !== performanceScenarios.length) throw new Error('Performance evidence requires every design scenario');
  for (const name of performanceScenarios) {
    const matches = document.scenarios.filter(scenario => scenario.name === name);
    if (matches.length !== 1 || !hash(matches[0].scenarioSha256)) throw new Error(`Missing measured performance scenario: ${name}`);
    const scenario = matches[0], inputs = scenario.inputs;
    if (!inputs || !['frontendSha256', 'dataSha256', 'configurationSha256'].every(key => hash(inputs[key]))) throw new Error('Performance comparison inputs must be identical and content-addressed');
    for (const shell of ['electron', 'tauri']) {
      const run = scenario[shell];
      if (run?.shell !== shell || run.sourceSha !== sourceSha || run.version !== version || !hash(run.artifactSha256)
        || canonicalJson(run.inputs) !== canonicalJson(inputs) || !integer(run.rootPid) || run.rootPid === 0
        || !finite(run.startupMs) || !Array.isArray(run.samples) || run.samples.length < 2) throw new Error(`Missing observed ${shell} process tree: ${name}`);
      if (shell === 'tauri' && !Object.values(artifacts).includes(run.artifactSha256)) throw new Error('Performance run did not exercise a qualified candidate artifact');
      let previous = -1;
      for (const sample of run.samples) {
        if (!finite(sample.monotonicMs) || sample.monotonicMs <= previous || !finite(sample.gpuBytes) || !Array.isArray(sample.processes)
          || !sample.processes.length || !Array.isArray(sample.frameTimesMs) || !sample.frameTimesMs.every(finite)
          || !Array.isArray(sample.inputLatenciesMs) || !sample.inputLatenciesMs.every(finite)) throw new Error('Performance samples must contain monotonic whole-tree and interaction observations');
        previous = sample.monotonicMs;
        const ids = new Set();
        for (const process of sample.processes) {
          if (!integer(process.pid) || process.pid === 0 || ids.has(process.pid) || !integer(process.parentPid) || !text(process.role)
            || !finite(process.cpuTimeMs) || !integer(process.memoryBytes) || !integer(process.handles) || !text(process.startIdentity)) throw new Error('Invalid measured process identity or counters');
          ids.add(process.pid);
        }
      }
      if (name !== 'remote-idle' && (!run.samples.some(sample => sample.frameTimesMs.length) || !run.samples.some(sample => sample.inputLatenciesMs.length))) throw new Error('Interactive performance scenarios require actual frame/input measurements');
    }
    if (!text(scenario.assessment?.method) || !text(scenario.assessment?.result) || scenario.assessment.accepted !== true) throw new Error('Measured performance comparison has not been accepted');
  }
  return document;
}
