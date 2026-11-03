/** One launch-bound native owner for benchmark and acceptance tooling. A root
 * exit is not tree completion. Only its original private receipt stream may
 * authorize releasing a profile; PIDs are diagnostics/sampling, never control. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(new URL('../src-tauri/Cargo.toml', import.meta.url));
let prepared;
export function prepareNativeProcessOwner() {
  if (!['linux', 'win32'].includes(process.platform)) return Promise.reject(new Error('Launch-bound descendant ownership is unsupported on this platform'));
  prepared ??= new Promise((resolve, reject) => {
    const child = spawn('cargo', ['build', '--manifest-path', manifest, '--locked', '--no-default-features', '--features', 'process-owner', '--bin', 'varin-process-owner', '--message-format=json-render-diagnostics'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let buffer = '', executable;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.reason === 'compiler-artifact' && message.target?.name === 'varin-process-owner' && message.executable) executable = message.executable;
        } catch { /* Cargo diagnostics are not ownership receipts. */ }
      }
    });
    child.once('error', reject);
    child.once('close', code => code === 0 && executable ? resolve(executable) : reject(new Error('Native process owner could not be built')));
  }).catch(error => { prepared = undefined; throw error; });
  return prepared;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The public root-exit promise may be intentionally ignored by scope-only users.
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.sort().join(',');
function validExit(exit) {
  return fields(exit, ['code', 'signal', 'success'])
    && (exit.code === null || Number.isSafeInteger(exit.code))
    && (exit.signal === null || Number.isSafeInteger(exit.signal))
    && (exit.code === null) !== (exit.signal === null)
    && exit.success === (exit.code === 0 && exit.signal === null);
}
function deadline(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000) throw new Error(`Invalid ${label}`);
  return value;
}

/** env is the complete child environment, not an overlay. App stdin is closed;
 * app stdout/stderr are discarded by default and never mix with owner receipts.
 * helperExecutable is a separately prepared helper from the same tested source.
 * helperArgs is useful for isolated protocol tests, never sourced from app input.
 * Windows verbatim arguments are an explicit caller-owned command-line format
 * (e.g. NSIS's final unquoted /D= tail); the executable is always quoted. */
export async function launchOwned({ executable, args = [], cwd, env = process.env, nonce = randomUUID(), windowsVerbatimArguments = false }, { helperExecutable, helperArgs = [], admissionTimeoutMs = 15_000, onOutput } = {}) {
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('Launch-bound descendant ownership is unsupported on this platform');
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')
    || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))
    || typeof windowsVerbatimArguments !== 'boolean'
    || (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')))
    || typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(nonce)
    || !env || typeof env !== 'object' || Array.isArray(env)
    || Object.entries(env).some(([key, value]) => !key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid owned process launch');
  if (windowsVerbatimArguments && process.platform !== 'win32') throw new Error('Verbatim Windows arguments are unsupported on this platform');
  duration(admissionTimeoutMs, 'admission timeout');
  helperExecutable ??= await prepareNativeProcessOwner();
  const guardian = spawn(helperExecutable, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'linux' });
  const admitted = deferred(), exited = deferred(), terminal = deferred();
  let rootPid = null, rootIdentity = null, rootStartIdentity = null, rootExit = null, receipt = null, invalid = null, closed = false, pending = '';
  let phase = 'admission';
  const uncertain = reason => ({ ownershipDrainConfirmed: false, clean: false, forced: false, rootExit, reason });
  const releaseEventLoop = () => { guardian.unref(); for (const pipe of [guardian.stdin, guardian.stdout, guardian.stderr]) pipe.unref?.(); };
  const writeControl = command => new Promise(resolve => {
    if (closed || guardian.stdin.destroyed || !guardian.stdin.writable) { resolve(false); return; }
    guardian.stdin.write(JSON.stringify({ ...command, nonce }) + '\n', error => resolve(!error));
  });
  const fail = reason => {
    invalid ??= reason;
    const error = Object.assign(new Error(reason), { ownershipDrainConfirmed: false, owner });
    admitted.reject(error); exited.reject(error); terminal.resolve(uncertain(invalid));
    // Continue original-owner cleanup after failed observation. Never PID-kill
    // the helper or app, and never reinterpret later bytes as a valid receipt.
    void writeControl({ type: 'stop', forceAfterMs: 0 });
    releaseEventLoop();
  };
  const owner = {
    get rootPid() { return rootPid; },
    get rootIdentity() { return rootIdentity; },
    get rootStartIdentity() { return rootStartIdentity; },
    rootExit: exited.promise,
    async requestStop({ forceAfterMs = 1_000 } = {}) {
      duration(forceAfterMs, 'stop grace');
      return { requested: await writeControl({ type: 'stop', forceAfterMs }) };
    },
    async settle({ timeoutMs = 30_000 } = {}) {
      duration(timeoutMs, 'settlement timeout');
      await writeControl({ type: 'settle' });
      return deadline(terminal.promise, timeoutMs, () => {
        releaseEventLoop();
        return uncertain('Original process scope is still unconfirmed at the observation deadline');
      });
    },
  };
  guardian.stdin.on('error', () => { /* Close/receipt validation establishes outcome. */ });
  guardian.stderr.on('data', chunk => { if (onOutput) onOutput(chunk); });
  guardian.stdout.setEncoding('utf8');
  guardian.stdout.on('data', chunk => {
    if (invalid) return;
    pending += chunk;
    if (pending.length > 16_384) { fail('Process owner receipt exceeded its protocol bound'); return; }
    let end;
    while ((end = pending.indexOf('\n')) !== -1 && !invalid) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { fail('Process owner receipt was malformed'); break; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('Process owner receipt was not an object'); break; }
      if (value.schema !== 1 || value.nonce !== nonce) { fail('Process owner receipt identity did not match the launch'); break; }
      if (value.type === 'ready' && phase === 'admission'
        && fields(value, ['schema', 'nonce', 'type', 'rootPid', 'rootIdentity', 'rootStartIdentity'])
        && Number.isSafeInteger(value.rootPid) && value.rootPid > 0
        && typeof value.rootStartIdentity === 'string' && new RegExp(`^${process.platform}:[0-9]+$`, 'u').test(value.rootStartIdentity)
        && value.rootIdentity === `${process.platform === 'win32' ? 'windows' : 'linux'}:${nonce}:${value.rootPid}`) {
        rootPid = value.rootPid; rootIdentity = value.rootIdentity; rootStartIdentity = value.rootStartIdentity; phase = 'running'; admitted.resolve(owner);
      } else if (value.type === 'root-exit' && phase === 'running'
        && fields(value, ['schema', 'nonce', 'type', 'rootExit']) && validExit(value.rootExit)) {
        rootExit = value.rootExit; phase = 'root-exited'; exited.resolve(rootExit);
      } else if (value.type === 'settled' && phase === 'root-exited'
        && fields(value, ['schema', 'nonce', 'type', 'rootExit', 'ownershipDrainConfirmed', 'clean', 'forced', 'reason'])
        && validExit(value.rootExit) && ['code', 'signal', 'success'].every(key => value.rootExit[key] === rootExit[key])
        && value.ownershipDrainConfirmed === true && typeof value.clean === 'boolean' && typeof value.forced === 'boolean'
        && (!value.clean || (rootExit.success && !value.forced && value.reason === null))
        && (value.reason === null || typeof value.reason === 'string')) {
        receipt = { ownershipDrainConfirmed: true, clean: value.clean, forced: value.forced, rootExit, reason: value.reason };
        phase = 'settled';
      } else { fail('Process owner receipt was invalid or out of sequence'); }
    }
  });
  guardian.once('error', () => fail('Native process owner could not start'));
  guardian.once('close', (code, signal) => {
    closed = true;
    if (!invalid && receipt && !pending && code === 0 && signal === null) terminal.resolve(receipt);
    else fail('Original guardian ended without a valid complete scope receipt');
  });
  const launch = { nonce, executable, args, cwd: cwd ?? null, env, windowsVerbatimArguments };
  guardian.stdin.write(JSON.stringify(launch) + '\n', error => { if (error) fail('Process owner launch admission was not delivered'); });
  const result = await deadline(admitted.promise, admissionTimeoutMs, () => {
    fail('Process owner launch admission remained unconfirmed');
    return null;
  });
  if (!result) throw Object.assign(new Error('Process owner launch admission remained unconfirmed'), { ownershipDrainConfirmed: false, owner });
  return result;
}
