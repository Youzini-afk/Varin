import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { activateRecovery, createColdBackup, restoreColdBackup, verifyColdBackup } from './cold-backup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-cold-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(data); fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(data, 'extensions'));
  fs.writeFileSync(path.join(data, 'extensions', 'identity.json'), JSON.stringify({ hostId: 'original-host' }));
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'original workspace bytes\n');
  fs.symlinkSync('note.txt', path.join(workspace, 'relative-link'));
  return { root, data, workspace, output: path.join(root, 'backup') };
}

test('cold copy preserves real SQLite WAL and native Knowledge publication recovery without rewriting facts', t => {
  const f = fixture(t);
  const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
  const nativePath = require.resolve('triviumdb');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    const { TriviumDB } = require(process.argv[1]);
    const root = process.argv[2];
    const sqlite = new DatabaseSync(root + '/wal.sqlite');
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (key TEXT PRIMARY KEY, outcome TEXT); INSERT INTO facts VALUES ('dispatched-key', 'unknown');");
    const db = new TriviumDB(root + '/knowledge.tdb', { dim: 8, syncMode: 'full', autoBuildQuiver: false, loadTextIndex: false });
    db.insert(Array(8).fill(0), { text: 'checkpoint' }); db.flush();
    const pending = db.insert(Array(8).fill(1), { text: 'durable WAL' });
    fs.mkdirSync(root + '/knowledge.tdb.tmp');
    try { db.flush(); process.exit(2); } catch { console.log(JSON.stringify({ pending })); process.exit(0); }
  `, nativePath, f.data], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const { pending } = JSON.parse(child.stdout);
  fs.rmdirSync(path.join(f.data, 'knowledge.tdb.tmp'));
  assert.ok(fs.statSync(path.join(f.data, 'wal.sqlite-wal')).size > 0);
  assert.ok(fs.readdirSync(f.data).some(name => name.includes('.publish')));
  const backup = createColdBackup({ dataDir: f.data, scopes: [{ name: 'workspace', source: f.workspace }], output: f.output, writersStopped: true });
  const verified = verifyColdBackup(f.output);
  assert.equal(verified.manifestSha256, backup.manifestSha256);
  assert.ok(verified.manifest.roots[0].entries.some(entry => entry.path === 'wal.sqlite-wal'));
  assert.ok(!verified.manifest.roots[0].entries.some(entry => entry.path === '.varin-cold-backup.lock'));
  assert.equal(verified.manifest.consistency, 'all-writers-stopped-operator-assertion');
  const restored = restoreColdBackup({ input: f.output, output: path.join(f.root, 'inspection') });
  assert.equal(restored.startup, 'fenced');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored.output, 'data/extensions/identity.json'))), { hostId: 'original-host' });
  assert.equal(fs.readFileSync(path.join(restored.output, 'workspace/relative-link'), 'utf8'), 'original workspace bytes\n');
  const sql = new DatabaseSync(path.join(restored.output, 'data/wal.sqlite'));
  try { assert.equal(sql.prepare('SELECT outcome FROM facts WHERE key=?').get('dispatched-key').outcome, 'unknown'); }
  finally { sql.close(); }
  const { TriviumDB } = require('triviumdb');
  const knowledge = new TriviumDB(path.join(restored.output, 'data/knowledge.tdb'), { dim: 8, syncMode: 'full', autoBuildQuiver: false, loadTextIndex: false });
  try { assert.equal(knowledge.nodeCount(), 2); assert.deepEqual(knowledge.getPayload(pending), { text: 'durable WAL' }); }
  finally { knowledge.close(); }
  // Original owners recover only the isolated copy; the immutable backup stays exact.
  verifyColdBackup(f.output);
  assert.throws(() => activateRecovery({ restoredRoot: restored.output, sourceFenced: true, effectsReviewed: true, bindingsReviewed: true }), /Inspection clones/);
});

test('recovery stays fenced until explicit assertions and can finish an interrupted activation without overwriting assets', t => {
  const f = fixture(t);
  assert.throws(() => createColdBackup({ dataDir: f.data, output: f.output }), /writers-stopped/);
  createColdBackup({ dataDir: f.data, output: f.output, writersStopped: true });
  assert.throws(() => createColdBackup({ dataDir: f.data, output: f.output, writersStopped: true }), /EEXIST/);
  verifyColdBackup(f.output);
  const output = path.join(f.root, 'recovery');
  restoreColdBackup({ input: f.output, output, mode: 'recovery' });
  assert.throws(() => restoreColdBackup({ input: f.output, output, mode: 'recovery' }), /EEXIST/);
  assert.throws(() => activateRecovery({ restoredRoot: output, sourceFenced: true, effectsReviewed: true }), /bindings-reviewed/);
  assert.ok(fs.existsSync(path.join(output, 'data/.varin-offline-restore.json')));
  const activate = () => activateRecovery({ restoredRoot: output, sourceFenced: true, effectsReviewed: true, bindingsReviewed: true });
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === path.join(output, 'data/.varin-offline-restore.json')) throw new Error('injected fence removal failure');
    return unlink(file);
  });
  assert.throws(activate, /injected/);
  assert.ok(fs.existsSync(path.join(output, 'data/.varin-offline-restore.json')));
  const originalReceipt = fs.readFileSync(path.join(output, 'activation.json'), 'utf8');
  t.mock.restoreAll();
  activate();
  assert.ok(!fs.existsSync(path.join(output, 'data/.varin-offline-restore.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'activation.json'))).mode, 'recovery');
  activate();
  assert.equal(fs.readFileSync(path.join(output, 'activation.json'), 'utf8'), originalReceipt);

  const retryRoot = path.join(f.root, 'publication-retry');
  restoreColdBackup({ input: f.output, output: retryRoot, mode: 'recovery' });
  const retry = () => activateRecovery({ restoredRoot: retryRoot, sourceFenced: true, effectsReviewed: true, bindingsReviewed: true });
  const sync = fs.fsyncSync, rootInode = fs.statSync(retryRoot).ino;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).ino === rootInode && fs.existsSync(path.join(retryRoot, 'activation.json'))) throw new Error('injected activation directory sync failure');
    return sync(fd);
  });
  assert.throws(retry, /injected/);
  assert.ok(fs.existsSync(path.join(retryRoot, 'data/.varin-offline-restore.json')));
  t.mock.restoreAll();
  let receiptDirectorySynced = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).ino === rootInode) receiptDirectorySynced = true;
    return sync(fd);
  });
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === path.join(retryRoot, 'data/.varin-offline-restore.json')) assert.ok(receiptDirectorySynced, 'persist activation before removing fence');
    return unlink(file);
  });
  retry();
  t.mock.restoreAll();
});

test('rejects corruption, unlisted assets, escaped links, and overlapping roots before publishing a backup', t => {
  const f = fixture(t);
  fs.symlinkSync('../workspace/note.txt', path.join(f.data, 'escape'));
  assert.throws(() => createColdBackup({ dataDir: f.data, output: f.output, writersStopped: true }), /External symlink/);
  assert.ok(!fs.existsSync(f.output));
  assert.ok(!fs.existsSync(path.join(f.data, '.varin-cold-backup.lock')));
  fs.unlinkSync(path.join(f.data, 'escape'));
  assert.throws(() => createColdBackup({ dataDir: f.data, output: path.join(f.data, 'backup'), writersStopped: true }), /overlap/);
  createColdBackup({ dataDir: f.data, output: f.output, writersStopped: true });
  const identity = path.join(f.output, 'roots/data/extensions/identity.json');
  const original = fs.readFileSync(identity);
  fs.writeFileSync(identity, 'corrupt');
  assert.throws(() => restoreColdBackup({ input: f.output, output: path.join(f.root, 'bad') }), /integrity/);
  assert.ok(!fs.existsSync(path.join(f.root, 'bad')));
  fs.writeFileSync(identity, original);
  fs.writeFileSync(path.join(f.output, 'roots/data/unlisted'), 'not in manifest');
  assert.throws(() => verifyColdBackup(f.output), /integrity/);
  fs.unlinkSync(path.join(f.output, 'roots/data/unlisted'));
  const manifestPath = path.join(f.output, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.roots[0].entries[0].path = '../../private';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyColdBackup(f.output), /integrity/);
});
