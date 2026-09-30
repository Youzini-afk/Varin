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
  software?: Record<string, { state: 'installed' | 'failed'; at: number; detail?: string; packages?: string[] }>;
}

export interface LinuxSoftwareResult {
  id: string;
  state: 'installed' | 'failed';
  detail?: string;
  packages?: string[];
}

export function createLinuxDesktop(options: { dataDir: string; driverDir: string; platform: string; exec?: VmExec }) {
  const data = join(options.dataDir, 'computer-desktop');
  const script = join(options.driverDir, 'linux', 'desktop.py');
  const installer = join(options.driverDir, 'linux', 'install-components.py');
  let operation: Promise<LinuxDesktopState> | undefined;
  let installOperation: Promise<LinuxSoftwareResult[]> | undefined;
  const software = async (): Promise<NonNullable<LinuxDesktopState['software']>> => {
    let text: string;
    try { text = await readFile(join(data, 'software.status.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    const body = JSON.parse(text) as { results?: unknown };
    if (!Array.isArray(body.results)) throw new HarnessServiceError('unavailable', 'Software install state is malformed');
    const result: NonNullable<LinuxDesktopState['software']> = {};
    for (const entry of body.results) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string'
        || !['installed', 'failed'].includes(entry.state) || !Number.isSafeInteger(entry.at)
        || (entry.packages !== undefined && (!Array.isArray(entry.packages) || !entry.packages.every((pkg: unknown) => typeof pkg === 'string')))) {
        throw new HarnessServiceError('unavailable', 'Software install state contains an invalid component');
      }
      result[entry.id] = { state: entry.state, at: entry.at,
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
        ...(entry.packages ? { packages: entry.packages } : {}) };
    }
    return result;
  };
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
    return { ...state, software: await software() };
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
    async install(spec: { groups?: string[]; packages?: string[] }): Promise<LinuxSoftwareResult[]> {
      if (options.platform !== 'linux') throw new HarnessServiceError('unavailable', 'Component install requires a Linux environment');
      const groups = spec.groups ?? [];
      const packages = spec.packages ?? [];
      if (groups.length === 0 && packages.length === 0) {
        throw new HarnessServiceError('invalid-params', 'install requires at least one component group or package');
      }
      for (const value of [...groups, ...packages]) {
        if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9+._:-]*$/u.test(value)) {
          throw new HarnessServiceError('invalid-params', `invalid component or package name: ${String(value)}`);
        }
      }
      // Serialize apt, but each request installs its own components.
      const previous = installOperation;
      const pending = (async (): Promise<LinuxSoftwareResult[]> => {
        await previous?.catch(() => undefined);
        const args = [installer, '--data-dir', data,
          ...groups.flatMap((group) => ['--group', group]),
          ...packages.flatMap((pkg) => ['--package', pkg])];
        const result = await execute('/usr/bin/python3', args);
        const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1);
        let payload: { ok?: boolean; error?: string; results?: LinuxSoftwareResult[] } | undefined;
        try { payload = JSON.parse(lastLine ?? '') as typeof payload; } catch { /* detail below */ }
        if (!payload?.results?.length || !payload.results.every((entry) => typeof entry.id === 'string'
          && ['installed', 'failed'].includes(entry.state))) {
          throw new HarnessServiceError('unavailable', payload?.error || result.stderr.trim() || 'Component installer returned no result');
        }
        return payload.results;
      })();
      installOperation = pending;
      try { return await pending; } finally { if (installOperation === pending) installOperation = undefined; }
    },
    async driverSpec(): Promise<DriverSpawnSpec> {
      const current = await status();
      if (current.state !== 'running') throw new HarnessServiceError('unavailable', current.detail ?? `Desktop is ${current.state}`);
      const asUser = process.getuid?.() === 0 && current.uid !== 0;
      return { command: asUser ? 'runuser' : '/usr/bin/python3', args: asUser ? ['-u', current.user!, '--', '/usr/bin/python3', current.driver!] : [current.driver!],
        env: { ...process.env, ...current.environment } };
    },
    async dispose() { await Promise.allSettled([operation, installOperation]); },
  };
}
