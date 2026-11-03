/** Private-profile verification and actual X11 pointer driver. Never publishes art. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyInstalledCompanion(data, shell, expected) {
  const directory = path.join(data, ...(shell === 'electron' ? ['electron-profile'] : []), 'companions', 'packs', 'varin');
  const read = async name => { const file = path.join(directory, name), stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Companion installation is not regular original-owner data'); return fs.readFile(file); };
  const installed = JSON.parse(await read('installed.json'));
  if (installed.id !== 'varin' || installed.version !== expected.version || installed.baseUrl !== expected.baseUrl
    || digest(JSON.stringify(installed.files)) !== expected.version || installed.bytes !== expected.bytes) throw new Error('Installed companion source/version differs from fixed catalog');
  for (const file of expected.files) {
    if (!/^[\w.-]+\.(png|json)$/u.test(file.path)) throw new Error('Unsafe locked asset name');
    const bytes = await read(file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Original installed companion file failed integrity verification');
  }
  return { verified: true, version: installed.version, fileCount: expected.files.length, bytes: expected.bytes };
}
export async function dragOriginalCompanion(observation, pids, { run = async args => (await execute('xdotool', args, { timeout: 10000, maxBuffer: 16384 })).stdout, platform = process.platform, signal } = {}) {
  if (platform !== 'linux' || !process.env.DISPLAY) throw new Error('System drag requires Linux X11 display and xdotool; no CDP replacement');
  const rawRun = run;
  run = async args => { signal?.throwIfAborted(); return rawRun(args); };
  const pause = async ms => { const { setTimeout } = await import('node:timers/promises'); await setTimeout(ms, undefined, { signal }); };
  const { point, bounds } = observation ?? {};
  if (!point || !bounds || ![point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || point.x <= 0 || point.x >= 1 || point.y <= 0 || point.y >= 1) throw new Error('Missing original opaque canvas hit and window geometry');
  const parse = value => Object.fromEntries(value.trim().split('\n').map(line => line.split('=')).filter(pair => pair.length === 2).map(([key, value]) => [key, Number(value)]));
  const candidates = new Set();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid original process identity');
    try { for (const id of (await run(['search', '--onlyvisible', '--pid', String(pid)])).trim().split(/\s+/u)) if (/^\d+$/u.test(id)) candidates.add(id); } catch { /* No window for this owned subprocess. */ }
  }
  const matching = [];
  for (const id of candidates) {
    const owner = Number((await run(['getwindowpid', id])).trim()); if (!pids.includes(owner)) continue;
    const geometry = parse(await run(['getwindowgeometry', '--shell', id]));
    if ([['X','x'], ['Y','y'], ['WIDTH','width'], ['HEIGHT','height']].every(([a,b]) => Math.abs(geometry[a] - bounds[b]) <= 2)) matching.push({ id, geometry });
  }
  if (matching.length !== 1) throw new Error('Original companion X11 window is missing or ambiguous; refusing another window');
  const { id, geometry: before } = matching[0];
  const x = Math.round(before.X + point.x * before.WIDTH), y = Math.round(before.Y + point.y * before.HEIGHT);
  await run(['mousemove', '--sync', String(x), String(y)]);
  // Real system hover/tap inputs retain authored timing; coverage is established
  // by the player's paint ledger, never inferred from these dispatches.
  let released = false, inputError;
  try {
    await pause(1500);
    await run(['click', '1']); await pause(1500);
    await run(['click', '--repeat', '2', '--delay', '180', '1']); await pause(1500);
    await run(['mousedown', '1']);
    for (let i = 1; i <= 8; i++) { await run(['mousemove', '--sync', String(x + i * 10), String(y + i * 5)]); await pause(100); }
  } catch (error) { inputError = error; error.pointerReleaseRequired = true; throw error; } finally { try { await rawRun(['mouseup', '1']); released = true; if (inputError) inputError.pointerReleased = true; if (signal?.aborted && signal.reason && typeof signal.reason === 'object') signal.reason.pointerReleased = true; } catch (cause) { const error = new Error('System pointer release is uncertain', { cause }); error.cleanupUncertain = true; throw error; } }
  const after = parse(await run(['getwindowgeometry', '--shell', id]));
  await pause(1200);
  const settled = parse(await run(['getwindowgeometry', '--shell', id]));
  if (Math.abs(after.X - before.X) + Math.abs(after.Y - before.Y) < 10 || after.X !== settled.X || after.Y !== settled.Y) throw new Error('Original window movement or post-release settlement was not observed');
  return { complete: true, input: 'X11-system-pointer', windowId: id, before, after, settled, released, physicalDisplayQualified: false, attemptedInputs: ['hover', 'tap', 'repeat-tap', 'drag-release'] };
}

export async function startBenchmarkWindowManager() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) throw new Error('Companion system-pointer benchmark currently requires Linux X11');
  const { spawn } = await import('node:child_process');
  await execute('xdotool', ['--version'], { timeout: 10000 });
  const version = (await execute('openbox', ['--version'], { timeout: 10000 })).stdout.trim().split('\n')[0];
  const child = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  let exit = null, failure;
  child.once('error', error => { failure = error; }); child.once('exit', (code, signal) => { exit = { code, signal }; });
  await new Promise(resolve => setTimeout(resolve, 750));
  if (failure || exit) throw new Error('Could not start owned Openbox; use a disposable X11 display without another window manager');
  return { receipt: { name: 'openbox', version, pid: child.pid, scope: 'owned-test-window-manager-not-desktop-product' },
    async stop() {
      if (!exit) child.kill('SIGTERM');
      for (let i = 0; i < 50 && !exit; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!exit) { const error = new Error('Owned Openbox did not exit'); error.cleanupUncertain = true; throw error; }
      return { pid: child.pid, exit, drained: true };
    } };
}

/** An owned task, not a fire-and-forget input operation. Sampling never awaits
 * this promise; teardown always cancels/joins it before touching product owners. */
export function startCompanionInputTask({ verify, drive }) {
  const controller = new AbortController();
  const state = { phase: 'verification', installation: null, result: null, error: null, settled: false };
  const done = (async () => {
    try {
      state.installation = await verify(controller.signal); controller.signal.throwIfAborted();
      state.phase = 'input'; state.result = await drive(controller.signal); state.phase = 'completed';
    } catch (error) { state.error = error; state.phase = controller.signal.aborted ? 'cancelled' : 'failed'; }
    finally { state.settled = true; }
    return state;
  })();
  return { state, cancel() { if (!state.settled) controller.abort(); }, join: () => done };
}
export function companionSamplePhase(observation, task, acknowledged = false) {
  if (task?.phase === 'input' || task?.phase === 'completed' && !acknowledged) return 'companion-input';
  if (task?.phase === 'verification') return 'companion-verification'; // Disk/hash work is outside the normal resource window.
  if (observation?.status === 'asset-diagnostic') return 'companion-asset-diagnostic';
  if (acknowledged || observation?.status === 'completed') return 'companion-post-input';
  return (observation?.normal?.paints > 0 || observation?.normal?.lastSuccessfulPaint?.epoch === observation?.normal?.epoch && typeof observation?.normal?.epoch === 'string') ? 'companion-idle' : 'companion-install';
}
