#!/usr/bin/env node
/** Same-source, owner-seeded full-product suite. It is not a performance waiver:
 * missing native input/GPU/physical display coverage remains explicitly pending. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { verifyElectronBaseline } from './benchmark-build.mjs';
import { startFixtureWorker, isolatedEnvironment } from './benchmark-services.mjs';
import { fixtureApi, seedProduct } from './benchmark-seed.mjs';
import { productWorkloads, operatorInstructions, manualScenarios } from './benchmark-workloads.mjs';
import { planTemplate, environmentProbe, runBenchmark } from './benchmark-desktop.mjs';
import { hashDirectory, hashJson, scenarioRequirements } from './benchmark-contract.mjs';
import { providerDisclosure } from './benchmark-fixture-service.mjs';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function makeRoot(root) { await fs.mkdir(path.join(root, 'data'), { recursive: true }); await fs.mkdir(path.join(root, 'home'), { recursive: true }); return root; }
export async function runSuite({ pairFile, output, repetitions = 4, manual = false, turns = 40 } = {}) {
  output = path.resolve(output); await fs.mkdir(output, { recursive: false });
  const report = { schema: 1, product: 'varin-desktop-benchmark-suite', status: 'running', qualification: 'not-accepted', sourceSha: null,
    providerDisclosure, scenarios: [], setup: [], limitations: [], cleanup: [] };
  let root, provider, cleanupUncertain = false;
  try {
    const pair = await read(path.resolve(pairFile)); report.sourceSha = pair.sourceSha;
    if (pair.schema !== 1 || pair.product !== 'varin-desktop-benchmark-pair' || pair.target !== `${process.platform}-${process.arch}`) throw new Error('Expected native same-source benchmark pair');
    const manifest = await verifyRuntimeManifest(pair.runtime, { platform: process.platform, architecture: process.arch });
    if (manifest.sources?.sourceSha !== pair.sourceSha || manifest.sources?.sourceDirty !== false) throw new Error('Runtime source provenance does not match the immutable pair');
    await verifyElectronBaseline(pair.electron.artifact, pair);
    const probe = environmentProbe(); await save(path.join(output, 'probe.json'), probe);
    if (!probe.displayAvailable) throw new Error('Native display is unavailable; explicitly provision a desktop or declared Linux Xvfb correctness session');
    if (process.env.VARIN_BENCHMARK_DISPOSABLE_OS_USER !== '1') throw new Error('A disposable OS account/session is required before full products register OS handlers');
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(turns) || turns < 20) throw new Error('Expected positive repetitions and at least 20 real history turns');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-benchmark-suite-'));
    const node = path.join(pair.runtime, manifest.node.executable), worker = (directory, configuration) => startFixtureWorker({ node,
      env: isolatedEnvironment(directory, pair.runtime, manifest), configuration: { runtime: pair.runtime, ...configuration } });
    const providerRoot = await makeRoot(path.join(root, 'provider'));
    provider = await worker(providerRoot, { mode: 'provider', nodePath: node });
    const seedRoot = await makeRoot(path.join(root, 'seed'));
    const workspace = path.join(seedRoot, 'home', 'workspace'); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'benchmark-workload.mjs'), "const start=performance.now(); let total=0; while(performance.now()-start<(process.argv.includes('--hold')?60000:5000)){for(let i=0;i<10000;i++)total+=Math.sqrt(i)} process.stdout.write(JSON.stringify({completed:true,finite:Number.isFinite(total)})+'\\n');\n");
    await fs.writeFile(path.join(root, 'upload.txt'), 'Varin synthetic native-browser upload.\n');
    let host = await worker(seedRoot, { mode: 'host', providerOrigin: provider.origin });
    const remotePort = Number(new URL(host.origin).port), remoteOrigin = host.origin, credentials = host.credentials;
    let seeded;
    try { seeded = await seedProduct(fixtureApi(host.origin, credentials), provider.origin, { turns, workspace }); }
    finally { report.setup.push({ owner: 'seed-host', ...(await host.stop()) }); host = null; }
    report.seed = { turns: seeded.turns, completedTurns: seeded.completedTurns, identity: seeded.identity, source: seeded.source ? 'real-live-root' : null };
    const workloads = productWorkloads(seeded.identity, { workspace, browserOrigin: provider.origin, remoteOrigin });
    const instructions = operatorInstructions(provider.origin);
    report.limitations.push(...instructions.limitations, 'Remote service CPU/memory is recorded separately and is not silently charged to one desktop shell.',
      'Fresh profiles are byte-identical; OS file caches are uncontrolled. These are not cold-versus-warm cache measurements.');
    await save(path.join(output, 'operator-instructions.json'), { ...instructions, uploadFile: path.join(root, 'upload.txt'), ephemeral: true });
    const plan = { ...planTemplate(), sourceSha: pair.sourceSha, version: pair.version, target: pair.target, repetitions,
      disposableOsUser: true, electron: pair.electron, tauri: pair.tauri, environment: {
        gpu: process.env.VARIN_BENCHMARK_GPU ?? 'unreported; GPU counters remain unavailable unless independently observed',
        display: process.env.VARIN_BENCHMARK_DISPLAY ?? (process.env.VARIN_BENCHMARK_VIRTUAL_DISPLAY === '1' ? 'Linux Xvfb virtual display; no physical display qualification' : `native session ${process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY ?? process.platform}; physical identity unreported`),
        powerMode: process.env.VARIN_BENCHMARK_POWER_MODE ?? 'uncontrolled; not a power-efficiency comparison',
        backgroundLoad: process.env.VARIN_BENCHMARK_BACKGROUND_LOAD ?? 'uncontrolled; alternate A/B order, retain raw observations', monitorCount: null,
      }, scenarios: [] };
    for (const [name, workload] of Object.entries(workloads)) {
      const fixtureDirectory = await makeRoot(path.join(root, 'fixtures', name));
      // The original Host is fully stopped before snapshotting its durable state.
      await fs.cp(path.join(seedRoot, 'data'), path.join(fixtureDirectory, 'data'), { recursive: true });
      await fs.cp(seedRoot, path.join(fixtureDirectory, 'remote'), { recursive: true });
      await fs.writeFile(path.join(fixtureDirectory, 'data', 'benchmark-upload.txt'), 'Varin synthetic native-browser upload.\n');
      const localHost = ['local-hybrid-execution', 'browser-interaction'].includes(name);
      const settings = await worker(fixtureDirectory, { mode: 'settings', operations: [
        { method: 'desktop_set_locale', args: { locale: 'en' } },
        { method: 'desktop_set_local_host_mode', args: { enabled: localHost } },
        { method: 'desktop_hosts_set', args: { input: { hosts: [{ id: 'benchmark-remote', label: 'Benchmark remote Host', url: remoteOrigin, apiUrl: remoteOrigin, clientToken: credentials.clientToken }],
          defaultHostId: localHost ? 'local' : 'benchmark-remote', initialHostChoiceCompleted: true } } },
        { method: 'saveWindowState', args: { state: { x: 0, y: 0, width: 1440, height: 1000, maximized: false, fullscreen: false } } },
      ] });
      const configured = await settings.stop();
      if (!configured.drained) throw new Error('Settings owner did not stop before hashing fixture');
      plan.scenarios.push({ name, fixtureDirectory, syntheticFixture: true, requirements: scenarioRequirements[name],
        configuration: { motion: 'full', width: 1440, height: 1000, locale: 'en', localHost, remoteOrigin, providerOrigin: provider.origin, workspace, seedTurns: turns }, workload });
      report.scenarios.push({ name, status: manualScenarios.includes(name) && !manual ? 'not-executed-native-operator-required' : 'prepared', fixtureSha256: await hashDirectory(fixtureDirectory), workloadSha256: hashJson(workload) });
    }
    // Plans contain private, ephemeral filesystem locations; preserve only the
    // hashed public preflight/comparison files in CI, not prepared profiles.
    const selected = plan.scenarios.filter(s => manual || !manualScenarios.includes(s.name)).map(s => s.name);
    const comparison = await runBenchmark(plan, { output: path.join(output, 'measurements'), selected, hooks: {
      async beforeRun({ root: copy, scenario }) {
        const remote = await worker(path.join(copy, 'remote'), { mode: 'host', providerOrigin: provider.origin, port: remotePort });
        try {
        if (remote.origin !== remoteOrigin || remote.credentials.clientToken !== credentials.clientToken) { throw new Error('Remote fixture endpoint/auth changed between paired runs'); }
        if (manualScenarios.includes(scenario.name)) process.stdout.write(`Native operator scenario: ${scenario.name}. Follow ${path.join(output, 'operator-instructions.json')} now.\n`);
        return { remote, before: (await provider.request('inspect')).receipt };
        } catch (error) { await remote.stop(); throw error; }
      },
      async afterRun({ services, scenario }) {
        if (!services) return null;
        const remote = await services.remote.stop(), after = (await provider.request('inspect')).receipt;
        const delta = { completed: after.completed - services.before.completed, cancelled: after.cancelled - services.before.cancelled,
          logins: after.logins - services.before.logins, downloads: after.downloads - services.before.downloads, uploads: after.uploads.length - services.before.uploads.length };
        if (scenario.name === 'long-chat-stream' && delta.completed < 1) throw new Error('UI completion has no completed controlled provider response');
        if (scenario.name === 'local-hybrid-execution' && (delta.completed < 3 || delta.cancelled < 1)) throw new Error('Local/remote task completions and original stream cancellation were not observed');
        if (scenario.name === 'browser-interaction' && (!delta.logins || !delta.uploads || !delta.downloads)) throw new Error('Native browser workload did not complete real fixture login/upload/download requests');
        return { remote, providerDelta: delta, externalServiceScope: 'separate-from-desktop-process-tree' };
      },
    } });
    cleanupUncertain ||= comparison.cleanupUncertain === true;
    report.retainedRunDirectories = comparison.retainedPrivateDirectories ?? [];
    report.comparisonStatus = comparison.status;
    if (comparison.blockers) report.blockers = comparison.blockers;
    for (const entry of report.scenarios) if (entry.status === 'prepared') {
      const measured = comparison.scenarios?.find(scenario => scenario.name === entry.name);
      entry.status = comparison.status === 'blocked' ? 'blocked-preflight' : measured?.pairs.length ? 'executed-see-paired-receipts'
        : comparison.retainedPrivateDirectories?.some(run => run.scenario === entry.name) ? 'interrupted-cleanup-unresolved' : 'not-executed-after-interruption';
    }
    const failed = issue => ['missing-or-failed-bound-product-receipt', 'product-exit-not-successful', 'real-product-startup-not-observed', 'process-tree-did-not-drain-before-observation-deadline'].includes(issue)
      || issue.startsWith('measurement-failed:') || issue.startsWith('fixture-drain-failed:');
    report.status = cleanupUncertain ? 'failed-cleanup' : comparison.status === 'blocked' ? 'blocked' : comparison.scenarios?.some(s => s.pairs.some(p => [...(p.coverage?.electron ?? []), ...(p.coverage?.tauri ?? [])].some(failed)))
      ? 'failed-measurement' : 'observed-not-qualified';
  } catch (error) { cleanupUncertain ||= error.cleanupUncertain === true; report.status = 'blocked'; report.failure = { code: error.code ?? 'suite-owner-operation-failed', reason: error.message }; }
  finally {
    if (provider) { try { report.cleanup.push({ owner: 'provider', ...(await provider.stop()) }); } catch (error) { cleanupUncertain ||= error.cleanupUncertain === true; report.status = 'failed-cleanup'; report.cleanup.push({ owner: 'provider', error: error.message, ...error.fixtureCleanup }); } }
    if (root && !cleanupUncertain) await fs.rm(root, { recursive: true, force: true });
    else if (root) report.retainedPrivateDirectory = root;
    await save(path.join(output, 'suite.json'), report);
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (!value('--pair') || !value('--output')) throw new Error('Usage: benchmark-suite.mjs --pair pair.json --output NEW-DIR [--repetitions N] [--manual]');
  const result = await runSuite({ pairFile: value('--pair'), output: value('--output'), repetitions: Number(value('--repetitions') ?? 4), manual: args.includes('--manual') });
  process.stdout.write(JSON.stringify({ status: result.status, qualification: result.qualification, output: path.resolve(value('--output')) }) + '\n');
  process.exitCode = result.status === 'observed-not-qualified' ? 0 : 2;
}
