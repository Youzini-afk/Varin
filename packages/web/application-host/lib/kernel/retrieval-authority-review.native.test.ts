import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { LiveRoot } from './protocol.generated.js';
import { retrievalFixture, responseTool, responseDone, latestOutput, deferred } from './retrieval-review.test-helper.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async (reply: Parameters<typeof retrievalFixture>[0]) => { const f = await retrievalFixture(reply); cleanups.push(f.dispose); return f; };
const revision = (text: string) => `d1_${createHash('sha256').update(text).digest('base64url')}`;
const askOnce = (body: Record<string, unknown>, response: Parameters<typeof responseDone>[0]) => latestOutput(body)
  ? responseDone(response) : responseTool(response, 'code_retrieval', { question: 'retrievalNeedle' });
const plan = () => ({ id: 'independent-test-plan', configurationGeneration: 7,
  stages: [{ kind: 'keyword' as const, providerId: 'fixture-keyword', configurationId: '7', status: 'ready' as const }, ...(['structure', 'semantic', 'model'] as const).map(kind => ({ kind, providerId: 'none', configurationId: 'disabled', status: 'disabled' as const }))] });
const source = (query: { workspaceId: string; executionWorkspaceId: string; liveRoot: LiveRoot }) => ({ mode: 'live_root' as const, workspaceId: query.workspaceId, executionWorkspaceId: query.executionWorkspaceId, liveRoot: query.liveRoot });
const stages = () => [{ kind: 'keyword' as const, status: 'ready' as const }, ...(['structure', 'semantic', 'model'] as const).map(kind => ({ kind, status: 'disabled' as const }))];
const omissions = () => ({ outOfScope: 0, stale: 0, unavailable: 0 });

it('a retrieval tool with no Host owner reports unavailable and records a real tool result', async () => {
  const f = await fixture(askOnce);
  await f.write('source.ts', 'export const retrievalNeedle = 1;\n');
  const run = await f.admit('missing-retrieval-owner', ['code_retrieval']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[0]!.tools)).toContain('code_retrieval');
  expect(JSON.stringify(latestOutput(f.requests[1]!))).toMatch(/unavailable/);
  expect((await f.runtime.history(run.branchId)).some(item => item.source === 'tool')).toBe(true);
}, 20_000);

it.each(['fixed_branch', 'materialized'] as const)('rejects %s retrieval before model dispatch rather than using the live index', async mode => {
  const f = await fixture(askOnce);
  await f.write('source.ts', 'export const retrievalNeedle = 1;\n');
  const run = await f.admit(`retrieval-${mode}`, ['code_retrieval']);
  const actor = f.kernel.scoped(run.grant);
  const bytes = Buffer.from('export const retrievalNeedle = 2;\n');
  const blob = await actor.putBlob(bytes, 'retrieval-fixed-object');
  await actor.createBranch({ operationId: 'retrieval-fixed-create', branchId: 'retrieval-fixed', workspaceId: f.workspaceId, draftBasePaths: [], captureScopes: [],
    entries: [{ path: 'source.ts', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const root = await actor.readBranch({ branchId: 'retrieval-fixed' });
  const published = await actor.publishBranch({ operationId: 'retrieval-fixed-publish', branchId: 'retrieval-fixed', expectedRoot: root.root, expectedWriteRevision: root.writeRevision });
  const lineage = { branchId: 'retrieval-fixed', revision: Number(published.revision) };
  await expect(f.runtime.startRun(run.receipt.run_id, undefined, { ...run.binding, sourceMode: mode, liveRoot: undefined,
    ...(mode === 'fixed_branch' ? { rootId: undefined, fileSource: lineage } : { materializedSource: lineage }) })).rejects.toThrow(/retrieval|live_root|source/i);
  expect(f.requests).toEqual([]);
  await f.runtime.cancelRun(run.receipt.run_id);
}, 20_000);

it('revalidates grant scope, symlink escapes and snippet revisions, rebuilding accepted text from actual source', async () => {
  const f = await fixture(askOnce);
  const allowed = 'export function retrievalNeedle() {\n  return 42;\n}\n';
  const privateText = 'PRIVATE_RETRIEVAL_INDEX_BODY';
  await f.write('allowed/source.ts', allowed);
  await f.write('private.ts', privateText);
  const outside = path.join(f.documents.root, 'outside.ts'); await fs.writeFile(outside, 'OUTSIDE_RETRIEVAL_INDEX_BODY');
  await fs.symlink(outside, path.join(f.documents.workspaceRoot, 'allowed/escape.ts'));
  const outsideDir = path.join(f.documents.root, 'outside-directory'); await fs.mkdir(outsideDir); await fs.writeFile(path.join(outsideDir, 'private.ts'), 'OUTSIDE_DIRECTORY_SECRET');
  await fs.symlink(outsideDir, path.join(f.documents.workspaceRoot, 'allowed/escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  let ownerCalls = 0;
  f.kernel.setRetrievalOwner(async query => {
    ownerCalls++;
    expect(query).toMatchObject({ runId: expect.any(String), threadId: 'retrieval-result-authority-thread', grantId: 'retrieval-result-authority-grant', workspaceId: f.workspaceId });
    expect(query).not.toHaveProperty('sessionId');
    const snippet = (file: string, rev = revision(allowed), startLine = 1, endLine = 3) => ({ path: file, revision: rev, startLine, endLine, content: 'FORGED_INDEX_CONTENT_MUST_NOT_REACH_HISTORY' });
    return { status: 'ready', plan: plan(), source: source(query), snippets: [
      snippet('allowed/source.ts'), snippet('private.ts', revision(privateText), 1, 1), snippet('../outside.ts'),
      snippet('allowed/escape.ts'), snippet('allowed/escape-dir/private.ts'), snippet('allowed/missing.ts'),
      snippet('allowed/source.ts', 'd1_old_revision'), snippet('allowed/source.ts', revision(allowed), 1, 900),
      snippet('allowed/source.ts', revision(allowed), 3, 1),
    ], omissions: omissions(), stages: stages() };
  });
  const run = await f.admit('retrieval-result-authority', ['code_retrieval'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(ownerCalls).toBe(1);
  const result = latestOutput(f.requests[1]!)!;
  expect(result).toMatchObject({ outcome: 'succeeded', content: { status: 'partial', snippets: [expect.objectContaining({ path: 'allowed/source.ts', revision: revision(allowed), content: allowed.trimEnd() })] } });
  for (const marker of ['PRIVATE_RETRIEVAL_INDEX_BODY', 'OUTSIDE_RETRIEVAL_INDEX_BODY', 'OUTSIDE_DIRECTORY_SECRET', 'FORGED_INDEX_CONTENT_MUST_NOT_REACH_HISTORY']) expect(JSON.stringify(result)).not.toContain(marker);
  const page = await f.runtime.historyPage({ branchId: run.branchId, limit: 20 });
  const tool = page.items.find(item => item.source === 'tool'); expect(tool).toBeDefined();
  const durable = await f.runtime.historyItem(tool!);
  expect(JSON.stringify(durable.content)).toContain('return 42;');
  expect(JSON.stringify(durable.content)).not.toContain('FORGED_INDEX_CONTENT');
}, 20_000);

it('rejects a returned foreign source identity rather than attaching it to a local Run', async () => {
  const f = await fixture(askOnce);
  await f.write('source.ts', 'const retrievalNeedle = 1;');
  f.kernel.setRetrievalOwner(async query => ({ status: 'ready', plan: plan(), source: { ...source(query), workspaceId: 'another-workspace' },
    snippets: [{ path: 'source.ts', revision: revision('const retrievalNeedle = 1;'), startLine: 1, endLine: 1, content: 'CROSS_ROOT_FORGED' }], omissions: omissions(), stages: stages() }));
  const run = await f.admit('foreign-retrieval-source', ['code_retrieval']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const result = latestOutput(f.requests[1]!);
  expect(result).not.toMatchObject({ outcome: 'succeeded', content: { status: 'ready' } });
  expect(JSON.stringify(result)).not.toContain('CROSS_ROOT_FORGED');
}, 20_000);

it('a stalled retrieval leaves control and unrelated reads usable; cancelling drops its late result', async () => {
  const f = await fixture((body, response) => {
    if (latestOutput(body)) responseDone(response);
    else if (JSON.stringify(body.input).includes('slow-retrieval')) responseTool(response, 'code_retrieval', { question: 'retrievalNeedle' });
    else responseTool(response, 'file_read', { path: 'other.txt' });
  });
  await f.write('source.ts', 'const retrievalNeedle = 1;'); await f.write('other.txt', 'UNRELATED_RETRIEVAL_READ_FINISHED');
  const gate = deferred(); let entered = false, aborted = false;
  f.kernel.setRetrievalOwner(async (query, signal) => {
    entered = true; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await gate.promise;
    return { status: 'ready', plan: plan(), source: source(query), snippets: [{ path: 'source.ts', revision: revision('const retrievalNeedle = 1;'), startLine: 1, endLine: 1, content: 'LATE_RETRIEVAL_RESULT' }], omissions: omissions(), stages: stages() };
  });
  const slow = await f.admit('slow-retrieval', ['code_retrieval']);
  try {
    await slow.start(); await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
    expect((await f.runtime.status()).epoch).toBeTruthy();
    const other = await f.admit('independent-reader', ['file_read']); await other.start();
    await expect.poll(async () => await f.runtime.run(other.receipt.run_id), { timeout: 10_000 }).toMatchObject({ state: 'completed' }).catch(async error => { console.error('INDEPENDENT_RETRIEVAL_DIAGNOSTIC', JSON.stringify({ run: await f.runtime.run(other.receipt.run_id), requests: f.requests, events: await f.runtime.events(0, 100) })); throw error; });
    expect(JSON.stringify(await f.runtime.history(other.branchId))).toContain('UNRELATED_RETRIEVAL_READ_FINISHED');
    await f.runtime.cancelRun(slow.receipt.run_id);
    await expect.poll(async () => (await f.runtime.run(slow.receipt.run_id)).state, { timeout: 10_000 }).toBe('cancelled');
    await expect.poll(() => aborted, { timeout: 10_000 }).toBe(true);
  } finally { gate.resolve(); }
  expect(JSON.stringify(await f.runtime.history(slow.branchId))).not.toContain('LATE_RETRIEVAL_RESULT');
}, 20_000);

it('denies an explicit search path outside the Run grant before invoking the Host pipeline', async () => {
  const f = await fixture((body, response) => latestOutput(body) ? responseDone(response)
    : responseTool(response, 'code_retrieval', { question: 'retrievalNeedle', paths: ['private'] }));
  await f.write('allowed/source.ts', 'const retrievalNeedle = 1;'); await f.write('private/secret.ts', 'SECRET_OUTSIDE_SCOPE');
  let invoked = 0;
  f.kernel.setRetrievalOwner(async query => { invoked++; return { status: 'ready', plan: plan(), source: source(query), snippets: [], omissions: omissions(), stages: [] }; });
  const run = await f.admit('denied-retrieval-path', ['code_retrieval'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(invoked).toBe(0);
  expect(latestOutput(f.requests[1]!)).not.toMatchObject({ outcome: 'succeeded' });
}, 20_000);

it('revoking the Run grant during an outstanding retrieval prevents its otherwise valid snippets from being committed', async () => {
  const f = await fixture(askOnce); const text = 'const retrievalNeedle = "REVOKED_RESULT_MUST_NOT_COMMIT";'; await f.write('source.ts', text);
  const gate = deferred(); let entered = false;
  f.kernel.setRetrievalOwner(async query => { entered = true; await gate.promise; return { status: 'ready', plan: plan(), source: source(query),
    snippets: [{ path: 'source.ts', revision: revision(text), startLine: 1, endLine: 1, content: text }], omissions: omissions(), stages: stages() }; });
  const run = await f.admit('revoked-retrieval-grant', ['code_retrieval']);
  try {
    await run.start(); await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
    await f.kernel.revokeGrant(run.grant.grantId); gate.resolve();
    await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(latestOutput(f.requests[1]!)).not.toMatchObject({ outcome: 'succeeded' });
    expect(JSON.stringify(await f.runtime.history(run.branchId))).not.toContain('REVOKED_RESULT_MUST_NOT_COMMIT');
  } finally { gate.resolve(); }
}, 20_000);

it('the same provider item/call IDs across model steps keep distinct history identities and an idempotent input retry adds nothing', async () => {
  let step = 0;
  const f = await fixture((_body, response) => { if (++step <= 2) responseTool(response, 'file_read', { path: 'source.txt' }); else responseDone(response); });
  await f.write('source.txt', 'REPEATED_PROVIDER_ID_SOURCE');
  const run = await f.admit('repeated-provider-model-steps', ['file_read']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const history = await f.runtime.history(run.branchId);
  expect(new Set(history.map(item => item.id)).size).toBe(history.length);
  const originals = history.filter(item => item.provider && (item.provider.item as { id?: string }).id === 'item-1');
  expect(originals).toHaveLength(2);
  expect(originals[0]!.id).not.toBe(originals[1]!.id);
  for (const original of originals) expect(original.provider!.item).toMatchObject({ id: 'item-1', call_id: 'call-1', name: 'file_read', arguments: JSON.stringify({ path: 'source.txt' }) });
  expect(history.filter(item => item.source === 'tool')).toHaveLength(2);
  const retried = await f.runtime.submit({ key: 'repeated-provider-model-steps-input', threadId: run.binding.threadId, branchId: run.branchId,
    expectedHead: null, input: { text: 'repeated-provider-model-steps' }, configuration: f.configuration });
  expect(retried).toEqual(run.receipt); expect(f.requests).toHaveLength(3);
  expect(await f.runtime.history(run.branchId)).toEqual(history);
  const fork = await f.runtime.forkBranch(run.branchId, 'repeated-provider-fork', history.at(-1)!.id);
  expect(await f.runtime.history(fork.branchId)).toEqual(history);
}, 20_000);
