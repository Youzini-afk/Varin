import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMacComputerHelper } from './build-helper.mjs';

test('builds and verifies the selected native bundle before publication', () => {
  const destination = mkdtempSync(join(tmpdir(), 'varin-helper-build-'));
  const calls = [];
  try {
    const bundle = buildMacComputerHelper({ destination, architecture: 'arm64', platform: 'darwin', signIdentity: 'Developer ID Fixture',
      run(command, args) {
        calls.push([command, args]);
        if (args.includes('--show-sdk-path')) return '/test/macOS.sdk\n';
        if (args.includes('swiftc')) writeFileSync(args.at(-1), 'compiled fixture');
        return '';
      } });
    assert.equal(readFileSync(join(bundle, 'Contents/MacOS/VarinComputer'), 'utf8'), 'compiled fixture');
    assert.match(readFileSync(join(bundle, 'Contents/Info.plist'), 'utf8'), /com\.varin\.computer/);
    assert.ok(calls[1][1].includes('arm64-apple-macosx13.0'));
    assert.deepEqual(calls.slice(-2).map(call => call[0]), ['codesign', 'codesign']);
    assert.ok(calls.at(-2)[1].includes('--timestamp'));
    assert.ok(calls.at(-1)[1].includes('--verify'));
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test('compiler failure preserves the previous valid bundle', () => {
  const destination = mkdtempSync(join(tmpdir(), 'varin-helper-failure-'));
  const executable = join(destination, 'Varin Computer.app/Contents/MacOS/VarinComputer');
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'valid prior helper');
  try {
    assert.throws(() => buildMacComputerHelper({ destination, platform: 'darwin', architecture: 'x64', run(_command, args) {
      if (args.includes('--show-sdk-path')) return '/test/sdk';
      throw new Error('compiler rejected candidate');
    } }), /compiler rejected/);
    assert.equal(readFileSync(executable, 'utf8'), 'valid prior helper');
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test('does not claim a native build on a machine without the macOS SDK', () => {
  assert.throws(() => buildMacComputerHelper({ platform: 'linux' }), /macOS SDK/);
});
