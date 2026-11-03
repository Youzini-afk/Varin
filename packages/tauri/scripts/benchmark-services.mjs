/** Own only new disposable benchmark workers. Await the original owner's stop
 * and direct process exit; retain private data when either remains uncertain. */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessCollector } from './benchmark-processes.mjs';
const worker = fileURLToPath(new URL('./benchmark-fixture-service.mjs', import.meta.url));
export function isolatedEnvironment(root, runtime, manifest) {
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, VARIN_DATA_DIR: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    VARIN_KERNEL_PATH: path.join(runtime, manifest.kernel.executable), VARIN_RG_PATH: path.join(runtime, manifest.tools.ripgrep) };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'VARIN_SERVER_URL', 'VARIN_SKIP_LOCAL_SERVER', 'VARIN_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  return env;
}
export async function startFixtureWorker({ node, env, configuration, timeoutMs = 60000 }) {
  const child = fork(worker, ['--fixture-worker'], { execPath: node, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32' });
  const pending = new Map(); let serial = 0, exited = false, exitResult;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true; exitResult = { code, signal }; resolve(exitResult);
    for (const entry of pending.values()) entry.reject(new Error('Fixture worker exited before its owner acknowledged the operation'));
    pending.clear();
  }));
  child.on('message', message => { const entry = pending.get(message?.id); if (!entry) return; pending.delete(message.id); message.ok ? entry.resolve(message) : entry.reject(new Error(message.error?.message ?? 'Fixture worker operation failed')); });
  child.on('error', error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); });
  const request = (command, fields = {}) => new Promise((resolve, reject) => {
    if (exited || !child.connected) return reject(new Error('Fixture worker is not connected'));
    const id = serial++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture ${command} did not finish within its observation budget`)); }, timeoutMs);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.send({ id, command, ...fields }, error => { if (error) { const entry = pending.get(id); pending.delete(id); entry?.reject(error); } });
  });
  let collector;
  const retainUnresolved = (error, { receipt, ownerStopAcknowledged = false, final } = {}) => {
    // A sampled empty table cannot prove that a descendant did not fork/detach
    // between observations. Never signal a reusable numeric PID or process
    // group to manufacture a cleanup receipt after the original owner failed.
    if (child.pid) {
      error.cleanupUncertain = true;
      error.fixtureCleanup = { receipt, pid: child.pid, exit: exitResult ?? null,
        drained: false, forced: false, ownerStopAcknowledged,
        observedCounterScopeEmpty: !!final && !final.processes.length && final.coverage?.rootState === 'exited',
        termination: 'not-attempted-without-launch-bound-process-scope' };
      // Keep the actual worker and its private data intact. Do not keep this
      // reporting controller alive solely through an unresolved child's IPC.
      child.unref(); child.channel?.unref();
    }
    return error;
  };

  try {
    await once(child, 'spawn');
    collector = await createProcessCollector({ rootPid: child.pid });
    const started = await request('start', { configuration });
    const startup = await collector.sample();
    return { pid: child.pid, startup, origin: started.origin, credentials: started.credentials, request,
      sample: () => collector.sample(),
      async stop() {
        let receipt, final, ownerStopAcknowledged = false;
        try {
          receipt = (await request('inspect')).receipt;
          await collector.sample();
          await request('stop'); ownerStopAcknowledged = true;
          await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture owner acknowledged stop but process did not exit')), 10000).unref())]);
          final = await collector.sample();
          if (exitResult.code !== 0 || final.processes.length || final.coverage.rootState !== 'exited' || !final.coverage.processCountersComplete) throw new Error('Fixture owner process tree did not drain');
          // The fixture's original stop protocol awaits its actual owner (the
          // Host rejects incomplete native shutdown), then its direct process
          // exits. The counter table is supporting observation, not that proof.
          await collector.close();
          return { receipt, exit: exitResult, drained: true, forced: false, ownerStopAcknowledged, final };
        } catch (error) {
          retainUnresolved(error, { receipt, ownerStopAcknowledged, final });
          try { await collector.close(); } catch { /* Preserve the original failure and unresolved owner. */ }
          throw error;
        }
      },
    };
  } catch (error) {
    retainUnresolved(error);
    try { await collector?.close(); } catch { /* Preserve cleanup uncertainty on the original setup error. */ }
    throw error;
  }
}
