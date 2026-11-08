import { createRequire } from 'node:module';
import path from 'node:path';
import { isComplete, main as ensureElectron } from './ensure-electron.mjs';

// Release automation may live in a second checkout; dependencies still belong
// to the accepted source in the working directory.
const require = createRequire(path.resolve('packages/electron/package.json'));
const builder = createRequire(require.resolve('electron-builder'));
const library = createRequire(builder.resolve('app-builder-lib'));

// Prepare network dependencies before expensive builds/tests. Use the builder's
// pinned checksums, shared cache and transport retries, including for Electron's
// install.js (whose own downloader does not share those retry settings).
if (process.env.PREPARE_ELECTRON === 'true') {
  console.log('[desktop-downloads] Preparing Electron');
  const packageDir = path.dirname(require.resolve('electron/package.json'));
  if (!isComplete(packageDir)) {
    const version = require('electron/package.json').version;
    await library('./util/electronGet').downloadElectronArtifactZip({
      version, platformName: process.platform, arch: process.arch, artifactName: 'electron',
    });
  }
  if (await ensureElectron([], { ...process.env, VARIN_ELECTRON_PKG_DIR: packageDir }) !== 0) throw new Error('Electron binary preparation failed');
}
if (process.env.PREPARE_TOOLS === 'true') {
  console.log('[desktop-downloads] Preparing archive tools');
  await library('./toolsets/7zip').getPath7za();
  if (process.platform === 'win32') {
    const { getMakeNsisPath, getNsisPluginsPath } = library('./toolsets/windows');
    await getMakeNsisPath();
    await getNsisPluginsPath();
    console.log('[desktop-downloads] Preparing Windows installer tools');
    await require('./scripts/prepare-installer-tool.cjs').prepare();
  }
}
