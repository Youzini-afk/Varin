import nodePath from 'node:path';

const TERMINAL_SHELL_IDS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'] as const;
export type TerminalShellId = typeof TERMINAL_SHELL_IDS[number];
export type TerminalShellPreference = 'auto' | TerminalShellId;
const TERMINAL_SHELL_ID_SET = new Set<string>(TERMINAL_SHELL_IDS);

export const normalizeTerminalShell = (value: unknown): TerminalShellPreference | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'auto' || TERMINAL_SHELL_ID_SET.has(normalized)
    ? normalized as TerminalShellPreference
    : null;
};

export const shellIdFromPath = (value: unknown): TerminalShellId | null => {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const id = filename.endsWith('.exe') ? filename.slice(0, -4) : filename;
  return TERMINAL_SHELL_ID_SET.has(id) ? id as TerminalShellId : null;
};

const SHELL_LABELS: Partial<Record<TerminalShellId, string>> = { pwsh: 'PowerShell (pwsh)', powershell: 'Windows PowerShell', cmd: 'Command Prompt' };
const shellLabel = (id: TerminalShellId): string => SHELL_LABELS[id] ?? id;

export const getTerminalShellLoginArgs = (executable: unknown, platform: NodeJS.Platform = process.platform): string[] | null => {
  const id = shellIdFromPath(executable);
  if (id === 'bash' || id === 'zsh' || id === 'ksh') return ['-l'];
  if (id === 'fish' || id === 'nu') return ['--login'];
  if (id === 'pwsh' && platform !== 'win32') return ['-Login'];
  return null;
};

export interface TerminalShellResolverDependencies {
  purpose?: 'terminal' | 'agent';
  buildAugmentedPath?: (() => string) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fs: { promises: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    readlink?(path: string): Promise<string>;
    readdir?(path: string): Promise<string[]>;
  } };
  isExecutable(path: string): boolean;
  path: { join(...parts: string[]): string };
  platform?: NodeJS.Platform | undefined;
  searchPathFor(name: string, searchPath: string): string | null;
}

export interface TerminalShellDescriptor {
  executable: string | null;
  id: TerminalShellPreference;
  name: string;
  supportsLogin: boolean;
}

export const createTerminalShellResolver = ({ fs, path, searchPathFor, isExecutable, buildAugmentedPath = () => env.PATH || '', platform = process.platform, env = process.env, purpose = 'terminal' }: TerminalShellResolverDependencies) => {
  // One shallow inventory per request. No shell is started to discover installed programs.
  const prepare = async () => {
    const searchPath = buildAugmentedPath();
    const reads = new Map<string, Promise<string | null>>();
    const isWslLauncher = (candidate: string) => platform === 'win32' && /[\\/](System32|Sysnative)[\\/]bash\.exe$/i.test(candidate);
    const executableAt = (candidate: string): Promise<string | null> => {
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      let read = reads.get(key);
      if (!read) {
        read = (async () => {
          if (isWslLauncher(candidate)) return null;
          if (isExecutable(candidate)) return candidate;
          if (platform === 'win32' && fs.promises.readlink) {
            try {
              // App Execution Aliases can fail stat with EACCES while readlink exposes
              // the installed executable. Pass that real path to the native PTY owner.
              const target = nodePath.win32.resolve(nodePath.win32.dirname(candidate), await fs.promises.readlink(candidate));
              if (!isWslLauncher(target) && isExecutable(target)) return target;
            } catch { /* Absent or broken candidate. */ }
          }
          return null;
        })();
        reads.set(key, read);
      }
      return read;
    };
    const resolveExecutable = async (candidate: unknown): Promise<string | null> => {
      if (!candidate) return null;
      const value = String(candidate);
      if (value.includes('/') || value.includes('\\')) return executableAt(value);
      if (platform === 'win32' && shellIdFromPath(value)) {
        const filename = value.toLowerCase().endsWith('.exe') ? value : `${value}.exe`;
        for (const directory of searchPath.split(';').filter(Boolean)) {
          const found = await executableAt(path.join(directory.replace(/^"(.*)"$/, '$1'), filename));
          if (found) return found;
        }
      }
      const found = searchPathFor(value, searchPath);
      if (found) return executableAt(found);
      return executableAt(value);
    };
    const resolveCandidates = async (candidates: unknown[]): Promise<string[]> => {
      const resolved = await Promise.all(candidates.map(resolveExecutable));
      const seen = new Set<string>();
      return resolved.filter((candidate): candidate is string => {
        if (!candidate) return false;
        const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const installed: string[] = [];
    const gitBash: string[] = [];
    if (platform === 'win32') {
      const roots = [...new Set([
        env.ProgramW6432, env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'],
        ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs')] : []),
      ].filter((root): root is string => Boolean(root)))];
      for (const root of roots) {
        gitBash.push(path.join(root, 'Git', 'bin', 'bash.exe'));
        const directory = path.join(root, 'PowerShell');
        installed.push(path.join(directory, 'pwsh.exe'));
        try {
          const versions = await fs.promises.readdir?.(directory) ?? [];
          versions.sort((a, b) => Number(/preview/i.test(a)) - Number(/preview/i.test(b)) || b.localeCompare(a, 'en', { numeric: true }));
          installed.push(...versions.map(version => path.join(directory, version, 'pwsh.exe')));
        } catch { /* This installation location is absent or not readable. */ }
      }
      if (env.LOCALAPPDATA) installed.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
      // Git may be installed outside Program Files (including portable installs).
      // Follow Git's layout rather than mistaking System32/bash.exe (WSL) for Git Bash.
      const git = searchPathFor('git.exe', searchPath);
      if (git) {
        const parent = nodePath.win32.dirname(git);
        const root = nodePath.win32.basename(parent).toLowerCase() === 'cmd' || nodePath.win32.basename(parent).toLowerCase() === 'bin'
          ? nodePath.win32.dirname(parent) : nodePath.win32.resolve(parent, '..', '..');
        gitBash.unshift(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
      }
    }
    const defaults = platform === 'win32'
      ? [env.VARIN_TERMINAL_SHELL, env.SHELL, ...(purpose === 'agent' ? gitBash : []), 'pwsh.exe', ...installed, 'powershell.exe',
        path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), env.ComSpec, 'cmd.exe']
      : [env.VARIN_TERMINAL_SHELL, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];
    return { defaults, gitBash, resolveCandidates };
  };

  const list = async (): Promise<TerminalShellDescriptor[]> => {
    const { defaults, gitBash, resolveCandidates } = await prepare();
    let configuredShells: string[] = [];
    if (platform !== 'win32') {
      try {
        const contents = await fs.promises.readFile('/etc/shells', 'utf8');
        configuredShells = contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      } catch {
        // PATH and platform defaults below remain authoritative fallbacks.
      }
    }

    const candidates = platform === 'win32'
      ? [...defaults, ...gitBash, ...TERMINAL_SHELL_IDS]
      : [env.VARIN_TERMINAL_SHELL, env.SHELL, ...configuredShells, ...TERMINAL_SHELL_IDS, '/bin/zsh', '/bin/bash', '/bin/sh'];
    const autoExecutable = (await resolveCandidates(defaults))[0] ?? null;
    const byId = new Map<TerminalShellPreference, TerminalShellDescriptor>([
      ['auto', {
        id: 'auto',
        name: 'Auto',
        executable: autoExecutable,
        supportsLogin: Boolean(autoExecutable && getTerminalShellLoginArgs(autoExecutable, platform)),
      }],
    ]);
    for (const executable of await resolveCandidates(candidates)) {
      const id = shellIdFromPath(executable);
      if (id && !byId.has(id)) {
        const git = platform === 'win32' && id === 'bash' && gitBash.some(candidate => candidate.toLowerCase() === executable.toLowerCase());
        byId.set(id, { id, name: git ? 'Git Bash' : shellLabel(id), executable, supportsLogin: Boolean(getTerminalShellLoginArgs(executable, platform)) });
      }
    }
    return [...byId.values()];
  };

  const resolve = async (preference: unknown): Promise<{ id: TerminalShellPreference; executables: string[] }> => {
    const normalized = normalizeTerminalShell(preference ?? 'auto');
    if (!normalized) throw new Error('Invalid terminal shell');
    if (normalized === 'auto') {
      const { defaults, resolveCandidates } = await prepare();
      return { id: 'auto', executables: await resolveCandidates(defaults) };
    }
    const selected = (await list()).find((shell) => shell.id === normalized);
    if (!selected) throw new Error(`Terminal shell "${normalized}" is not available`);
    return { id: selected.id, executables: selected.executable ? [selected.executable] : [] };
  };

  return { list, resolve };
};
