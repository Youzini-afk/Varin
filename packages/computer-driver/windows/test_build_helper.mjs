import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWindowsComputerHelper, windowsHelperBuildIdentity } from './build-helper.mjs';
import artifact from './helper-artifact.cjs';

function pe(arch = 'x64', imported = 'KERNEL32.dll') {
  const bytes = Buffer.alloc(1024);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132);
  bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148);
  const optional = 152; bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 120); bytes.writeUInt32LE(40, optional + 124);
  const section = optional + 240; bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1050, 512 + 12); bytes.write(imported + '\0', 592);
  return bytes;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-helper-build-'));
  for (const file of ['kernel/crates/varin-computer-windows/src/main.rs', 'kernel/Cargo.toml', 'kernel/Cargo.lock',
    'packages/computer-driver/windows/VarinComputer.manifest', 'packages/computer-driver/windows/build-helper.mjs',
    'packages/electron/resources/icons/icon.ico', 'scripts/kernel-binary-identity.cjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file);
  }
  fs.writeFileSync(path.join(root, 'kernel/rust-toolchain.toml'), '[toolchain]\nchannel = "1.90.0"\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const rc = path.join(root, 'rc.exe'); fs.writeFileSync(rc, 'resource compiler');
  const environment = { INCLUDE: 'include', WindowsSdkDir: 'sdk', VSCMD_ARG_TGT_ARCH: 'x64', WindowsSDKVersion: '10', VCToolsVersion: '14' };
  let builds = 0, compiler = 'rustc 1.90.0', fail = false, signature = 'NotSigned';
  const run = (command, args, options = {}) => {
    if (command === 'rustc') return compiler;
    if (command === 'cargo' && args[0] === '--version') return 'cargo 1.90.0';
    if (command === 'where.exe') return rc;
    if (command === 'powershell.exe') return JSON.stringify({ status: signature, subject: signature === 'Valid' ? 'CN=Varin' : null, thumbprint: signature === 'Valid' ? 'ABC' : null });
    if (command === 'signtool.exe') { signature = 'Valid'; fs.appendFileSync(args.at(-1), 'signed final bytes'); return ''; }
    assert.equal(command, 'cargo'); assert.equal(args[0], 'build'); builds++;
    if (fail) throw new Error('compiler failed');
    const target = args[args.indexOf('--target') + 1];
    const executable = path.join(args[args.indexOf('--target-dir') + 1], target, 'release', artifact.EXECUTABLE);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, pe(target.startsWith('aarch64') ? 'arm64' : 'x64'));
    assert.match(options.env.CARGO_ENCODED_RUSTFLAGS, /target-feature=\+crt-static/);
    assert.match(options.env.VARIN_COMPUTER_BUILD_ID, /^[a-f0-9]{64}$/);
    return '';
  };
  const options = { root, architecture: 'x64', platform: 'win32', environment, run, destination: path.join(root, 'generation/windows') };
  return { root, options, get builds() { return builds; }, set fail(value) { fail = value; }, set compiler(value) { compiler = value; },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('Windows PE identity and imports reject wrong architecture and missing VC runtime', () => {
  assert.deepEqual(artifact.inspectExecutable(pe(), 'x64').imports, ['kernel32.dll']);
  assert.deepEqual(artifact.inspectExecutable(pe('x64', 'bcryptprimitives.dll'), 'x64').imports, ['bcryptprimitives.dll']);
  assert.equal(artifact.inspectExecutable(pe('arm64'), 'arm64').architecture, 'arm64');
  assert.throws(() => artifact.inspectExecutable(pe(), 'arm64'), /architecture/);
  assert.throws(() => artifact.inspectExecutable(pe('x64', 'VCRUNTIME140.dll'), 'x64'), /unbundled/);
  assert.throws(() => artifact.inspectExecutable(pe().subarray(0, 180), 'x64'), /truncated|header/);
});

test('bootstraps the SDK through cmd from a batch path containing spaces', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    const installation = path.join(f.root, 'Visual Studio (fixture & tools)');
    const script = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, [
      '@echo off',
      // Batch positional parameters split unquoted '='. The raw argument tail
      // preserves the developer command's -arch=value syntax.
      'set "VARIN_FIXTURE_ARGS=%*"',
      'set "INCLUDE=fixture SDK include"',
      'set "WindowsSdkDir=fixture SDK"',
      'set "WindowsSDKVersion=fixture SDK version"',
      'set "VSCMD_ARG_TGT_ARCH=x64"',
      'exit /b 0',
      '',
    ].join('\r\n'));
    const environment = { ...process.env };
    for (const name of ['INCLUDE', 'WindowsSdkDir', 'VSCMD_ARG_TGT_ARCH']) delete environment[name];
    let bootstrapped = false;
    const run = (command, args, options) => {
      if (path.basename(command) === 'vswhere.exe') return installation;
      if (command === 'cmd.exe') return execFileSync(command, args, options);
      assert.equal(options.env.VARIN_FIXTURE_ARGS.trim(), `-arch=x64 -host_arch=${process.arch}`);
      assert.equal(options.env.INCLUDE, 'fixture SDK include');
      assert.equal(options.env.WindowsSdkDir, 'fixture SDK');
      bootstrapped = true;
      return f.options.run(command, args, options);
    };
    const identity = windowsHelperBuildIdentity({ ...f.options, environment, run });
    assert.equal(bootstrapped, true);
    assert.equal(identity.values.sdk, 'fixture SDK version');
    assert.equal(identity.values.target, 'x86_64-pc-windows-msvc');
  } finally { f.close(); }
});

test('reads a real unsigned file with built-in PowerShell modules despite an inherited module path', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-signature-check-'));
  const previous = process.env.PSModulePath;
  try {
    const modules = path.join(root, 'inherited modules');
    const security = path.join(modules, 'Microsoft.PowerShell.Security');
    fs.mkdirSync(security, { recursive: true });
    fs.writeFileSync(path.join(security, 'Microsoft.PowerShell.Security.psd1'),
      "@{ ModuleVersion='1.0'; RootModule='security.psm1'; FunctionsToExport=@('Get-AuthenticodeSignature') }\r\n");
    fs.writeFileSync(path.join(security, 'security.psm1'), "throw 'Inherited module must not be loaded'\r\n");
    const unsigned = path.join(root, 'unsigned fixture.ps1');
    fs.writeFileSync(unsigned, '# Signature inspection fixture. Never executed.\r\n');
    process.env.PSModulePath = modules;
    assert.deepEqual(artifact.readSignature(unsigned), { status: 'unsigned' });
    assert.equal(process.env.PSModulePath, modules);
  } finally {
    if (previous === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native helper cache includes source, lockfile, manifest, icon, actual toolchain, flags and target', () => {
  const f = fixture();
  try {
    const identify = () => windowsHelperBuildIdentity(f.options).buildId;
    let previous = identify();
    for (const file of ['kernel/crates/varin-computer-windows/src/main.rs', 'kernel/Cargo.lock', 'packages/computer-driver/windows/VarinComputer.manifest', 'packages/electron/resources/icons/icon.ico']) {
      fs.appendFileSync(path.join(f.root, file), 'changed'); const next = identify(); assert.notEqual(next, previous); previous = next;
    }
    f.compiler = 'rustc changed'; assert.notEqual(identify(), previous); previous = identify();
    f.options.environment.RUSTFLAGS = '-C opt-level=2'; assert.notEqual(identify(), previous); previous = identify();
    f.options.architecture = 'arm64'; f.options.environment.VSCMD_ARG_TGT_ARCH = 'arm64'; assert.notEqual(identify(), previous);
  } finally { f.close(); }
});

test('builds once, validates cache bytes, and stages no scripts or compiler inputs', () => {
  const f = fixture();
  try {
    const first = buildWindowsComputerHelper(f.options);
    const second = buildWindowsComputerHelper({ ...f.options, destination: path.join(f.root, 'other/windows') });
    assert.equal(f.builds, 1); assert.equal(first.manifest.buildId, second.manifest.buildId);
    assert.deepEqual(fs.readdirSync(second.directory).sort(), ['VarinComputer.exe', 'manifest.json']);
    assert.equal(first.manifest.signature.status, 'unsigned');
    fs.appendFileSync(path.join(f.root, 'artifacts/build/computer-windows', first.manifest.buildId, artifact.EXECUTABLE), 'damaged cache');
    const repaired = buildWindowsComputerHelper(f.options);
    assert.equal(f.builds, 2);
    assert.equal(repaired.manifest.sha256, first.manifest.sha256);
    fs.appendFileSync(path.join(second.directory, 'VarinComputer.exe'), 'changed');
    assert.throws(() => artifact.verifyHelper(second.directory), /digest mismatch/);
  } finally { f.close(); }
});

test('failed preparation preserves the previous generation byte-for-byte', () => {
  const f = fixture();
  try {
    const first = buildWindowsComputerHelper(f.options);
    const oldManifest = fs.readFileSync(path.join(first.directory, 'manifest.json'));
    fs.appendFileSync(path.join(f.root, 'kernel/Cargo.lock'), 'change'); f.fail = true;
    assert.throws(() => buildWindowsComputerHelper(f.options), /compiler failed/);
    assert.deepEqual(fs.readFileSync(path.join(first.directory, 'manifest.json')), oldManifest);
    assert.equal(artifact.verifyHelper(first.directory, { run: f.options.run }).buildId, first.manifest.buildId);
  } finally { f.close(); }
});

test('publisher signature and digest describe final signed bytes and unsigned release is rejected', () => {
  const f = fixture();
  try {
    f.options.environment.VARIN_COMPUTER_REQUIRE_SIGNATURE = '1';
    assert.throws(() => buildWindowsComputerHelper(f.options), /publisher signature/);
    f.options.environment.VARIN_COMPUTER_SIGN_CERTIFICATE_SHA1 = 'a'.repeat(40);
    f.options.environment.VARIN_COMPUTER_SIGN_TIMESTAMP = 'https://timestamp.example.test';
    const result = buildWindowsComputerHelper(f.options);
    assert.equal(result.manifest.signature.status, 'valid');
    assert.equal(result.manifest.sha256, artifact.digest(fs.readFileSync(path.join(result.directory, artifact.EXECUTABLE))));
    assert.ok(fs.readFileSync(path.join(result.directory, artifact.EXECUTABLE)).includes(Buffer.from('signed final bytes')));
  } finally { f.close(); }
});
