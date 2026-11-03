import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyInstalledCompanion, dragOriginalCompanion, startCompanionInputTask, companionSamplePhase } from './benchmark-companion.mjs';
import { productWorkloads } from './benchmark-workloads.mjs';
import { createCompanionPaintEvidence } from '../../ui/src/components/companion/paintEvidence.ts';
const digest = data => createHash('sha256').update(data).digest('hex');
test('real UI workload binds fixed catalog and requires download, selection, wake and original close', () => {
  const value = productWorkloads({ runtime: 'agent', threadId: 'test', branchId: 'branch' }, { workspace: os.tmpdir() })['companion-drag'];
  assert.equal(value.companion.files.length, 45); assert.equal(value.companion.bytes, 121431042); assert.equal(value.companion.packageCount, 550);
  assert.equal(digest(JSON.stringify(value.companion.files)), value.companion.version);
  assert.equal(value.steps.some(step => step.action === 'manual'), false);
  assert.ok(value.steps.some(step => step.selector === '[data-companion-pack="varin"] [data-companion-action="download"]'));
  assert.equal(value.steps.at(-1).owner, 'companion-closed');
});
test('original installation bytes and version must verify, not merely an installed marker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-verification-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'companions/packs/varin'); await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.from('{"synthetic-test":true}'), files = [{ path: 'bundle.json', bytes: bytes.length, sha256: digest(bytes) }];
  const expected = { id: 'varin', version: digest(JSON.stringify(files)), files, bytes: bytes.length, baseUrl: 'https://fixed-test.invalid/' };
  await fs.writeFile(path.join(directory, 'installed.json'), JSON.stringify(expected)); await fs.writeFile(path.join(directory, 'bundle.json'), bytes);
  assert.equal((await verifyInstalledCompanion(root, 'tauri', expected)).verified, true);
  await fs.writeFile(path.join(directory, 'bundle.json'), 'corrupt');
  await assert.rejects(verifyInstalledCompanion(root, 'tauri', expected), /integrity/);
  await fs.rm(path.join(directory, 'bundle.json')); await fs.symlink(path.join(directory, 'installed.json'), path.join(directory, 'bundle.json'));
  await assert.rejects(verifyInstalledCompanion(root, 'tauri', expected), /regular/);
});
test('paint evidence counts only successful owner calls, retains missing coverage and cannot be changed through a snapshot', () => {
  const owner = createCompanionPaintEvidence(); owner.enable(); owner.reset('epoch', [{ id: 'action', frames: [1,2] }, { id: 'bridge', frames: [1] }]);
  owner.decoded('atlas.png', 10, 20); owner.painted('action', 0); owner.painted('action', 0); owner.painted('missing', 0); owner.painted('action', 2);
  const result = owner.snapshot(); assert.equal(result.paints, 2); assert.equal(result.packages[0].paintedFrames, 1); assert.deepEqual(result.notCovered, ['bridge']);
  result.packages[0].paintedFrames = 100; assert.equal(owner.snapshot().packages[0].paintedFrames, 1);
  owner.released('atlas.png'); owner.close(); owner.painted('action', 1);
  assert.equal(owner.snapshot().observedLiveBitmaps, 0); assert.equal(owner.snapshot().releases, 1); assert.equal(owner.snapshot().paints, 2);
});
test('system drag targets only one geometrically matched owned window and releases pointer on failure', async t => {
  const previous = process.env.DISPLAY; process.env.DISPLAY = ':synthetic-test'; t.after(() => { if (previous === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previous; });
  const observation = { point: { x: .5, y: .5 }, bounds: { x: 1, y: 2, width: 100, height: 100 } }, calls = [];
  const run = async args => {
    calls.push(args); if (args[0] === 'search') return '123'; if (args[0] === 'getwindowpid') return '42';
    if (args[0] === 'getwindowgeometry') return 'X=1\nY=2\nWIDTH=100\nHEIGHT=100';
    if (args[0] === 'mousemove' && calls.some(call => call[0] === 'mousedown')) throw new Error('injected native movement failure');
    return '';
  };
  await assert.rejects(dragOriginalCompanion(observation, [42], { run, platform: 'linux' }), /native movement failure/);
  assert.equal(calls.at(-1)[0], 'mouseup'); assert.equal(calls.some(call => call[0] === 'windowmove'), false);
  calls.length = 0;
  await assert.rejects(dragOriginalCompanion(observation, [99], { run, platform: 'linux' }), /missing or ambiguous/);
  assert.equal(calls.some(call => call[0] === 'mousedown'), false);
});

test('owned companion input remains joinable and verification cannot be labelled idle', async () => {
  let verified, drove = false;
  const task = startCompanionInputTask({ verify: () => new Promise(resolve => { verified = resolve; }), drive: async () => { drove = true; } });
  assert.equal(companionSamplePhase({ normal: { paints: 1 } }, task.state), 'companion-verification');
  task.cancel(); assert.equal(task.state.settled, false);
  verified({ verified: true }); const result = await task.join();
  assert.equal(result.phase, 'cancelled'); assert.equal(result.settled, true); assert.equal(drove, false);
  assert.equal(companionSamplePhase({}, { phase: 'input' }), 'companion-input');
  assert.equal(companionSamplePhase({}, { phase: 'completed' }), 'companion-input');
  assert.equal(companionSamplePhase({}, { phase: 'completed' }, true), 'companion-post-input');
});

test('static readiness retains a real pre-observation paint receipt without fabricating observed frames', () => {
  const owner = createCompanionPaintEvidence(); owner.reset('epoch', [{ id: 'pose', frames: [1] }]);
  owner.painted('pose', 0); assert.equal(owner.snapshot().paints, 0);
  owner.enable(); const value = owner.snapshot();
  assert.equal(value.paints, 0); assert.equal(value.lastSuccessfulPaint.packageId, 'pose');
  assert.equal(value.lastSuccessfulPaint.source, 'original-painter-successful-commit');
  assert.deepEqual(value.notCovered, ['pose']);
  value.lastSuccessfulPaint.packageId = 'forged'; assert.equal(owner.snapshot().lastSuccessfulPaint.packageId, 'pose');
  assert.equal(companionSamplePhase({ normal: value }), 'companion-idle');
  owner.reset('next', [{ id: 'pose', frames: [1] }]); assert.equal(owner.snapshot().lastSuccessfulPaint, null);
  assert.equal(companionSamplePhase({ normal: owner.snapshot() }), 'companion-install');
});
