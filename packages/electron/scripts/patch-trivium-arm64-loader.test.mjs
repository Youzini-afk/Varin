import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { patchTriviumArm64Loader } from './patch-trivium-arm64-loader.mjs';

const originalLoader = `const { platform, arch } = process;
let nativeBinding = null;
try {
  if (platform === 'win32') { nativeBinding = require('./triviumdb.win32-x64-msvc.node'); }
  else { nativeBinding = require('./triviumdb.linux-x64-gnu.node'); }
} catch (e) { throw e; }
module.exports = nativeBinding;
`;

function loadForArchitecture(source, arch) {
  const loaded = [];
  const module = { exports: null };
  vm.runInNewContext(source, {
    process: { platform: 'win32', arch },
    module,
    require(specifier) {
      loaded.push(specifier);
      return specifier;
    },
  });
  return { loaded, binding: module.exports };
}

test('TriviumDB ARM64 loader selects exactly one native binding and repairs the earlier patch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-trivium-loader-'));
  try {
    const web = path.join(root, 'packages', 'web');
    const dependency = path.join(web, 'node_modules', 'triviumdb');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"name":"triviumdb","version":"0.8.8"}\n');
    fs.writeFileSync(path.join(dependency, 'triviumdb.win32-arm64-msvc.node'), 'fixture');
    const entry = path.join(dependency, 'index.js');

    for (const source of [
      originalLoader,
      originalLoader.replace(
        "  if (platform === 'win32')",
        "  if (platform === 'win32' && arch === 'arm64') { nativeBinding = require('./triviumdb.win32-arm64-msvc.node'); }\n  if (platform === 'win32')",
      ),
    ]) {
      fs.writeFileSync(entry, source);
      patchTriviumArm64Loader(path.join(web, 'package.json'));
      const patched = fs.readFileSync(entry, 'utf8');
      assert.deepEqual(loadForArchitecture(patched, 'arm64').loaded, ['./triviumdb.win32-arm64-msvc.node']);
      assert.deepEqual(loadForArchitecture(patched, 'x64').loaded, ['./triviumdb.win32-x64-msvc.node']);
      patchTriviumArm64Loader(path.join(web, 'package.json'));
      assert.equal(fs.readFileSync(entry, 'utf8'), patched);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
