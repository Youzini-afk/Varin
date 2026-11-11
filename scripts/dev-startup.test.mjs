import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const fixtures = `
import fs from 'node:fs';
const record = value => fs.appendFileSync(process.env.DEV_TEST_LOG, value + '\\n');
const waitFor = (file, done) => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); done(); } }, 10); };
// A graceful child may exit successfully while the supervisor is cancelling.
const stop = () => { record('stopped'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
`;

async function launch(t, mode, { fail = false, buildFail = false, buildExitCode = 9, descendant = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-dev-startup-'));
  await mkdir(path.join(directory, 'scripts'));
  await mkdir(path.join(directory, 'packages/web'), { recursive: true });
  for (const name of ['dev-startup.mjs', `dev-web-${mode}.mjs`]) {
    await copyFile(new URL(name, import.meta.url), path.join(directory, 'scripts', name));
  }
  const log = path.join(directory, 'events');
  const prepareGate = path.join(directory, 'prepare-gate');
  const buildGate = path.join(directory, 'build-gate');
  await writeFile(log, '');
  await writeFile(path.join(directory, 'leaf.mjs'), `
import fs from 'node:fs';
const record = value => fs.appendFileSync(process.env.DEV_TEST_LOG, value + '\\n');
process.on('SIGINT', () => {});
process.on('SIGTERM', () => { record('leaf-stopped'); process.exit(0); });
fs.writeFileSync(process.env.DEV_TEST_LEAF_PID, String(process.pid));
fs.writeFileSync(process.env.DEV_TEST_HEARTBEAT, String(Date.now()));
record('leaf-start');
setInterval(() => fs.writeFileSync(process.env.DEV_TEST_HEARTBEAT, String(Date.now())), 20);
`);
  await writeFile(path.join(directory, 'scripts/build-products.mjs'), fixtures + `
import { spawn } from 'node:child_process';
if (process.env.DEV_TEST_DESCENDANT === '1') spawn(process.execPath, [process.env.DEV_TEST_LEAF], { stdio: 'ignore' });
assertRuntime();
function assertRuntime() { if (process.argv[2] !== 'runtime') throw new Error('Not the runtime target'); }
record('prepare-start');
waitFor(process.env.DEV_TEST_PREPARE_GATE, () => {
  if (process.env.DEV_TEST_FAIL === '1') { record('prepare-failed'); process.exit(7); }
  fs.writeFileSync(process.env.DEV_TEST_PREPARED, 'ready');
  record('prepare-done'); process.exit(0);
});
`);
  await writeFile(path.join(directory, 'consumer.mjs'), fixtures + `
if (!fs.existsSync(process.env.DEV_TEST_PREPARED)) record('consumer-before-prepare');
const kind = process.argv.includes('build:watch') ? 'build' : process.argv.includes('vite') ? 'vite' : 'api';
record(kind + '-start');
setInterval(() => {}, 1000);
if (kind === 'build') {
  console.log('watching for file changes...');
  waitFor(process.env.DEV_TEST_BUILD_GATE, () => {
    if (process.env.DEV_TEST_BUILD_FAIL === '1') { record('build-failed'); process.exit(Number(process.env.DEV_TEST_BUILD_EXIT_CODE)); }
    process.stdout.write('✓ 2 modules transformed.\\nbui');
    setTimeout(() => { process.stdout.write('lt in 12ms.\\n'); record('build-done'); }, 20);
  });
}
`);
  // Replace only the external Bun command, not the launchers or their lifecycle.
  // Node children keep the real process/signal/stream behavior on every platform.
  const hook = path.join(directory, 'hook.mjs');
  await writeFile(hook, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (command, args, options) => command === 'bun'
  ? original(process.execPath, [${JSON.stringify(path.join(directory, 'consumer.mjs'))}, ...args], options)
  : original(command, args, options);
syncBuiltinESMExports();
process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
`);
  const child = spawn(process.execPath, ['--import', hook, path.join(directory, 'scripts', `dev-web-${mode}.mjs`)], {
    env: { ...process.env, DEV_TEST_LOG: log, DEV_TEST_PREPARE_GATE: prepareGate,
      DEV_TEST_BUILD_GATE: buildGate, DEV_TEST_PREPARED: path.join(directory, 'prepared'), DEV_TEST_FAIL: fail ? '1' : '0', DEV_TEST_BUILD_FAIL: buildFail ? '1' : '0', DEV_TEST_BUILD_EXIT_CODE: String(buildExitCode),
      DEV_TEST_DESCENDANT: descendant ? '1' : '0', DEV_TEST_LEAF: path.join(directory, 'leaf.mjs'), DEV_TEST_LEAF_PID: path.join(directory, 'leaf-pid'),
      DEV_TEST_HEARTBEAT: path.join(directory, 'heartbeat') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  const wait = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const values = await events();
      if (predicate(values)) return values;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Launcher exited before condition: ${output}`);
      await delay(10);
    }
    throw new Error(`Timed out waiting for launcher: ${output}`);
  };
  const stop = () => process.platform === 'win32' ? child.send('stop') : child.kill('SIGTERM');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) stop();
    await exited;
    if (descendant) {
      try { process.kill(Number(await readFile(path.join(directory, 'leaf-pid'), 'utf8')), 'SIGKILL'); }
      catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { child, exited, events, wait, stop,
    heartbeat: () => readFile(path.join(directory, 'heartbeat'), 'utf8'),
    prepare: () => writeFile(prepareGate, ''), build: () => writeFile(buildGate, ''), output: () => output };
}

for (const mode of ['hmr', 'full']) {
  test(`${mode}: cold preparation completes before consumers; full waits for successful build`, { timeout: 15000 }, async t => {
    const run = await launch(t, mode);
    await run.wait(events => events.includes('prepare-start'));
    await delay(50);
    assert.deepEqual(await run.events(), ['prepare-start']);
    await run.prepare();
    if (mode === 'full') {
      await run.wait(events => events.includes('build-start'));
      await delay(50);
      assert.ok(!(await run.events()).includes('api-start'), 'watch announcement is not a completed build');
      await run.build();
    }
    const events = await run.wait(events => events.includes('api-start') && events.includes(mode === 'hmr' ? 'vite-start' : 'build-done'));
    assert.ok(!events.includes('consumer-before-prepare'));
    assert.ok(events.indexOf('prepare-done') < events.indexOf('api-start'));
    if (mode === 'full') assert.ok(events.indexOf('build-done') < events.indexOf('api-start'));
  });

  test(`${mode}: preparation failure exits without launching consumers`, { timeout: 15000 }, async t => {
    const run = await launch(t, mode, { fail: true });
    await run.wait(events => events.includes('prepare-start'));
    await run.prepare();
    assert.deepEqual(await run.exited, [1, null]);
    assert.deepEqual(await run.events(), ['prepare-start', 'prepare-failed']);
    assert.match(run.output(), /Runtime dependency preparation failed \(code=7\)/);
  });

  test(`${mode}: cancellation during preparation never starts consumers`, { timeout: 15000 }, async t => {
    const run = await launch(t, mode);
    await run.wait(events => events.includes('prepare-start'));
    run.stop();
    await run.exited;
    assert.ok(!(await run.events()).some(value => /^(api|vite|build)-start$/.test(value)));
    if (process.platform !== 'win32') assert.ok((await run.events()).includes('stopped'));
  });
}

test('full: unsuccessful first build exits without starting API', { timeout: 15000 }, async t => {
  const run = await launch(t, 'full', { buildFail: true });
  await run.wait(events => events.includes('prepare-start'));
  await run.prepare();
  await run.wait(events => events.includes('build-start'));
  await run.build();
  assert.deepEqual(await run.exited, [1, null]);
  assert.ok(!(await run.events()).includes('api-start'));
});

test('full: cancellation while waiting for first build never starts API', { timeout: 15000 }, async t => {
  const run = await launch(t, 'full');
  await run.wait(events => events.includes('prepare-start'));
  await run.prepare();
  await run.wait(events => events.includes('build-start'));
  run.stop();
  await run.exited;
  assert.ok(!(await run.events()).includes('api-start'));
});

for (const mode of ['hmr', 'full']) {
  test(`${mode}: cancellation stops compiler descendants after preparation leader exits`, { timeout: 15000 }, async t => {
    const run = await launch(t, mode, { descendant: true });
    await run.wait(events => events.includes('leaf-start'));
    await delay(50);
    run.stop();
    await run.exited;
    const events = await run.events();
    if (process.platform !== 'win32') assert.ok(events.includes('stopped'), 'the preparation leader exited gracefully');
    if (process.platform !== 'win32') assert.ok(events.includes('leaf-stopped'), 'SIGTERM reaches the descendant that ignored SIGINT');
    const heartbeat = await run.heartbeat();
    await delay(80);
    assert.equal(await run.heartbeat(), heartbeat, 'compiler execution has stopped');
    assert.ok(!events.some(value => /^(api|vite|build)-start$/.test(value)));
  });
}

test('full: zero exit before first successful build is still startup failure', { timeout: 15000 }, async t => {
  const run = await launch(t, 'full', { buildFail: true, buildExitCode: 0 });
  await run.wait(events => events.includes('prepare-start'));
  await run.prepare();
  await run.wait(events => events.includes('build-start'));
  await run.build();
  assert.deepEqual(await run.exited, [1, null]);
  assert.match(run.output(), /Build watcher exited before first successful build \(code=0\)/);
  assert.ok(!(await run.events()).includes('api-start'));
});
