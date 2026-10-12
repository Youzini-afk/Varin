import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseVarinRuntimeContractResult, type VarinRuntimeSourceRequest, type VarinRuntimeSourceResult } from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';

const id = 'example.immutable-source';
const text = '\ufeffaé中😀\r\nlast\n';
async function fixture(extra: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'varin-source-contract-'));
  const directory = join(root, 'checkout'); await mkdir(directory);
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3', brokerScript: 'never-loaded' });
  await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { mode: 'brokered', file: 'host.cjs', activation: ['service-request'] } },
    provides: { services: [{ id: 'example.source', version: 1, contract: { methods: {
      read: { inputSchema: true, outputSchema: true, source: { path: 'source.unknown', line: 1 } },
    } } }] } }));
  for (const [path, content] of Object.entries({ 'host.cjs': 'throw Error("Never activate this package");', 'source.unknown': text, 'empty': '', 'binary': Buffer.from([0xc0, 0xaf]), ...extra })) {
    await writeFile(join(directory, path), content);
  }
  const installed = await runtime.packages.installOrStage({ kind: 'local', display: 'Source', specifier: directory }, 0);
  const artifactIntegrity = installed.extensions[0]!.integrity!;
  const request: VarinRuntimeSourceRequest = { action: 'read', kind: 'source', extensionId: id, slot: 'selected', artifactIntegrity, path: 'source.unknown' };
  const read = async (change: Partial<VarinRuntimeSourceRequest> = {}, signal?: AbortSignal): Promise<VarinRuntimeSourceResult> => {
    const result = parseVarinRuntimeContractResult(await runtime.queryContracts({ ...request, ...change }, {}, signal));
    assert.equal(result.kind, 'source');
    return result as VarinRuntimeSourceResult;
  };
  const record = (await runtime.catalog.store.read()).document.extensions[id]!;
  return { root, directory, runtime, request, read, artifactRoot: record.resolvedPath!,
    close: async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('cold metadata exposes original slot identities without package I/O; source pages remain immutable Unicode', async () => {
  const h = await fixture();
  try {
    const original = h.runtime.packages.artifacts.readSource;
    h.runtime.packages.artifacts.readSource = async () => { throw Error('metadata must not read files'); };
    h.runtime.packages.artifacts.prepare = async () => { throw Error('queries must not prepare files'); };
    const description = await h.runtime.queryContracts({ action: 'describe', kind: 'service', serviceId: 'example.source', version: 1,
      member: { kind: 'method', name: 'read' } });
    assert.ok(description.kind === 'service' && description.action === 'describe');
    assert.deepEqual(description.service!.implementations[0]!.artifacts, {
      selected: { extensionId: id, slot: 'selected', artifactIntegrity: h.request.artifactIntegrity }, candidate: null,
    });
    assert.deepEqual(description.member?.contract.source, { path: 'source.unknown', line: 1 });
    h.runtime.packages.artifacts.readSource = original;
    await writeFile(join(h.directory, 'source.unknown'), 'Live checkout changed and must not be read');
    let offset = 0, content = '';
    for (;;) {
      const result = await h.read({ offset, maxBytes: 1 });
      assert.ok(result.status === 'found');
      assert.equal(result.page.offset, offset);
      assert.ok(result.page.byteLength >= 1 && result.page.byteLength <= 4);
      assert.equal(result.page.byteLength, Buffer.byteLength(result.page.text));
      assert.equal(result.page.totalBytes, Buffer.byteLength(text));
      content += result.page.text;
      if (result.page.nextOffset === null) break;
      assert.ok(result.page.nextOffset > offset); offset = result.page.nextOffset;
    }
    assert.equal(content, text);
    const eof = await h.read({ offset: Buffer.byteLength(text), maxBytes: 1 });
    assert.ok(eof.status === 'found'); assert.equal(eof.page.text, ''); assert.equal(eof.page.nextOffset, null);
    const empty = await h.read({ path: 'empty' });
    assert.ok(empty.status === 'found'); assert.equal(empty.page.totalBytes, 0); assert.equal(empty.page.text, '');
    for (const [change, code] of [
      [{ path: 'absent' }, 'source_missing'], [{ path: 'binary' }, 'source_not_utf8'],
      [{ offset: 1 }, 'offset_not_utf8_boundary'], [{ offset: 99 }, 'offset_out_of_range'],
      [{ slot: 'candidate' }, 'candidate_missing'], [{ extensionId: 'example.absent' }, 'extension_missing'],
    ] as const) {
      const result = await h.read(change); assert.ok(result.status !== 'found'); assert.equal(result.code, code);
    }
    assert.equal(h.runtime.services.getSnapshot().providers.length, 0);
    const catalogFile = h.runtime.catalog.store.catalogPath;
    const saved = await readFile(catalogFile, 'utf8');
    await writeFile(catalogFile, '{invalid');
    const staleCatalog = await h.read();
    assert.ok(staleCatalog.status === 'stale'); assert.equal(staleCatalog.code, 'catalog_stale');
    await writeFile(catalogFile, saved);
  } finally { await h.close(); }
});

test('same-version selected and candidate sources never alias, and retained old artifacts become stale', async () => {
  const h = await fixture();
  try {
    await writeFile(join(h.directory, 'source.unknown'), 'Candidate at the same version');
    const staged = await h.runtime.packages.reloadLocalSource({ extensionId: id, expectedRevision: 1 });
    assert.equal(staged.outcome, 'staged');
    const candidate = staged.snapshot.extensions[0]!.candidate!;
    const old = await h.read(); assert.ok(old.status === 'found'); assert.equal(old.page.text, text);
    const next = await h.read({ slot: 'candidate', artifactIntegrity: candidate.integrity });
    assert.ok(next.status === 'found'); assert.equal(next.page.text, 'Candidate at the same version');
    const wrongSlot = await h.read({ artifactIntegrity: candidate.integrity });
    assert.equal(wrongSlot.status, 'stale');
    const requested = await h.runtime.catalog.requestCandidateApplication(id, candidate.integrity, staged.snapshot.revision);
    await h.runtime.packages.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: requested.revision });
    const stale = await h.read(); assert.equal(stale.status, 'stale');
    assert.equal((await readFile(join(h.artifactRoot, 'package', 'source.unknown'))).toString(), text, 'retention does not grant a current read');
    const current = await h.read({ artifactIntegrity: candidate.integrity }); assert.ok(current.status === 'found');
  } finally { await h.close(); }
});

test('owner rechecks the requested slot after I/O without retrying for unrelated catalog changes', async () => {
  const h = await fixture();
  try {
    const original = h.runtime.packages.artifacts.readSource.bind(h.runtime.packages.artifacts);
    let reads = 0;
    h.runtime.packages.artifacts.readSource = async (...args) => {
      reads++;
      const result = await original(...args);
      await h.runtime.catalog.setEnabled(id, false, (await h.runtime.catalog.snapshot()).revision);
      return result;
    };
    assert.equal((await h.read()).status, 'found'); assert.equal(reads, 1);
    h.runtime.packages.artifacts.readSource = async (...args) => {
      const result = await original(...args);
      await writeFile(join(h.directory, 'source.unknown'), 'later');
      const staged = await h.runtime.packages.reloadLocalSource({ extensionId: id, expectedRevision: (await h.runtime.catalog.snapshot()).revision });
      const candidateIntegrity = staged.snapshot.extensions[0]!.candidate!.integrity;
      const requested = await h.runtime.catalog.requestCandidateApplication(id, candidateIntegrity, staged.snapshot.revision);
      await h.runtime.packages.selectCandidate({ extensionId: id, candidateIntegrity, expectedRevision: requested.revision });
      return result;
    };
    assert.equal((await h.read()).status, 'stale');
  } finally { await h.close(); }
});

test('missing immutable artifacts, corrupt indexes/files and symlink escapes stay distinct and do not expose Host paths', async () => {
  const h = await fixture();
  try {
    const sourcePath = join(h.artifactRoot, 'package', 'source.unknown');
    await writeFile(sourcePath, 'tampered');
    let result = await h.read(); assert.equal(result.status, 'corrupt'); assert.ok(!JSON.stringify(result).includes(h.root));
    await writeFile(sourcePath, text);
    await rm(sourcePath); await symlink(join(h.directory, 'source.unknown'), sourcePath);
    assert.equal((await h.read()).status, 'corrupt');
    await rm(sourcePath); await writeFile(sourcePath, text);
    const indexPath = join(h.artifactRoot, 'artifact-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.files['package/source.unknown'].integrity = 'sha256-' + '0'.repeat(64);
    await writeFile(indexPath, JSON.stringify(index));
    assert.equal((await h.read()).status, 'corrupt');
    await rm(h.artifactRoot, { recursive: true });
    result = await h.read(); assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'artifact_unavailable');
    const record = (await h.runtime.catalog.store.read()).document.extensions[id]!;
    delete record.integrity; delete record.resolvedPath;
    await h.runtime.catalog.upsert(record, (await h.runtime.catalog.snapshot()).revision);
    result = await h.read(); assert.ok(result.status !== 'found'); assert.equal(result.code, 'artifact_unmaterialized');
    const description = await h.runtime.queryContracts({ action: 'list', kind: 'service' });
    assert.ok(description.kind === 'service' && description.action === 'list');
    assert.equal(description.entries[0]!.implementations[0]!.artifacts.selected, null);
  } finally { await h.close(); }
});

test('a long verified source read yields control and cancellation closes its actual file stream', async () => {
  const h = await fixture({ large: '𠮷'.repeat(2 * 1024 * 1024) });
  const controller = new AbortController();
  const original = fs.createReadStream;
  let streamClosed: Promise<void> | undefined, observed = false, closed = false;
  try {
    fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = original(...args);
      if (String(args[0]).endsWith('/package/large')) {
        observed = true;
        streamClosed = new Promise(resolve => stream.once('close', () => { closed = true; resolve(); }));
        stream.once('data', () => {
          void h.runtime.queryContracts({ action: 'list', kind: 'service' }).then(() => controller.abort(new Error('source cancelled')));
        });
      }
      return stream;
    }) as typeof fs.createReadStream;
    syncBuiltinESMExports();
    await assert.rejects(h.read({ path: 'large', maxBytes: 1 }, controller.signal), /source cancelled/);
    assert.equal(observed, true);
    assert.equal(closed, true, 'read cancellation settles after actual file stream close');
    await streamClosed;
    assert.equal((await h.read()).status, 'found');
  } finally {
    fs.createReadStream = original; syncBuiltinESMExports(); await h.close();
  }
});
