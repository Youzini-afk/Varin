const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const { detectKernelBinaryIdentity } = require('../../../scripts/kernel-binary-identity.cjs');
const builder = createRequire(require.resolve('electron-builder'));
const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar');

/** Verify the packaged artifact, not the checkout's (possibly full) resources. */
module.exports = function verifyLightPayload({ appOutDir, electronPlatformName, arch, packager }) {
  const app = electronPlatformName === 'darwin' ? path.join(appOutDir, packager.appInfo.productFilename + '.app', 'Contents') : null;
  const root = app ? path.join(app, 'Resources') : path.join(appOutDir, 'resources');
  const archive = path.join(root, 'app.asar');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  const architecture = ({ 1: 'x64', 3: 'arm64' })[arch];
  if (!architecture || manifest.name !== 'varin-light' || manifest.varinDistribution?.role !== 'light'
    || manifest.varinDistribution.platform !== electronPlatformName || manifest.varinDistribution.architecture !== architecture) {
    throw new Error('Light application role, platform or architecture mismatch');
  }
  const executable = app ? path.join(app, 'MacOS', packager.appInfo.productFilename)
    : path.join(appOutDir, electronPlatformName === 'win32' ? packager.appInfo.productFilename + '.exe' : 'varin-light');
  // Only the executable header is needed, not the entire Electron binary.
  const header = Buffer.alloc(4096), fd = fs.openSync(executable, 'r');
  let binary;
  try { binary = detectKernelBinaryIdentity(header.subarray(0, fs.readSync(fd, header, 0, header.length, 0))); }
  finally { fs.closeSync(fd); }
  if (binary.platform !== electronPlatformName || binary.arch !== architecture) throw new Error('Light Electron executable architecture mismatch');
  const entries = new Set(asar.listPackage(archive).map(name => name.replaceAll('\\', '/')));
  for (const name of ['/bootstrap.mjs', '/dist-bundle/main.mjs', '/dist-bundle/preload.mjs']) {
    if (!entries.has(name)) throw new Error(`Light desktop is missing ${name}`);
  }
  for (const name of entries) {
    if (/(?:^|\/)node_modules\/(?:@varin|puppeteer-core|triviumdb)(?:\/|$)/u.test(name) || /\.node$/u.test(name)) {
      throw new Error(`Unexpected Host or native runtime in light archive: ${name}`);
    }
  }
  for (const name of ['kernel', 'tools', 'server', 'computer-driver', 'workspace-component']) {
    if (fs.existsSync(path.join(root, name))) throw new Error(`Unexpected light package resource: ${name}`);
  }
  for (const name of ['web-dist/index.html', 'web-dist/companion-catalog.json', 'icons/icon.png', ...(electronPlatformName === 'win32' ? ['icons/icon.ico'] : []), ...(app ? ['Assets.car'] : []), 'legal/LICENSE', 'legal/THIRD_PARTY_NOTICES.md']) {
    if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Light desktop is missing ${name}`);
  }
  for (const name of ['companion-assets', 'companion-review-director']) {
    if (fs.existsSync(path.join(root, 'web-dist', name))) throw new Error('Optional artwork entered light package');
  }
};
