import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Test-only driver for an already-running exact candidate, not a production API.
// Copy the selected checkout's resource owner unchanged into a temporary path:
// Node 24 strips its type-only imports without installing/building another parser.
const [mode, ...arguments_] = process.argv.slice(2);
const mib = 1024 * 1024;
const positive = (value, name) => assert.ok(Number.isFinite(value) && value > 0, `${name} must be a finite positive number`);

if (mode === '--probe') {
  const [encodedLimits, sourceDigest, releaseId] = arguments_;
  const limits = JSON.parse(encodedLimits);
  for (const [name, value] of Object.entries(limits)) positive(value, name);
  const source = new URL('./resources-system.ts', import.meta.url);
  assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceDigest, 'Probe differs from the selected checkout');
  const { createDefaultResourceProbe } = await import(source.href);
  const probe = createDefaultResourceProbe();
  const check = sample => {
    // Docker's own configured limits are the independent reference. A tighter
    // visible ancestor is valid; a fallback to the host's capacity is not.
    assert.ok(['linux-cgroup-v1', 'linux-cgroup-v2', 'linux-cgroup-hybrid'].includes(sample.system?.source), 'Real cgroup facts are required');
    assert.equal(sample.system.status, 'available', JSON.stringify(sample.system));
    assert.equal(sample.system.scope, 'visible-cgroup-ancestors');
    positive(sample.cpuCores, 'effective CPU');
    positive(sample.memoryMb, 'effective memory');
    positive(sample.pidsLimit, 'effective PID limit');
    assert.ok(sample.cpuCores <= limits.cpuCores, 'Effective CPU exceeds the Docker quota');
    assert.ok(sample.memoryMb <= limits.memoryMb, 'Effective memory exceeds the Docker limit');
    assert.ok(sample.pidsLimit <= limits.pidsLimit, 'Effective PID limit exceeds the Docker limit');
    assert.ok(limits.cpuCores < sample.system.physical.cpuCores, 'CPU fixture must distinguish quota from physical capacity');
    assert.ok(limits.memoryMb < sample.system.physical.memoryMb, 'Memory fixture must distinguish cgroup from physical capacity');
    positive(sample.usedMemoryMb, 'observed cgroup memory use');
    positive(sample.pidsCurrent, 'observed cgroup task count');
    assert.ok(Number.isFinite(sample.memoryAvailableMb) && sample.memoryAvailableMb >= 0, 'Memory headroom is unread');
    assert.ok(sample.memoryAvailableMb <= Math.max(0, sample.memoryMb - sample.usedMemoryMb), 'Headroom escaped the limiting cgroup ancestry');
    assert.ok(Number.isInteger(sample.pidsAvailable) && sample.pidsAvailable >= 0, 'PID headroom is unread');
    assert.ok(sample.pidsAvailable <= Math.max(0, sample.pidsLimit - sample.pidsCurrent), 'PID headroom escaped the limiting cgroup ancestry');
  };
  const before = probe();
  console.log(JSON.stringify({ kind: 'container-budget-observation', limits, sourceDigest, sample: before }));
  check(before);
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, 'The limited candidate must remain healthy');
  assert.equal((await response.json()).releaseId, releaseId, 'Health must belong to the selected candidate');
  const after = probe();
  check(after);
  console.log(JSON.stringify({ kind: 'container-budget-verified', releaseId, sample: after }));
} else {
  const name = mode, releaseId = process.env.EXPECTED_RELEASE_ID;
  if (!name || arguments_.length || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !releaseId) {
    throw new Error('Usage: EXPECTED_RELEASE_ID=image-<source SHA> node scripts/smoke-container-budget.mjs <container>');
  }
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const [container] = JSON.parse(docker('inspect', name));
  assert.equal(container.State.Running, true, 'Start the exact candidate before checking its budget');
  const limits = { cpuCores: container.HostConfig.NanoCpus / 1e9, memoryMb: container.HostConfig.Memory / mib, pidsLimit: container.HostConfig.PidsLimit };
  for (const [key, value] of Object.entries(limits)) positive(value, `Docker ${key}`);
  const source = fileURLToPath(new URL('../packages/web/application-host/lib/harness/resources-system.ts', import.meta.url));
  const sourceDigest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const directory = docker('exec', name, 'node', '-e', "process.stdout.write(require('node:fs').mkdtempSync('/tmp/varin-budget-smoke-'))");
  assert.match(directory, /^\/tmp\/varin-budget-smoke-[a-zA-Z0-9]+$/);
  try {
    docker('cp', source, `${name}:${directory}/resources-system.ts`);
    docker('cp', fileURLToPath(import.meta.url), `${name}:${directory}/check.mjs`);
    execFileSync('docker', ['exec', name, 'node', `${directory}/check.mjs`, '--probe', JSON.stringify(limits), sourceDigest, releaseId], { stdio: 'inherit' });
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Running, true, 'Candidate stopped during budget verification');
    assert.equal(state.OOMKilled, false, 'Candidate was killed by its test memory limit');
  } finally {
    const cleanup = spawnSync('docker', ['exec', name, 'node', '-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", directory], { encoding: 'utf8' });
    if (cleanup.status !== 0) console.error('Temporary budget probe cleanup failed; the workflow must remove its disposable container.');
  }
}
