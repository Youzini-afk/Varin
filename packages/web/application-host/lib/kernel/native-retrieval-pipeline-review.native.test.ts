import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRetrievalPipelineOwner } from '../harness/retrieval-pipeline.js';
import { createStructureSource } from '../structure/source.js';
import { createTreeSitterStructureProvider } from '../structure/tree-sitter-provider.js';
import { createNativeRetrievalOwner, type NativeRetrievalResult } from './native-retrieval-owner.js';
import { retrievalFixture, responseTool, responseDone, latestOutput, deferred } from './native-retrieval-review.test-helper.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const fixture = async (reply: Parameters<typeof retrievalFixture>[0]) => { const f = await retrievalFixture(reply); cleanups.push(f.dispose); return f; };
const once = (body: Record<string, unknown>, response: Parameters<typeof responseDone>[0]) => latestOutput(body) ? responseDone(response) : responseTool(response, 'native_code_retrieval', { question: 'retrievalNeedle' });
const sourceText = 'export function retrievalNeedle(input: number): number {\n  const adjusted = input + 41;\n  return adjusted;\n}\n';
function install(f: Awaited<ReturnType<typeof fixture>>, pipelines: ReturnType<typeof createRetrievalPipelineOwner>) {
  const owner = createNativeRetrievalOwner({ documents: f.documents.authority, kernel: f.kernel, validateSource: f.liveSources.validate, pipelines });
  const results = new Map<string, NativeRetrievalResult>();
  f.kernel.setNativeRetrievalOwner(async (query, signal) => {
    const result = await owner(query, signal); results.set(query.runId, result); return result;
  });
  return results;
}
function actualStructure(f: Awaited<ReturnType<typeof fixture>>) {
  return { providerId: 'varin.tree-sitter', configurationId: 'bundled-test', status: 'ready' as const,
    implementation: createStructureSource([createTreeSitterStructureProvider({ compute: f.compute, parseBudgetMs: 30_000 })]) };
}

it('public HTTP runs keyword → actual Rust structure → durable native history → follow-up read without paid model fallback', async () => {
  let serial = 0;
  const f = await fixture((body, response) => {
    const out = latestOutput(body);
    if (!out) responseTool(response, 'native_code_retrieval', { question: 'retrievalNeedle' }, ++serial);
    else if (serial === 1) responseTool(response, 'native_file_read', { path: 'module.ts' }, ++serial);
    else responseDone(response);
  });
  await f.write('module.ts', sourceText);
  const pipelines = createRetrievalPipelineOwner({ configurationId: 'actual-native', structure: actualStructure(f) }); const results = install(f, pipelines);
  const identity = await f.api.create('retrieval-public-http');
  const liveRoot = await f.liveSources.prepare(f.workspaceId, f.workspaceId, identity.threadId);
  const receipt = await f.api.submit({ ...identity, key: 'retrieval-http-input', expectedHead: null, text: 'Find retrievalNeedle and check the source', model: { providerId: 'fixture', modelId: 'retrieval-loopback' },
    source: { mode: 'live_root', workspaceId: f.workspaceId, executionWorkspaceId: f.workspaceId, liveRoot, tools: ['code_retrieval', 'file_read'] } });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(f.launchErrors).toEqual([]); expect(f.requests).toHaveLength(3);
  const retrieval = latestOutput(f.requests[1]!)!;
  expect(retrieval).toMatchObject({ outcome: 'succeeded', content: {
    source: { mode: 'live_root', workspaceId: f.workspaceId, liveRoot },
    snippets: expect.arrayContaining([expect.objectContaining({ path: 'module.ts', startLine: 1, endLine: 4, content: sourceText.trimEnd() })]),
  } });
  expect(results.get(receipt.run_id)?.plan).toMatchObject({ configurationGeneration: 1,
    stages: expect.arrayContaining([{ kind: 'structure', providerId: 'varin.tree-sitter', configurationId: 'bundled-test', status: 'ready' }]) });
  expect(retrieval.content).not.toHaveProperty('plan');
  expect(retrieval.content).not.toHaveProperty('stages');
  expect(retrieval.content).not.toHaveProperty('inferenceReceipts');
  const snippet = (retrieval.content as { snippets: Array<{ revision: string }> }).snippets[0]!;
  expect(JSON.stringify(latestOutput(f.requests[2]!))).toContain(sourceText.trimEnd().replaceAll('\n', '\\n'));
  expect(snippet.revision).toBe(`d1_${createHash('sha256').update(sourceText).digest('base64url')}`);
  const followup = latestOutput(f.requests[2]!)!.content as { content: { text: string }; source: { liveRoot: unknown } };
  expect(followup.content.text).toBe(sourceText);
  expect(followup.source.liveRoot).toEqual(liveRoot);
  const snapshot = await f.api.snapshot(identity);
  expect(JSON.stringify(snapshot.history)).toContain(sourceText.trimEnd().replaceAll('\n', '\\n'));
  expect(JSON.stringify(snapshot.history)).toContain('native_code_retrieval');
  expect(JSON.stringify(snapshot.history)).not.toContain('sessionId');
  expect(pipelines.capture().plan.stages.filter(stage => stage.kind === 'semantic' || stage.kind === 'model').every(stage => stage.status === 'disabled')).toBe(true);
}, 30_000);

it('selected cold semantic/structure stages preserve useful keyword evidence and explicit partial coverage', async () => {
  const f = await fixture(once); await f.write('module.ts', sourceText);
  const pipelines = createRetrievalPipelineOwner({ configurationId: 'cold-selected',
    structure: { providerId: 'cold-grammar', configurationId: 'cold-1', status: 'unavailable' },
    semantic: { providerId: 'cold-index', configurationId: 'index-1', status: 'unavailable' },
  }); const results = install(f, pipelines);
  const run = await f.admit('cold-selected-retrieval', ['code_retrieval']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(latestOutput(f.requests[1]!)).toMatchObject({ outcome: 'succeeded', content: { status: 'partial',
    snippets: expect.arrayContaining([expect.objectContaining({ path: 'module.ts' })]),
  } });
  expect(results.get(run.receipt.run_id)?.stages).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'semantic', status: 'unavailable' }), expect.objectContaining({ kind: 'structure', status: 'unavailable' }),
  ]));
}, 20_000);

it('an in-flight Run retains its selected model handle/generation while a failed candidate leaves the current pipeline active', async () => {
  const f = await fixture(once); await f.write('module.ts', sourceText);
  const gate = deferred(); let oldEntered = 0, oldCalls = 0, newCalls = 0;
  const oldModel = vi.fn(async () => { oldEntered++; await gate.promise; oldCalls++; return [0]; });
  const newModel = vi.fn(async () => { newCalls++; return [0]; });
  const pipelines = createRetrievalPipelineOwner({ configurationId: 'old-config', model: { providerId: 'selected-old', configurationId: 'old-model-config', status: 'ready', implementation: oldModel } });
  const results = install(f, pipelines); const oldPlan = pipelines.capture().plan;
  const oldRun = await f.admit('old-retrieval-generation', ['code_retrieval']);
  try {
    await oldRun.start(); await expect.poll(() => oldEntered, { timeout: 10_000 }).toBe(1);
    const published = await pipelines.replace(async () => ({ configurationId: 'new-config', model: { providerId: 'selected-new', configurationId: 'new-model-config', status: 'ready', implementation: newModel } }));
    await expect(pipelines.replace(async () => { throw new Error('candidate failed to prepare'); })).rejects.toThrow('candidate failed to prepare');
    expect(pipelines.capture().plan).toBe(published);
    const newRun = await f.admit('new-retrieval-generation', ['code_retrieval']); await newRun.start();
    await expect.poll(async () => await f.runtime.run(newRun.receipt.run_id), { timeout: 10_000 }).toMatchObject({ state: 'completed' });
    expect(newCalls).toBe(1); expect(oldCalls).toBe(0);
    gate.resolve(); await expect.poll(async () => (await f.runtime.run(oldRun.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    const oldHistory = JSON.stringify(await f.runtime.history(oldRun.branchId));
    const newHistory = JSON.stringify(await f.runtime.history(newRun.branchId));
    expect(results.get(oldRun.receipt.run_id)?.plan?.id).toBe(oldPlan.id);
    expect(results.get(newRun.receipt.run_id)?.plan?.id).toBe(published.id);
    expect(oldHistory).toContain('retrievalNeedle'); expect(oldHistory).not.toContain(published.id);
    expect(newHistory).toContain('retrievalNeedle'); expect(newHistory).not.toContain(oldPlan.id);
    expect(oldCalls).toBe(1); expect(f.requests).toHaveLength(4);
  } finally { gate.resolve(); }
}, 25_000);

it('two Runs share real grammar preparation; cancelling one waiter does not cancel the surviving retrieval', async () => {
  const f = await fixture(once); await f.write('module.ts', sourceText);
  const gate = deferred(); let grammarCalls = 0;
  const scoped = f.kernel.scoped.bind(f.kernel);
  vi.spyOn(f.kernel, 'scoped').mockImplementation(grant => {
    const actor = scoped(grant);
    const register = actor.computeGrammarRegister.bind(actor);
    vi.spyOn(actor, 'computeGrammarRegister').mockImplementation(async (...args) => { grammarCalls++; await gate.promise; return register(...args); });
    return actor;
  });
  install(f, createRetrievalPipelineOwner({ configurationId: 'shared-grammar', structure: actualStructure(f) }));
  const first = await f.admit('grammar-first', ['code_retrieval']); const second = await f.admit('grammar-second', ['code_retrieval']);
  try {
    await Promise.all([first.start(), second.start()]); await expect.poll(() => grammarCalls, { timeout: 10_000 }).toBe(1);
    await f.runtime.cancelRun(first.receipt.run_id); await expect.poll(async () => (await f.runtime.run(first.receipt.run_id)).state, { timeout: 10_000 }).toBe('cancelled');
    expect((await f.runtime.run(second.receipt.run_id)).state).not.toBe('completed');
    gate.resolve(); await expect.poll(async () => await f.runtime.run(second.receipt.run_id), { timeout: 15_000 }).toMatchObject({ state: 'completed' });
    expect(grammarCalls).toBe(1);
    expect(JSON.stringify(await f.runtime.history(second.branchId))).toContain('return adjusted;');
    expect((await f.runtime.run(first.receipt.run_id)).state).toBe('cancelled');
  } finally { gate.resolve(); }
}, 30_000);


it('selected semantic candidates use real chunk hashes, admit source before model selection, and discard out-of-scope index text', async () => {
  const f = await fixture(once);
  const semanticText = 'export function conceptualAnswer() {\n  return "VALID_SEMANTIC_ONLY_EVIDENCE";\n}';
  await f.write('allowed/semantic.ts', semanticText); await f.write('private/secret.ts', 'PRIVATE_INDEX_BODY');
  const observed = vi.spyOn(f.documents.authority, 'readSnapshot');
  const selectedBodies: string[] = [];
  const hit = (documentId: string, body: string, rank: number) => ({ documentId, revision: `d1_${createHash('sha256').update(body).digest('base64url')}`, blockId: `block-${rank}`, parentUnitId: `parent-${rank}`,
    parentName: 'conceptualAnswer', parentKind: 'function', startLine: 1, endLine: body.split('\n').length,
    contentHash: createHash('sha256').update(body).digest('hex'), body, similarity: 0.9, rank });
  install(f, createRetrievalPipelineOwner({ configurationId: 'explicit-semantic',
    semantic: { providerId: 'published-index-fixture', configurationId: 'published-1', status: 'ready', implementation: { search: async () => ({ status: 'ready', coverage: 'complete', lifecycle: 'ready',
      hits: [hit('allowed/semantic.ts', semanticText, 1), hit('private/secret.ts', 'PRIVATE_INDEX_BODY', 2), hit('../outside.ts', 'OUTSIDE_INDEX_BODY', 3)] }) } },
    model: { providerId: 'selected-model-fixture', configurationId: 'selection-1', status: 'ready', implementation: async input => { selectedBodies.push(JSON.stringify(input.snippets)); return input.snippets.map((_item, index) => index); } },
  }));
  const run = await f.admit('semantic-source-authority', ['code_retrieval'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  const result = latestOutput(f.requests[1]!);
  expect(result).toMatchObject({ outcome: 'succeeded', content: { status: 'partial', snippets: [expect.objectContaining({ path: 'allowed/semantic.ts', content: semanticText })] } });
  expect(selectedBodies).toHaveLength(1); expect(selectedBodies[0]).toContain('VALID_SEMANTIC_ONLY_EVIDENCE');
  expect(selectedBodies[0]).not.toContain('PRIVATE_INDEX_BODY'); expect(selectedBodies[0]).not.toContain('OUTSIDE_INDEX_BODY');
  expect(observed.mock.calls.some(([resource]) => resource.resourceId.includes('private') || resource.resourceId.includes('..'))).toBe(false);
  expect(JSON.stringify(await f.runtime.history(run.branchId))).not.toContain('PRIVATE_INDEX_BODY');
}, 20_000);

it('large structured units retain the actual distant hit instead of refilling omitted lines and truncating before it', async () => {
  const marker = 'DISTANT_QUOTED_RETRIEVAL_HIT';
  const f = await fixture((body, response) => latestOutput(body) ? responseDone(response) : responseTool(response, 'native_code_retrieval', { question: `Find "${marker}"` }));
  const lines = ['export function distantEvidence() {', ...Array.from({ length: 90 }, (_, index) => `  // filler ${index} ${'x'.repeat(350)}`), `  return "${marker}";`, '}'];
  await f.write('large-unit.ts', lines.join('\n'));
  install(f, createRetrievalPipelineOwner({ configurationId: 'large-structure-slice', structure: actualStructure(f) }));
  const run = await f.admit('distant-structure-evidence', ['code_retrieval']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  const result = latestOutput(f.requests[1]!);
  expect(result).toMatchObject({ outcome: 'succeeded' });
  expect(JSON.stringify(result)).toContain(marker);
  const snippets = (result!.content as { snippets: Array<{ startLine: number; endLine: number; content: string }> }).snippets;
  for (const snippet of snippets) expect(snippet.content).toBe(lines.slice(snippet.startLine - 1, snippet.endLine).join('\n'));
}, 25_000);

it('a selected model failure keeps verified source order and reports partial without invoking a fallback model', async () => {
  const f = await fixture(once); await f.write('module.ts', sourceText);
  const selected = vi.fn(async () => { throw new Error('selected model unavailable'); });
  const results = install(f, createRetrievalPipelineOwner({ configurationId: 'failing-selected-model', model: { providerId: 'explicit-model', configurationId: 'failed-generation', status: 'ready', implementation: selected } }));
  const run = await f.admit('failed-selected-model', ['code_retrieval']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(selected).toHaveBeenCalledTimes(1); expect(f.requests).toHaveLength(2);
  expect(latestOutput(f.requests[1]!)).toMatchObject({ outcome: 'succeeded', content: { status: 'partial',
    snippets: expect.arrayContaining([expect.objectContaining({ path: 'module.ts' })]),
  } });
  expect(results.get(run.receipt.run_id)?.stages).toContainEqual({ kind: 'model', status: 'failed' });
}, 20_000);
