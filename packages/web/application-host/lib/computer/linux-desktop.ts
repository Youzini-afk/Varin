import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverSpawnSpec } from './driver-host.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { VmExec } from './vm-provider.js';

export interface LinuxDesktopState {
  state: 'unprepared' | 'starting' | 'running' | 'stopped' | 'failed';
  detail?: string;
  socket?: string;
  width?: number;
  height?: number;
  user?: string;
  uid?: number;
  driver?: string;
  artifact?: string;
  home?: string;
  environment?: Record<string, string>;
}

export function createLinuxDesktop(options: { dataDir: string; driverDir: string; platform: string; exec?: VmExec }) {
  const data = join(options.dataDir, 'computer-desktop');
  const script = join(options.driverDir, 'linux', 'desktop.py');
  let operation: Promise<LinuxDesktopState> | undefined;
  const execute: VmExec = options.exec ?? ((command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  }));
  const invoke = async (action: 'prepare' | 'start' | 'stop' | 'status', dimensions?: { width?: number; height?: number }): Promise<LinuxDesktopState> => {
    if (options.platform !== 'linux') throw new HarnessServiceError('unavailable', 'Persistent Linux desktops must be prepared on a Linux Host');
    const args = action === 'prepare' ? [join(options.driverDir, 'linux', 'prepare-desktop.sh')] : [script, action];
    args.push('--data-dir', data);
    for (const field of ['width', 'height'] as const) {
      const value = dimensions?.[field];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value <= 0) throw new HarnessServiceError('invalid-params', `${field} must be a positive integer`);
      args.push(`--${field}`, String(value));
    }
    const result = await execute(action === 'prepare' ? 'sh' : '/usr/bin/python3', args);
    const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1);
    let state: LinuxDesktopState | undefined;
    try { state = JSON.parse(lastLine ?? '') as LinuxDesktopState; } catch { /* component error below */ }
    if (!state || !['unprepared', 'starting', 'running', 'stopped', 'failed'].includes(state.state)) {
      throw new HarnessServiceError('unavailable', result.stderr.trim() || 'Desktop component returned no valid status');
    }
    if (result.code !== 0) throw new HarnessServiceError('unavailable', state.detail || result.stderr.trim() || 'Desktop preparation failed');
    if (state.state === 'running' && (typeof state.socket !== 'string' || typeof state.driver !== 'string'
      || typeof state.user !== 'string' || !Number.isSafeInteger(state.uid) || !state.environment
      || !Object.values(state.environment).every((value) => typeof value === 'string')
      || !Number.isSafeInteger(state.width) || !Number.isSafeInteger(state.height))) {
      throw new HarnessServiceError('unavailable', 'Desktop component returned incomplete session identity');
    }
    return state;
  };
  const status = async (): Promise<LinuxDesktopState> => {
    if (options.platform !== 'linux') return { state: 'unprepared' };
    try { await readFile(join(data, 'config.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'unprepared' }; throw error; }
    return invoke('status');
  };
  return {
    status,
    async change(action: 'prepare' | 'start' | 'stop', dimensions?: { width?: number; height?: number }) {
      // Concurrent Prepare clicks share the real operation. Lifecycle changes
      // follow it so stopping cannot be undone by a late setup completion.
      if (operation) { if (action === 'prepare') return operation; await operation.catch(() => {}); }
      const pending = invoke(action, dimensions);
      operation = pending;
      try { return await pending; } finally { if (operation === pending) operation = undefined; }
    },
    async driverSpec(): Promise<DriverSpawnSpec> {
      const current = await status();
      if (current.state !== 'running') throw new HarnessServiceError('unavailable', current.detail ?? `Desktop is ${current.state}`);
      const asUser = process.getuid?.() === 0 && current.uid !== 0;
      return { command: asUser ? 'runuser' : '/usr/bin/python3', args: asUser ? ['-u', current.user!, '--', '/usr/bin/python3', current.driver!] : [current.driver!],
        env: { ...process.env, ...current.environment } };
    },
    async dispose() { await operation?.catch(() => {}); },
  };
}
