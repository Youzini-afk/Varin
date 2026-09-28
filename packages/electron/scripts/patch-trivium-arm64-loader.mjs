import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const defaultWebManifest = fileURLToPath(new URL('../../web/package.json', import.meta.url));
const oldWindowsBranch = "if (platform === 'win32') { nativeBinding = require('./triviumdb.win32-x64-msvc.node'); }";
const arm64WindowsBranch = "if (platform === 'win32' && arch === 'arm64') { nativeBinding = require('./triviumdb.win32-arm64-msvc.node'); }\n  " + oldWindowsBranch;

/** TriviumDB 0.8.8 publishes an x64-only Windows loader even when an ARM64 addon
 * is present. Patch the installed dependency after preparing the ARM64 addon.
 * The explicit manifest also lets current release automation repair an older tag. */
export function patchTriviumArm64Loader(webManifest = defaultWebManifest) {
  const webRequire = createRequire(path.resolve(webManifest));
  const packageRoot = path.dirname(webRequire.resolve('triviumdb/package.json'));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageInfo.version !== '0.8.8') {
    throw new Error(`TriviumDB ARM64 loader repair expects 0.8.8, found ${packageInfo.version}`);
  }
  const addon = path.join(packageRoot, 'triviumdb.win32-arm64-msvc.node');
  if (!fs.existsSync(addon)) throw new Error(`TriviumDB Windows ARM64 addon is missing: ${addon}`);

  const entry = path.join(packageRoot, 'index.js');
  const current = fs.readFileSync(entry, 'utf8');
  if (!current.includes(arm64WindowsBranch)) {
    if (!current.includes(oldWindowsBranch)) {
      throw new Error('TriviumDB Windows loader changed; review its ARM64 branch before packaging');
    }
    fs.writeFileSync(entry, current.replace(oldWindowsBranch, arm64WindowsBranch));
  }
  // On a native ARM64 runner, prove the installed package now loads the addon.
  if (process.platform === 'win32' && process.arch === 'arm64') webRequire('triviumdb');
  console.log('[electron] verified TriviumDB Windows ARM64 loader');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchTriviumArm64Loader(process.argv[2] || defaultWebManifest);
}
