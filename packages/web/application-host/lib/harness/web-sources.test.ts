import { expect, it } from 'vitest';
import { captureSearchSource, captureScholarlySource } from './web-sources.js';
import { createMaterialStoreFixture } from './web-materials.test-helper.js';

it('keeps provider observations separate from page reads and from changed source provenance', async () => {
  const f = createMaterialStoreFixture();
  const authority = { kind: 'thread' as const, owningWorkspaceId: 'ws', threadId: 'owner' };
  const hit = { title: 'Discovery', url: 'https://example.com/page', snippet: 'Provider snippet', publishedAt: '2024-01-01', contentKind: 'search-description' as const };
  const first = await captureSearchSource(f.materials, hit, authority, { providerId: 'exa', query: 'query' });
  const same = await captureSearchSource(f.materials, hit, authority, { providerId: 'exa', query: 'query' });
  const other = await captureSearchSource(f.materials, hit, authority, { providerId: 'brave', query: 'query' });
  expect(same.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
  expect(other.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
  expect(first.snapshot).toMatchObject({ representation: 'search-observation-v1', provenance: { kind: 'search-result', contentKind: 'search-description', publishedAt: '2024-01-01' } });
  expect(first.snapshot.fetchedAt).not.toBe(Date.parse(hit.publishedAt));
  expect((await f.reopen().read('ws', first.snapshot.snapshotId, authority))?.body.toString()).toBe('Provider snippet');
  expect(await f.materials.read('ws', first.snapshot.snapshotId, { ...authority, threadId: 'unrelated' })).toBeNull();
  const page = await f.materials.put('ws', { sourceUrl: hit.url, finalUrl: hit.url, representation: 'readability-markdown' }, Buffer.from('Provider snippet'), authority);
  expect(page.snapshotId).not.toBe(first.snapshot.snapshotId);
  expect(page.provenance).toBeUndefined();
  await expect(captureSearchSource(f.materials, { ...hit, url: 'file:///private' }, authority, { providerId: 'exa' })).rejects.toThrow('HTTP(S)');
});

it('retains the exact scholarly record without presenting an abstract or open location as full text', async () => {
  const f = createMaterialStoreFixture();
  const authority = { kind: 'thread' as const, owningWorkspaceId: 'ws', threadId: 'owner' };
  const paper = { provider: 'semantic-scholar' as const, id: 'paper-id', title: 'Record', abstract: 'The abstract.',
    authors: [{ name: 'Author' }], year: 2024, doi: '10.example/paper', content: 'open-location' as const, openAccessUrl: 'https://example.com/paper.pdf' };
  const source = await captureScholarlySource(f.materials, paper, authority, 'operation');
  const observed = await f.materials.read('ws', source.snapshot.snapshotId, authority);
  expect(observed?.ref.provenance).toMatchObject({ providerId: 'semantic-scholar', contentKind: 'paper-metadata', operationId: 'operation' });
  expect(observed?.ref.document).toBeUndefined();
  expect(observed?.ref.provenance?.publishedAt).toBeUndefined();
  expect(JSON.parse(observed!.body.toString().split('\n\n').slice(1).join('\n\n'))).toEqual(paper);
  expect(await f.materials.read('ws', source.snapshot.snapshotId, { ...authority, threadId: 'other' })).toBeNull();
});


it('retains each original excerpt once and labels generated summaries separately', async () => {
  const f = createMaterialStoreFixture();
  const authority = { kind: 'thread' as const, owningWorkspaceId: 'ws', threadId: 'owner' };
  const source = await captureSearchSource(f.materials, { title: 'Excerpt source', url: 'https://example.com/source', snippet: 'First … Second',
    excerpts: ['First', 'Second'], summary: 'Generated conclusion', summaryKind: 'generated-summary', contentKind: 'provider-excerpt' }, authority, { providerId: 'exa' });
  const result = await f.materials.read('ws', source.snapshot.snapshotId, authority);
  expect(result?.body.toString()).toBe('First\n\nSecond\n\nSummary (generated-summary):\nGenerated conclusion');
  expect(result?.ref.provenance?.summaryKind).toBe('generated-summary');
});

it('keeps the producer retrieval time on cache reuse and addresses repeated operation captures directly', async () => {
  const f = createMaterialStoreFixture();
  const authority = { kind: 'thread' as const, owningWorkspaceId: 'ws', threadId: 'owner' };
  const hit = { title: 'Cached source', url: 'https://example.com/cached', snippet: 'Original observation',
    provenance: [{ providerId: 'exa', connectionId: 'default-exa', query: 'q', retrievedAt: 123456 }] };
  const first = await captureSearchSource(f.materials, hit, authority, { providerId: 'exa', operationId: 'original-operation' });
  const restarted = await captureSearchSource(f.reopen(), hit, authority, { providerId: 'exa', operationId: 'original-operation' });
  const later = await captureSearchSource(f.materials, hit, authority, { providerId: 'exa', operationId: 'another-operation' });
  expect(restarted.snapshot).toEqual(first.snapshot);
  expect(later.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
  expect(later.snapshot.fetchedAt).toBe(123456);
});
