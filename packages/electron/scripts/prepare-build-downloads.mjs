import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isComplete, main as ensureElectron } from './ensure-electron.mjs';
import { downloadBuildAsset, temporaryDownloadFailure } from '../../../scripts/download-build-asset.mjs';

// Release automation may live in a second checkout; dependencies still belong
// to the accepted source in the working directory.
const require = createRequire(path.resolve('packages/electron/package.json'));
const builder = createRequire(require.resolve('electron-builder'));
const library = createRequire(builder.resolve('app-builder-lib'));
const downloads = library('./util/electronGet');

// Prepare network dependencies before expensive builds/tests. Use the builder's
// pinned checksums, shared cache and transport retries, including for Electron's
// install.js (whose own downloader does not share those retry settings).
if (process.env.PREPARE_ELECTRON === 'true') {
  console.log('[desktop-downloads] Preparing Electron');
  const packageDir = path.dirname(require.resolve('electron/package.json'));
  const version = require('electron/package.json').version;
  const checksums = require('electron/checksums.json');
  // The lockfile already authenticates Electron's published checksum table.
  // Seed the builder's supported offline-checksum format: otherwise it fetches
  // SHASUMS256.txt again even for a cached, byte-for-byte identical ZIP.
  const cache = downloads.defaultElectronGetCacheRoot();
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, `SHASUMS256.txt-${version}`),
    Object.entries(checksums).map(([file, hash]) => `${hash} *${file}\n`).join(''));
  if (!isComplete(packageDir)) {
    await downloads.downloadElectronArtifactZip({
      version, platformName: process.platform, arch: process.arch, artifactName: 'electron',
      electronDownload: { checksums, downloader: { download: downloadBuildAsset } },
    });
  }
  if (await ensureElectron([], { ...process.env, VARIN_ELECTRON_PKG_DIR: packageDir }) !== 0) throw new Error('Electron binary preparation failed');
}
if (process.env.PREPARE_TOOLS === 'true') {
  // Toolsets expose their pinned release/filename/checksum but no Downloader
  // option. On a transport failure seed their documented archive-cache location,
  // then let the original loader verify and extract the archive as usual.
  const original = downloads.downloadBuilderToolset;
  downloads.downloadBuilderToolset = async options => {
    try { return await original(options); }
    catch (error) {
      if (!temporaryDownloadFailure(error)) throw error;
      const { releaseName, filenameWithExt, githubOrgRepo = 'electron-userland/electron-builder-binaries', overrideUrl } = options;
      const base = overrideUrl ? `${overrideUrl}/` : `${downloads.getBinariesMirrorUrl(githubOrgRepo)}${releaseName}/`;
      await downloadBuildAsset(`${base}${filenameWithExt}`,
        path.join(downloads.getCacheDirectory({ allowEnvVarOverride: true }), releaseName, filenameWithExt));
      return original(options);
    }
  };
  try {
    console.log('[desktop-downloads] Preparing archive tools');
    await library('./toolsets/7zip').getPath7za();
    if (process.platform === 'win32') {
      const { getMakeNsisPath, getNsisPluginsPath, getRceditBundle } = library('./toolsets/windows');
      await getMakeNsisPath();
      await getNsisPluginsPath();
      console.log('[desktop-downloads] Preparing Windows installer tools');
      await require('./scripts/prepare-installer-tool.cjs').prepare();
      if (process.env.PREPARE_PACKAGE === 'true') await getRceditBundle(require('./package.json').build.toolsets?.winCodeSign);
    } else if (process.platform === 'linux' && process.env.PREPARE_PACKAGE === 'true') {
      await library('./toolsets/linux').getAppImageTools(require('./package.json').build.toolsets?.appimage ?? '0.0.0',
        library('builder-util').Arch[process.arch]);
    }
  } finally { downloads.downloadBuilderToolset = original; }
}
