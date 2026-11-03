/** Own only new disposable benchmark workers. A stop acknowledgement is not an
 * exit: wait for the real process, retain forced cleanup as a failed outcome. */
import { fork, execFile } from 'node:child_process';
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
  const force = async () => {
    // A root exit is not a descendant exit. Retain the original collector and
    // original detached process group until forced cleanup is observed too.
    const before = collector ? await collector.sample() : null;
    if (!exited || before?.processes.length) {
      if (process.platform === 'win32') {
        await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (!exited) await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Forced fixture exit remains unobserved')), 10000).unref())]);
    }
    if (collector) {
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        const sample = await collector.sample();
        if (!sample.processes.length && sample.coverage.rootState === 'exited' && sample.coverage.processCountersComplete) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Forced fixture process-tree drain remains unobserved; keep its private directory');
    }
  };

  try {
    await once(child, 'spawn');
    collector = await createProcessCollector({ rootPid: child.pid });
    const started = await request('start', { configuration });
    const startup = await collector.sample();
    return { pid: child.pid, startup, origin: started.origin, credentials: started.credentials, request,
      sample: () => collector.sample(),
      async stop() {
        let receipt, forced = false;
        try {
          receipt = (await request('inspect')).receipt;
          await collector.sample();
          await request('stop');
          await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture owner acknowledged stop but process did not exit')), 10000).unref())]);
          const final = await collector.sample();
          if (exitResult.code !== 0 || final.processes.length || final.coverage.rootState !== 'exited' || !final.coverage.processCountersComplete) throw new Error('Fixture owner process tree did not drain');
          return { receipt, exit: exitResult, drained: true, forced, final };
        } catch (error) { forced = true; try { await force(); } catch (cleanupError) { throw Object.assign(cleanupError, { cleanupUncertain: true }); } throw Object.assign(error, { fixtureCleanup: { receipt, exit: exitResult, drained: false, forced } }); }
        finally { await collector.close(); }
      },
    };
  } catch (error) { try { await force(); } catch (cleanupError) { throw Object.assign(cleanupError, { cleanupUncertain: true }); } finally { await collector?.close(); } throw error; }
}
