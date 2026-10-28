// Keep the filesystem extension's sandbox/FSKit entitlements when the enclosing
// Electron app is distribution-signed. Electron/JIT entitlements belong to its
// own binaries, not to the native filesystem executor.
const path = require('node:path');
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign.js');
module.exports = async options => {
  const original = options.optionsForFile;
  return sign({ ...options, optionsForFile: file => {
    const normalized = file.replaceAll('\\', '/');
    const value = original ? original(file) : {};
    if (normalized.includes('/VarinWorkspace.appex')) return { ...value,
      entitlements: path.resolve(__dirname, '../../workspace-driver/macos/Extension.entitlements') };
    if (normalized.includes('/VarinWorkspace.app')) return { ...value,
      entitlements: path.resolve(__dirname, '../../workspace-driver/macos/Control.entitlements') };
    return value;
  } });
};
