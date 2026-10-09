import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ExistingHostCredentialOwner } from '../../kernel/native-credential-owner.js';
import { createNativeSemanticInference, type NativeSemanticInferenceLease } from './native-inference.js';
import { createSemanticInferenceLedger, semanticInferenceOperationKey, type SemanticInferenceOperation } from './inference-ledger.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const { HostCredentialAuthority } = await import(pathToFileURL(path.join(repository, 'packages/pi-host/src/credential-authority.ts')).href);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.restoreAllMocks(); } });
const secret = 'fake-ledger-loopback-secret-not-for-real-services';
const privateText = 'PRIVATE_INPUT_BODY_MUST_NOT_BE_STORED_77';
const nativeOperation = (id = 'one'): SemanticInferenceOperation => ({ kind: 'native-query', hostId: 'ledger-review', threadId: 'thread', runId: `run-${id}`,
  invocation: { kind: 'model_step', requestId: `persisted-model-step-${id}`, toolCallId: `persisted-tool-call-${id}` }, stage: 'native-code-retrieval.semantic.query-embedding' });
async function fixture(reply: (body: { input: string[]; model: string }, response: ServerResponse, before: Awaited<ReturnType<ReturnType<typeof createSemanticInferenceLedger>['list']>>) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-inference-ledger-review-')); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent'); await fs.mkdir(agentDir);
  const authority = HostCredentialAuthority.open(agentDir);
  await authority.modifyWithIntent('ledger-provider', 'replace', async () => ({ type: 'api_key', key: secret }));
  let requests = 0; const observed: unknown[] = [];
  let ledger = createSemanticInferenceLedger({ dataDir: root, hostId: 'ledger-review' });
  const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => {
    requests++; const body = JSON.parse(Buffer.concat(chunks).toString());
    void ledger.list().then(facts => { observed.push(facts); reply(body, response, facts); }).catch(error => response.destroy(error));
  }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No endpoint');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const settings = (modelId = 'a') => fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ harness: { embedding: { protocol: 'openai-compatible', providerId: 'ledger-provider', modelId, dimensions: 2, maxTokens: 4096 } } }));
  const models = (endpoint = baseUrl) => fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'ledger-provider': {
    api: 'openai-completions', baseUrl: endpoint, models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    capabilities: { chat: false, embedding: { protocol: 'openai-compatible', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
  } } }));
  await settings(); await models();
  let inference = createNativeSemanticInference(authority, undefined, { ledger });
  cleanups.push(() => inference.close());
  const reopen = async () => { await inference.close(); ledger = createSemanticInferenceLedger({ dataDir: root, hostId: 'ledger-review' });
    inference = createNativeSemanticInference(HostCredentialAuthority.open(agentDir), undefined, { ledger }); };
  return { root, agentDir, authority, baseUrl, settings, models, observed, requests: () => requests, ledger: () => ledger, inference: () => inference, reopen };
}
function input(lease: NativeSemanticInferenceLease, operationIdentity = nativeOperation(), batchId = 'transport-one', text = privateText) {
  return { purpose: 'query' as const, ...lease.binding, maxTokens: lease.binding.maxTokens!, batchId,
    // This lower-level suite proves dispatch durability; actual Run authorization is exercised by the native suite.
    guard: async () => {}, items: [{ id: 'stable-position-0', text }], operationIdentity };
}
const success = (body: { input: string[] }, response: ServerResponse) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 7, total_tokens: 7 } }));

it('actual loopback dispatch observes prior durable admission; lost response and reopened owner never redispatch the same native invocation', async () => {
  const f = await fixture((_body, response, facts) => { expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ state: 'unknown', receipt: { state: 'indeterminate', attempts: 0, attemptsKnown: false } }); response.destroy(); });
  const first = await f.inference().capture();
  await expect(first.embed(input(first))).rejects.toMatchObject({ receipt: { state: 'indeterminate', attempts: 1, attemptsKnown: true, usage: { status: 'unknown' } } }); first.release();
  expect(f.requests()).toBe(1); expect(await f.ledger().list({ runId: 'run-one', state: 'unknown' })).toHaveLength(1);
  await f.reopen(); const again = await f.inference().capture();
  await expect(again.embed(input(again, nativeOperation(), 'different-bridge-batch'))).rejects.toMatchObject({ receipt: { state: 'indeterminate', reused: true } });
  expect(f.requests()).toBe(1);
  await expect(again.embed(input(again, nativeOperation(), 'different-input-batch', 'CHANGED_INPUT'))).rejects.toThrow();
  again.release(); await f.settings('b'); const changedModel = await f.inference().capture();
  await expect(changedModel.embed(input(changedModel))).rejects.toThrow(); changedModel.release();
  await f.models(`${f.baseUrl}/changed-endpoint`); const changedEndpoint = await f.inference().capture();
  await expect(changedEndpoint.embed(input(changedEndpoint))).rejects.toThrow(); changedEndpoint.release();
  expect(f.requests()).toBe(1); expect(await f.ledger().list()).toHaveLength(1);
}, 30_000);

it('completed vectors survive owner restart, rebind only ephemeral envelopes, and reject different intent or model space without another dispatch', async () => {
  const f = await fixture(success); const first = await f.inference().capture();
  const result = await first.embed(input(first)); first.release();
  expect(result.receipt).toMatchObject({ state: 'succeeded', attempts: 1, attemptsKnown: true, usage: { status: 'known', inputTokens: 7, totalTokens: 7 } });
  await f.reopen(); const next = await f.inference().capture();
  const replay = await next.embed({ ...input(next, nativeOperation(), 'fresh-transport-batch'), items: [{ id: 'fresh-item-envelope', text: privateText }] });
  expect(replay.batchId).toBe('fresh-transport-batch'); expect(replay.items.map(item => item.vector)).toEqual(result.items.map(item => item.vector)); expect(replay.items[0]?.id).toBe('fresh-item-envelope'); expect(replay.receipt.reused).toBe(true); expect(f.requests()).toBe(1);
  await expect(next.embed(input(next, nativeOperation(), 'changed-input', 'DIFFERENT_INTENT'))).rejects.toThrow(); next.release();
  await f.settings('b'); const wrongSpace = await f.inference().capture(); await expect(wrongSpace.embed(input(wrongSpace))).rejects.toThrow(); wrongSpace.release(); expect(f.requests()).toBe(1);
  await f.settings('a'); await f.authority.modifyWithIntent('ledger-provider', 'replace', async () => ({ type: 'api_key', key: 'fake-new-ledger-account' }));
  const newAccount = await f.inference().capture(); await expect(newAccount.embed(input(newAccount))).rejects.toThrow(); newAccount.release(); expect(f.requests()).toBe(1);
  await f.inference().close();
  const { TriviumDB } = createRequire(import.meta.url)('triviumdb') as typeof import('triviumdb');
  const db = new TriviumDB(path.join(f.root, 'knowledge', 'ledger-review', 'semantic-inference', 'ledger.tdb'), { dim: 1, accessMode: 'readOnly', loadTextIndex: false, autoBuildQuiver: false });
  try {
    const stored = JSON.stringify(db.indexedLookup({ type: 'semantic-inference' }, db.nodeCount()).map(id => db.getPayload(id)));
    expect(stored).not.toContain(privateText); expect(stored).not.toContain(secret); expect(stored).not.toContain('Bearer');
    expect(stored).toContain('persisted-model-step-one'); expect(stored).toContain('persisted-tool-call-one');
  } finally { db.close(); }
}, 30_000);

it('new explicit index input is a separate operation while an older unknown document attempt stays fenced across reopen', async () => {
  let firstRequest = true;
  const f = await fixture((body, response) => { if (firstRequest) { firstRequest = false; response.destroy(); } else success(body, response); });
  const operation: SemanticInferenceOperation = { kind: 'index-build', hostId: 'ledger-review', workspaceId: 'registered-workspace', recipeId: 'recipe-one', stage: 'document-embedding' };
  const first = await f.inference().capture(); const original = { ...input(first, operation), purpose: 'document' as const };
  await expect(first.embed(original)).rejects.toThrow(); first.release(); await f.reopen(); const next = await f.inference().capture();
  await expect(next.embed({ ...input(next, operation, 'new-batch'), purpose: 'document' })).rejects.toThrow(); expect(f.requests()).toBe(1);
  const changed = await next.embed({ ...input(next, operation, 'different-source-version', 'NEW_DOCUMENT_VERSION'), purpose: 'document' });
  expect(changed.receipt.purpose).toBe('index-document-embedding'); expect(f.requests()).toBe(2); next.release();
  const facts = await f.ledger().list({ scopeId: 'registered-workspace' }); expect(facts).toHaveLength(2); expect(facts.filter(fact => fact.state === 'unknown')).toHaveLength(1); expect(facts.filter(fact => fact.hasResult)).toHaveLength(1);
}, 30_000);

it('an unresolved index batch fences regrouped overlapping inputs across restart instead of charging each partial batch again', async () => {
  let firstRequest = true;
  const f = await fixture((body, response) => { if (firstRequest) { firstRequest = false; response.destroy(); } else success(body, response); });
  const operation: SemanticInferenceOperation = { kind: 'index-build', hostId: 'ledger-review', workspaceId: 'registered-workspace', recipeId: 'recipe-one', stage: 'document-embedding' };
  const first = await f.inference().capture();
  const grouped = { ...input(first, operation, 'initial-group'), purpose: 'document' as const, items: [{ id: 'a', text: 'FIRST_PENDING_DOCUMENT' }, { id: 'b', text: 'SECOND_PENDING_DOCUMENT' }] };
  await expect(first.embed(grouped)).rejects.toThrow(); first.release(); await f.reopen();
  const next = await f.inference().capture();
  await expect(next.embed({ ...input(next, operation, 'regrouped-one'), purpose: 'document', items: [{ id: 'new-a', text: 'FIRST_PENDING_DOCUMENT' }] })).rejects.toThrow();
  await expect(next.embed({ ...input(next, operation, 'regrouped-two'), purpose: 'document', items: [{ id: 'new-b', text: 'SECOND_PENDING_DOCUMENT' }, { id: 'c', text: 'NEW_UNSENT_DOCUMENT' }] })).rejects.toThrow();
  expect(f.requests()).toBe(1);
  const distinct = await next.embed({ ...input(next, operation, 'separate-version'), purpose: 'document', items: [{ id: 'd', text: 'INDEPENDENT_DOCUMENT_VERSION' }] });
  expect(distinct.receipt.state).toBe('succeeded'); expect(f.requests()).toBe(2); next.release();
  expect((await f.ledger().list({ scopeId: 'registered-workspace', state: 'unknown' })).length).toBe(1);
}, 30_000);

it('a malformed provider vector response is a known failed attempt and never triggers a paid fallback or automatic replay', async () => {
  const f = await fixture((_body, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })));
  const lease = await f.inference().capture();
  await expect(lease.embed(input(lease))).rejects.toMatchObject({ receipt: { state: 'failed', attempts: 1, attemptsKnown: true, usage: { status: 'unknown' } } });
  await expect(lease.embed(input(lease, nativeOperation(), 'retry-envelope'))).rejects.toThrow(); expect(f.requests()).toBe(1);
  expect(await f.ledger().list()).toMatchObject([{ state: 'terminal', hasResult: false, receipt: { state: 'failed' } }]); lease.release();
}, 30_000);

it('an isolated child exiting after durable admission without close leaves a recoverable unknown WAL fence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-ledger-exit-review-')); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const identity = { providerId: 'exit-provider', modelId: 'fixture', protocol: 'openai-compatible' as const,
    configurationId: 'exit-config', endpointHash: digest('loopback-only'), credentialScopeHash: digest('fake-scope'),
    dimensions: 2, maxTokens: 100, operation: nativeOperation('unclosed'), inputHashes: [digest('no-source-body-persisted')] };
  const receipt = { batchId: 'child-original-batch', providerId: identity.providerId, modelId: identity.modelId, configurationId: identity.configurationId,
    purpose: 'query-embedding' as const, inputItems: 1, inputBytes: 32, attempts: 0, attemptsKnown: false, state: 'indeterminate' as const, usage: { status: 'unknown' as const } };
  const admission = { key: semanticInferenceOperationKey(identity, receipt.purpose), identity, receipt };
  const engineUrl = pathToFileURL(path.join(repository, 'packages/web/application-host/lib/knowledge/semantic/inference-ledger-engine.ts')).href;
  const source = `import { createSemanticInferenceLedgerEngine } from ${JSON.stringify(engineUrl)}; const ledger = createSemanticInferenceLedgerEngine(${JSON.stringify({ dataDir: root, hostId: 'ledger-review' })}); const result = await ledger.admit(${JSON.stringify(admission)}); console.log(JSON.stringify(result)); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: repository, encoding: 'utf8', timeout: 15_000 });
  expect(child.status, child.stderr).toBe(0); expect(JSON.parse(child.stdout.trim())).toMatchObject({ status: 'admitted' });
  const directory = path.join(root, 'knowledge', 'ledger-review', 'semantic-inference'); const wal = path.join(directory, 'ledger.tdb.wal');
  expect((await fs.stat(wal)).size).toBeGreaterThan(6);
  if (process.env.VARIN_REVIEW_EVIDENCE_DIR) {
    await fs.mkdir(process.env.VARIN_REVIEW_EVIDENCE_DIR, { recursive: true });
    const evidence = await fs.mkdtemp(path.join(process.env.VARIN_REVIEW_EVIDENCE_DIR, 'unclosed-ledger-'));
    await fs.cp(directory, path.join(evidence, 'before-reopen'), { recursive: true });
    await fs.writeFile(path.join(evidence, 'admission.json'), JSON.stringify({ admission, childStdout: child.stdout, walSha256: createHash('sha256').update(await fs.readFile(wal)).digest('hex') }, null, 2));
    console.info(`Unclosed-ledger evidence retained: ${evidence}`);
  }
  const reopened = createSemanticInferenceLedger({ dataDir: root, hostId: 'ledger-review' }); cleanups.push(() => reopened.close());
  expect(await reopened.read(admission.key)).toMatchObject({ status: 'indeterminate', receipt: { attempts: 0, attemptsKnown: false, state: 'indeterminate' } });
  expect(await reopened.admit({ ...admission, receipt: { ...receipt, batchId: 'different-bridge-envelope' } })).toMatchObject({ status: 'indeterminate' });
  expect(await reopened.list({ runId: 'run-unclosed' })).toHaveLength(1);
}, 25_000);

it('empty provider usage stays unknown while an explicitly measured zero remains known', async () => {
  let count = 0;
  const f = await fixture((body, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })), usage: ++count === 1 ? {} : { prompt_tokens: 0, total_tokens: 0 } })));
  const lease = await f.inference().capture();
  expect((await lease.embed(input(lease, nativeOperation('unknown-usage')))).receipt.usage).toEqual({ status: 'unknown' });
  expect((await lease.embed(input(lease, nativeOperation('zero-usage'), 'zero-batch'))).receipt.usage).toEqual({ status: 'known', inputTokens: 0, totalTokens: 0 });
  expect(f.requests()).toBe(2); lease.release();
}, 30_000);

it('parallel reads of malformed settings cannot drain another caller error and return stale ready configuration', async () => {
  const f = await fixture(success); const ready = await f.inference().capture(); ready.release();
  await fs.writeFile(path.join(f.agentDir, 'settings.json'), '{ malformed settings');
  const results = await Promise.all(Array.from({ length: 6 }, () => f.inference().describe()));
  expect(results.every(result => result.status !== 'ready')).toBe(true); expect(f.requests()).toBe(0);
}, 30_000);

it('index resume waits for a provably finalized zero-dispatch attempt, and concurrent resumes send only once after the old credential gate releases', async () => {
  let finishResponse: (() => void) | undefined;
  const f = await fixture((body, response) => { finishResponse = () => { finishResponse = undefined; success(body, response); }; });
  let releaseGate!: () => void; const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let markEntered!: () => void; const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const originalResolve = ExistingHostCredentialOwner.prototype.resolve;
  let firstResolution = true;
  vi.spyOn(ExistingHostCredentialOwner.prototype, 'resolve').mockImplementation(async function (this: ExistingHostCredentialOwner, ...args) {
    const auth = await originalResolve.apply(this, args);
    // Transparent timing instrumentation: keep the real owner's validated headers and scope.
    if (firstResolution) { firstResolution = false; markEntered(); await gate; }
    return auth;
  });
  const operation: SemanticInferenceOperation = { kind: 'index-build', hostId: 'ledger-review', workspaceId: 'paused-workspace', recipeId: 'recipe-one', stage: 'document-embedding' };
  const lease = await f.inference().capture(); const controller = new AbortController();
  const request = { ...input(lease, operation, 'paused-before-send'), purpose: 'document' as const, signal: controller.signal };
  const paused = lease.embed(request); void paused.catch(() => {});
  try {
    await entered; controller.abort(new Error('index directory paused'));
    await expect(paused).rejects.toMatchObject({ receipt: { state: 'indeterminate', attempts: 0, attemptsKnown: false } });
    expect(f.requests()).toBe(0); expect(f.inference().stats().activeRequests).toBe(1);
    await expect(lease.embed({ ...input(lease, operation, 'too-early-resume'), purpose: 'document' })).rejects.toThrow(); expect(f.requests()).toBe(0);
    releaseGate(); await expect.poll(() => f.inference().stats().activeRequests, { timeout: 10_000 }).toBe(0);
    expect(f.requests()).toBe(0);
    const first = lease.embed({ ...input(lease, operation, 'resume-one'), purpose: 'document' });
    const second = lease.embed({ ...input(lease, operation, 'resume-two'), purpose: 'document' });
    const settled = Promise.allSettled([first, second]);
    await expect.poll(f.requests, { timeout: 10_000 }).toBe(1); await expect.poll(() => Boolean(finishResponse)).toBe(true); finishResponse!();
    const outcomes = await settled; expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.requests()).toBe(1);
    const facts = await f.ledger().list({ scopeId: 'paused-workspace' });
    expect(facts.some(fact => fact.receipt.state === 'not-started' && fact.receipt.attempts === 0)).toBe(true);
    expect(facts.some(fact => fact.receipt.state === 'succeeded' && fact.hasResult)).toBe(true);
  } finally { releaseGate(); finishResponse?.(); lease.release(); }
}, 40_000);
