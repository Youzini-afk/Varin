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
import type { StructureSource } from '../../structure/types.js';

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
  const unitsFixed = vi.fn(async (request: { path: string }) => {
    const body = files.get(request.path)!;
    return { status: 'ready' as const, revision: revision(body), recipeId: 'recipe-1',
      units: [{ startLine: 1, endLine: 1, parentName: '', parentKind: 'file', parentSignature: '', docComments: '', text: body, fallback: true }] };
  });
  const structure: StructureSource = { unitsRecipe: async () => 'recipe-1', unitsFixed,
    outline: async () => { throw new Error('not used'); }, classifyHits: async () => { throw new Error('not used'); },
    literalCalls: async () => { throw new Error('not used'); }, imports: async () => { throw new Error('not used'); } };
  const documentVectors = vi.fn(async (texts: readonly string[]) => embedder.embed(texts, { purpose: 'document' }));
  const queryVector = vi.fn(async (question: string, cached?: number[]) => cached ?? (await embedder.embed([question], { purpose: 'query' }))[0]!);
  const acquire = async () => {
    const query = await acquireSourceQuery({ scope, source, embedder, roots: ['allowed'], structure, cache, scheduler,
      signal: new AbortController().signal, store: () => store, cacheAuthority: 'query-account', documentVectors, queryVector,
      assertAvailable() {}, authorize: async () => { if (!allowed) throw new Error('source or binding revoked'); } });
    cleanup.push(query.release); return query;
  };
  const publish = async (path: string, body: string, token: number) => {
    await store.publishDocument({ documentId: path, revision: revision(body), publishToken: token,
      chunks: packPlainText({ documentId: path, text: body, maxTokens: embedder.space.maxTokens, countTokens: embedder.countTokens }) });
    await store.markReady(true);
  };
  return { acquire, files, publish, store, listFiles, unitsFixed, documentVectors, queryVector, revoke: () => { allowed = false; } };
}

it('captures without source work, freezes its base, masks every unrelated live row, and reuses completed source material', async () => {
  const f = await fixture();
  await f.publish('allowed/live-only.ts', 'privateSource fixed source', 1);
  await f.publish('allowed/a.ts', 'live version that must be masked', 1);
  const query = await f.acquire();
  expect(f.listFiles).not.toHaveBeenCalled(); expect(f.documentVectors).not.toHaveBeenCalled();
  await f.publish('allowed/a.ts', 'new live publication', 2);
  const result = await query.search('privateSource', 20);
  expect(result.hits.map(hit => hit.documentId)).toEqual(['allowed/a.ts']);
  expect(result.hits[0]?.body).toBe(f.files.get('allowed/a.ts'));
  expect(f.unitsFixed).toHaveBeenCalledOnce(); expect(f.documentVectors).toHaveBeenCalledOnce();
  expect(result.status.coverage).toBe('complete');
  await query.search('another question', 20);
  expect(f.listFiles).toHaveBeenCalledOnce(); expect(f.unitsFixed).toHaveBeenCalledOnce();
  await query.release();
  const again = await f.acquire(); await again.search('privateSource', 20);
  expect(f.listFiles).toHaveBeenCalledTimes(2); expect(f.unitsFixed).toHaveBeenCalledOnce(); expect(f.documentVectors).toHaveBeenCalledOnce();
  f.revoke();
  await expect(again.search('privateSource', 20)).rejects.toThrow('revoked');
  expect(f.documentVectors).toHaveBeenCalledOnce();
});

it('reuses equal source revisions from its captured reader after live replacement without parsing or document embedding', async () => {
  const f = await fixture(), body = f.files.get('allowed/a.ts')!;
  await f.publish('allowed/a.ts', body, 1);
  const query = await f.acquire();
  await f.publish('allowed/a.ts', 'new live text', 2);
  await f.store.removeDocument('allowed/a.ts', 3); await f.store.markReady(true);
  expect((await query.search('privateSource', 20)).hits[0]?.body).toBe(body);
  expect(f.unitsFixed).not.toHaveBeenCalled(); expect(f.documentVectors).not.toHaveBeenCalled();
});

it('keeps an actual source change from installing source material after model preparation', async () => {
  const f = await fixture();
  f.documentVectors.mockImplementationOnce(async texts => {
    f.files.set('allowed/a.ts', 'changed during provider work');
    return texts.map(() => Array(384).fill(0));
  });
  const query = await f.acquire();
  const first = await query.search('privateSource', 20);
  expect(first.hits).toEqual([]); expect(first.status.coverage).toBe('empty');
  await query.release();
  const next = await f.acquire(); await next.search('changed', 20);
  expect(f.unitsFixed).toHaveBeenCalledTimes(2); expect(f.documentVectors).toHaveBeenCalledTimes(2);
});

it('intersects source resource coordinates without resolving the former directory', () => {
  expect(sourceViewRoots('/gone/project', ['src'], ['/gone/project/src/nested'])).toEqual(['src/nested']);
  expect(sourceViewRoots('/gone/project', ['src'], ['/another/project'])).toEqual([]);
  expect(sourceViewRoots('C:\\remote\\project', ['src'], undefined)).toEqual(['src']);
  expect(sourceViewRoots('C:\\remote\\project', ['..'], undefined)).toEqual(['.']);
});
