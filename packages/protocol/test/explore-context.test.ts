import assert from 'node:assert/strict';
import { it } from 'node:test';
import { partitionExploreViews } from '../src/explore-context.js';
import type { ExploreQueryView } from '../src/harness.js';

it('keeps related files together ahead of unrelated material when partitioning', async () => {
  const view = (path: string, relatedPaths: string[] = []): ExploreQueryView => ({
    viewId: path, path, revision: 'source', source: 'disk', startLine: 1, endLine: 1,
    text: `original ${path}`, why: 'source', ranges: [], arrivals: [], assessment: 'object-present', purpose: 'candidate', relatedPaths,
  });
  const contract = view('contract.ts', ['implementation.ts']), implementation = view('implementation.ts'), unrelated = view('other.ts');
  const result = await partitionExploreViews([contract, unrelated, implementation], [], async batch => batch.length <= 2);
  assert(result.batches.some(batch => batch.includes(contract) && batch.includes(implementation)));
  assert(result.batches.some(batch => batch.includes(unrelated)));
  assert.deepEqual(result.oversized, []);
  assert(result.batches.every(batch => batch.length <= 2));
});
