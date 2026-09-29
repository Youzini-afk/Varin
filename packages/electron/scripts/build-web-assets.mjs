import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitWebAssetGeneration } from './commit-web-asset-generation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const electronDir = path.join(repoRoot, 'packages', 'electron');

const resourcesDir = path.join(electronDir, 'resources');
const resourcesWebDistDir = path.join(resourcesDir, 'web-dist');
const webDistDir = path.join(webDir, 'dist');

const quoteWindowsCommandArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

const run = (cmd, args, cwd) => {
  const isWindowsCommandScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const result = isWindowsCommandScript
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', ['call', quoteWindowsCommandArg(cmd), ...args.map(quoteWindowsCommandArg)].join(' ')],
        { cwd, stdio: 'inherit', windowsVerbatimArguments: true },
      )
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
};

const resolveBun = () => {
  if (typeof process.env.BUN === 'string' && process.env.BUN.trim()) {
    return process.env.BUN.trim();
  }
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['bun'], { encoding: 'utf8' });
    const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const resolved = candidates.find((entry) => /\.(exe|cmd|bat)$/i.test(entry)) || candidates[0];
    return resolved || 'bun';
  }
  const result = spawnSync('/bin/bash', ['-lc', 'command -v bun'], { encoding: 'utf8' });
  const resolved = (result.stdout || '').trim();
  return resolved || 'bun';
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const removeDir = async (target) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
};

const copyDir = async (src, dst) => {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
};

const bunExe = resolveBun();

// A local Linux package must carry the same managed VM guest assets as a
// release workflow package. Release jobs attach the already verified bundle;
// a source checkout builds it here when absent or stale.
if (process.platform === 'linux' && process.arch === 'x64') {
  const manifestPath = path.join(repoRoot, 'packages', 'computer-driver', 'linux', 'guest-bundle-x64', 'manifest.json');
  const version = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' });
  let bundled;
  try { bundled = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { /* bundle absent */ }
  if (!bundled || bundled.version !== version || bundled.sourceRevision !== revision.stdout?.trim()
    || dirty.status !== 0 || Boolean(dirty.stdout?.trim()) || bundled.sourceDirty === true) {
    console.log('[electron] building Linux x64 VM guest runtime...');
    run(process.execPath, ['scripts/build-vm-guest-bundle.mjs'], repoRoot);
  }
}

console.log('[electron] building web UI dist...');
run(bunExe, ['run', 'build:web'], repoRoot);

console.log('[electron] staging packaged resources...');
await fs.mkdir(resourcesDir, { recursive: true });
const stagedWebDistDir = await fs.mkdtemp(path.join(resourcesDir, 'web-dist-staging-'));
const backupWebDistDir = path.join(resourcesDir, `web-dist-backup-${process.pid}`);

try {
  await copyDir(webDistDir, stagedWebDistDir);
  await removeDir(backupWebDistDir);
  // Never delete the active resource generation before the candidate commits.
  // On Windows a running bundled-dev window may hold this directory open; in
  // that case rename fails while the complete previous generation remains live.
  const result = await commitWebAssetGeneration({
    activeDir: resourcesWebDistDir,
    candidateDir: stagedWebDistDir,
    backupDir: backupWebDistDir,
    rename: (src, dest) => fs.rename(src, dest),
    removeDir,
    exists: (target) => fsSync.existsSync(target),
  });

  if (!result.ok) {
    if (result.recoveryError) {
      throw new AggregateError(
        [result.error, result.recoveryError],
        `${result.error.message}; ${result.recoveryError.message}`,
      );
    }
    throw result.error;
  }

  if (result.backupCleanupWarning) {
    console.warn(`[electron] ${result.backupCleanupWarning}`);
  }
} catch (error) {
  await removeDir(stagedWebDistDir).catch(() => undefined);
  throw error;
}

console.log(`[electron] web assets ready: ${resourcesWebDistDir}`);
