import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const helperArtifact = require('../../computer-driver/windows/helper-artifact.cjs');
const childProcess = require('node:child_process');
const hookPath = require.resolve('./after-sign.cjs');

function fixture(t, architecture = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-after-sign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['VARIN_TARGET_ARCH', 'VARIN_COMPUTER_REQUIRE_SIGNATURE', 'CSC_LINK', 'WIN_CSC_LINK', 'WINDOWS_CSC_LINK'];
  const environment = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const directory = path.join(root, 'resources/app.asar.unpacked/node_modules/@varin/web/server/computer-driver/windows');
  fs.mkdirSync(directory, { recursive: true });
  // Header-only fixture tests the real target-architecture validator, not
  // Windows execution or publisher signing. Those remain native acceptance.
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 132);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt32LE(16, 260);
  fs.writeFileSync(path.join(directory, helperArtifact.EXECUTABLE), bytes);
  const manifest = { schema: 1, protocolVersion: 1, executable: helperArtifact.EXECUTABLE, architecture,
    target: architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', version: '1.2.3',
    buildId: 'a'.repeat(64), sha256: helperArtifact.digest(bytes), imports: [], signature: { status: 'unsigned' } };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const smoke = t.mock.method(childProcess, 'execFileSync', () => '');
  t.mock.method(helperArtifact, 'readSignature', () => ({ status: 'unsigned' }));
  const verifyHelper = helperArtifact.verifyHelper;
  t.mock.method(helperArtifact, 'verifyHelper', (location, options) => verifyHelper(location, { ...options, verifySignature: false }));
  delete require.cache[hookPath];
  const afterSign = require(hookPath);
  t.after(() => { delete require.cache[hookPath]; });
  return { afterSign, directory, smoke,
    context: { electronPlatformName: 'win32', arch: architecture === 'arm64' ? 3 : 1,
      appOutDir: root, packager: { appInfo: { version: '1.2.3' } } } };
}

test('afterSign validates ARM64 from the builder context without a target environment variable', async t => {
  const f = fixture(t);
  await f.afterSign(f.context);
  const manifest = helperArtifact.verifyHelper(f.directory, { architecture: 'arm64', verifySignature: false });
  assert.equal(manifest.architecture, 'arm64');
  assert.equal(f.smoke.mock.callCount(), process.arch === 'arm64' ? 1 : 0);
});

test('afterSign accepts a matching target alias and validates x64 from the builder context', async t => {
  const f = fixture(t, 'x64');
  process.env.VARIN_TARGET_ARCH = 'amd64';
  await f.afterSign(f.context);
  assert.equal(f.smoke.mock.callCount(), process.arch === 'x64' ? 1 : 0);
});

test('afterSign rejects a conflicting environment before changing or signing the artifact', async t => {
  const f = fixture(t);
  process.env.VARIN_TARGET_ARCH = 'x64';
  const before = fs.readFileSync(path.join(f.directory, 'manifest.json'));
  await assert.rejects(f.afterSign(f.context), /architecture arm64 conflicts with VARIN_TARGET_ARCH=x64/);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'manifest.json')), before);
  assert.equal(f.smoke.mock.callCount(), 0);
});

test('afterSign rejects a binary from a different architecture instead of accepting the host architecture', async t => {
  const f = fixture(t, 'x64');
  await assert.rejects(f.afterSign({ ...f.context, arch: 3 }), /PE architecture mismatch \(expected arm64\)/);
});

test('afterSign rejects unsupported or missing builder architecture instead of guessing the host', async t => {
  const f = fixture(t);
  await assert.rejects(f.afterSign({ ...f.context, arch: 0 }), /Unsupported package architecture: 0/);
  await assert.rejects(f.afterSign({ ...f.context, arch: undefined }), /Unsupported package architecture: undefined/);
});
