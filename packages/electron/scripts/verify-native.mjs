#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(electronRoot, '../..');
const require = createRequire(import.meta.url);
const executable = require('electron');
const target = resolveTargetArchitecture();
if (target.node !== process.arch) throw new Error('Native execution verification requires a matching architecture runner');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const webRoot = path.resolve(argument('--web-root') || path.join(repository, 'packages/web'));
const kernelRoot = argument('--kernel-root');
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
if (!argument('--web-root')) execFileSync(process.execPath, [path.join(electronRoot, 'scripts/prepare-native-runtime.mjs')], {
  cwd: electronRoot, stdio: 'inherit', windowsHide: true,
});
execFileSync(executable, [path.join(repository, 'scripts/smoke-kernel-release.mjs'), webRoot, ...(kernelRoot ? [path.resolve(kernelRoot)] : [])], {
  cwd: electronRoot, env: environment, stdio: 'inherit', windowsHide: true, timeout: 120_000,
});
// TriviumDB remains the existing knowledge owner. Verify its real Node-API
// loading and durable read/write under Electron rather than rebuilding PTY/SQL.
execFileSync(executable, [path.join(electronRoot, 'scripts/verify-knowledge-runtime.mjs'), webRoot], {
  cwd: electronRoot, env: environment, stdio: 'inherit', windowsHide: true, timeout: 30_000,
});
console.log('[electron] verified Rust release authority and TriviumDB under Electron');
