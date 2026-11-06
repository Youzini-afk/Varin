#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const webRoot = path.join(repoRoot, 'packages', 'web');
const outputDir = path.join(webRoot, '.application-host-types');

// These declarations are a disposable type-check cache, not a runtime
// artifact. Compile in place: Windows file watchers and TypeScript language
// services may hold the directory open, making directory-level rename falsely
// fail with EPERM. Remove old files in place so deleted/excluded source modules
// cannot survive as declarations. A cleanup or tsc failure stops the caller.
if (fs.lstatSync(outputDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw new Error(`Refusing to clean Application Host type cache through a symbolic link or junction: ${outputDir}`);
}
fs.mkdirSync(outputDir, { recursive: true });
function clearCacheFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) clearCacheFiles(target);
    else fs.unlinkSync(target);
  }
}
clearCacheFiles(outputDir);

const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
const result = spawnSync(process.execPath, [
  tscJs,
  // Cross-layer tests consume helper signatures too, without compiling Host
  // source under renderer settings. Runtime builds still use the production config.
  '-p', path.join(webRoot, 'tsconfig.application-host.types.json'),
  '--emitDeclarationOnly',
  '--outDir', outputDir,
], { cwd: webRoot, stdio: 'inherit', shell: false });

if (result.status !== 0) {
  process.stderr.write(`[build:application-host:types] tsc exited with status ${result.status}\n`);
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(outputDir, 'index.d.ts'))) {
  process.stderr.write('[build:application-host:types] output does not contain index.d.ts\n');
  process.exit(1);
}

process.stdout.write('[build:application-host:types] Build complete.\n');
