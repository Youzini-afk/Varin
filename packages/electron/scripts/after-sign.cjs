const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helperArtifact = require('../../computer-driver/windows/helper-artifact.cjs');

// electron-builder may sign nested executables during signApp. Record the
// digest only now, after the final signing bytes, and explicitly include the
// Computer helper in the same publisher configuration as the main executable.
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const directory = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@varin', 'web', 'server', 'computer-driver', 'windows');
  const executable = path.join(directory, helperArtifact.EXECUTABLE);
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const signingConfigured = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.WINDOWS_CSC_LINK
    || context.packager.forceCodeSigning
    || context.packager.platformSpecificBuildOptions?.signtoolOptions?.certificateSha1
    || context.packager.platformSpecificBuildOptions?.signtoolOptions?.certificateFile
    || context.packager.platformSpecificBuildOptions?.signtoolOptions?.certificateSubjectName
    || context.packager.platformSpecificBuildOptions?.signtoolOptions?.sign
    || context.packager.platformSpecificBuildOptions?.azureSignOptions);
  if (signingConfigured) {
    if (typeof context.packager.signIf !== 'function') throw new Error('Windows publisher signing is configured but the Computer helper signing hook is unavailable');
    await context.packager.signIf(executable);
  }
  const bytes = fs.readFileSync(executable);
  const architecture = process.env.VARIN_TARGET_ARCH || process.arch;
  helperArtifact.inspectExecutable(bytes, architecture);
  manifest.sha256 = helperArtifact.digest(bytes);
  manifest.signature = helperArtifact.readSignature(executable);
  if ((signingConfigured || process.env.VARIN_COMPUTER_REQUIRE_SIGNATURE === '1') && manifest.signature.status !== 'valid') {
    throw new Error('The release Computer helper is not publisher-signed');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  helperArtifact.verifyHelper(directory, { architecture, version: context.packager.appInfo.version,
    requireSignature: signingConfigured || process.env.VARIN_COMPUTER_REQUIRE_SIGNATURE === '1' });
  // Exercise the exact unpacked path with no source directory or compiler on PATH.
  if (architecture === process.arch) execFileSync(process.env.VARIN_PACKAGING_NODE || process.execPath,
    [path.resolve(__dirname, '../../computer-driver/windows/smoke-helper.mjs'), directory], { stdio: 'inherit', windowsHide: true });
};
