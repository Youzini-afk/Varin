import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { augmentPathWithBundledRipgrep, resolveBundledRipgrepBinDir } from './bundled-tools.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('preserves user tool precedence and merges Windows PATH case-insensitively', () => {
  const env: NodeJS.ProcessEnv = { Path: 'C:\\UserTools;C:\\Windows;C:/windows/' };
  const options = { env, platform: 'win32' as const, delimiter: ';', resolveBinDir: () => 'D:\\Varin\\tools' };
  expect(augmentPathWithBundledRipgrep(options).added).toBe(true);
  expect(env).toEqual({ PATH: 'C:\\UserTools;C:\\Windows;D:\\Varin\\tools' });
  expect(augmentPathWithBundledRipgrep(options).added).toBe(false);
});

it('executes the locked native rg through ordinary PATH without a Node shim or another product toolchain', () => {
  const binDir = resolveBundledRipgrepBinDir();
  expect(binDir).not.toBeNull();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-rg-native-')); roots.push(root);
  fs.writeFileSync(path.join(root, '中文.txt'), 'native ripgrep evidence\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const result = spawnSync('rg', ['-n', 'evidence', '.'], { cwd: root, env: { ...env, PATH: binDir! }, encoding: 'utf8', windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('中文.txt:1:native ripgrep evidence');
});

it('does not treat a package manager JavaScript shim as a native tool', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-rg-shim-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'rg.mjs'), '#!/usr/bin/env node\n');
  expect(resolveBundledRipgrepBinDir({ packageJsonPath: path.join(root, 'package.json'), resourcesPath: root })).toBeNull();
});
