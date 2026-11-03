import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectPortableExecutable, stageWindowsBootstrap, windowsArchives, windowsBundleResources, installBootstrapForBundle } from './windows-bootstrap.mjs';

function pe({ machine = 0x8664, dll = false, exportName = 'RunWinMain' } = {}) {
  const bytes = Buffer.alloc(2048);
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(machine, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94); bytes.writeUInt16LE(dll ? 0x2000 : 0x0022, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98); bytes.writeUInt16LE(0x140, 0x98 + 70);
  const section = 0x98 + 240;
  bytes.write('.rdata', section); bytes.writeUInt32LE(1024, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(1024, section + 16); bytes.writeUInt32LE(512, section + 20);
  if (dll && exportName) {
    bytes.writeUInt32LE(16, 0x98 + 108); bytes.writeUInt32LE(0x1000, 0x98 + 112); bytes.writeUInt32LE(128, 0x98 + 116);
    bytes.writeUInt32LE(1, 512 + 24); bytes.writeUInt32LE(0x1040, 512 + 32); bytes.writeUInt32LE(0x1080, 576);
    bytes.write(exportName, 640);
  }
  return bytes;
}
async function fixture(t, architecture = 'x64') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-cef-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cefDirectory = path.join(root, 'sdk'), targetDirectory = path.join(root, 'target'), destination = path.join(root, 'runnable');
  await fs.mkdir(cefDirectory); await fs.mkdir(targetDirectory); await fs.mkdir(path.join(cefDirectory, 'locales'));
  const lock = windowsArchives[architecture];
  await fs.writeFile(path.join(cefDirectory, 'archive.json'), JSON.stringify({ name: lock.name, sha1: lock.sha1, type: 'minimal' }));
  await fs.writeFile(path.join(cefDirectory, 'bootstrap.exe'), pe({ machine: lock.machine }));
  await fs.writeFile(path.join(targetDirectory, 'varin_desktop.dll'), pe({ machine: lock.machine, dll: true }));
  await fs.writeFile(path.join(targetDirectory, 'varin.exe'), 'build-only sentinel');
  for (const name of ['libcef.dll', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'v8_context_snapshot.bin', 'LICENSE.txt', 'CREDITS.html']) await fs.writeFile(path.join(cefDirectory, name), `fixture ${name}`);
  await fs.writeFile(path.join(cefDirectory, 'locales/en-US.pak'), 'en-US');
  await fs.writeFile(path.join(cefDirectory, 'locales/zh-CN.pak'), 'zh-CN');
  return { cefDirectory, targetDirectory, destination, architecture };
}
for (const architecture of ['x64', 'arm64']) test(`stages matching ${architecture} sandbox bootstrap and actual renamed DLL`, async t => {
  const input = await fixture(t, architecture);
  const output = await stageWindowsBootstrap(input);
  assert.deepEqual(await fs.readFile(path.join(output.directory, 'varin.dll')), await fs.readFile(path.join(input.targetDirectory, 'varin_desktop.dll')));
  assert.deepEqual(await fs.readFile(output.executable), await fs.readFile(path.join(input.cefDirectory, 'bootstrap.exe')));
  assert.equal((await inspectPortableExecutable(path.join(output.directory, 'varin.dll'))).exports[0], 'RunWinMain');
  assert.equal(await fs.readFile(path.join(input.targetDirectory, 'varin.exe'), 'utf8'), 'build-only sentinel');
  const resources = await windowsBundleResources(output.directory);
  assert.equal(resources[path.join(output.directory, 'varin.dll')], 'varin.dll');
  assert.equal(resources[path.join(output.directory, 'locales/zh-CN.pak')], 'locales/zh-CN.pak');
  assert.equal(resources[output.executable], undefined);
  await installBootstrapForBundle(output.directory, input.targetDirectory);
  assert.deepEqual(await fs.readFile(path.join(input.targetDirectory, 'varin.exe')), await fs.readFile(output.executable));
});
test('rejects a DLL without the genuine bootstrap entry rather than start without sandbox', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.targetDirectory, 'varin_desktop.dll'), pe({ dll: true, exportName: 'UnrelatedEntry' }));
  await assert.rejects(stageWindowsBootstrap(input), /RunWinMain|bootstrap entry/);
  await assert.rejects(fs.stat(input.destination), { code: 'ENOENT' });
});
test('architecture mismatch and wrong fixed CEF receipt fail before publication', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.targetDirectory, 'varin_desktop.dll'), pe({ machine: 0xaa64, dll: true }));
  await assert.rejects(stageWindowsBootstrap(input), /architecture/);
  await fs.writeFile(path.join(input.cefDirectory, 'archive.json'), JSON.stringify({ ...windowsArchives.arm64, type: 'minimal' }));
  await assert.rejects(stageWindowsBootstrap(input), /pinned/);
});
test('missing runtime bytes and post-stage tampering are observable failures', async t => {
  const input = await fixture(t);
  await fs.rm(path.join(input.cefDirectory, 'icudtl.dat'));
  await assert.rejects(stageWindowsBootstrap(input), /icudtl/);
  await fs.writeFile(path.join(input.cefDirectory, 'icudtl.dat'), 'restored');
  const output = await stageWindowsBootstrap(input);
  await fs.appendFile(path.join(output.directory, 'varin.dll'), 'changed');
  await assert.rejects(windowsBundleResources(output.directory), /integrity/);
  await assert.rejects(installBootstrapForBundle(output.directory, input.targetDirectory), /integrity/);
  assert.equal(await fs.readFile(path.join(input.targetDirectory, 'varin.exe'), 'utf8'), 'build-only sentinel');
});
test('PE parser checks offsets without executing the file', async t => {
  const input = await fixture(t);
  const broken = pe(); broken.writeUInt32LE(0xfffffff0, 0x3c);
  await fs.writeFile(path.join(input.targetDirectory, 'broken.exe'), broken);
  await assert.rejects(inspectPortableExecutable(path.join(input.targetDirectory, 'broken.exe')), /PE range/);
});

test('Windows dev/build request the cdylib and never launch the Cargo sentinel', async () => {
  const { desktopArguments } = await import('./desktop.mjs');
  for (const command of ['dev', 'build']) {
    const args = desktopArguments(command, 'tauri.js', { bundle: { active: false } }, 'win32');
    assert.deepEqual(args.slice(0, 4), ['tauri.js', 'build', '--debug', '--no-bundle']);
    assert.deepEqual(args.slice(-2), ['--', '--lib']);
    assert.ok(!args.includes('--no-watch'));
  }
  assert.equal(desktopArguments('dev', 'tauri.js', {}, 'linux')[1], 'dev');
});

test('signs DLL before real EXE, verifies signatures and reseals exact final bytes', async t => {
  const { signWindowsBootstrap, verifyWindowsBootstrap } = await import('./windows-bootstrap.mjs');
  const input = await fixture(t);
  const output = await stageWindowsBootstrap(input), order = [];
  const signed = await signWindowsBootstrap(output.directory, {
    sign: async file => { order.push(path.basename(file)); await fs.appendFile(file, 'synthetic signature fixture'); },
    verifySignature: async () => true,
  });
  assert.deepEqual(order, ['varin.dll', 'varin.exe']);
  assert.equal(signed.signing.application, 'verified');
  assert.deepEqual((await verifyWindowsBootstrap(output.directory)).files, signed.files);
  await installBootstrapForBundle(output.directory, input.targetDirectory);
  assert.deepEqual(await fs.readFile(path.join(input.targetDirectory, 'varin.exe')), await fs.readFile(output.executable));
});

test('a failed signature verifier does not reseal or publish modified bytes', async t => {
  const { signWindowsBootstrap } = await import('./windows-bootstrap.mjs');
  const input = await fixture(t), output = await stageWindowsBootstrap(input);
  await assert.rejects(signWindowsBootstrap(output.directory, {
    sign: async file => fs.appendFile(file, 'invalid signature fixture'), verifySignature: async () => false,
  }), /Authenticode verification/);
  await assert.rejects(installBootstrapForBundle(output.directory, input.targetDirectory), /integrity/);
  assert.equal(await fs.readFile(path.join(input.targetDirectory, 'varin.exe'), 'utf8'), 'build-only sentinel');
});

test('unexpected untracked files and traversal inventory entries are rejected', async t => {
  const { verifyWindowsBootstrap } = await import('./windows-bootstrap.mjs');
  const input = await fixture(t), output = await stageWindowsBootstrap(input);
  await fs.writeFile(path.join(output.directory, 'unexpected.dll'), 'not in the stage receipt');
  await assert.rejects(verifyWindowsBootstrap(output.directory), /integrity/);
  await fs.rm(path.join(output.directory, 'unexpected.dll'));
  const receipt = output.receipt; receipt.files[0].path = '../outside.dll';
  await fs.writeFile(path.join(output.directory, 'cef-runtime-manifest.json'), JSON.stringify(receipt));
  await assert.rejects(verifyWindowsBootstrap(output.directory), /relative path/);
});

test('installer invocation keeps signed bootstrap unpatched and maps resources beside it', async () => {
  const { windowsBundleArguments } = await import('./windows-bundle.mjs');
  const resources = { '/generation/varin.dll': 'varin.dll', '/generation/locales/en-US.pak': 'locales/en-US.pak', '/runtime/': 'runtime/' };
  const args = windowsBundleArguments({ cli: 'tauri.js', runtime: '/runtime', resources, target: 'aarch64-pc-windows-msvc' });
  assert.deepEqual(args.slice(0, 6), ['tauri.js', 'bundle', '--debug', '--no-binary-patching', '--no-sign', '--ci']);
  assert.ok(args.includes('aarch64-pc-windows-msvc'));
  const configs = args.flatMap((value, index) => value === '--config' ? [JSON.parse(args[index + 1])] : []);
  assert.deepEqual(configs[0].bundle.resources, []);
  assert.deepEqual(configs[1].bundle.resources, resources);
  assert.throws(() => windowsBundleArguments({ cli: 'tauri.js', runtime: '/runtime', resources, bundles: ['deb'] }), /Windows installer/);
});
