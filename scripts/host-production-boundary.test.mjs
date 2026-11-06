import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHostProductionGraph, isLegacyHostArtifact, pruneLegacyHostArtifacts } from './host-production-boundary.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-production-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text = 'export {};\n') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('public-contract.js');
  return { root, write };
}

for (const statement of [
  "import './lib/old.test-helper.js';",
  "export * from './lib/old.test-helper.js';",
  "await import('./lib/old.test-helper.js');",
  "require('./lib/old.test-helper.js');",
  "new Worker(new URL('./lib/old.test-helper.js', import.meta.url));",
]) {
  test(`rejects reachable legacy implementation: ${statement}`, t => {
    const f = fixture(t);
    f.write('index.js', statement);
    f.write('lib/old.test-helper.js');
    assert.throws(() => inspectHostProductionGraph(f.root), /Legacy Host runtime dependency: index.js -> lib\/old.test-helper.js/);
    assert.ok(fs.existsSync(path.join(f.root, 'lib/old.test-helper.js')), 'audit must not erase a reachable dependency');
  });
}

test('prunes unreachable legacy code and declarations, then audits the emitted release bytes', t => {
  const f = fixture(t);
  f.write('index.js', "export * from './lib/current.js';");
  f.write('lib/current.js');
  f.write('lib/local-sqlite-recovery-engine.test-helper.js');
  f.write('lib/working-state-store.js');
  f.write('lib/working-state-store.d.ts');
  f.write('lib/contract-fixtures.js.map', '{}');
  const report = pruneLegacyHostArtifacts(f.root);
  assert.deepEqual(report, { runtimeModules: 3, removedArtifacts: 4 });
  assert.deepEqual(inspectHostProductionGraph(f.root), ['index.js', 'lib/current.js', 'public-contract.js']);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'production-boundary.json'), 'utf8'));
  assert.equal(manifest.removedArtifacts.length, 4);
  assert.equal(isLegacyHostArtifact('lib/kernel/kernel-client.js'), false);
});

test('missing worker entrypoints fail the release audit', t => {
  const f = fixture(t);
  f.write('index.js', "new Worker(new URL('./worker.js', import.meta.url));");
  assert.throws(() => inspectHostProductionGraph(f.root), /Missing Host runtime dependency/);
});

test('type cache refresh preserves directories and refuses linked cache roots', t => {
  const f = fixture(t);
  const builder = 'packages/web/scripts/build-application-host-types.mjs';
  f.write(builder, fs.readFileSync(new URL(`../${builder}`, import.meta.url), 'utf8'));
  // Control compilation only; cleanup runs through the original builder.
  f.write('node_modules/typescript/lib/tsc.js', `
    const fs = require('node:fs'), path = require('node:path');
    const output = process.argv[process.argv.indexOf('--outDir') + 1];
    fs.writeFileSync(path.join(output, 'index.d.ts'), 'export {};\\n');
  `);
  const cache = path.join(f.root, 'packages/web/.application-host-types');
  f.write('packages/web/.application-host-types/old/removed.d.ts');
  f.write('packages/web/.application-host-types/old/removed.d.ts.map', '{}');
  const directory = fs.statSync(cache);
  const run = () => spawnSync(process.execPath, [path.join(f.root, builder)], { encoding: 'utf8' });
  const refreshed = run();
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(fs.statSync(cache).ino, directory.ino, 'refresh must retain the cache directory');
  assert.deepEqual(fs.readdirSync(path.join(cache, 'old')), [], 'old files are removed without replacing their directory');
  assert.equal(fs.readFileSync(path.join(cache, 'index.d.ts'), 'utf8'), 'export {};\n');

  fs.rmSync(cache, { recursive: true });
  f.write('external-cache/sentinel.d.ts', 'do not delete\n');
  const external = path.join(f.root, 'external-cache');
  fs.symlinkSync(external, cache, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to clean Application Host type cache through a symbolic link or junction/);
  assert.ok(fs.lstatSync(cache).isSymbolicLink(), 'refusal must leave the link untouched');
  assert.deepEqual(fs.readdirSync(external), ['sentinel.d.ts']);
  assert.equal(fs.readFileSync(path.join(external, 'sentinel.d.ts'), 'utf8'), 'do not delete\n');
});
