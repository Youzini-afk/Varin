const fs = require('node:fs');
const path = require('node:path');

// Both packages ship several platforms in one npm archive. Keep the current
// engine and the one-time WAL checkpoint helper, each with its target addon.
module.exports = function pruneTriviumRuntime(modulesRoot, platform, architecture) {
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : '';
  const binary = `triviumdb.${platform}-${architecture}${suffix}.node`;
  const roots = ['triviumdb', 'triviumdb-upgrade-0.8'].map(name => path.join(modulesRoot, name));
  for (const root of roots) {
    if (!fs.statSync(path.join(root, binary), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing target TriviumDB binary: ${path.join(root, binary)}`);
    }
  }
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith('.node') && name !== binary) fs.rmSync(path.join(root, name));
    }
  }
};
