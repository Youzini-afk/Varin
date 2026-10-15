import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  normalizeTargetArchitecture,
  readElectronBuilderArchitecture,
  resolveTargetArchitecture,
} from './target-architecture.mjs';

const require = createRequire(import.meta.url);
const {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
} = require('../../../scripts/kernel-binary-identity.cjs');

test('normalizes host and release architecture aliases', () => {
  assert.equal(normalizeTargetArchitecture('amd64').node, 'x64');
  assert.equal(normalizeTargetArchitecture('x86_64').electronBuilder, 'x64');
  assert.equal(normalizeTargetArchitecture('aarch64').node, 'arm64');
});

test('reads a single electron-builder target architecture', () => {
  assert.equal(readElectronBuilderArchitecture(['--linux', '--arch=aarch64']), 'arm64');
  assert.equal(readElectronBuilderArchitecture(['--linux', '--x64']), 'x64');
});

test('rejects unsupported architectures', () => {
  assert.throws(() => normalizeTargetArchitecture('ia32'), /Supported architectures: x64, arm64/);
});

test('rejects conflicting architecture inputs', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x64',
      environment: { VARIN_TARGET_ARCH: 'x64', ELECTRON_BUILDER_ARCH: 'arm64' },
    }),
    /Conflicting target architectures/,
  );
});

test('rejects cross-architecture Linux packaging', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x86_64',
      environment: { VARIN_TARGET_ARCH: 'aarch64' },
    }),
    /must be built natively.*host is x64, target is arm64/,
  );
});

test('accepts matching native Linux architecture aliases', () => {
  assert.equal(resolveTargetArchitecture({
    platform: 'linux',
    hostArchitecture: 'x64',
    environment: { VARIN_TARGET_ARCH: 'amd64' },
  }).node, 'x64');
});

test('normalizes kernel aliases and binds the target triple', () => {
  assert.equal(normalizeKernelArchitecture('amd64'), 'x64');
  assert.equal(normalizeKernelArchitecture('aarch64'), 'arm64');
  assert.equal(defaultKernelTargetTriple('win32', 'amd64'), 'x86_64-pc-windows-msvc');
});

test('reads the architecture from the actual kernel binary header', () => {
  const x64 = Buffer.alloc(0x80);
  x64.write('MZ', 0, 'ascii');
  x64.writeUInt32LE(0x40, 0x3c);
  x64.write('PE\0\0', 0x40, 'binary');
  x64.writeUInt16LE(0x8664, 0x44);
  assert.deepEqual(detectKernelBinaryIdentity(x64), { platform: 'win32', arch: 'x64', format: 'pe' });

  const arm64 = Buffer.from(x64);
  arm64.writeUInt16LE(0xaa64, 0x44);
  assert.deepEqual(detectKernelBinaryIdentity(arm64), { platform: 'win32', arch: 'arm64', format: 'pe' });
});

test('kernel staging and Electron packaging consume the owning wire version', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-kernel-manifest-'));
  const previousArch = process.env.VARIN_TARGET_ARCH;
  const previousTriple = process.env.VARIN_TARGET_TRIPLE;
  try {
    // Header-only packaging fixture; this does not claim an executable kernel handshake.
    const header = Buffer.alloc(20);
    header.write('\x7fELF', 0, 'binary'); header[5] = 1; header.writeUInt16LE(62, 18);
    const prebuilt = path.join(temporary, 'fixture-kernel');
    fs.writeFileSync(prebuilt, header);
    const stage = path.join(temporary, 'resources', 'kernel');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build-kernel.mjs'), '--stage', stage,
      '--platform', 'linux', '--arch', 'x64', '--target', 'x86_64-unknown-linux-gnu'], {
      env: { ...process.env, VARIN_KERNEL_PREBUILT: prebuilt }, stdio: 'pipe',
    });
    const manifestPath = path.join(stage, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { protocolVersion } = require('../../../kernel/protocol/schema.json');
    assert.equal(manifest.protocolVersion, protocolVersion);
    process.env.VARIN_TARGET_ARCH = 'x64'; process.env.VARIN_TARGET_TRIPLE = 'x86_64-unknown-linux-gnu';
    const afterPack = require('./after-pack.cjs');
    const context = { electronPlatformName: 'linux', appOutDir: temporary };
    // Reaching the next payload check proves the original staged manifest was accepted.
    assert.throws(() => afterPack(context), /Missing target TriviumDB binary/);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, protocolVersion: protocolVersion + 1 }));
    assert.throws(() => afterPack(context), /Rust kernel manifest does not match/);
  } finally {
    if (previousArch === undefined) delete process.env.VARIN_TARGET_ARCH; else process.env.VARIN_TARGET_ARCH = previousArch;
    if (previousTriple === undefined) delete process.env.VARIN_TARGET_TRIPLE; else process.env.VARIN_TARGET_TRIPLE = previousTriple;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
