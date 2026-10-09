import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createSemanticStoreEngine } from './store-engine.js';
import { createSemanticGenerationStore } from './store.js';
import { createHashEmbedder } from './embedder.js';
import { blockIdentity, contentHashOf, workspaceScope } from './identity.js';
import type { SemanticChunk } from './chunker.js';

const dirs: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.useRealTimers(); for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const chunk = (documentId: string, body: string): SemanticChunk => ({ documentId, blockId: blockIdentity(documentId, 1, 1), parentUnitId: documentId, parentName: 'f', parentKind: 'function', parentSignature: 'function f()', startLine: 1, endLine: 1, contentHash: contentHashOf(body), body, embedText: body, fallback: false });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'varin-published-review-')); dirs.push(dataDir);
  const space = { ...createHashEmbedder().space, dim: 2 };
  const options = { dataDir, hostId: 'review', scope: workspaceScope('review'), space };
  const store = createSemanticStoreEngine(options); stores.push(store);
  const publish = (body: string, token: number, documentId = 'a.ts', vector = [1, 0]) => store.publishDocuments([{ documentId, revision: `file-${token}`, chunks: [chunk(documentId, body)], vectors: [vector], publishToken: token }]);
  return { store, options, dataDir, publish };
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) visit(file); else result[file] = createHash('sha256').update(readFileSync(file)).digest('hex'); } };
  visit(root); return result;
}

describe('independent immutable publication reader acceptance', () => {
  it('a cold reader acquire does not materialize or publish an empty database', async () => {
    const f = fixture(); const before = files(f.dataDir);
    expect(await f.store.retainPublished()).toBeNull();
    expect(files(f.dataDir)).toEqual(before);
  });

  it('pins old bytes while new publication and deletion become visible only to new readers', async () => {
    const f = fixture(); await f.publish('OLD_PUBLICATION', 1); f.store.markReady(true);
    const old = (await f.store.retainPublished())!; expect(old).not.toBeNull();
    const oldResult = await f.store.searchPinned(old.token, [1, 0], 10);
    expect(oldResult.map(hit => hit.body)).toEqual(['OLD_PUBLICATION']);
    await f.publish('NEW_PUBLICATION', 2); f.store.markReady(true);
    const next = (await f.store.retainPublished())!;
    expect(next.publicationId).not.toBe(old.publicationId);
    expect(next.ownerEpoch).toBe(old.ownerEpoch);
    expect(await f.store.searchPinned(old.token, [1, 0], 10)).toEqual(oldResult);
    expect((await f.store.searchPinned(next.token, [1, 0], 10))[0]?.body).toBe('NEW_PUBLICATION');
    await f.store.removeDocument('a.ts', 3); f.store.markReady(true);
    const empty = (await f.store.retainPublished())!;
    expect(await f.store.searchPinned(empty.token, [1, 0], 10)).toEqual([]);
    expect(await f.store.searchPinned(old.token, [1, 0], 10)).toEqual(oldResult);
    await f.store.releasePinned(old.token); await f.store.releasePinned(old.token);
    await expect(f.store.searchPinned(old.token, [1, 0], 10)).rejects.toThrow();
    await f.store.releasePinned(next.token); await f.store.releasePinned(empty.token);
    expect(f.store.publishedReaderStats()).toMatchObject({ activeReaders: 0, retainedPublications: 1 });
  });

  it('batches publication at quiet/busy checkpoint boundaries and never copies on acquire/search', async () => {
    vi.useFakeTimers();
    const { TriviumDB } = createRequire(import.meta.url)('triviumdb') as typeof import('triviumdb');
    const manifests = vi.spyOn(TriviumDB.prototype, 'publishGenerationManifest');
    const f = fixture(); f.store.markBuilding('building');
    await f.publish('one', 1); await f.publish('two', 2); await f.publish('three', 3);
    expect(manifests).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999); expect(manifests).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(manifests).toHaveBeenCalledTimes(1);
    f.store.markReady(true);
    const baseline = manifests.mock.calls.length;
    const before = files(f.dataDir);
    for (let i = 0; i < 4; i++) { const reader = (await f.store.retainPublished())!; await f.store.searchPinned(reader.token, [1, 0], 5); await f.store.releasePinned(reader.token); }
    expect(manifests).toHaveBeenCalledTimes(baseline); expect(files(f.dataDir)).toEqual(before);
    await f.publish('four', 4); await f.publish('five', 5);
    await vi.advanceTimersByTimeAsync(249); expect(manifests).toHaveBeenCalledTimes(baseline);
    await vi.advanceTimersByTimeAsync(1); expect(manifests).toHaveBeenCalledTimes(baseline + 1);
  });

  it('pins coverage metadata independently and keeps scoped block caches isolated across replacement', async () => {
    const f = fixture();
    await f.publish('allowed old', 1, 'allowed/a.ts'); await f.publish('private old', 1, 'private/b.ts', [0, 1]);
    f.store.markReady(false);
    const partial = (await f.store.retainPublished())!;
    expect(partial.checkpoint.coverage).toBe('partial');
    expect((await f.store.searchPinned(partial.token, [1, 0], 5, ['allowed'])).map(hit => hit.documentId)).toEqual(['allowed/a.ts']);
    f.store.markReady(true);
    const complete = (await f.store.retainPublished())!;
    expect(complete.checkpoint.coverage).toBe('complete'); expect(partial.checkpoint.coverage).toBe('partial');
    expect(complete.publicationId).not.toBe(partial.publicationId);
    expect(f.store.publishedReaderStats()).toEqual({ activeReaders: 2, retainedPublications: 1 });
    await f.publish('allowed new', 2, 'allowed/c.ts'); await f.store.removeDocument('allowed/a.ts', 2); f.store.markReady(true);
    const replaced = (await f.store.retainPublished())!;
    expect((await f.store.searchPinned(replaced.token, [1, 0], 5, ['allowed'])).map(hit => hit.documentId)).toEqual(['allowed/c.ts']);
    expect((await f.store.searchPinned(partial.token, [1, 0], 5, ['allowed'])).map(hit => hit.documentId)).toEqual(['allowed/a.ts']);
    expect(f.store.publishedReaderStats()).toEqual({ activeReaders: 3, retainedPublications: 2 });
    await f.store.releasePinned(partial.token); await f.store.releasePinned(complete.token);
    expect(f.store.publishedReaderStats()).toEqual({ activeReaders: 1, retainedPublications: 1 });
    await f.store.releasePinned(replaced.token);
  });

  it('failed publication preserves a previously retained reader and cannot relabel pending writer bytes as published', async () => {
    const { TriviumDB } = createRequire(import.meta.url)('triviumdb') as typeof import('triviumdb');
    const manifest = vi.spyOn(TriviumDB.prototype, 'publishGenerationManifest');
    const f = fixture(); await f.publish('SAFE_OLD', 1); f.store.markReady(true);
    const old = (await f.store.retainPublished())!;
    await f.publish('PENDING_NEW', 2);
    manifest.mockImplementationOnce(() => { throw new Error('independent publication failure'); });
    expect(() => f.store.markReady(true)).toThrow('independent publication failure');
    // Reader-only work must not retry publication or expose the pending writer.
    expect((await f.store.searchPinned(old.token, [1, 0], 1))[0]?.body).toBe('SAFE_OLD');
    const retained = (await f.store.retainPublished())!;
    expect(retained.publicationId).toBe(old.publicationId);
    expect((await f.store.searchPinned(retained.token, [1, 0], 1))[0]?.body).toBe('SAFE_OLD');
    await f.store.releasePinned(retained.token);
    f.store.markReady(true);
    const current = (await f.store.retainPublished())!;
    expect((await f.store.searchPinned(current.token, [1, 0], 1))[0]?.body).toBe('PENDING_NEW');
    expect(current.publicationId).not.toBe(old.publicationId);
    await f.store.releasePinned(old.token); await f.store.releasePinned(current.token);
  });

  it('a token cannot cross owner epochs and close invalidates all retained readers', async () => {
    const f = fixture(); await f.publish('retained', 1); f.store.markReady(true);
    const old = (await f.store.retainPublished())!;
    await f.store.close(); expect(f.store.publishedReaderStats()).toEqual({ activeReaders: 0, retainedPublications: 0 });
    await expect(f.store.searchPinned(old.token, [1, 0], 1)).rejects.toThrow();
    const reopened = createSemanticStoreEngine(f.options); stores.push(reopened);
    await expect(reopened.searchPinned(old.token, [1, 0], 1)).rejects.toThrow();
    const current = (await reopened.retainPublished())!;
    expect(current.token).not.toBe(old.token); expect(current.ownerEpoch).not.toBe(old.ownerEpoch); expect((await reopened.searchPinned(current.token, [1, 0], 1))[0]?.body).toBe('retained');
    await reopened.releasePinned(current.token);
  });

  it('Host cold retain does not start a worker-backed store, and concurrent close settles acquisition without a leaked reader', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'varin-published-cold-ipc-review-')); dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const store = createSemanticGenerationStore({ dataDir, hostId: 'cold-ipc-review', scope: workspaceScope('cold-ipc-review'), embedder }); stores.push(store);
    expect(await store.retainPublished()).toBeNull(); expect(files(dataDir)).toEqual({});
    const abort = new AbortController(); abort.abort(new Error('cold cancellation'));
    await expect(store.retainPublished(abort.signal)).rejects.toThrow('cold cancellation'); expect(files(dataDir)).toEqual({});
    await store.publishDocument({ documentId: 'a.ts', revision: 'r1', chunks: [chunk('a.ts', 'close race')] }); await store.markReady(true);
    const retaining = store.retainPublished(); const closing = store.close();
    await expect(retaining).rejects.toThrow(/closing|closed/); await closing;
    expect(await store.publishedReaderStats()).toEqual({ activeReaders: 0, retainedPublications: 0 });
  });

  it('private storage IPC pins and releases actual native reader data without calling an embedding model per query', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'varin-published-ipc-review-')); dirs.push(dataDir);
    const embedder = createHashEmbedder(); const calls = vi.spyOn(embedder, 'embed');
    const store = createSemanticGenerationStore({ dataDir, hostId: 'ipc-review', scope: workspaceScope('ipc-review'), embedder }); stores.push(store);
    await store.publishDocument({ documentId: 'a.ts', revision: 'revision-before', chunks: [chunk('a.ts', 'older text')] }); await store.markReady(true);
    const old = (await store.retainPublished())!;
    const query = (await embedder.embed(['older text']))[0]!;
    const count = calls.mock.calls.length;
    expect((await store.searchPinned(old.token, query, 5))[0]?.revision).toBe('revision-before'); expect(calls).toHaveBeenCalledTimes(count);
    await store.publishDocument({ documentId: 'a.ts', revision: 'revision-after', chunks: [chunk('a.ts', 'newer text')], publishToken: 2 }); await store.markReady(true);
    expect((await store.searchPinned(old.token, query, 5))[0]?.revision).toBe('revision-before');
    await store.releasePinned(old.token); await expect(store.searchPinned(old.token, query, 5)).rejects.toThrow();
  });
});
