#!/usr/bin/env node
/** Linux x64 release asset consumed by the libvirt NoCloud recipe. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCloudRuntime } from './build-cloud-runtime.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The current guest bundle recipe builds Linux x64 binaries on a Linux x64 runner');
}
if (process.argv.slice(2).some((arg) => arg !== '--skip-build')) throw new Error('Unknown VM guest bundle option');
const build = !process.argv.includes('--skip-build');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = join(root, 'packages/computer-driver/linux/guest-bundle-x64');
const bunPath = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout?.trim();
if (!bunPath || !existsSync(bunPath)) throw new Error('Bun binary is required to bundle the guest runtime');
const temporary = mkdtempSync(join(tmpdir(), 'varin-vm-bundle-'));
// Clear an earlier generated bundle before building the Host so its asset copy
// cannot recursively include an older VM bundle inside the new runtime.
rmSync(destination, { recursive: true, force: true });
try {
  const archive = join(temporary, 'runtime.tgz');
  const result = buildCloudRuntime({ outputDir: join(temporary, 'runtime'), archivePath: archive,
    build, generateLock: true, install: false });
  mkdirSync(destination, { recursive: true });
  const files = { runtime: archive, node: process.execPath, bun: bunPath };
  const digests = {};
  for (const [name, source] of Object.entries(files)) {
    const filename = name === 'runtime' ? 'runtime.tgz' : name;
    copyFileSync(source, join(destination, filename));
    digests[name] = createHash('sha256').update(readFileSync(join(destination, filename))).digest('hex');
  }
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, architecture: 'x64',
    version: result.version, sourceRevision: result.sourceRevision, sourceDirty: result.sourceDirty, digests }, null, 2) + '\n');
  console.log(`VM guest bundle ready: ${destination} (Varin ${result.version})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
