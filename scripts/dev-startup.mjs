import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Development consumers may start only after their shared package exports exist.
export function waitForSuccessfulExit(child, label) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} failed (${signal ? `signal=${signal}` : `code=${code ?? 'null'}`}).`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export function waitForFirstBuildSuccess(child) {
  return new Promise((resolve, reject) => {
    const buffers = { stdout: '', stderr: '' };
    const cleanup = () => {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onOutput = (chunk, source) => {
      // Vite can split its completion line across writes. The watcher announcement
      // also occurs before a failed build, so it is not a readiness signal.
      buffers[source] = (buffers[source] + chunk.toString()).slice(-8000);
      if (/\bbuilt in\b/i.test(buffers[source])) { cleanup(); resolve(); }
    };
    const onStdout = (chunk) => onOutput(chunk, 'stdout');
    const onStderr = (chunk) => onOutput(chunk, 'stderr');
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Build watcher exited before first successful build (${signal ? `signal=${signal}` : `code=${code ?? 'null'}`}).`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitUntilStopped(isAlive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) await delay(25);
  return !isAlive();
}

export async function stopChildTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // Killing the leader first loses taskkill's ancestry lookup. Use the same
    // tree termination command as the Electron dev launcher, before that happens.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    await waitForSuccessfulExit(killer, 'Development process tree termination');
    await waitUntilStopped(() => child.exitCode === null && child.signalCode === null, 1000);
    return;
  }

  // Every dev child owns a detached process group. A successful leader exit does
  // not prove its compiler/watch descendants stopped, so retain the original pgid.
  const pid = child.pid;
  for (const [signal, timeoutMs] of [['SIGINT', 2500], ['SIGTERM', 2500], ['SIGKILL', 1000]]) {
    if (!processGroupExists(pid)) return;
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (await waitUntilStopped(() => processGroupExists(pid), timeoutMs)) return;
  }
  // A terminated orphan may remain a zombie until the OS parent reaps it. The
  // final group SIGKILL still reaches all descendants, even after the leader exits.
}
