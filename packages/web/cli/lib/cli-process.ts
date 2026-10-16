import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getRunDir } from './cli-paths.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { errorMessage, recordOf, type CliNotice, type CliOptions } from './cli-types.js';

export interface StoredInstanceOptions {
  apiOnly?: boolean | undefined;
  hasUiPassword?: boolean | undefined;
  host?: string | undefined;
  launchMode?: 'daemon' | 'foreground' | undefined;
  port?: number | undefined;
  startedAt?: number | undefined;
  uiPassword?: string | undefined;
}

export type VarinProcessState = 'dead' | 'matched' | 'mismatched' | 'unknown';
type NoticeHandler = (notice: CliNotice) => void;

function assertNodeServerRuntime(): void {
  // Script workers inherit the Host executable and require Node's REPL.
  if (process.versions.bun) {
    throw new TunnelCliError('Starting Varin requires Node.js. Run this command with node instead of bun.', EXIT_CODE.USAGE_ERROR);
  }
}

async function getPidFilePath(port: number): Promise<string> {
  return path.join(getRunDir(), `varin-${port}.pid`);
}

async function getInstanceFilePath(port: number): Promise<string> {
  return path.join(getRunDir(), `varin-${port}.json`);
}

function readPidFile(pidFilePath: string): number | null {
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pidFilePath: string, pid: number, onNotice?: NoticeHandler): void {
  try {
    fs.writeFileSync(pidFilePath, String(pid), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write PID file: ${errorMessage(error)}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'PID_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removePidFile(pidFilePath: string): void {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch {
    // Best-effort operation; continue when it is unavailable.
  }
}

function readInstanceOptions(instanceFilePath: string): StoredInstanceOptions | null {
  try {
    const value = recordOf(JSON.parse(fs.readFileSync(instanceFilePath, 'utf8')));
    return {
      ...(typeof value.port === 'number' ? { port: value.port } : {}),
      ...(typeof value.host === 'string' ? { host: value.host } : {}),
      ...(value.launchMode === 'foreground' || value.launchMode === 'daemon' ? { launchMode: value.launchMode } : {}),
      ...(typeof value.uiPassword === 'string' ? { uiPassword: value.uiPassword } : {}),
      ...(typeof value.hasUiPassword === 'boolean' ? { hasUiPassword: value.hasUiPassword } : {}),
      ...(typeof value.apiOnly === 'boolean' ? { apiOnly: value.apiOnly } : {}),
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    };
  } catch {
    return null;
  }
}

function writeInstanceOptions(
  instanceFilePath: string,
  options: Pick<CliOptions, 'apiOnly' | 'host' | 'port' | 'uiPassword'> & {
    launchMode?: 'daemon' | 'foreground';
    startedAt?: number;
  },
  onNotice?: NoticeHandler,
): void {
  try {
    const toStore = {
      port: options.port,
      host: typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined,
      launchMode: options.launchMode === 'foreground' ? 'foreground' : 'daemon',
      uiPassword: typeof options.uiPassword === 'string' ? options.uiPassword : undefined,
      hasUiPassword: typeof options.uiPassword === 'string',
      apiOnly: options.apiOnly === true,
      startedAt: Number.isFinite(options.startedAt) ? options.startedAt : Date.now(),
    };
    fs.writeFileSync(instanceFilePath, JSON.stringify(toStore, null, 2), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write instance file: ${errorMessage(error)}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'INSTANCE_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removeInstanceFile(instanceFilePath: string): void {
  try {
    if (fs.existsSync(instanceFilePath)) {
      fs.unlinkSync(instanceFilePath);
    }
  } catch {
    // Best-effort operation; continue when it is unavailable.
  }
}

// Liveness only — "is *some* process alive with this PID". Use this when the
// PID is known to be ours (a child we just spawned, or a process we are
// stopping). Do NOT use it to validate a PID read from a pid file: after an
// ungraceful shutdown the pid file is stale and the kernel may have recycled
// that PID to an unrelated process — see isVarinProcessRunning.
function isProcessRunning(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort command line for a live PID, used for identity verification.
// Returns the cmdline string, '' when the process has no readable cmdline, or
// null when identity can't be determined on this platform (caller falls back to
// liveness — so behaviour is unchanged where we can't check).
function readProcessCmdline(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/cmdline is a NUL-delimited argv list.
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const out = (result.stdout || '').trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    return null;
  }
  // Windows / other: a process's full command line isn't cheaply available, so
  // we can't verify identity — fall back to liveness-only.
  return null;
}

function isVarinCmdline(cmdline: unknown): boolean {
  if (typeof cmdline !== 'string' || cmdline.length === 0) {
    return false;
  }
  const normalized = cmdline.toLowerCase().replace(/\\/g, '/');
  if (normalized.includes('/@varin/web/')) {
    return true;
  }
  return [
    '/packages/web/bin/cli.js',
    '/packages/web/server/index.js',
  ].some((entry) => {
    const entryIndex = normalized.indexOf(entry);
    return entryIndex >= 0 && normalized.lastIndexOf('/varin/', entryIndex) >= 0;
  });
}

// Liveness + identity — "is the Varin instance recorded in a pid file
// still the process running under this PID". Use this (not isProcessRunning)
// when validating a PID read from a pid file. After an ungraceful shutdown
// removePidFile never runs, so the stale PID can be recycled to an unrelated
// process; a liveness-only check then reports us as "already running" and aborts
// startup, which loops forever under systemd Restart=always (issue #1721).
// Where identity can't be determined (Windows, unreadable /proc or ps), we fall
// back to liveness so there are no false negatives on those platforms.
function isVarinProcessRunning(pid: unknown): boolean {
  const state = getVarinProcessState(pid);
  return state === 'matched' || state === 'unknown';
}

function getVarinProcessState(pid: unknown, options: {
  isProcessRunning?: (pid: number) => boolean;
  readProcessCmdline?: (pid: number) => string | null;
} = {}): VarinProcessState {
  const checkProcessRunning = typeof options.isProcessRunning === 'function'
    ? options.isProcessRunning
    : isProcessRunning;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0 || !checkProcessRunning(pid)) {
    return 'dead';
  }

  const readCmdline = typeof options.readProcessCmdline === 'function'
    ? options.readProcessCmdline
    : readProcessCmdline;
  const cmdline = readCmdline(pid);
  if (cmdline === null) {
    return 'unknown';
  }
  return isVarinCmdline(cmdline) ? 'matched' : 'mismatched';
}

function hasVarinRuntimeInfo(info: unknown): info is { pid?: number | null; runtime: string } {
  const value = recordOf(info);
  return typeof value.runtime === 'string' && value.runtime.length > 0;
}

function waitForProcessExit(pid: unknown, timeoutMs: number): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve(true);
  }

  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (!isProcessRunning(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

export interface ProcessStopOptions {
  forceTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  shutdownWaitMs?: number;
}

async function terminateProcessTree(pid: unknown, options: ProcessStopOptions = {}): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const gracefulTimeoutMs = typeof options.gracefulTimeoutMs === 'number' && Number.isFinite(options.gracefulTimeoutMs) && options.gracefulTimeoutMs >= 0
    ? Math.trunc(options.gracefulTimeoutMs)
    : 2500;
  const forceTimeoutMs = typeof options.forceTimeoutMs === 'number' && Number.isFinite(options.forceTimeoutMs) && options.forceTimeoutMs >= 0
    ? Math.trunc(options.forceTimeoutMs)
    : 3000;

  if (process.platform === 'win32') {
    try {
      process.kill(pid);
    } catch {
    // Best-effort operation; continue when it is unavailable.
  }

    if (await waitForProcessExit(pid, 800)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
    // Best-effort operation; continue when it is unavailable.
  }

    if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
    // Best-effort operation; continue when it is unavailable.
  }

    return waitForProcessExit(pid, forceTimeoutMs);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Best-effort operation; continue when it is unavailable.
  }

  if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
    return true;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort operation; continue when it is unavailable.
  }

  return waitForProcessExit(pid, forceTimeoutMs);
}

async function stopInstanceProcess(pid: unknown, options: ProcessStopOptions = {}): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const shutdownWaitMs = typeof options.shutdownWaitMs === 'number' && Number.isFinite(options.shutdownWaitMs) && options.shutdownWaitMs >= 0
    ? Math.trunc(options.shutdownWaitMs)
    : 5000;

  if (await waitForProcessExit(pid, shutdownWaitMs)) {
    return true;
  }

  return terminateProcessTree(pid, options);
}


export {
  assertNodeServerRuntime,
  getPidFilePath,
  getInstanceFilePath,
  readPidFile,
  writePidFile,
  removePidFile,
  readInstanceOptions,
  writeInstanceOptions,
  removeInstanceFile,
  isProcessRunning,
  isVarinCmdline,
  isVarinProcessRunning,
  getVarinProcessState,
  hasVarinRuntimeInfo,
  terminateProcessTree,
  stopInstanceProcess,
};
