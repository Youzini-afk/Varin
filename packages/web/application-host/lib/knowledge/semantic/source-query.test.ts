import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSourceQuery, sourceViewRoots } from './source-query.js';
import { createSemanticGenerationStore } from './store.js';
import { createHashEmbedder } from './embedder.js';
import { createEmbedScheduler } from './embed-scheduler.js';
import { createVectorCache } from './vector-cache.js';
import { contentHashOf, workspaceScope } from './identity.js';
import { packPlainText } from './chunker.js';
import type { SemanticSourceView } from './query-view.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'varin-source-query-'));
  const embedder = createHashEmbedder(), scope = workspaceScope('original-workspace');
  const store = createSemanticGenerationStore({ dataDir, hostId: 'source-query', scope, embedder });
  cleanup.push(async () => { await store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const cache = createVectorCache(), scheduler = createEmbedScheduler();
  let allowed = true;
  const files = new Map([['allowed/a.ts', 'export const privateSource = "fixed source";']]);
  const revision = (body: string) => contentHashOf(body);
  const listFiles = vi.fn(async () => ({ complete: true, files: [...files].map(([path, body]) => ({ path, revision: revision(body) })) }));
  const source: SemanticSourceView = {
    mode: 'fixed_branch', resourceOwner: { kind: 'local' }, resourceRoot: '/removed/original',
    configurationRoot: '/removed/original', cacheWorkspaceId: 'original-workspace', listFiles,
    compute: async () => { throw new Error('Not used by the focused structure port'); },
    validateDocuments: async expected => {
      if (expected.some(file => !files.has(file.path) || revision(files.get(file.path)!) !== file.revision)) throw new Error('source changed');
    },
  };
  const queryVector = vi.fn(async (question: string, cached?: number[]) => cached ?? (await embedder.embed([question], { purpose: 'query' }))[0]!);
  const acquire = async () => {
    const query = await acquireSourceQuery({ scope, source, embedder, roots: ['allowed'], cache, scheduler,
      signal: new AbortController().signal, store: () => store, cacheAuthority: 'query-account', queryVector,
      assertAvailable() {}, authorize: async () => { if (!allowed) throw new Error('source or binding revoked'); } });
    cleanup.push(query.release); return query;
  };
  const publish = async (path: string, body: string, token: number) => {
    await store.publishDocument({ documentId: path, revision: revision(body), publishToken: token,
      chunks: packPlainText({ documentId: path, text: body, maxTokens: embedder.space.maxTokens, countTokens: embedder.countTokens }) });
    await store.markReady(true);
  };
  return { acquire, files, publish, store, listFiles, queryVector, revoke: () => { allowed = false; } };
}

it('does not scan or embed a fixed source when the available publication has different content', async () => {
  const f = await fixture();
  await f.publish('allowed/live-only.ts', 'privateSource fixed source', 1);
  await f.publish('allowed/a.ts', 'live version that must be masked', 1);
  const query = await f.acquire();
  const result = await query.search('privateSource', 20);
  expect(result.hits).toEqual([]);
  expect(result.status.coverage).toBe('partial');
  expect(result.gaps.some(gap => gap.reason === 'content-changed')).toBe(true);
  expect(f.listFiles).not.toHaveBeenCalled();
  f.revoke();
  await expect(query.search('privateSource', 20)).rejects.toThrow('revoked');
});

it('reuses equal source revisions from its captured reader after live replacement without parsing or document embedding', async () => {
  const f = await fixture(), body = f.files.get('allowed/a.ts')!;
  await f.publish('allowed/a.ts', body, 1);
  const query = await f.acquire();
  await f.publish('allowed/a.ts', 'new live text', 2);
  await f.store.removeDocument('allowed/a.ts', 3); await f.store.markReady(true);
  expect((await query.search('privateSource', 20)).hits[0]?.body).toBe(body);
});

it('checks the actual source version after query embedding and retains no stale hit', async () => {
  const f = await fixture();
  await f.publish('allowed/a.ts', f.files.get('allowed/a.ts')!, 1);
  f.queryVector.mockImplementationOnce(async () => {
    f.files.set('allowed/a.ts', 'changed during query embedding');
    return Array(384).fill(0);
  });
  const query = await f.acquire();
  const result = await query.search('privateSource', 20);
  expect(result.hits).toEqual([]);
});

it('intersects source resource coordinates without resolving the former directory', () => {
  expect(sourceViewRoots('/gone/project', ['src'], ['/gone/project/src/nested'])).toEqual(['src/nested']);
  expect(sourceViewRoots('/gone/project', ['src'], ['/another/project'])).toEqual([]);
  expect(sourceViewRoots('C:\\remote\\project', ['src'], undefined)).toEqual(['src']);
  expect(sourceViewRoots('C:\\remote\\project', ['..'], undefined)).toEqual(['.']);
});
