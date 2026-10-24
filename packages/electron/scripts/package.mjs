import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import { prepareRipgrep } from '../../../scripts/prepare-ripgrep.mjs';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const builderArgs = process.argv.slice(2);
const unsignedMacIndex = builderArgs.indexOf('--varin-unsigned-mac');
const unsignedMac = unsignedMacIndex >= 0;
if (unsignedMac) builderArgs.splice(unsignedMacIndex, 1);
const requestedPlatforms = new Set();
for (const argument of builderArgs) {
  if (argument === '--win' || argument.startsWith('--win=')) requestedPlatforms.add('win32');
  if (argument === '--linux' || argument.startsWith('--linux=')) requestedPlatforms.add('linux');
  if (argument === '--mac' || argument.startsWith('--mac=')) requestedPlatforms.add('darwin');
}
if (requestedPlatforms.size > 1) throw new Error(`Exactly one Electron target platform is required, got: ${[...requestedPlatforms].join(', ')}.`);
const targetPlatform = [...requestedPlatforms][0] || process.platform;
const targetArchitecture = resolveTargetArchitecture({ platform: targetPlatform, environment: env, builderArgs });
const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
env.VARIN_TARGET_ARCH = targetArchitecture.node;
env.VARIN_TARGET_PLATFORM = targetPlatform;
env.VARIN_PACKAGING_NODE = process.execPath;
prepareRipgrep({ platform: targetPlatform, arch: targetArchitecture.node, stage: path.join(electronDir, 'resources', 'tools') });

if (!builderArgs.some((argument) => argument.startsWith('--config.electronVersion='))) {
  builderArgs.push(`--config.electronVersion=${electronVersion}`);
}

if (process.platform === 'win32' && env.WINDOWS_CSC_LINK && !env.WIN_CSC_LINK) {
  env.WIN_CSC_LINK = env.WINDOWS_CSC_LINK;
}

if (process.platform === 'win32' && env.WINDOWS_CSC_KEY_PASSWORD && !env.WIN_CSC_KEY_PASSWORD) {
  env.WIN_CSC_KEY_PASSWORD = env.WINDOWS_CSC_KEY_PASSWORD;
}

if (process.platform === 'win32' && !env.CSC_LINK && !env.WIN_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

if (unsignedMac) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  builderArgs.push('--config=scripts/electron-builder.unsigned-mac.cjs');
  console.log('[electron] macOS code signing and notarization disabled for this package.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  process.platform === 'win32' ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (process.platform === 'win32' ? 'bun.exe' : 'bun');

execFileSync(process.execPath, [path.join(electronDir, 'scripts', 'prepare-native-runtime.mjs')], {
  cwd: electronDir, env, stdio: 'inherit', windowsHide: true,
});

execFileSync(process.execPath, [
  path.resolve(electronDir, '..', '..', 'scripts', 'build-kernel.mjs'),
  '--stage',
  path.join(electronDir, 'resources', 'kernel'),
  '--platform',
  targetPlatform,
  '--arch',
  targetArchitecture.node,
], {
  cwd: electronDir,
  env,
  stdio: 'inherit',
});

if (targetPlatform === 'linux' && !builderArgs.some((argument) => (
  argument === '--x64' || argument === '--arm64' || argument === '--arch' || argument.startsWith('--arch=')
))) {
  builderArgs.push(`--${targetArchitecture.electronBuilder}`);
}

if (process.platform === 'darwin') {
  const compiledIconAssets = path.join(electronDir, 'resources', 'icons', 'Assets.car');
  if (fs.existsSync(compiledIconAssets) && fs.statSync(compiledIconAssets).size > 0) {
    console.log(`[electron] using versioned macOS icon assets at ${compiledIconAssets}`);
  } else {
    execFileSync(process.execPath, [path.join(electronDir, 'scripts', 'generate-macos-icon-assets.cjs')], {
      cwd: electronDir,
      env,
      stdio: 'inherit',
    });
  }
}

const child = spawn(bunBinary, ['x', 'electron-builder', ...builderArgs], {
  cwd: electronDir,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
