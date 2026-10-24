import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mergePathValues } from './path-utils.js';

const require = createRequire(import.meta.url);
const executable = (file: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
};

/** Resolves only a native CLI. Package-manager JS/WASI shims are not product tools. */
export function resolveBundledRipgrepBinDir(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  packageJsonPath?: string;
} = {}): string | null {
  const platform = options.platform ?? process.platform;
  const binary = platform === 'win32' ? 'rg.exe' : 'rg';
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = resources ? [path.join(resources, 'tools', binary)] : [];
  if (options.packageJsonPath) candidates.push(path.join(path.dirname(options.packageJsonPath), 'bin', binary));
  else {
    try {
      const fromPackage = createRequire(require.resolve('@vscode/ripgrep'));
      const resolved = fromPackage.resolve(`@vscode/ripgrep-${platform}-${options.arch ?? process.arch}/bin/${binary}`);
      candidates.push(resolved.replace(/\.asar([\\/])/, '.asar.unpacked$1'));
    } catch { /* Missing optional target package is reported by packaging verification. */ }
  }
  const found = candidates.find(file => executable(file, platform));
  return found ? path.dirname(found) : null;
}

export function augmentPathWithBundledRipgrep(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  delimiter?: string;
  resolveBinDir?: () => string | null;
} = {}): { added: boolean; binDir: string | null } {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const delimiter = options.delimiter ?? path.delimiter;
  const binDir = options.resolveBinDir ? options.resolveBinDir() : resolveBundledRipgrepBinDir({ platform });
  if (!binDir) return { added: false, binDir: null };
  const key = Object.keys(env).find(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  const current = key ? env[key] ?? '' : '';
  // Explicit user programs retain precedence; the product fills missing tools.
  const next = mergePathValues(current, binDir, delimiter);
  if (platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key];
  env.PATH = next;
  return { added: current !== next, binDir };
}
