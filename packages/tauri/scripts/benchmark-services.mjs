/** Own disposable benchmark workers through their original native scope. The
 * private application stop receipt and root exit are separate from scope drain. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createProcessCollector } from './benchmark-processes.mjs';
import { launchOwned, prepareNativeProcessOwner } from './native-process-owner.mjs';
const worker = fileURLToPath(new URL('./benchmark-fixture-service.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function isolatedEnvironment(root, runtime, manifest) {
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, VARIN_DATA_DIR: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    VARIN_KERNEL_PATH: path.join(runtime, manifest.kernel.executable), VARIN_RG_PATH: path.join(runtime, manifest.tools.ripgrep) };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'VARIN_SERVER_URL', 'VARIN_SKIP_LOCAL_SERVER', 'VARIN_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  return env;
}
export async function startFixtureWorker({ node, env, configuration, timeoutMs = 60000 }) {
  const helperExecutable = await prepareNativeProcessOwner(); // Reject unsupported platforms before a launch or private copy.
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-benchmark-control-'));
  const nonce = randomUUID();
  let owner, collector, serial = 0, exited = false, exitResult = null, ownerError = false, stopPromise;
  const request = async (command, fields = {}) => {
    if (!['start', 'inspect', 'stop'].includes(command) || exited || ownerError) throw new Error('Fixture control is unavailable');
    const id = serial++, file = path.join(control, `request-${id}.json`), temporary = `${file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, nonce, id, command, ...fields }), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    const response = path.join(control, `response-${id}.json`), deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      let value;
      try {
        const stat = await fs.lstat(response);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid fixture control receipt');
        value = JSON.parse(await fs.readFile(response, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid fixture control receipt'); }
      if (value !== undefined) {
        if (!value || value.schema !== 1 || value.nonce !== nonce || value.id !== id || value.command !== command || typeof value.ok !== 'boolean') throw new Error('Invalid fixture control receipt');
        if (!value.ok) throw new Error('The real isolated fixture owner failed its operation');
        return value;
      }
      if (exited || ownerError) throw new Error('Fixture worker exited before its original operation receipt');
      await sleep(10);
    }
    throw new Error('Fixture operation remained unconfirmed at its observation deadline');
  };
  const finish = async ({ receipt, ownerStopAcknowledged = false, failure } = {}) => {
    let scope, final, controlConfirmed = true;
    if (owner) {
      try { scope = await owner.settle({ timeoutMs: failure ? 100 : 10000 }); } catch { ownerError = true; }
      if (!scope?.ownershipDrainConfirmed) {
        try { controlConfirmed = (await owner.requestStop({ forceAfterMs: 1000 })).requested; } catch { controlConfirmed = false; }
        try { scope = await owner.settle({ timeoutMs: 10000 }); } catch { ownerError = true; }
      }
    }
    try { final = await collector?.sample(); } catch { /* Counter gaps are diagnostic, never a release proof. */ }
    let cleanupUncertain = !scope?.ownershipDrainConfirmed || ownerError || !controlConfirmed;
    try { await collector?.close(); } catch { cleanupUncertain = true; }
    const result = { receipt, pid: owner?.rootPid ?? null, exit: exitResult, ownerStopAcknowledged,
      ownershipDrainConfirmed: scope?.ownershipDrainConfirmed === true,
      drained: scope?.ownershipDrainConfirmed === true, forced: scope?.forced === true,
      clean: !failure && ownerStopAcknowledged && scope?.clean === true && exitResult?.success === true && !cleanupUncertain,
      observedCounterScopeEmpty: !!final && !final.processes.length && final.coverage?.rootState === 'exited', final };
    if (!cleanupUncertain) {
      try { await fs.rm(control, { recursive: true, force: true }); } catch { cleanupUncertain = true; }
    }
    if (failure || !result.clean || cleanupUncertain) {
      throw Object.assign(new Error('Fixture owner did not complete a clean original-scope shutdown'), {
        cleanupUncertain, fixtureCleanup: result,
        ...(cleanupUncertain ? { retainedControlDirectory: control } : {}),
      });
    }
    return result;
  };
  try {
    try {
      owner = await launchOwned({ executable: node, args: [worker, '--fixture-worker', control, nonce], env }, { helperExecutable });
    } catch (error) { owner = error.owner; ownerError = true; throw new Error('Fixture launch admission was not confirmed'); }
    owner.rootExit.then(value => { exited = true; exitResult = value; }, () => { exited = true; ownerError = true; });
    collector = await createProcessCollector();
    await collector.setRoot(owner.rootPid, owner.rootStartIdentity);
    const started = await request('start', { configuration });
    const startup = await collector.sample();
    return { pid: owner.rootPid, startup, origin: started.origin, credentials: started.credentials, request,
      sample: () => collector.sample(),
      stop() {
        stopPromise ??= (async () => {
          let receipt, ownerStopAcknowledged = false, failure;
          try { receipt = (await request('inspect')).receipt; await request('stop'); ownerStopAcknowledged = true; }
          catch (error) { failure = error; }
          return finish({ receipt, ownerStopAcknowledged, failure });
        })();
        return stopPromise;
      },
    };
  } catch (failure) { return finish({ failure }); }
}
