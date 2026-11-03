import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ApplicationExtensionCatalog, ApplicationExtensionRuntime, ExtensionStorageStore } from '../src/index.js';
import type { VarinExtensionInstallationRecord } from '@varin/extension-contract';

const extensionId = 'example.publication';
const oldIntegrity = `sha256-${'a'.repeat(64)}`;
const newIntegrity = `sha256-${'b'.repeat(64)}`;
const address = (key: string) => ({ extensionId, scope: 'application' as const, key });
async function fixture(requestApplication = true) {
  const root = await mkdtemp(join(tmpdir(), 'varin-storage-publication-'));
  const catalog = new ApplicationExtensionCatalog({ dataDir: root });
  const storage = new ExtensionStorageStore(root);
  const now = new Date().toISOString();
  const manifest = { schemaVersion: 1 as const, id: extensionId, version: '1.0.0', engines: { varin: '*' }, capabilities: { host: ['workspace.files'] } };
  const record: VarinExtensionInstallationRecord = {
    manifest, source: { kind: 'local', display: 'original', specifier: root },
    resolvedVersion: '1.0.0', selectedVersion: '1.0.0', integrity: oldIntegrity, resolvedPath: root,
    capabilityGrants: [{ capability: 'workspace.files', realm: 'host', granted: true, manifestVersion: '1.0.0', updatedAt: now }], desired: { enabled: true, revision: 1, updatedAt: now }, installedAt: now, updatedAt: now,
  };
  let snapshot = await catalog.upsert(record, 0);
  snapshot = await catalog.stageCandidate({ manifest: { ...manifest, version: '2.0.0' }, source: record.source,
    resolvedVersion: '2.0.0', resolvedPath: root, integrity: newIntegrity, preparedAt: now }, snapshot.revision);
  if (requestApplication) await catalog.requestCandidateApplication(extensionId, newIntegrity, snapshot.revision);
  for (const key of ['first', 'second']) await storage.update(address(key), 0, 1, { key });
  return { root, catalog, storage, publication: { extensionId, previousIntegrity: oldIntegrity, candidateIntegrity: newIntegrity },
    resolve: (publication: Parameters<typeof catalog.store.resolveStoragePublication>[0], id: string) => catalog.store.resolveStoragePublication(publication, id),
    close: () => rm(root, { force: true, recursive: true }) };
}
async function crash(root: string, point: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-publication-crash.mjs', import.meta.url)), root, point], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const status = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.notEqual(status.code, 0, output);
  assert.equal(await readFile(join(root, 'crash-point'), 'utf8'), point, output);
}
for (const point of ['first-document', 'before-catalog', 'after-catalog']) {
  test(`real process crash at ${point} recovers the original Catalog decision and whole data group`, { timeout: 30_000 }, async () => {
    const h = await fixture();
    try {
      await crash(h.root, point);
      const storage = new ExtensionStorageStore(h.root);
      const catalog = new ApplicationExtensionCatalog({ dataDir: h.root });
      await storage.recoverPublications((publication, id) => catalog.store.resolveStoragePublication(publication, id));
      const committed = point === 'after-catalog';
      assert.equal((await catalog.snapshot()).extensions[0]!.manifest.version, committed ? '2.0.0' : '1.0.0');
      for (const key of ['first', 'second']) {
        const snapshot = await storage.read(address(key));
        assert.equal(snapshot.document.schemaVersion, committed ? 2 : 1);
        assert.deepEqual(snapshot.document.data, committed ? { key, migrated: true } : { key });
      }
      assert.deepEqual((await readdir(join(h.root, 'extensions', 'storage-publications'))).filter(name => name.endsWith('.json')), []);
      await storage.recoverPublications((publication, id) => catalog.store.resolveStoragePublication(publication, id));
    } finally { await h.close(); }
  });
}

test('a lost commit response never rolls back committed data; revoked grants are not restored', async () => {
  const h = await fixture();
  try {
    const transaction = await h.storage.prepareMigration(address('first'), 2, () => ({ migrated: true }));
    assert.ok(transaction);
    await assert.rejects(h.storage.publishPrepared([transaction], h.publication, async id => {
      await h.catalog.selectCandidate(extensionId, newIntegrity, (await h.catalog.snapshot()).revision, undefined, undefined, id);
      throw new Error('lost response');
    }, h.resolve), /lost response/);
    await h.catalog.reviewCapabilities({ extensionId, expectedRevision: (await h.catalog.snapshot()).revision, decisions: [{ realm: 'host', capability: 'workspace.files', granted: false }] });
    await h.catalog.setEnabled(extensionId, false, (await h.catalog.snapshot()).revision);
    await h.storage.recoverPublications(h.resolve);
    assert.equal((await h.catalog.snapshot()).extensions[0]!.desired.enabled, false);
    assert.equal((await h.catalog.snapshot()).extensions[0]!.capabilityGrants[0]!.granted, false);
    assert.equal((await h.storage.read(address('first'))).document.schemaVersion, 2);
    await assert.rejects(h.storage.update(address('first'), 2, 1, { old: true }, 1), /schema changed/);
  } finally { await h.close(); }
});

test('unreadable Catalog keeps the publication evidence and data untouched for explicit recovery', async () => {
  const h = await fixture();
  try {
    await crash(h.root, 'before-catalog');
    await writeFile(h.catalog.store.catalogPath, '{ broken');
    const before = await h.storage.read(address('first'));
    const catalog = new ApplicationExtensionCatalog({ dataDir: h.root });
    await assert.rejects(h.storage.recoverPublications((publication, id) => catalog.store.resolveStoragePublication(publication, id)));
    assert.deepEqual((await h.storage.read(address('first'))).document, before.document);
    assert.equal((await readdir(join(h.root, 'extensions', 'storage-publications'))).filter(name => name.endsWith('.json')).length, 1);
  } finally { await h.close(); }
});

for (const lostResponse of [false, true]) {
  test(`Runtime removal consumes publication before deleting data (lost response: ${lostResponse})`, async () => {
    const h = await fixture(false);
    const options = { dataDir: h.root, brokerScript: '', varinVersion: '1.2.3' };
    const runtime = await ApplicationExtensionRuntime.create({ ...options, catalog: h.catalog, storage: h.storage });
    let restarted: ApplicationExtensionRuntime | undefined;
    try {
      await runtime.start();
      await h.catalog.requestCandidateApplication(extensionId, newIntegrity, (await h.catalog.snapshot()).revision);
      const migration = await h.storage.prepareMigration(address('first'), 2, () => ({ upgraded: true }));
      assert.ok(migration);
      const publish = h.storage.publishPrepared([migration], h.publication, async id => {
        await h.catalog.selectCandidate(extensionId, newIntegrity, (await h.catalog.snapshot()).revision, undefined, undefined, id);
        if (lostResponse) throw new Error('lost commit response');
      }, h.resolve);
      if (lostResponse) await assert.rejects(publish, /lost commit response/);
      else await publish;
      await runtime.setEnabled(extensionId, false, (await h.catalog.snapshot()).revision);
      await runtime.removeExtension({ extensionId, expectedRevision: (await h.catalog.snapshot()).revision, deleteData: true });
      await runtime.stop();
      restarted = await ApplicationExtensionRuntime.create(options);
      await restarted.start();
      assert.equal((await restarted.storage.read(address('first'))).exists, false, 'explicit removal must never resurrect migrated data');
      assert.equal((await restarted.catalog.snapshot()).extensions.some(entry => entry.manifest.id === extensionId), false);
    } finally { await restarted?.stop(); await runtime.stop(); await h.close(); }
  });
}
