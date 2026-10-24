import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { augmentPathWithBundledRipgrep } from './bundled-tools.js';
import { mergePathValues, pathLooksUserConfigured } from './path-utils.js';

type Environment = Record<string, string | undefined>;

const normalizeEnvironmentPath = (environment: Environment): string => {
  if (typeof environment.PATH === 'string') return environment.PATH;
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path');
  return typeof entry?.[1] === 'string' ? entry[1] : '';
};

const parseNullSeparatedEnvironment = (raw: unknown): Environment | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const environment: Environment = {};
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  if (Object.keys(environment).length === 0) return null;
  const environmentPath = normalizeEnvironmentPath(environment);
  if (environmentPath) environment.PATH = environmentPath;
  return environment;
};

export const createPlatformEnvironmentRuntime = (options: {
  fsModule?: typeof fs;
  osModule?: typeof os;
  pathModule?: typeof path;
  processLike?: Pick<NodeJS.Process, 'platform' | 'env'>;
  spawnSyncFn?: typeof spawnSync;
} = {}) => {
  const processLike = options.processLike ?? process;
  const fsModule = options.fsModule ?? fs;
  const osModule = options.osModule ?? os;
  const pathModule = options.pathModule ?? path;
  const runSpawnSync = options.spawnSyncFn ?? spawnSync;
  let cachedShellEnvironment: Environment | null | undefined;
  let resolvedGitBinary: string | null = null;

  const isExecutable = (filePath: unknown): filePath is string => {
    if (typeof filePath !== 'string' || !filePath.trim()) return false;
    try {
      const stat = fsModule.statSync(filePath);
      if (!stat.isFile()) return false;
      if (processLike.platform === 'win32') return true;
      fsModule.accessSync(filePath, fsModule.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const executableNames = (name: string): string[] => {
    if (processLike.platform !== 'win32' || pathModule.extname(name)) return [name];
    const extensions = String(processLike.env.PATHEXT || processLike.env.PathExt || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean);
    return [...extensions.map((extension) => `${name}${extension.startsWith('.') ? extension : `.${extension}`}`), name];
  };

  const searchPathFor = (binaryName: unknown, searchPath = normalizeEnvironmentPath(processLike.env)): string | null => {
    const name = typeof binaryName === 'string' ? binaryName.trim() : '';
    if (!name) return null;
    for (const directory of String(searchPath || '').split(pathModule.delimiter).filter(Boolean)) {
      for (const candidateName of executableNames(name)) {
        const candidate = pathModule.join(directory, candidateName);
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  };

  const getWindowsShellEnvironment = (): Environment | null => {
    const script = [
      // This private probe returns a UTF-8 protocol. It does not configure user terminals.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
      '$entries = [ordered]@{}',
      'Get-ChildItem Env: | ForEach-Object { $entries[$_.Name] = $_.Value }',
      "$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Process')) | Where-Object { $_ }",
      "if ($paths.Count -gt 0) { $entries['Path'] = ($paths -join ';') }",
      "$entries.GetEnumerator() | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }",
    ].join('; ');
    const candidates = [
      'pwsh.exe',
      'powershell.exe',
      pathModule.join(processLike.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ];
    for (const shell of candidates) {
      try {
        const result = runSpawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', script], {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        if (result.status !== 0) continue;
        const parsed = parseNullSeparatedEnvironment(result.stdout);
        if (parsed) return parsed;
      } catch {
        // Try the next installed PowerShell.
      }
    }
    return null;
  };

  const getLoginShellEnvSnapshot = (): Environment | null => {
    if (cachedShellEnvironment !== undefined) return cachedShellEnvironment;
    if (processLike.platform === 'win32') {
      cachedShellEnvironment = getWindowsShellEnvironment();
      return cachedShellEnvironment;
    }
    const candidates = [processLike.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const shell of candidates) {
      if (!isExecutable(shell)) continue;
      try {
        const result = runSpawnSync(shell, ['-lic', 'env -0'], {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        if (result.status !== 0) continue;
        const parsed = parseNullSeparatedEnvironment(result.stdout);
        if (parsed) {
          cachedShellEnvironment = parsed;
          return cachedShellEnvironment;
        }
      } catch {
        // Try the next login shell.
      }
    }
    cachedShellEnvironment = null;
    return cachedShellEnvironment;
  };

  const applyLoginShellEnvSnapshot = (): void => {
    const snapshot = getLoginShellEnvSnapshot();
    for (const [key, value] of Object.entries(snapshot ?? {})) {
      if (key.toLowerCase() === 'path' || ['PWD', 'OLDPWD', 'SHLVL', '_'].includes(key)) continue;
      if (typeof processLike.env[key] !== 'string' || processLike.env[key].length === 0) {
        processLike.env[key] = value;
      }
    }
    const augmented = buildAugmentedPath();
    if (processLike.platform === 'win32') for (const key of Object.keys(processLike.env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete processLike.env[key];
    processLike.env.PATH = augmented;
  };

  const buildAugmentedPath = (): string => {
    const currentPath = normalizeEnvironmentPath(processLike.env);
    const shellPath = normalizeEnvironmentPath(getLoginShellEnvSnapshot() ?? {});
    const currentIsUserConfigured = processLike.platform === 'win32' || pathLooksUserConfigured(currentPath, osModule.homedir(), pathModule.delimiter);
    const primary = currentIsUserConfigured ? currentPath : shellPath;
    const fallback = currentIsUserConfigured ? shellPath : currentPath;
    const environment = { PATH: mergePathValues(primary, fallback, pathModule.delimiter) };
    augmentPathWithBundledRipgrep({ env: environment, platform: processLike.platform, delimiter: pathModule.delimiter });
    return environment.PATH || '';
  };

  const resolveGitBinaryForSpawn = (): string => {
    if (processLike.platform !== 'win32') return 'git';
    if (resolvedGitBinary) return resolvedGitBinary;
    const explicit = [processLike.env.GIT_BINARY, processLike.env.VARIN_GIT_BINARY]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        resolvedGitBinary = candidate;
        return resolvedGitBinary;
      }
    }
    const fromPath = searchPathFor('git');
    if (fromPath) {
      resolvedGitBinary = fromPath;
      return resolvedGitBinary;
    }
    const roots = [processLike.env.ProgramFiles, processLike.env['ProgramFiles(x86)'], processLike.env.LocalAppData]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const root of roots) {
      for (const suffix of [
        ['Git', 'cmd', 'git.exe'],
        ['Git', 'bin', 'git.exe'],
        ['Programs', 'Git', 'cmd', 'git.exe'],
      ]) {
        const candidate = pathModule.join(root, ...suffix);
        if (isExecutable(candidate)) {
          resolvedGitBinary = candidate;
          return resolvedGitBinary;
        }
      }
    }
    resolvedGitBinary = 'git.exe';
    return resolvedGitBinary;
  };

  return {
    refresh: () => { cachedShellEnvironment = undefined; resolvedGitBinary = null; applyLoginShellEnvSnapshot(); },
    applyLoginShellEnvSnapshot,
    buildAugmentedPath,
    getLoginShellEnvSnapshot,
    isExecutable,
    resolveGitBinaryForSpawn,
    searchPathFor,
  };
};

export { parseNullSeparatedEnvironment };
