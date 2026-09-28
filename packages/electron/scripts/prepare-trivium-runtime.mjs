import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { detectKernelBinaryIdentity, normalizeKernelArchitecture } = require('../../../scripts/kernel-binary-identity.cjs');
const VERSION = '0.8.8';
const COMMIT = 'f4bdfe35e9a3b7c0587da798886ce29380976cfe';
const TARGET = 'aarch64-pc-windows-msvc';
const BINARY = 'triviumdb.win32-arm64-msvc.node';
const RECIPE = 1;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
const assertTarget = (file) => {
  const identity = detectKernelBinaryIdentity(fs.readFileSync(file));
  if (identity.platform !== 'win32' || identity.arch !== 'arm64') {
    throw new Error(`TriviumDB build produced ${identity.platform}/${identity.arch}, expected win32/arm64.`);
  }
};

export function prepareTriviumRuntime() {
  const platform = process.env.VARIN_TARGET_PLATFORM || process.platform;
  const architecture = normalizeKernelArchitecture(process.env.VARIN_TARGET_ARCH || process.arch);
  if (platform !== 'win32' || architecture !== 'arm64') return;
  const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
  const packageRoot = path.dirname(webRequire.resolve('triviumdb/package.json'));
  const installedVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  if (installedVersion !== VERSION) {
    throw new Error(`TriviumDB source recipe is for ${VERSION}, but the installed package is ${installedVersion}.`);
  }
  const cache = path.join(os.homedir(), '.cache', 'varin-native', `triviumdb-${COMMIT}-windows-arm64-r${RECIPE}`);
  const payload = path.join(cache, 'payload', BINARY);
  const receiptPath = path.join(cache, 'receipt.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cached = receipt?.commit === COMMIT && receipt?.recipe === RECIPE && receipt?.version === VERSION
    && receipt?.target === TARGET && fs.existsSync(payload) && receipt.sha256 === sha256(payload);
  if (!cached) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-triviumdb-'));
    try {
      const source = path.join(temporary, 'source');
      run('git', ['init', source], temporary);
      run('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/YoKONCy/TriviumDB.git', COMMIT], temporary);
      run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD'], temporary);
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      if (revision !== COMMIT) throw new Error(`Unexpected TriviumDB source revision: ${revision}`);
      const targetDirectory = path.join(temporary, 'target');
      run('cargo', [
        'build', '--locked', '--release', '--lib', '--features', 'nodejs',
        '--package', 'triviumdb', '--target', TARGET, '--target-dir', targetDirectory,
      ], source);
      const built = path.join(targetDirectory, TARGET, 'release', 'triviumdb.dll');
      assertTarget(built);
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.copyFileSync(built, payload);
      receipt = { version: VERSION, commit: COMMIT, recipe: RECIPE, target: TARGET, sha256: sha256(payload) };
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  assertTarget(payload);
  const destination = path.join(packageRoot, BINARY);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(payload, temporary);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`[electron] prepared TriviumDB ${VERSION} win32/arm64 from ${COMMIT}${cached ? ' (verified cache)' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareTriviumRuntime();
