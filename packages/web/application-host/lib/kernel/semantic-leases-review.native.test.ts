import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createRetrievalComposition } from './retrieval-composition.js';
import { createRetrievalOwner } from './retrieval-owner.js';
import { createWorkspaceSemanticRuntime } from '../knowledge/semantic/workspace-runtime.js';
import { createSemanticInferenceLedger } from '../knowledge/semantic/inference-ledger.js';
import { createSemanticInference } from '../knowledge/semantic/runtime-inference.js';
import { createEmbedScheduler } from '../knowledge/semantic/embed-scheduler.js';
import { createHashEmbedder } from '../knowledge/semantic/embedder.js';
import { createProjectIndexScope } from '../knowledge/index-scope.js';
import { createStructureSource } from '../structure/source.js';
import { createTreeSitterStructureProvider } from '../structure/tree-sitter-provider.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { retrievalFixture, responseTool, responseDone, latestOutput } from './retrieval-review.test-helper.js';
import type { RetrievalQuery } from './protocol.generated.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { HostCredentialAuthority } = await import(pathToFileURL(path.join(repository, 'packages/pi-host/src/credential-authority.ts')).href);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const semanticKey = 'varin.builtin.retrieval-semantic:host:varin.retrieval.plan@1';
const question = 'where is the elusive conceptual behavior';
const alpha = 'export function alphaConcept() {\n  return "ALPHA_SEMANTIC_EVIDENCE";\n}\n';
const beta = 'export function betaConcept() {\n  return "BETA_SEMANTIC_EVIDENCE";\n}\n';
type Wire = { model: string; input: string[]; dimensions?: number };

async function fixture(hooks: { concurrency?: number; conversation?: (body: Record<string, unknown>, response: ServerResponse) => void; embedding?: (wire: Wire, response: ServerResponse) => boolean; cold?: boolean } = {}) {
  const f = await retrievalFixture(hooks.conversation ?? ((body, response) => latestOutput(body) ? responseDone(response) : responseTool(response, 'code_retrieval', { question }))); cleanups.push(f.dispose);
  await f.write('alpha.ts', alpha); await f.write('beta.ts', beta);
  const wires: Wire[] = [];
  const server = createServer((request, response) => {
    if (request.url !== '/v1/embeddings' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    if (!request.headers.authorization?.startsWith('Bearer fake-')) { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => {
    const wire = JSON.parse(Buffer.concat(chunks).toString()) as Wire; wires.push(wire);
    if (hooks.embedding?.(wire, response)) return;
    respondEmbedding(wire, response);
  }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback unavailable');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const agentDir = path.join(f.documents.root, 'semantic-agent'); await fs.mkdir(agentDir);
  const authority = HostCredentialAuthority.open(agentDir);
  await authority.modifyWithIntent('semantic-review', 'replace', async () => ({ type: 'api_key', key: 'fake-loopback-only-key' }));
  const writeSettings = (model = 'model-a', extra: Record<string, unknown> = {}) => fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ harness: { embedding: { protocol: 'openai-compatible', providerId: 'semantic-review', modelId: model, dimensions: 2, maxTokens: 2048, ...extra } } }));
  const writeModels = (enabled = true) => fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'semantic-review': {
    api: 'openai-completions', baseUrl: endpoint,
    models: [{ id: 'model-a', name: 'Fixture A' }, { id: 'model-b', name: 'Fixture B' }],
    capabilities: { chat: false, embedding: { protocol: 'openai-compatible', enabled, models: [{ id: 'model-a', name: 'Fixture A' }, { id: 'model-b', name: 'Fixture B' }] } },
  } } }));
  await writeModels(); await writeSettings();
  const ledger = createSemanticInferenceLedger({ dataDir: f.documents.dataDir, hostId: 'process-consumer' });
  const receipts: Array<import('../knowledge/semantic/runtime-inference.js').SemanticInferenceReceipt> = [];
  const inference = createSemanticInference(authority, undefined, { ledger, onReceipt: receipt => receipts.push(receipt) });
  cleanups.push(() => inference.close());
  const scope = createProjectIndexScope([f.documents.workspaceRoot]); cleanups.push(async () => scope.dispose());
  const structure = createStructureSource([createTreeSitterStructureProvider({ compute: f.compute, parseBudgetMs: 30_000 })]);
  const filesystem = createFsSearchRuntime({ compute: f.compute });
  const local = createHashEmbedder(); const localCalls = vi.spyOn(local, 'embed');
  const forbiddenPi = vi.fn(() => { throw new Error('Semantic must not request a Pi broker'); });
  const workspace = createWorkspaceSemanticRuntime({ dataDir: f.documents.dataDir, hostId: 'process-consumer', configCwd: agentDir,
    documents: f.documents.authority, structureSource: structure, searchFilesystemFiles: filesystem.searchFilesystemFiles,
    isIndexablePath: async (id, resource, signal, options) => filesystem.isSearchableFile((await f.documents.authority.inspectWorkspace(id)).root, resource, signal, options),
    // These overlap tests explicitly allow three real HTTP slots; the production default is one.
    scheduler: createEmbedScheduler({ concurrency: hooks.concurrency ?? 3 }), embedder: local, getIndexScope: scope.get, runtimeInference: inference, getBroker: forbiddenPi,
    executionViews: { get: () => undefined }, workingBranches: { pinQuery: async () => null },
  }); cleanups.push(() => workspace.dispose());
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(f.documents.root, 'extensions'), varinVersion: '0.9.24', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey: semanticKey, scope: { projectId: 'semantic-review-project' }, serviceId: 'varin.retrieval.plan', version: 1 } });
  const authorize = async (query: RetrievalQuery, signal: AbortSignal) => { signal.throwIfAborted(); await f.liveSources.validate(query, signal); f.kernel.retrievalGrant(query); };
  const composition = createRetrievalComposition(extensions, { structure, prepareSemantic: async (selection, signal) => {
    const query = selection.query; if (!query) throw new Error('Query identity required');
    await authorize(query, signal ?? new AbortController().signal);
    const grant = f.kernel.retrievalGrant(query);
    return workspace.acquireQuery({ workspaceId: query.workspaceId, threadId: query.threadId, runId: query.runId, invocation: query.invocation, roots: query.paths ?? grant.pathScopes, ...(signal ? { signal } : {}), authorize: active => authorize(query, active), assertAuthorized: () => { f.kernel.retrievalGrant(query); } });
  } });
  const queries: RetrievalQuery[] = [];
  const selections: Array<Awaited<ReturnType<typeof composition.prepare>>> = [];
  f.kernel.setRetrievalOwner(createRetrievalOwner({ documents: f.documents.authority, kernel: f.kernel, validateSource: f.liveSources.validate,
    preparePipeline: async (query, signal) => { queries.push(query); const selected = await composition.prepare({ threadId: query.threadId, projectId: 'semantic-review-project', workspaceId: query.liveRoot.canonicalRoot, query }, signal); selections.push(selected); return selected; } }));
  const scan = async () => { await workspace.scanWorkspace(f.workspaceId); await workspace.drain(); };
  if (!hooks.cold) await scan();
  const run = async (id: string, roots = ['']) => { const admitted = await f.admit(id, ['code_retrieval'], roots); await admitted.start(); return admitted; };
  const completed = async (admitted: Awaited<ReturnType<typeof run>>) => { await expect.poll(async () => (await f.runtime.run(admitted.receipt.run_id)).state, { timeout: 20_000 }).toBe('completed'); return f.runtime.history(admitted.branchId); };
  cleanups.push(async () => { server.closeAllConnections(); });
  return { ...f, authority, workspace, inference, ledger, receipts, scope, selections, queries, extensions, wires, forbiddenPi, localCalls, writeSettings, writeModels, scan, run, completed };
}
function respondEmbedding(wire: Wire, response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: wire.input.map((text, index) => ({ index, embedding: text.includes('BETA_') ? [0, 1] : [1, 0] })) }));
}

it('real configured inference, registered indexing and installed semantic selection reach history without Pi calls or local fallback', async () => {
  const f = await fixture();
  expect(f.workspace.indexStatuses()[0]?.status.coverage).toBe('complete');
  expect(f.wires.some(wire => wire.input.some(text => text.includes('ALPHA_SEMANTIC_EVIDENCE')))).toBe(true);
  const run = await f.run('semantic-installed-loop'); const history = JSON.stringify(await f.completed(run));
  expect(history).toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(f.selections[0]?.selection.providerKey).toBe(semanticKey);
  const output = f.requests.map(latestOutput).find(value => value?.outcome === 'succeeded') as { content?: { snippets?: Array<{ path: string }> } } | undefined;
  expect(output?.content?.snippets?.[0]?.path).toBe('alpha.ts');
  expect(history).not.toContain('inferenceReceipts'); expect(history).not.toContain('query-embedding');
  expect(f.selections[0]?.plan.semantic?.publishedRevision).toBeTruthy();
  expect(f.selections[0]?.plan.semantic).toMatchObject({ bindingState: 'ready', coverage: 'complete', lifecycle: 'ready' });
  expect(f.selections[0]?.plan.stages.find(stage => stage.kind === 'model')?.status).toBe('disabled');
  expect(f.wires.some(wire => wire.input.includes(question))).toBe(true);
  expect(f.receipts.some(receipt => receipt.purpose === 'index-document-embedding' && receipt.state === 'succeeded')).toBe(true);
  expect(f.receipts.some(receipt => receipt.purpose === 'query-embedding' && receipt.state === 'succeeded' && receipt.usage.status === 'unknown')).toBe(true);
  expect((await f.ledger.list({ runId: run.receipt.run_id })).some(fact => fact.hasResult && fact.identity.operation.kind === 'retrieval-query')).toBe(true);
  expect(f.forbiddenPi).not.toHaveBeenCalled(); expect(f.localCalls).not.toHaveBeenCalled();
  const sent = f.wires.length; f.scope.update([], [f.documents.workspaceRoot]); await f.workspace.refreshIndexScope();
  const pausedHistory = JSON.stringify(await f.completed(await f.run('semantic-paused-published')));
  expect(pausedHistory).toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(pausedHistory).not.toContain('"reused":true'); expect(f.wires).toHaveLength(sent);
  expect(f.receipts.some(receipt => receipt.purpose === 'query-embedding' && receipt.state === 'succeeded' && receipt.attempts === 0 && receipt.attemptsKnown && receipt.reused)).toBe(true);
  await f.workspace.drain(); expect(await f.workspace.queryStats()).toMatchObject({ activeQueries: 0, activeReaders: 0 });
  await f.workspace.dispose(); expect(await f.workspace.queryStats()).toMatchObject({ activeQueries: 0, activeReaders: 0, retainedPublications: 0 });
  await f.inference.close(); expect(f.inference.stats()).toEqual({ activeLeases: 0, activeRequests: 0, activeCalls: 0, pendingSettlements: 0 });
}, 45_000);

it('a cold selected semantic query remains incomplete without silently scanning, probing or paying', async () => {
  const f = await fixture({ cold: true }); const run = await f.run('semantic-cold'); const history = JSON.stringify(await f.completed(run));
  expect(f.wires).toHaveLength(0); expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE');
  expect(f.selections[0]?.plan.semantic?.publishedRevision).toBeNull();
  expect(history).toMatch(/partial|unavailable/); expect(f.forbiddenPi).not.toHaveBeenCalled();
  await fs.writeFile(path.join(f.documents.root, 'semantic-agent/settings.json'), '{}');
  await f.completed(await f.run('semantic-unconfigured'));
  expect(f.selections[1]?.plan.semantic).toMatchObject({ bindingState: 'unconfigured', configurationId: null, providerId: null, modelId: null });
  await f.writeSettings('model-a', { protocol: 'invalid-protocol' }); await f.completed(await f.run('semantic-invalid'));
  expect(f.selections[2]?.plan.semantic?.bindingState).toBe('invalid'); expect(f.wires).toHaveLength(0);
}, 50_000);

it('a query retains model A and old published reader while model B and a replacement publication serve a new query', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.model === 'model-a' && wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const old = await f.run('semantic-old'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const oldMeta = f.selections[0]!.plan.semantic!;
  await f.write('alpha.ts', alpha.replace('ALPHA_SEMANTIC_EVIDENCE', 'ALPHA_NEW_BYTES')); await f.writeSettings('model-b');
  await f.scan();
  const current = await f.run('semantic-new'); const newHistory = JSON.stringify(await f.completed(current));
  expect(f.selections[1]!.plan.semantic!.modelId).toBe('model-b'); expect(f.selections[1]!.plan.semantic!.publishedRevision).not.toBe(oldMeta.publishedRevision);
  expect(newHistory).toContain('ALPHA_NEW_BYTES');
  respondEmbedding(held!.wire, held!.response); const oldHistory = JSON.stringify(await f.completed(old));
  expect(oldMeta.modelId).toBe('model-a'); expect(oldHistory).not.toContain('ALPHA_NEW_BYTES'); expect(oldHistory).not.toContain('ALPHA_SEMANTIC_EVIDENCE');
  expect(oldHistory).toContain('BETA_SEMANTIC_EVIDENCE'); expect(oldHistory).toMatch(/stale|partial/);
}, 60_000);

it('explicit provider disable fences an in-flight response and starts no fallback model request', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const run = await f.run('semantic-disabled'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const sent = f.wires.length; await f.writeModels(false); respondEmbedding(held!.wire, held!.response);
  const history = JSON.stringify(await f.completed(run));
  expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(history).not.toContain('BETA_SEMANTIC_EVIDENCE');
  expect(f.wires).toHaveLength(sent); expect(f.localCalls).not.toHaveBeenCalled();
  await f.completed(await f.run('semantic-disabled-new')); expect(f.selections[1]?.plan.semantic?.bindingState).toBe('disabled'); expect(f.wires).toHaveLength(sent);
}, 45_000);

it('a bad selected model does not revoke an accepted old query and cannot silently charge the previous model for a new query', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const old = await f.run('semantic-candidate-old'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const sent = f.wires.length; await f.writeSettings('model-that-does-not-exist');
  const candidate = await f.run('semantic-candidate-missing'); const candidateHistory = JSON.stringify(await f.completed(candidate));
  expect(candidateHistory).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(f.wires).toHaveLength(sent);
  respondEmbedding(held!.wire, held!.response); const oldHistory = JSON.stringify(await f.completed(old));
  expect(oldHistory).toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(f.localCalls).not.toHaveBeenCalled();
}, 55_000);

it('removing the selected index directory while inference waits prevents old source delivery', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const run = await f.run('semantic-directory-removed'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const sent = f.wires.length; f.scope.update([], [], [f.documents.workspaceRoot]); await f.workspace.refreshIndexScope();
  respondEmbedding(held!.wire, held!.response); const history = JSON.stringify(await f.completed(run));
  expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(history).not.toContain('BETA_SEMANTIC_EVIDENCE'); expect(f.wires).toHaveLength(sent);
}, 45_000);

it('credential account replacement while inference waits blocks delivery under the captured account', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const run = await f.run('semantic-account-replaced'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const sent = f.wires.length;
  await f.authority.modifyWithIntent('semantic-review', 'replace', async () => ({ type: 'api_key', key: 'fake-replacement-account-key' }));
  respondEmbedding(held!.wire, held!.response); const history = JSON.stringify(await f.completed(run));
  expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(history).not.toContain('BETA_SEMANTIC_EVIDENCE'); expect(f.wires).toHaveLength(sent);
}, 45_000);

it('Run grant revocation during inference drops source and never starts a fallback request', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  const run = await f.run('semantic-grant-revoked'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  const sent = f.wires.length; await f.kernel.revokeGrant(run.grant.grantId);
  respondEmbedding(held!.wire, held!.response);
  await expect.poll(async () => ['completed', 'failed', 'cancelled'].includes((await f.runtime.run(run.receipt.run_id)).state), { timeout: 20_000 }).toBe(true);
  const history = JSON.stringify(await f.runtime.history(run.branchId));
  expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(history).not.toContain('BETA_SEMANTIC_EVIDENCE'); expect(f.wires).toHaveLength(sent);
}, 45_000);

it('cached query vectors do not bypass source authorization after a symlink escape and out-of-scope paths are never read', async () => {
  const f = await fixture();
  await f.write('allowed/entry.ts', 'export const conceptual = "ALLOWED_SEMANTIC_MARKER";\n');
  await f.write('private/secret.ts', 'export const hidden = "PRIVATE_SEMANTIC_SECRET";\n'); await f.scan();
  const first = await f.run('semantic-cache-first', ['allowed']); const firstHistory = JSON.stringify(await f.completed(first));
  expect(firstHistory).toContain('ALLOWED_SEMANTIC_MARKER'); expect(firstHistory).not.toContain('PRIVATE_SEMANTIC_SECRET');
  const queryCount = f.wires.filter(wire => wire.input.includes(question)).length; expect(queryCount).toBe(1);
  const outside = path.join(f.documents.root, 'outside-secret.ts'); await fs.writeFile(outside, 'export const outside = "SYMLINK_PRIVATE_SECRET";\n');
  await fs.unlink(path.join(f.documents.workspaceRoot, 'allowed/entry.ts')); await fs.symlink(outside, path.join(f.documents.workspaceRoot, 'allowed/entry.ts'));
  const reads = vi.spyOn(f.documents.authority, 'readSnapshot');
  const second = await f.run('semantic-cache-symlink', ['allowed']); const history = JSON.stringify(await f.completed(second));
  expect(f.wires.filter(wire => wire.input.includes(question))).toHaveLength(queryCount);
  expect(history).not.toContain('SYMLINK_PRIVATE_SECRET'); expect(history).not.toContain('PRIVATE_SEMANTIC_SECRET'); expect(history).not.toContain('ALLOWED_SEMANTIC_MARKER');
  expect(reads.mock.calls.some(([resource]) => resource.resourceId.includes('private') || resource.resourceId === 'allowed/entry.ts')).toBe(false);
}, 50_000);

it('unchanged chunk bytes do not substitute for a changed whole-file Documents revision', async () => {
  let held: { wire: Wire; response: ServerResponse } | undefined;
  const f = await fixture({ embedding: (wire, response) => { if (wire.input.includes(question)) { held = { wire, response }; return true; } return false; } });
  await fs.unlink(path.join(f.documents.workspaceRoot, 'alpha.ts')); await fs.unlink(path.join(f.documents.workspaceRoot, 'beta.ts'));
  await f.write('mixed.ts', `${alpha}\n${beta}`); await f.scan();
  const run = await f.run('semantic-file-revision'); await expect.poll(() => Boolean(held), { timeout: 15_000 }).toBe(true);
  await f.write('mixed.ts', `${alpha}\n${beta.replace('BETA_SEMANTIC_EVIDENCE', 'CHANGED_OTHER_UNIT')}`);
  respondEmbedding(held!.wire, held!.response); const history = JSON.stringify(await f.completed(run));
  expect(history).not.toContain('ALPHA_SEMANTIC_EVIDENCE'); expect(history).not.toContain('CHANGED_OTHER_UNIT'); expect(history).toMatch(/stale|partial/);
}, 50_000);

it('cancelling one blocked query leaves another query and the shared indexed owner usable, with no reader leak', async () => {
  let queryRequests = 0;
  const f = await fixture({ embedding: (wire, _response) => { if (wire.input.includes(question)) return ++queryRequests === 1; return false; } });
  const blocked = await f.run('semantic-cancel-one'); await expect.poll(() => queryRequests, { timeout: 15_000 }).toBe(1);
  const independent = await f.run('semantic-independent'); const history = JSON.stringify(await f.completed(independent)); expect(history).toContain('ALPHA_SEMANTIC_EVIDENCE');
  await f.runtime.cancelRun(blocked.receipt.run_id);
  await expect.poll(async () => (await f.runtime.run(blocked.receipt.run_id)).state, { timeout: 10_000 }).toBe('cancelled');
  await f.workspace.drain();
  await expect.poll(async () => (await f.workspace.queryStats()).activeReaders, { timeout: 10_000 }).toBe(0);
  expect((await f.workspace.queryStats()).activeQueries).toBe(0);
  expect(JSON.stringify(await f.runtime.history(blocked.branchId))).not.toContain('ALPHA_SEMANTIC_EVIDENCE');
  const facts = await f.ledger.list({ runId: blocked.receipt.run_id }); expect(facts.some(fact => fact.state === 'unknown')).toBe(true);
  expect(f.workspace.indexStatuses()[0]?.status.publishedDocuments).toBe(2);
}, 55_000);

it('unknown dimensions are learned from an authorized document build with a durable receipt, never from a hidden readiness probe', async () => {
  const f = await fixture({ cold: true }); await f.writeSettings('model-a', { dimensions: undefined });
  expect(f.wires).toHaveLength(0); await f.scan();
  expect(f.wires.length).toBeGreaterThan(0);
  expect(f.wires.every(wire => wire.dimensions === undefined && wire.input.every(text => /ALPHA_SEMANTIC_EVIDENCE|BETA_SEMANTIC_EVIDENCE/.test(text)))).toBe(true);
  const beforeQuery = await f.ledger.list({ scopeId: f.workspaceId });
  expect(beforeQuery.length).toBeGreaterThan(0); expect(beforeQuery.every(fact => fact.receipt.purpose === 'index-document-embedding' && fact.hasResult)).toBe(true);
  const run = await f.run('semantic-discovered-dimension'); expect(JSON.stringify(await f.completed(run))).toContain('ALPHA_SEMANTIC_EVIDENCE');
  expect(f.localCalls).not.toHaveBeenCalled();
}, 50_000);

it('a blocked inference at the default single-slot capacity does not block ordinary reads, status or cancellation', async () => {
  let held = false;
  const f = await fixture({ concurrency: 1, embedding: (wire) => { if (wire.input.includes(question)) { held = true; return true; } return false; },
    conversation: (body, response) => latestOutput(body) ? responseDone(response)
      : JSON.stringify(body.input).includes('ordinary-read') ? responseTool(response, 'file_read', { path: 'alpha.ts' })
      : responseTool(response, 'code_retrieval', { question }),
  });
  const blocked = await f.run('single-slot-blocked'); await expect.poll(() => held, { timeout: 15_000 }).toBe(true);
  expect((await f.runtime.status()).epoch).toBeGreaterThan(0);
  const ordinary = await f.admit('ordinary-read', ['file_read']); await ordinary.start();
  expect(JSON.stringify(await f.completed(ordinary))).toContain('ALPHA_SEMANTIC_EVIDENCE');
  await f.runtime.cancelRun(blocked.receipt.run_id);
  await expect.poll(async () => (await f.runtime.run(blocked.receipt.run_id)).state, { timeout: 10_000 }).toBe('cancelled');
  expect(f.wires.filter(wire => wire.input.includes(question))).toHaveLength(1);
  await expect.poll(async () => (await f.workspace.queryStats()).activeReaders, { timeout: 10_000 }).toBe(0);
}, 45_000);
