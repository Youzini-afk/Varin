const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

// Same checksummed 7-Zip toolset used by electron-builder. Use x86 for the x86 NSIS
// installer on both x64 and ARM64 Windows; never embed the build host's Linux/macOS tool.
const TOOLSET = {
  releaseName: '7zip@1.0.0',
  filenameWithExt: '7zip-win-ia32.tar.gz',
  checksums: {
    '7zip-win-ia32.tar.gz': 'ac3f38f96ce7498096a123bb0862dd6db863a7353c9e9e1c15f73c183adf6620',
  },
  githubOrgRepo: 'electron-userland/electron-builder-binaries',
};

async function prepare(projectDir = path.resolve(__dirname, '..')) {
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const library = createRequire(builderRequire.resolve('app-builder-lib'));
  const source = await library('./util/electronGet').downloadBuilderToolset(TOOLSET);
  const binary = await fs.readFile(path.join(source, 'bin', '7za.exe'));
  const pe = binary.readUInt32LE(0x3c);
  if (binary.subarray(0, 2).toString() !== 'MZ' || binary.readUInt32LE(pe) !== 0x4550
    || binary.readUInt16LE(pe + 4) !== 0x14c) {
    throw new Error('Installer extractor must be the pinned Windows x86 executable.');
  }
  const destination = path.join(projectDir, 'resources', 'installer-tools');
  await fs.mkdir(destination, { recursive: true });
  for (const [name, data] of [
    ['7za.exe', binary],
    ['LICENSE.txt', await fs.readFile(path.join(source, 'LICENSE.txt'))],
    ['COPYING', await fs.readFile(path.join(source, 'COPYING'))],
  ]) {
    const file = path.join(destination, name);
    if ((await fs.readFile(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))?.equals(data)) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, data);
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  await require('./build-installer-plugin.cjs').prepareInstallerUI(destination);
  return destination;
}

module.exports = async (context) => {
  if (context.electronPlatformName === 'win32') {
    await prepare(context.packager.projectDir);
  }
};
module.exports.prepare = prepare;

if (require.main === module) {
  prepare().then((directory) => console.log(`[electron] installer extractor prepared: ${directory}`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
