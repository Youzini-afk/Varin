import assert from 'node:assert/strict';
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

test('independent desktop entries participate in the same production graph and must all exist', t => {
  const f = fixture(t);
  f.write('index.js');
  f.write('desktop-host.js', "import './desktop-worker.js';");
  f.write('desktop-worker.js');
  f.write('desktop-settings.js');
  const entries = ['index.js', 'public-contract.js', 'desktop-host.js', 'desktop-settings.js', 'desktop-browser.js'];
  assert.throws(() => pruneLegacyHostArtifacts(f.root, entries), /Missing Host runtime dependency: desktop-browser.js/);
  f.write('desktop-browser.js', "import './lib/old.test-helper.js';");
  f.write('lib/old.test-helper.js');
  assert.throws(() => pruneLegacyHostArtifacts(f.root, entries), /Legacy Host runtime dependency: desktop-browser.js/);
  f.write('desktop-browser.js');
  pruneLegacyHostArtifacts(f.root, entries);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'production-boundary.json'), 'utf8'));
  assert.ok(report.runtimeModules.includes('desktop-worker.js'));
  assert.ok(report.runtimeModules.includes('desktop-browser.js'));
});
