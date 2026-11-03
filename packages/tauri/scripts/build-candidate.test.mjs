import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { candidateConfiguration, copyMacosRuntime, discoverCef, engineInventory } from './build-candidate.mjs';
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
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtime, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'frontend/index.html'), '<!doctype html><title>Prepare</title>');
  const originals = new Map();
  for (const name of ['Cargo.toml', 'Cargo.lock', 'tauri.conf.json', 'build.rs']) {
    const bytes = await fs.readFile(path.join(source, name));
    originals.set(name, bytes);
    await fs.writeFile(path.join(native, name), bytes);
  }
  await fs.cp(path.join(source, 'vendor'), path.join(native, 'vendor'), { recursive: true });
  await fs.writeFile(path.join(native, 'src/main.rs'), 'fn main() {}\n');
  await fs.writeFile(path.join(native, 'src/lib.rs'), '');
  await fs.mkdir(path.join(native, 'src/bin'), { recursive: true });
  await fs.writeFile(path.join(native, 'src/bin/varin-process-owner.rs'), 'fn main() {}\n');
  // The actual CLI owns preparation and feature normalization. Node replaces
  // only the compiler, and a receipt proves preparation reached that boundary.
  await fs.writeFile(path.join(native, 'build'), `require('node:fs').writeFileSync('runner.json', JSON.stringify({args:process.argv.slice(2),config:JSON.parse(process.env.TAURI_CONFIG||'{}')})); process.exit(86);\n`);
  const require = createRequire(new URL('../package.json', import.meta.url));
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const result = spawnSync(process.execPath, [cli, 'build', '--no-bundle', '--ci', '--features', 'desktop',
    '--runner', process.execPath, '--config', JSON.stringify(candidateConfiguration(runtime))], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_HOME: path.join(root, 'cargo-home'), CARGO_TARGET_DIR: path.join(root, 'target') },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'The preparation probe must stop before a real native build');
  const runner = await fs.readFile(path.join(native, 'runner.json'), 'utf8').catch(error => {
    throw new Error(`CLI did not reach the no-build runner: ${result.stdout}\n${result.stderr}`, { cause: error });
  });
  const prepared = JSON.parse(runner);
  assert.ok(prepared.args.includes('--release'));
  assert.deepEqual(prepared.config.bundle.resources, process.platform==='darwin'?[]:{ [runtime + path.sep]: 'runtime/' });
  assert.equal(prepared.config.build.frontendDist, path.join(runtime, 'frontend'));
  for (const [name, original] of originals) {
    assert.deepEqual(await fs.readFile(path.join(native, name)), original, `${name} changed during CLI preparation`);
  }
});

test('macOS copies the original runtime with canonical framework aliases instead of the generic resource walker', {skip:process.platform==='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-macos-runtime-copy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime'),app=path.join(root,'Varin.app');
  const framework=path.join(runtime,'legacy-electron/Electron.app/Contents/Frameworks/Electron Framework.framework');
  await fs.mkdir(path.join(framework,'Versions/A/Resources'),{recursive:true});
  await fs.mkdir(path.join(app,'Contents/Resources'),{recursive:true});
  await fs.writeFile(path.join(framework,'Versions/A/Electron Framework'),'sealed native framework fixture');
  await fs.writeFile(path.join(framework,'Versions/A/Resources/Info.plist'),'sealed framework metadata');
  await fs.symlink('A',path.join(framework,'Versions/Current'));
  await fs.symlink('Versions/Current/Resources',path.join(framework,'Resources'));
  await fs.symlink('Versions/Current/Electron Framework',path.join(framework,'Electron Framework'));
  assert.deepEqual(candidateConfiguration(runtime,'darwin').bundle.resources,[]);
  for(const platform of ['linux','win32'])assert.deepEqual(candidateConfiguration(runtime,platform).bundle.resources,{[runtime+path.sep]:'runtime/'});
  const before=await engineInventory(runtime);
  await copyMacosRuntime(runtime,app);
  assert.deepEqual(await engineInventory(path.join(app,'Contents/Resources/runtime')),before);
  assert.deepEqual(await engineInventory(runtime),before,'Source framework bytes and links must remain unchanged');
  await assert.rejects(copyMacosRuntime(runtime,app),{code:'ERR_FS_CP_EEXIST'});
});

test('the pinned CLI bundles only the prepared runtime after merging the checked-in configuration', async t => {
  // Linux's small .deb path exercises the real CLI/config/resource copier without
  // compiling, downloading dependencies or running Varin. It does not prove the
  // macOS app bundle, CEF framework/helper layout or installed-product startup.
  if (process.platform !== 'linux') {
    t.skip('The resource-merge regression uses the Linux deb bundler');
    return;
  }
  for (const command of ['cargo', 'rustc', 'dpkg-deb']) {
    if (spawnSync(command, ['--version'], { timeout: 10_000 }).status !== 0) {
      t.skip(`The resource-merge regression requires ${command} for metadata or archive inspection`);
      return;
    }
  }
  if (!await fs.stat('/bin/true').then(stat => stat.isFile(), error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    t.skip('The resource-merge regression requires /bin/true as an unexecuted binary placeholder');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tauri-bundle-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, '../src-tauri'), native = path.join(root, 'src-tauri');
  const target = path.join(root, 'target'), runtime = path.join(root, 'generations/prepared-runtime');
  await fs.mkdir(path.join(native, 'src'), { recursive: true });
  await fs.mkdir(path.join(target, 'release'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'frontend/index.html'), '<!doctype html><title>Prepared runtime</title>');
  await fs.writeFile(path.join(runtime, 'generation.txt'), 'only the selected immutable generation');
  await fs.mkdir(path.join(root, 'generations/other-runtime'));
  await fs.writeFile(path.join(root, 'generations/other-runtime/unselected.txt'), 'must not be bundled');
  const config = JSON.parse(await fs.readFile(path.join(source, 'tauri.conf.json'), 'utf8'));
  config.bundle.icon = config.bundle.icon.map(icon => path.resolve(source, icon));
  // Do not run application hooks even if one is added to the base configuration.
  config.build.beforeBundleCommand = null;
  await fs.writeFile(path.join(native, 'tauri.conf.json'), JSON.stringify(config));
  await fs.writeFile(path.join(native, 'Cargo.toml'), `[package]\nname = "varin"\nversion = ${JSON.stringify(config.version)}\nedition = "2021"\ndescription = "Resource merge probe"\nlicense = "AGPL-3.0-only"\nauthors = ["Varin"]\n[[bin]]\nname = "varin"\npath = "src/main.rs"\n[[bin]]\nname = "varin-process-owner"\npath = "src/bin/varin-process-owner.rs"\nrequired-features = ["process-owner"]\n[features]\ndesktop = []\nprocess-owner = []\n`);
  await fs.writeFile(path.join(native, 'src/main.rs'), 'fn main() {}\n');
  await fs.mkdir(path.join(native, 'src/bin'), { recursive: true });
  await fs.writeFile(path.join(native, 'src/bin/varin-process-owner.rs'), 'fn main() {}\n');
  // The opt-in tooling helper is deliberately absent from the product build.
  await fs.copyFile('/bin/true', path.join(target, 'release/varin'));
  const env = { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_HOME: path.join(root, 'cargo-home'), CARGO_TARGET_DIR: target };
  delete env.CARGO_BUILD_TARGET;
  delete env.TAURI_CONFIG;
  const invoke = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  const require = createRequire(new URL('../package.json', import.meta.url));
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const bundle = () => invoke(process.execPath, [cli, 'bundle', '--ci', '--no-sign', '--no-binary-patching',
    '--bundles', 'deb', '--features', 'desktop', '--config', JSON.stringify(candidateConfiguration(runtime))]);
  const result = bundle();
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const bundles = path.join(target, 'release/bundle/deb');
  const archives = (await fs.readdir(bundles)).filter(name => name.endsWith('.deb'));
  assert.equal(archives.length, 1);
  const extracted = path.join(root, 'extracted');
  const extraction = invoke('dpkg-deb', ['--extract', path.join(bundles, archives[0]), extracted]);
  assert.ifError(extraction.error);
  assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);
  const resources = path.join(extracted, 'usr/lib', config.productName);
  assert.deepEqual((await fs.readdir(resources, { recursive: true })).sort(),
    ['runtime', 'runtime/frontend', 'runtime/frontend/index.html', 'runtime/generation.txt']);
  for (const file of ['frontend/index.html', 'generation.txt']) {
    assert.deepEqual(await fs.readFile(path.join(resources, 'runtime', file)), await fs.readFile(path.join(runtime, file)));
  }
  // Capturing TAURI_CONFIG alone cannot detect this regression: the CLI folds
  // overlays before merging with the base, so a stale base map survives.
  config.bundle.resources = { '../resources/runtime/': 'runtime/' };
  await fs.writeFile(path.join(native, 'tauri.conf.json'), JSON.stringify(config));
  const stale = bundle();
  assert.ifError(stale.error);
  assert.notEqual(stale.status, 0);
  assert.match(`${stale.stdout}\n${stale.stderr}`, /resource path `\.\.\/resources\/runtime` doesn't exist/);
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
