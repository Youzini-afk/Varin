#!/usr/bin/env node
/**
 * Build helper for the Application Host.
 *
 * Compiles packages/web/application-host to a staging directory, then
 * atomically replaces packages/web/server with the staged output. Development
 * launchers can instead request a private generation so a running or stale
 * Host never has to release packages/web/server before the next Host starts.
 *
 * Application Host source is TypeScript. Non-code assets (templates and
 * runtime fixtures) are copied as-is after compilation.
 *
 * On failure, the staging directory is removed and the existing server/
 * is left untouched. On success, the old server/ is replaced.
 */

import { pruneLegacyHostArtifacts } from '../../../scripts/host-production-boundary.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const webRoot = path.join(repoRoot, 'packages', 'web');
const sourceDir = path.join(webRoot, 'application-host');
const devOutputArg = process.argv.indexOf('--dev-output');
const devOutputName = devOutputArg >= 0 ? process.argv[devOutputArg + 1] : null;
if (devOutputArg >= 0 && (!devOutputName || !/^\.application-host-dev-\d+$/.test(devOutputName))) {
  throw new Error('--dev-output requires a private .application-host-dev-<pid> directory name');
}
const outputDir = devOutputName
  ? path.join(webRoot, devOutputName)
  : path.join(webRoot, 'server');

const log = (message) => process.stdout.write(`[build:application-host] ${message}\n`);

const removeGeneratedOutputs = () => {
  const targets = [
    outputDir,
    path.join(webRoot, '.application-host-build'),
    path.join(webRoot, '.application-host-types'),
    // Staged Computer Use driver assets (BC9) — copied from packages/computer-driver.
    path.join(webRoot, 'computer-driver'),
  ];
  for (const entry of fs.readdirSync(webRoot, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.application-host-staging-')
      || entry.name.startsWith('.application-host-dev-')
      || entry.name.startsWith('.application-host-types-staging-')
      || entry.name.startsWith('.application-host-types-backup-')
      || entry.name.startsWith('.server-backup-')
    ) {
      targets.push(path.join(webRoot, entry.name));
    }
  }
  for (const target of targets) {
    if (path.dirname(target) !== webRoot) throw new Error(`Refusing to clean outside Web package: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
};

if (process.argv.includes('--clean')) {
  removeGeneratedOutputs();
  log('Generated Application Host outputs removed.');
  process.exit(0);
}

// ── Step 1: Compile to a staging directory ───────────────────────────────

const stagingDir = path.join(webRoot, `.application-host-staging-${process.pid}`);
const buildDir = devOutputName ? outputDir : stagingDir;

const cleanBuildDir = () => {
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

try {
  // A private development generation is compiled in place. Production builds
  // still compile to staging before swapping the public server/ directory.
  cleanBuildDir();

  // Run tsc with a unique outDir to avoid concurrent build conflicts.
  // Use process.execPath (node) to run tsc.js directly — avoids both
  // cmd.exe and bun path resolution issues on Windows.
  const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const configPath = path.join(webRoot, 'tsconfig.application-host.json');
  log('Refreshing structure runtime wasm...');
  const copyRuntime = spawnSync(process.execPath, [path.join(webRoot, 'scripts', 'copy-structure-runtime.mjs')], {
    cwd: webRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (copyRuntime.status !== 0) {
    throw new Error(`copy-structure-runtime exited with status ${copyRuntime.status}`);
  }

  log('Compiling application-host to staging directory...');
  const tscResult = spawnSync(process.execPath, [
    tscJs,
    '-p', configPath,
    '--outDir', buildDir,
  ], {
    cwd: webRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (tscResult.status !== 0) {
    const errMsg = tscResult.stderr?.toString() ?? tscResult.error?.message ?? 'unknown error';
    throw new Error(`tsc exited with status ${tscResult.status}: ${errMsg}`);
  }

  // ── Step 2: Copy non-JS/TS runtime assets ─────────────────────────────
  // Some files in application-host are not JS/TS but are needed at runtime
  // (e.g., HTML templates, static fixtures). Copy them to staging.
  const copyAssets = (srcDir, destDir) => {
    if (!fs.existsSync(srcDir)) return;
    // Local inference is an explicitly installed component. Cached development
    // model weights must not enter a normal Host build or desktop installer.
    if (srcDir === path.join(sourceDir, 'lib', 'knowledge', 'semantic', 'runtime')) return;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      // Skip test files
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.ts')) continue;
      if (entry.name.endsWith('.md')) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyAssets(srcPath, destPath);
      } else {
        // Copy runtime assets; TypeScript emits JavaScript and declarations.
        const ext = path.extname(entry.name);
        if (ext !== '.js' && ext !== '.ts' && ext !== '.mjs' && ext !== '.mts' && ext !== '.cjs' && ext !== '.cts' && ext !== '.d.ts' && ext !== '.d.ts.map' && ext !== '.js.map') {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  };
  copyAssets(sourceDir, buildDir);

  // ── Step 2b: Stage Computer Use driver assets ─────────────────────────
  // Compiled code lives at <gen>/lib/computer/driver-host.js; its driver-dir
  // resolution walks up four levels to <webRoot>/computer-driver. Stage the
  // real driver scripts there so dev generations, production server/, and
  // packaged installs all resolve the same layout — not the source checkout.
  const driverSource = path.join(repoRoot, 'packages', 'computer-driver');
  const driverDest = path.join(webRoot, 'computer-driver');
  const copyDriverAssets = (srcDir, destDir) => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      // Development-only helpers never ship to a runtime/driver install.
      if (entry.name === 'check-syntax.ps1' || entry.name === 'smoke.ps1') continue;
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyDriverAssets(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };
  if (fs.existsSync(driverSource)) {
    fs.rmSync(driverDest, { recursive: true, force: true });
    fs.mkdirSync(driverDest, { recursive: true });
    copyDriverAssets(driverSource, driverDest);
    log('Staged computer-driver assets.');
  }

  // ── Step 3: Validate staging ───────────────────────────────────────────
  const indexJs = path.join(buildDir, 'index.js');
  if (!fs.existsSync(indexJs)) {
    throw new Error('Staging directory does not contain index.js');
  }
  const indexDeclaration = path.join(buildDir, 'index.d.ts');
  const publicContract = path.join(buildDir, 'public-contract.js');
  if (!fs.existsSync(indexDeclaration) || !fs.existsSync(publicContract)) {
    throw new Error('Staging directory does not contain the typed public Host contract');
  }

  const boundary = pruneLegacyHostArtifacts(buildDir);
  log(`Production boundary: ${boundary.runtimeModules} reachable modules; ${boundary.removedArtifacts} legacy/test artifacts excluded.`);
  log(`${devOutputName ? 'Development generation' : 'Staging'} complete: ${buildDir}`);

  // ── Step 4: Publish the compiled generation ─────────────────────────────
  // Development runs use a private generation. Rebuilding packages/web/server
  // in place is unsafe on Windows because an earlier Host (or an indexer) can
  // retain a directory handle and make the otherwise valid rename fail with
  // EPERM. The private generation is disposable and leaves server/ untouched.
  if (devOutputName) {
    log('Build complete.');
    process.exit(0);
  }

  // Production/package builds keep the atomic server/ replacement contract.
  // On Windows, we can't atomically rename over an existing directory.
  // Strategy: rename old server/ to a backup, rename staging to server/,
  // then remove the backup. If the rename fails, restore the backup.
  const backupDir = path.join(webRoot, `.server-backup-${process.pid}`);

  // Remove any existing backup
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* */ }

  if (fs.existsSync(outputDir)) {
    fs.renameSync(outputDir, backupDir);
  }

  try {
    fs.renameSync(stagingDir, outputDir);
    log(`Replaced ${outputDir}`);
    // Clean up backup
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* */ }
  } catch (renameError) {
    // Restore backup if rename failed
    if (fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, outputDir); } catch { /* */ }
    }
    throw new Error(`Failed to replace server/: ${renameError.message}`);
  }

  log('Build complete.');
} catch (error) {
  cleanBuildDir();
  log(`Build failed: ${error.message}`);
  process.exit(1);
}
