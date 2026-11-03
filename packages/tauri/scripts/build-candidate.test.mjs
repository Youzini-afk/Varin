import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { discoverCef, engineInventory } from './build-candidate.mjs';
import { pinnedCefLicense } from './cef-license.mjs';

test('the pinned Tauri CLI prepares release builds without rewriting committed manifests', async t => {
  if (spawnSync('cargo', ['--version'], { windowsHide: true }).status !== 0) {
    t.skip('The CLI preparation check requires Cargo metadata, but does not compile or download dependencies');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tauri-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, '../src-tauri'), native = path.join(root, 'src-tauri');
  await fs.mkdir(path.join(native, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'frontend'));
  await fs.writeFile(path.join(root, 'frontend/index.html'), '<!doctype html><title>Prepare</title>');
  const originals = new Map();
  for (const name of ['Cargo.toml', 'Cargo.lock', 'tauri.conf.json', 'build.rs']) {
    const bytes = await fs.readFile(path.join(source, name));
    originals.set(name, bytes);
    await fs.writeFile(path.join(native, name), bytes);
  }
  await fs.cp(path.join(source, 'vendor'), path.join(native, 'vendor'), { recursive: true });
  await fs.writeFile(path.join(native, 'src/main.rs'), 'fn main() {}\n');
  await fs.writeFile(path.join(native, 'src/lib.rs'), '');
  // The actual CLI owns preparation and feature normalization. Node replaces
  // only the compiler, and a receipt proves preparation reached that boundary.
  await fs.writeFile(path.join(native, 'build'), `require('node:fs').writeFileSync('runner.json', JSON.stringify(process.argv.slice(2))); process.exit(86);\n`);
  const require = createRequire(new URL('../package.json', import.meta.url));
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const result = spawnSync(process.execPath, [cli, 'build', '--no-bundle', '--ci', '--features', 'desktop',
    '--runner', process.execPath, '--config', JSON.stringify({ build: { frontendDist: '../frontend' }, bundle: { active: false, resources: [] } })], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_HOME: path.join(root, 'cargo-home'), CARGO_TARGET_DIR: path.join(root, 'target') },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'The preparation probe must stop before a real native build');
  const runner = await fs.readFile(path.join(native, 'runner.json'), 'utf8').catch(error => {
    throw new Error(`CLI did not reach the no-build runner: ${result.stdout}\n${result.stderr}`, { cause: error });
  });
  assert.ok(JSON.parse(runner).includes('--release'));
  for (const [name, original] of originals) {
    assert.deepEqual(await fs.readFile(path.join(native, name)), original, `${name} changed during CLI preparation`);
  }
});

test('retains the pinned CEF license when the upstream downloader omits it and rejects drift', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-cef-license-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = await pinnedCefLicense(root);
  const bytes = await fs.readFile(original);
  assert.match(bytes.toString('utf8'), /Redistribution and use in source and binary forms/);
  await fs.copyFile(original, path.join(root, 'LICENSE.txt'));
  assert.equal(await pinnedCefLicense(root), original);
  await fs.appendFile(path.join(root, 'LICENSE.txt'), 'changed');
  await assert.rejects(pinnedCefLicense(root), /differs from the pinned/);
});

test('candidate discovery accepts only the official target/version receipt', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-cef-discovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lock=JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json',import.meta.url),'utf8'));
  for(const [target,pin] of Object.entries(lock.targets)) {
    const [platform,architecture]=target.split('-');
    await fs.writeFile(path.join(root,'archive.json'),JSON.stringify({name:`cef_binary_${lock.version}_${pin.upstream}_minimal.tar.bz2`,type:'minimal',sha1:pin.sha1}));
    assert.equal(await discoverCef(root,platform,architecture),root);
    await assert.rejects(discoverCef(root,platform,architecture==='x64'?'arm64':'x64'),/receipt/);
  }
  await fs.writeFile(path.join(root,'archive.json'),JSON.stringify({name:'different',type:'minimal',sha1:'0'.repeat(40)}));
  await assert.rejects(discoverCef(root,'linux','x64'),/receipt/);
});
test('upgraded SDK discovery follows the pinned versioned cache and rejects old or non-minimal SDKs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-cef-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json', import.meta.url), 'utf8'));
  for (const [target, pin] of Object.entries(lock.targets)) {
    const [platform, architecture] = target.split('-');
    const receipt = { name: `cef_binary_${lock.version}_${pin.upstream}_minimal.tar.bz2`, type: 'minimal', sha1: pin.sha1 };
    const cache = path.join(root, target);
    const suffix = `cef_${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'}_${architecture === 'x64' ? 'x86_64' : 'aarch64'}`;
    const sdk = path.join(cache, lock.version.split('+')[0], suffix);
    await fs.mkdir(sdk, { recursive: true });
    // A stale root receipt must not mask download-cef's new versioned generation.
    await fs.writeFile(path.join(cache, 'archive.json'), JSON.stringify({ ...receipt, name: receipt.name.replace(lock.version, '154.0.34+g14c5a08+chromium-154.0.8037.98') }));
    await assert.rejects(discoverCef(cache, platform, architecture), /receipt/);
    await fs.writeFile(path.join(sdk, 'archive.json'), JSON.stringify({ ...receipt, type: 'standard' }));
    await assert.rejects(discoverCef(cache, platform, architecture), /receipt/);
    await fs.writeFile(path.join(sdk, 'archive.json'), JSON.stringify({ ...receipt, sha1: '0'.repeat(40) }));
    await assert.rejects(discoverCef(cache, platform, architecture), /receipt/);
    await fs.writeFile(path.join(sdk, 'archive.json'), JSON.stringify(receipt));
    assert.equal(await discoverCef(cache, platform, architecture), sdk);
  }
});
test('engine receipts hash actual bytes and permit only contained framework links', {skip:process.platform==='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-engine-inventory-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'app');await fs.mkdir(path.join(dir,'runtime'),{recursive:true});
  await fs.writeFile(path.join(dir,'engine'),'first');await fs.writeFile(path.join(dir,'runtime','host'),'excluded');
  await fs.symlink('engine',path.join(dir,'framework-link'));
  const first=await engineInventory(dir,{exclude:'runtime'});assert.deepEqual(first.map(f=>f.path),['engine','framework-link']);
  await fs.writeFile(path.join(dir,'engine'),'changed');
  assert.notEqual((await engineInventory(dir,{exclude:'runtime'}))[0].sha256,first[0].sha256);
  await fs.writeFile(path.join(root,'outside'),'outside');await fs.symlink('../outside',path.join(dir,'external-link'));
  await assert.rejects(engineInventory(dir),/external symbolic/);
});
