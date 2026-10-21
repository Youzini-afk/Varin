import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { remoteEmbeddingSpaceParts } from '@varin/protocol';
import { createSemanticInferenceLedgerEngine } from './inference-ledger-engine.js';
import { semanticInferenceOperationKey } from './inference-ledger-contract.js';
import { removeSemanticPublications } from './published-readers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'varin-ledger-retention-'));
  const options = { dataDir: root, hostId: 'retention' };
  let ledger = createSemanticInferenceLedgerEngine(options);
  cleanups.push(async () => { await ledger.close(); removeSemanticPublications(root); });
  const space = { providerId: 'provider', modelId: 'model', protocol: 'openai-compatible' as const,
    configurationId: 'config', maxTokens: 100, dim: 2, spaceId: '' };
  space.spaceId = hash(JSON.stringify(remoteEmbeddingSpaceParts({ ...space, dimensions: space.dim }))).slice(0, 16);
  async function admit(name: string, workspaceId = 'workspace') {
    const identity = { ...space, endpointHash: hash('endpoint'), credentialScopeHash: hash('scope'), dimensions: 2,
      operation: { kind: 'index-build' as const, hostId: 'retention', workspaceId, recipeId: 'recipe', stage: 'document-embedding' as const }, inputHashes: [hash(name)] };
    const receipt = { batchId: name, providerId: space.providerId, modelId: space.modelId, configurationId: space.configurationId,
      purpose: 'index-document-embedding' as const, inputItems: 1, inputBytes: name.length,
      attempts: 0, attemptsKnown: false, state: 'indeterminate' as const, usage: { status: 'unknown' as const } };
    const admitted = await ledger.admit({ identity, receipt, key: semanticInferenceOperationKey(identity, receipt.purpose) });
    if (admitted.status !== 'admitted') throw new Error('Expected original admission');
    return { token: admitted.token, receipt, identity, complete: () => ledger.settle(admitted.token, {
      receipt: { ...receipt, state: 'succeeded', attempts: 1, attemptsKnown: true },
      result: { batchId: name, space, items: [{ id: name, index: 0, vector: [1, 0] }] },
    }) };
  }
  return { get ledger() { return ledger; }, space, admit,
    reopen: async () => { await ledger.close(); ledger = createSemanticInferenceLedgerEngine(options); } };
}

it('releases entire published receipts while preserving unpublished results and live transports', async () => {
  const f = await fixture();
  const published = await f.admit('published'); await published.complete();
  const unpublished = await f.admit('unpublished'); await unpublished.complete();
  const other = await f.admit('other', 'another-workspace'); await other.complete();
  await f.admit('live');
  expect(f.ledger.collectPublished('workspace', f.space.spaceId, key => key === hash('published'))).toBe(1);
  expect((await f.ledger.list()).map(entry => entry.receipt.batchId).sort()).toEqual(['live', 'other', 'unpublished']);
  await f.reopen();
  expect((await f.ledger.list()).map(entry => entry.receipt.batchId).sort()).toEqual(['live', 'other', 'unpublished']);
});

it('index removal releases old records and waits for each original live transport, including across restart', async () => {
  const f = await fixture();
  const done = await f.admit('done'); await done.complete();
  const live = await f.admit('live');
  const interrupted = await f.admit('interrupted');
  await f.ledger.retireScope('workspace');
  expect((await f.ledger.list()).map(entry => entry.receipt.batchId).sort()).toEqual(['interrupted', 'live']);
  // New work does not cancel an older admission's retirement.
  const fresh = await f.admit('fresh'); await fresh.complete();
  await f.ledger.settle(live.token, { receipt: live.receipt, transportStopped: true });
  expect((await f.ledger.list()).map(entry => entry.receipt.batchId).sort()).toEqual(['fresh', 'interrupted']);
  await f.reopen();
  expect((await f.ledger.list()).map(entry => entry.receipt.batchId)).toEqual(['fresh']);
  expect(interrupted.token).toBeTruthy();
});
