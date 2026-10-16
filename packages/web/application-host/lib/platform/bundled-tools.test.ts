import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { augmentPathWithBundledRipgrep, resolveBundledRipgrepBinDir } from './bundled-tools.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const makeTempRipgrepPackage = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-rg-test-'));
  roots.push(root);
  const packageJsonPath = path.join(root, 'node_modules', '@vscode', 'ripgrep', 'package.json');
  const binDir = path.join(path.dirname(packageJsonPath), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(packageJsonPath, '{"name":"@vscode/ripgrep"}\n');
  const binaryPath = path.join(binDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
  fs.writeFileSync(binaryPath, '');
  if (process.platform !== 'win32') {
    fs.chmodSync(binaryPath, 0o755);
  }
  return { root, packageJsonPath, binDir };
};

const makeTempRipgrepBinPackage = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-rg-test-'));
  roots.push(root);
  const packageJsonPath = path.join(root, 'node_modules', 'ripgrep', 'package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const binDir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(packageJsonPath, '{"name":"ripgrep","bin":{"rg":"lib/rg.mjs"}}\n');
  fs.writeFileSync(path.join(packageRoot, 'lib', 'rg.mjs'), '#!/usr/bin/env node\n');
  const binaryPath = path.join(binDir, process.platform === 'win32' ? 'rg.cmd' : 'rg');
  fs.writeFileSync(binaryPath, '');
  if (process.platform !== 'win32') {
    fs.chmodSync(binaryPath, 0o755);
  }
  return { root, packageJsonPath, binDir };
};

describe('bundled ripgrep PATH helpers', () => {
  test('resolves the @vscode/ripgrep bin directory from package.json', () => {
    const { packageJsonPath, binDir } = makeTempRipgrepPackage();

    expect(resolveBundledRipgrepBinDir({ packageJsonPath })).toBe(binDir);
  });

  test('resolves the package manager rg shim from the ripgrep package', () => {
    const { packageJsonPath, binDir } = makeTempRipgrepBinPackage();

    expect(resolveBundledRipgrepBinDir({ packageJsonPath })).toBe(binDir);
  });

  test('prepends bundled ripgrep to PATH without duplicating it', () => {
    const { packageJsonPath, binDir } = makeTempRipgrepPackage();
    const env = { PATH: ['/usr/bin', binDir].join(path.delimiter) };

    const first = augmentPathWithBundledRipgrep({
      env,
      resolvePackageJson: () => packageJsonPath,
    });
    const second = augmentPathWithBundledRipgrep({
      env,
      resolvePackageJson: () => packageJsonPath,
    });

    expect(first).toEqual({ added: true, binDir });
    expect(second).toEqual({ added: false, binDir });
    expect(env.PATH.split(path.delimiter)).toEqual([binDir, '/usr/bin']);
  });

  test('tries later bundled package candidates when an earlier candidate has no rg binary', () => {
    const unavailable = makeTempRipgrepPackage();
    fs.rmSync(unavailable.binDir, { recursive: true, force: true });
    const available = makeTempRipgrepBinPackage();
    const env = { PATH: '/usr/bin' };

    const result = augmentPathWithBundledRipgrep({
      env,
      resolvePackageJson: () => [unavailable.packageJsonPath, available.packageJsonPath],
    });

    expect(result).toEqual({ added: true, binDir: available.binDir });
    expect(env.PATH.split(path.delimiter)[0]).toBe(available.binDir);
  });

  test('leaves PATH unchanged when bundled ripgrep is unavailable', () => {
    const env = { PATH: '/usr/bin' };

    const result = augmentPathWithBundledRipgrep({
      env,
      resolvePackageJson: () => null,
    });

    expect(result).toEqual({ added: false, binDir: null });
    expect(env.PATH).toBe('/usr/bin');
  });
});
