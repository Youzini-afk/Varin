import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessCollector, parseLinuxStat, parseLinuxPss, parseDrmFdinfo, summarizeDrmClients, ProcessTreeTracker, parseNativeProcessTable } from './benchmark-processes.mjs';

const statText = ({ pid = 100, parentPid = 1, start = '1000', user = 25, system = 12, name = 'node', state = 'S' } = {}) => {
  const fields = [state, parentPid, 0, 0, 0, 0, 0, 0, 0, 0, 0, user, system, 99999, 99999, 0, 0, 1, 0, start, 12345, 20];
  return `${pid} (${name}) ${fields.join(' ')}\n`;
};
const processRow = (pid, parentPid, start, extra = {}) => ({ pid, parentPid, startIdentity: `linux:${start}`, startOrder: String(start), state: 'running', ...extra });
const codes = sample => sample.coverage.issues.map(item => item.code);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-proc-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function writeProcess(root, pid, parentPid, start = 1000, overrides = {}) {
  const dir = join(root, String(pid));
  await mkdir(join(dir, 'fd'), { recursive: true });
  await mkdir(join(dir, 'fdinfo'), { recursive: true });
  await writeFile(join(dir, 'stat'), statText({ pid, parentPid, start, ...overrides }));
  await writeFile(join(dir, 'smaps_rollup'), 'Rss: 9000 kB\nPss: 1234 kB\nSwapPss: 250 kB\n');
  await writeFile(join(dir, 'fd', '0'), '');
  await writeFile(join(dir, 'fdinfo', '0'), 'pos: 0\nflags: 0100000\n');
}

// Parser fixtures test accounting boundaries; they are not desktop A/B evidence.
test('Linux stat reads actual clock ticks and self CPU despite spaces and parentheses', () => {
  const record = parseLinuxStat(statText({ name: 'a ) tricky ( name', user: 25, system: 12 }), 250);
  assert.equal(record.cpuTimeMs, 148);
  assert.equal(record.startIdentity, 'linux:1000');
  assert.equal(record.parentPid, 1);
  assert.throws(() => parseLinuxStat('invalid', 100));
  assert.throws(() => parseLinuxStat(statText(), 0));
  assert.equal(parseLinuxPss('Pss: 10 kB\nRss: 100 kB\nPss: 20 kB\nSwapPss: 999 kB\n'), 30720);
  assert.throws(() => parseLinuxPss('Rss: 100 kB\n'));
  assert.throws(() => parseLinuxPss('Pss: 999999999999999999999 kB\n'));
});

test('tree tracking covers unordered descendants and reparenting without adopting reused PIDs', () => {
  const tracker = new ProcessTreeTracker(10, 'linux:100');
  const initial = [processRow(12, 11, 120), processRow(90, 1, 90), processRow(11, 10, 110), processRow(10, 1, 100)];
  assert.deepEqual(tracker.select(initial).processes.map(row => row.pid), [10, 11, 12]);
  assert.deepEqual(tracker.select([processRow(10, 1, 100), processRow(12, 1, 120)]).processes.map(row => row.pid), [10, 12]);
  const replaced = tracker.select([processRow(10, 1, 100), processRow(12, 1, 900), processRow(13, 12, 901)]);
  assert.deepEqual(replaced.processes.map(row => row.pid), [10]);
  assert.deepEqual(replaced.reused, [12]);
  const rootReused = tracker.select([processRow(10, 1, 999), processRow(14, 10, 1000)]);
  assert.equal(rootReused.rootState, 'reused');
  assert.deepEqual(rootReused.processes, []);
  // Windows can retain a dead parent's PID. An older child is not owned by its replacement.
  const another = new ProcessTreeTracker(1, 'linux:500');
  assert.deepEqual(another.select([processRow(1, 0, 500), processRow(2, 1, 400)]).processes.map(row => row.pid), [1]);
});

const drm = (client, device = '0000:03:00.0', shared = '0', extra = '') => parseDrmFdinfo(`drm-driver: test\ndrm-pdev: ${device}\ndrm-client-id: ${client}\ndrm-total-vram: 8 MiB\ndrm-resident-vram: 4 MiB\ndrm-shared-vram: ${shared} KiB\n${extra}`);
test('DRM deduplicates shared descriptors by device and client, not PID or FD', () => {
  const first = drm(7), otherDevice = drm(7, '0000:04:00.0');
  const result = summarizeDrmClients([{ ...first, pid: 1 }, { ...first, pid: 1 }, { ...first, pid: 2 }, { ...otherDevice, pid: 3 }]);
  assert.equal(result.gpuBytes, 8 * 1048576);
  assert.equal(result.gpu.clients.length, 2);
  assert.deepEqual(result.gpu.clients[0].pids, [1, 2]);
  assert.equal(result.gpu.clients[0].observedDescriptors, 3);
  assert.equal(parseDrmFdinfo('pos: 0\nflags: 0100000'), null);
});

test('DRM never invents totals for shared buffers, absent metrics, malformed units or permission loss', () => {
  assert.equal(summarizeDrmClients([drm(1, undefined, '64'), drm(2, undefined, '64')]).gpuBytes, null);
  assert.equal(summarizeDrmClients([parseDrmFdinfo('drm-driver: test\ndrm-client-id: 1\ndrm-resident-vram: 1024\n')]).gpuBytes, null);
  assert.equal(summarizeDrmClients([parseDrmFdinfo('drm-driver: test\ndrm-resident-vram: 1 KiB\n')]).gpuBytes, null);
  assert.equal(summarizeDrmClients([drm(1)], { complete: false }).gpuBytes, null);
  assert.equal(summarizeDrmClients([]).gpuBytes, null);
  assert.equal(summarizeDrmClients([parseDrmFdinfo('drm-driver: t\ndrm-client-id: 1\ndrm-resident-vram: 100 kB\ndrm-shared-vram: 0\n')]).gpuBytes, null);
  const alias = parseDrmFdinfo('drm-driver: amdgpu\ndrm-client-id: 1\ndrm-memory-vram: 9 MiB\ndrm-resident-vram: 8 MiB\ndrm-shared-vram: 0\n');
  assert.equal(summarizeDrmClients([alias]).gpuBytes, 8 * 1048576);
  const observedZero = parseDrmFdinfo('drm-driver: t\ndrm-client-id: 1\ndrm-resident-vram: 0\ndrm-shared-vram: 0\n');
  assert.equal(summarizeDrmClients([observedZero]).gpuBytes, 0);
});


test('unsupported GPU descriptors keep the tree total unknown even beside a measured DRM client', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  await writeFile(join(root, '10/fdinfo/8'), 'drm-driver: t\ndrm-client-id: 1\ndrm-resident-vram: 4 KiB\ndrm-shared-vram: 0\n');
  await writeFile(join(root, '10/fdinfo/9'), 'pos: 0\nflags: 0100000\n');
  await symlink('/dev/nvidia0', join(root, '10/fd/9'));
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100, rootPid: 10 });
  t.after(() => collector.close());
  const sample = await collector.sample();
  assert.equal(sample.gpuBytes, null);
  assert.equal(sample.gpu.clients.length, 1);
  assert(codes(sample).includes('gpu-device-counters-unavailable'));
});

test('native table parsing preserves unknown counters, identities and strips unrequested data', () => {
  const row = { pid: 25, parentPid: 2, startIdentity: 'win32:20261103180000123456', startOrder: '20261103180000123456',
    cpuTimeMs: 120.25, memoryBytes: 12345678, handles: 25, CommandLine: 'secret', environment: 'secret' };
  const parsed = parseNativeProcessTable(JSON.stringify([row]), 'win32');
  assert.equal(parsed.processes[0].cpuTimeMs, 120.25);
  assert.equal(parsed.processes[0].memoryBytes, 12345678);
  assert.equal('CommandLine' in parsed.processes[0], false);
  const denied = parseNativeProcessTable(JSON.stringify([{ ...row, cpuTimeMs: null, memoryBytes: null, handles: null }]), 'win32');
  assert.equal(denied.processes[0].memoryBytes, null);
  assert.equal(denied.processes[0].issues.length, 3);
  const unknown = parseNativeProcessTable(JSON.stringify([{ pid: 25, parentPid: 2, startIdentity: null }]), 'win32');
  assert.deepEqual(unknown.unreadablePids, [25]);
  assert.deepEqual(unknown.unresolved, [{ pid: 25, parentPid: 2 }]);
  assert.deepEqual(unknown.issues, []);
  assert.throws(() => parseNativeProcessTable(JSON.stringify([row, row]), 'win32'));
  assert.throws(() => parseNativeProcessTable('{}', 'darwin'));
});

test('collector reads whole proc table, rolls up PSS and deduplicates DRM across descendants', async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  await writeProcess(root, 20, 10, 200);
  await writeProcess(root, 30, 20, 300);
  await writeProcess(root, 99, 1, 400);
  const fdinfo = 'drm-driver: test\ndrm-pdev: 0000:01:00.0\ndrm-client-id: 11\ndrm-resident-vram: 4 KiB\ndrm-shared-vram: 0\n';
  await writeFile(join(root, '20/fdinfo/8'), fdinfo);
  await writeFile(join(root, '30/fdinfo/9'), fdinfo);
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 250 });
  t.after(() => collector.close());
  assert.equal(await collector.setRoot(10), 'linux:100');
  const sample = await collector.sample();
  assert.equal(collector.memoryMetric, 'proportional-set-bytes');
  assert.deepEqual(sample.processes.map(row => row.pid), [10, 20, 30]);
  assert.equal(sample.processes[0].memoryBytes, 1234 * 1024);
  assert.equal(sample.processes[0].cpuTimeMs, 148);
  assert.equal(sample.processes[0].handles, 1);
  assert.equal(sample.gpuBytes, 4096);
  assert.equal(sample.coverage.complete, true);
  // Parent disappears; its observed grandchild remains in the owned tree.
  await rm(join(root, '20'), { recursive: true });
  await writeFile(join(root, '30/stat'), statText({ pid: 30, parentPid: 1, start: 300 }));
  assert.deepEqual((await collector.sample()).processes.map(row => row.pid), [10, 30]);
  // A replacement with the same PID and no ancestry is not adopted.
  await writeFile(join(root, '30/stat'), statText({ pid: 30, parentPid: 1, start: 900 }));
  const reused = await collector.sample();
  assert.deepEqual(reused.processes.map(row => row.pid), [10]);
  assert(codes(reused).includes('observed-pid-reused'));
});

test('missing process table, exited root and unreadable identity remain different states', async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100, rootPid: 10 });
  t.after(() => collector.close());
  await writeFile(join(root, '10/stat'), 'malformed');
  const unknown = await collector.sample();
  assert.equal(unknown.coverage.rootState, 'unknown');
  assert.equal(unknown.coverage.processCountersComplete, false);
  assert(codes(unknown).includes('process-identity-unavailable'));
  await rm(join(root, '10'), { recursive: true });
  const exited = await collector.sample();
  assert.equal(exited.coverage.rootState, 'exited');
  assert.equal(exited.coverage.processCountersComplete, true);
  assert.deepEqual(exited.processes, []);
  await rm(root, { recursive: true });
  const unavailable = await collector.sample();
  assert.equal(unavailable.coverage.rootState, 'unknown');
  assert.equal(unavailable.coverage.processCountersComplete, false);
  assert(codes(unavailable).includes('process-table-unavailable'));
});

test('missing memory or fd metrics are null, with explicit coverage issues', async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100, rootPid: 10 });
  t.after(() => collector.close());
  await rm(join(root, '10/smaps_rollup'));
  await rm(join(root, '10/fd'), { recursive: true });
  await rm(join(root, '10/fdinfo'), { recursive: true });
  const missing = await collector.sample();
  assert.equal(missing.processes[0].memoryBytes, null);
  assert.equal(missing.processes[0].handles, null);
  assert.equal(missing.gpuBytes, null);
  assert(codes(missing).includes('memory-unavailable'));
  assert(codes(missing).includes('handles-unavailable'));
  assert(codes(missing).includes('fdinfo-unavailable'));
  await writeFile(join(root, '10/smaps'), 'Pss: 10 kB\nPss: 20 kB\n');
  assert.equal((await collector.sample()).processes[0].memoryBytes, 30720);
});

test('permission denied on rollup never becomes zero or falls back to a readable smaps', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100, rootPid: 10 });
  t.after(() => collector.close());
  await writeFile(join(root, '10/smaps'), 'Pss: 999 kB\n');
  await chmod(join(root, '10/smaps_rollup'), 0);
  const denied = await collector.sample();
  assert.equal(denied.processes[0].memoryBytes, null);
  assert(denied.coverage.issues.some(item => item.code === 'memory-unavailable' && item.error === 'EACCES'));
  await chmod(join(root, '10/smaps_rollup'), 0o600);
});

test('collector pins expected root identity and refuses invalid lifecycle calls', async t => {
  const root = await fixture(t);
  await writeProcess(root, 10, 1, 100);
  await assert.rejects(createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100, rootPid: 10, rootStartIdentity: 'linux:999' }), /does not match/u);
  const collector = await createProcessCollector({ platform: 'linux', procRoot: root, ticksPerSecond: 100 });
  await assert.rejects(collector.sample(), /no root/u);
  await collector.setRoot(10);
  await assert.rejects(collector.setRoot(10), /new collector/u);
  await collector.close();
  await assert.rejects(collector.sample(), /closed/u);
  await collector.close();
});

test('Windows counters retain the original launch handle FILETIME without rounding', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { launchOwned } = await import('./native-process-owner.mjs');
  const root = await mkdtemp(join(tmpdir(), 'varin-counter-identity-'));
  const stop = join(root, 'stop-original');
  const program = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},25);setTimeout(()=>clearInterval(timer),90000).unref();`;
  let owner, collector, other, drained = false;
  try {
    owner = await launchOwned({ executable: process.execPath, args: ['-e', program, stop], cwd: root, env: process.env });
    assert.match(owner.rootStartIdentity, /^win32:[0-9]+$/u);
    collector = await createProcessCollector();
    assert.equal(await collector.setRoot(owner.rootPid, owner.rootStartIdentity), owner.rootStartIdentity);
    const sample = await collector.sample();
    assert.equal(sample.processes.find(row => row.pid === owner.rootPid)?.startIdentity, owner.rootStartIdentity);
    other = await createProcessCollector();
    const changed = `win32:${BigInt(owner.rootStartIdentity.slice(6)) + 1n}`;
    await assert.rejects(other.setRoot(owner.rootPid, changed), /does not match/u);
  } finally {
    await collector?.close(); await other?.close();
    await writeFile(stop, 'stop');
    if (owner) drained = (await owner.settle({ timeoutMs: 15000 })).ownershipDrainConfirmed;
    if (drained) await rm(root, { recursive: true, force: true });
    else t.diagnostic('Original counter identity fixture retained because its scope is unconfirmed.');
  }
});

const treeProgram = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [mode, directory] = process.argv.slice(2);
const report = (event, fields = {}) => appendFileSync(join(directory, mode + '.jsonl'), JSON.stringify({ event, mode, pid: process.pid, ...fields }) + '\n');
process.on('exit', code => report('exit', { code }));
process.on('uncaughtExceptionMonitor', error => report('failure', { code: error.code ?? null }));
const allocations = [Buffer.alloc(4 * 1024 * 1024, 1)];
let grew = false;
setInterval(() => {
  if (existsSync(join(directory, mode + '.exit'))) process.exit(0);
  if (!grew && existsSync(join(directory, mode + '.grow'))) {
    allocations.push(Buffer.alloc(24 * 1024 * 1024, 7)); grew = true; report('grew');
  }
  const until = performance.now() + 5;
  while (performance.now() < until) allocations[0][0] ^= 1;
}, 20);
// Every generation reads its own fixed control files. A middle process exiting
// must not control a surviving leaf's stdin pipe or output channel lifetime.
if (mode !== 'leaf') {
  // libuv places non-detached Windows children in a per-parent job with
  // KILL_ON_JOB_CLOSE. Detach these fixture children so parent exit does not
  // kill the leaf whose continued OS identity this test is meant to observe.
  // The actual spawn ancestry and explicit file-controlled exit remain intact.
  // https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process.c#L69-L97
  const child = spawn(process.execPath, [import.meta.filename, mode === 'root' ? 'middle' : 'leaf', directory], {
    detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('error', error => { report('spawn-failure', { code: error.code ?? null }); process.exit(1); });
}
report('ready');
setTimeout(() => { report('timeout'); process.exit(1); }, 90000).unref();
`;

test('real Node root/child/grandchild: CPU and memory growth, exit and retained reparenting', { skip: !['linux', 'darwin', 'win32'].includes(process.platform), timeout: process.platform === 'win32' ? 60000 : 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-proc-tree-')), script = join(directory, 'tree.mjs');
  const modes = ['root', 'middle', 'leaf'];
  await writeFile(script, treeProgram);
  // Compile/setup happens before launch, as in the desktop A/B runner.
  const collector = await createProcessCollector();
  const root = spawn(process.execPath, [script, 'root', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  root.stderr.on('data', bytes => stderr.push(bytes.toString()));
  const closed = once(root, 'close'), exitedRoot = once(root, 'exit');
  const command = (mode, name) => writeFile(join(directory, `${mode}.${name}`), '');
  const events = async () => (await Promise.all(modes.map(async mode => {
    try {
      // Read only complete records if an append is in flight.
      return (await readFile(join(directory, `${mode}.jsonl`), 'utf8')).split('\n').slice(0, -1).map(line => JSON.parse(line));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }))).flat();
  let phase = 'startup', lastSample;
  t.after(async () => {
    let cleanupTimer;
    try {
      await Promise.all(modes.map(mode => command(mode, 'exit')));
      await Promise.race([closed, new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('Process fixture exit is unconfirmed; its control directory is retained')), 15000);
      })]);
      const observed = await events();
      // Neither an empty sample nor the root's exit alone proves this fixture's
      // descendants stopped. Require every generation's own exit receipt too.
      for (const mode of modes) {
        const ready = observed.find(event => event.mode === mode && event.event === 'ready');
        assert(ready && observed.some(event => event.mode === mode && event.pid === ready.pid && event.event === 'exit'),
          `The ${mode} fixture exit is unconfirmed; its control directory is retained`);
      }
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      t.diagnostic(`Process fixture control directory retained: ${directory}`);
      throw error;
    } finally { clearTimeout(cleanupTimer); await collector.close(); }
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate(await events())) {
      if (Date.now() > deadline) throw new Error(`Process fixture timed out in ${phase}: ${stderr.join('')}`);
      await delay(20);
    }
  };
  const sample = async () => (lastSample = await collector.sample());
  try {
    await collector.setRoot(root.pid);
    await waitFor(observed => observed.filter(event => event.event === 'ready').length === 3);
    const pids = Object.fromEntries((await events()).filter(event => event.event === 'ready').map(event => [event.mode, event.pid]));
    const first = await sample();
    assert.deepEqual(new Set(first.processes.map(row => row.pid)), new Set(Object.values(pids)));
    assert.equal(first.coverage.processCountersComplete, true);
    assert.equal(first.processes.find(row => row.pid === pids.middle).parentPid, pids.root);
    assert.equal(first.processes.find(row => row.pid === pids.leaf).parentPid, pids.middle);
    if (process.platform === 'linux') assert.equal(collector.metadata.clockTicksPerSecond > 0, true);
    if (process.platform === 'darwin') { assert(collector.metadata.machTimebase.numer > 0); assert(collector.metadata.machTimebase.denom > 0); }
    for (const row of first.processes) { assert(row.memoryBytes > 0); assert(row.handles > 0); assert(row.cpuTimeMs >= 0); }
    phase = 'growth';
    await Promise.all(modes.map(mode => command(mode, 'grow')));
    await waitFor(observed => observed.filter(event => event.event === 'grew').length === 3);
    await delay(150);
    const second = await sample();
    assert(second.monotonicMs > first.monotonicMs);
    assert.equal(second.coverage.processCountersComplete, true);
    assert.deepEqual(second.processes.map(row => row.pid), first.processes.map(row => row.pid));
    for (const row of second.processes) {
      const before = first.processes.find(prior => prior.pid === row.pid);
      assert.equal(row.startIdentity, before.startIdentity);
      assert(row.cpuTimeMs > before.cpuTimeMs, 'busy workload must increase cumulative self CPU');
      assert(row.memoryBytes > before.memoryBytes + 16 * 1024 * 1024, 'touched private allocation must grow the OS memory metric');
    }
    phase = 'middle exit';
    await command('middle', 'exit');
    await waitFor(observed => observed.some(event => event.mode === 'middle' && event.event === 'exit' && event.code === 0));
    let reparented;
    const deadline = Date.now() + 5000;
    do { await delay(40); reparented = await sample(); }
    while (Date.now() < deadline && !reparented.processes.some(row => row.pid === pids.leaf && (process.platform === 'win32' ? !reparented.processes.some(other => other.pid === pids.middle) : row.parentPid !== pids.middle)));
    const leaf = reparented.processes.find(row => row.pid === pids.leaf);
    assert(leaf && (process.platform === 'win32' || leaf.parentPid !== pids.middle));
    assert.equal(leaf.startIdentity, first.processes.find(row => row.pid === pids.leaf).startIdentity);
    assert(!reparented.processes.some(row => row.pid === pids.middle));
    assert.equal(reparented.coverage.processCountersComplete, true);
    assert.equal((await events()).some(event => event.mode === 'leaf' && event.event === 'exit'), false);
    phase = 'root exit';
    await command('root', 'exit');
    await exitedRoot;
    const surviving = await sample();
    assert.equal(surviving.coverage.rootState, 'exited');
    assert.equal(surviving.coverage.processCountersComplete, true);
    assert.equal(surviving.processes.find(row => row.pid === pids.leaf)?.startIdentity, leaf.startIdentity);
    phase = 'leaf exit';
    await command('leaf', 'exit');
    await waitFor(observed => observed.some(event => event.mode === 'leaf' && event.event === 'exit' && event.code === 0));
    let ended;
    const exitDeadline = Date.now() + 5000;
    do { await delay(30); ended = await sample(); } while (ended.processes.length && Date.now() < exitDeadline);
    assert.deepEqual(ended.processes, []);
    assert.equal(ended.coverage.rootState, 'exited');
    assert.equal(ended.coverage.processCountersComplete, true);
    assert((await events()).filter(event => event.event === 'exit').every(event => event.code === 0));
    t.diagnostic(JSON.stringify({ evidence: 'native collector smoke only, not product A/B', processCount: first.processes.length,
      memoryMetric: collector.memoryMetric, cpuDeltaMs: second.processes.map(row => row.cpuTimeMs - first.processes.find(prior => prior.pid === row.pid).cpuTimeMs),
      memoryGrowthBytes: second.processes.map(row => row.memoryBytes - first.processes.find(prior => prior.pid === row.pid).memoryBytes),
      sampleDurationMs: [first.sampleDurationMs, second.sampleDurationMs], gpuBytes: first.gpuBytes,
      gpuCoverage: first.coverage.issues.filter(item => item.scope === 'gpu') }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, events: await events(), lastSample, stderr: stderr.join('') }));
    throw error;
  }
});
