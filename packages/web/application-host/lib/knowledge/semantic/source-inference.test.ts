import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalSemanticEmbedder } from './local-embedder.js';
import { localComponentFixture } from './fixtures/local-component.test-helper.js';
import { createSemanticInference } from './runtime-inference.js';
import { createWorkspaceSemanticRuntime } from './workspace-runtime.js';
import { createHashEmbedder } from './embedder.js';
import { createEmbedScheduler } from './embed-scheduler.js';
import type { InferenceRequestsOptions } from './inference-requests.js';
import type { SemanticSourceView } from './query-view.js';
import type { StructureSource } from '../../structure/types.js';
import type { DocumentAuthority } from '../../documents/authority.js';

async function fixture(failSource: boolean, local = false, managed = false, live = false) {
  const directory = mkdtempSync(join(tmpdir(), 'varin-source-inference-'));
  const credentials = { reference: 'fixture', authority: 'fixture-owner', account: 'fixture-account', generation: 1 };
  const embedding = { providerId: 'embedding', modelId: 'fixture', protocol: 'openai-compatible', dimensions: 2, maxTokens: 4096, enabled: true };
  let selection: unknown = local ? undefined : embedding;
  let readGate: (() => Promise<void>) | undefined;
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  const kernel = { agentRuntimeRequest: async (method: string, params: Record<string, unknown>) => {
    frames.push({ method, params });
    if (method === 'runtime.inference.session') return { hasRequests: false };
    const id = params.operationId ?? `inference:${params.parentOperationId}:${params.ordinal}`;
    if (method === 'runtime.inference.settle') return { operationId: id, phase: 'terminal', outcome: 'succeeded',
      live: false, dispatched: true, recovered: false, cancelRequested: false, receipt: params.receipt };
    return { operationId: id, phase: 'running', outcome: null, live: true,
      dispatched: method === 'runtime.inference.dispatch', recovered: false, cancelRequested: false, receipt: null };
  } } as unknown as InferenceRequestsOptions['kernel'];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 7, total_tokens: 7 } }),
      { headers: { 'content-type': 'application/json' } });
  });
  const inference = createSemanticInference({ readGlobalInferenceSettings: async () => { await readGate?.(); return { harness: { embedding: selection } }; },
    resolveEmbeddingBinding: async (providerId) => {
      if (providerId === 'unavailable') throw new Error('Configured provider is unavailable');
      return { providerId: 'embedding', modelId: 'fixture', baseUrl: 'https://embedding.invalid/v1',
      requestUrl: 'https://embedding.invalid/v1/embeddings', configurationId: 'source-inference-fixture', credentialRef: 'fixture',
      credentialScope: credentials, currentScope: async () => credentials, assertAvailable: async () => {},
      getAuth: async () => ({ auth: { apiKey: 'controlled-fixture-key' } }) };
    },
  }, undefined, { requests: { kernel,
    runtime: { onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {} },
    egress: { prepare: async () => ({ policy: { version: 1, mode: 'direct', noProxy: [], source: 'default' } as never, fetch }) },
  } });
  const versionCheck = vi.fn(async () => { if (failSource) throw new Error('Original source changed'); });
  const source: SemanticSourceView = { mode: 'fixed_branch', resourceOwner: { kind: 'local' }, resourceRoot: '/removed/original',
    configurationRoot: '/removed/original', cacheWorkspaceId: 'original-workspace',
    listFiles: async () => ({ complete: true, files: [{ path: 'a.ts', revision: 'original-revision' }] }),
    compute: async () => { throw new Error('The structure port supplies controlled units'); }, validateDocuments: versionCheck };
  const structure: StructureSource = { unitsRecipe: async () => 'recipe-1', unitsFixed: async () => ({ status: 'ready', revision: 'original-revision', recipeId: 'recipe-1',
    units: [{ startLine: 1, endLine: 1, parentName: '', parentKind: 'file', parentSignature: '', docComments: '', text: 'export const source = 42;', fallback: true }] }),
    outline: async () => { throw new Error('not used'); }, classifyHits: async () => { throw new Error('not used'); },
    literalCalls: async () => { throw new Error('not used'); }, imports: async () => { throw new Error('not used'); } };
  if (managed) {
    source.mode = 'live_root';
    source.resourceOwner = { kind: 'managed_host', hostId: 'host-b', connectionId: 'connection-b', endpointIdentity: 'endpoint-b' };
    source.resourceRoot = 'C:\\remote\\project'; source.configurationRoot = ''; source.cacheWorkspaceId = 'managed-source:host-b';
    source.structure = structure;
  }
  const unavailable = () => { throw new Error('A source query must not inspect or watch the old live directory'); };
  let releaseWatch!: () => void;
  const watchReady = new Promise<boolean>(resolve => { releaseWatch = () => resolve(true); });
  const watch = vi.fn(() => ({ ready: watchReady, close() {}, position: null, settle: async () => {} }));
  const documents = { inspectWorkspace: live ? async () => ({ root: directory }) : unavailable, read: unavailable,
    watch: live ? watch : unavailable } as unknown as DocumentAuthority;
  const component = local ? await localComponentFixture(join(directory, 'component')) : undefined;
  const encoder = component ? createLocalSemanticEmbedder({ dataDir: '', pack: component.pack }) : createHashEmbedder();
  const runtime = createWorkspaceSemanticRuntime({ dataDir: directory, hostId: 'source-inference',
    documents, structureSource: managed ? new Proxy({} as StructureSource, { get: () => { throw new Error('Managed source cannot use coordinator grammars'); } }) : structure,
    ...(managed ? { getIndexScope: () => { throw new Error('Managed source cannot use coordinator index selection'); } } : {}),
    ...(live ? { searchFilesystemFiles: async () => [] } : {}), scheduler: createEmbedScheduler(), embedder: encoder, runtimeInference: inference });
  let invocation = 0;
  const run = (beforeSearch?: () => void) => inference.requests!.run({ operationId: `original-query-${++invocation}`,
    executorOwner: { kind: 'external', identity: 'source-test', epoch: 'original-epoch' } }, new AbortController().signal, async call => {
    await call.assertFresh();
    const lease = await runtime.acquireQuery({ workspaceId: 'original-workspace', inference: call, roots: [''], signal: call.signal,
      ...(live ? {} : { sourceView: source }), assertAuthorized() {}, authorize: async () => {} });
    try {
      expect(versionCheck).not.toHaveBeenCalled(); beforeSearch?.();
      if (lease.stage.status !== 'ready' || !lease.stage.implementation) throw new Error('Embedding binding unavailable');
      return await lease.stage.implementation.search('source meaning', 5, call.signal);
    } finally { lease.release(); }
  });
  return { source, frames, fetch, versionCheck, embedding, run, runtime, inference, component, directory, encoder, watch, releaseWatch,
    select: (value: unknown) => { selection = value; }, setReadGate: (gate?: () => Promise<void>) => { readGate = gate; }, close: async () => {
    await runtime.dispose(); await inference.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

it('serves a configured foreground query while the background document watcher is still starting', async () => {
  const f = await fixture(false, false, false, true);
  const scan = f.runtime.scanWorkspace('original-workspace');
  try {
    await vi.waitFor(() => expect(f.watch).toHaveBeenCalledOnce());
    let result: Awaited<ReturnType<typeof f.run>> | undefined;
    const query = f.run().then(value => { result = value; });
    await vi.waitFor(() => expect(result).toBeDefined());
    await query;
    expect(result?.hits).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.watch).toHaveBeenCalledOnce();
  } finally { f.releaseWatch(); await scan; await f.close(); }
});

it('keeps cold source queries free of document inference and still honors explicit revocation', async () => {
  const f = await fixture(false);
  try {
    const result = await f.run();
    expect(result.hits).toEqual([]); expect(f.fetch).not.toHaveBeenCalled(); expect(f.versionCheck).not.toHaveBeenCalled();
    expect(result.gaps).toContainEqual({ path: '.', reason: 'index-not-ready' });
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.admit')).toHaveLength(0);
    f.versionCheck.mockClear(); f.fetch.mockClear();
    await expect(f.run(() => { f.embedding.enabled = false; })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.versionCheck).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps installed local inference idle without a publication and respects explicit model selections', async () => {
  const f = await fixture(false, true);
  try {
    const result = await f.run();
    expect(result.hits).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    const admitted = f.frames.filter(frame => frame.method === 'runtime.inference.admit');
    expect(admitted).toHaveLength(0);
    const before = (await f.component!.calls()).length;
    f.versionCheck.mockClear();
    await f.run();
    expect(await f.component!.calls()).toHaveLength(before);
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.admit')).toHaveLength(0);
    for (const selection of [{ enabled: false }, { protocol: 'invalid', providerId: 'bad' }, { ...f.embedding, providerId: 'unavailable' }]) {
      f.select(selection); f.versionCheck.mockClear();
      await expect(f.run()).rejects.toThrow('Embedding binding unavailable');
      expect(await f.component!.calls()).toHaveLength(before);
    }
    f.select(f.embedding); f.versionCheck.mockClear();
    await f.run(); expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.component!.calls()).toHaveLength(before);
  } finally { await f.close(); }
});

it('closes selection pins before waiting for replacement retirement while its next candidate is still preparing', async () => {
  const f = await fixture(false, true);
  try {
    await f.run();
    const nextPack = await localComponentFixture(join(f.directory, 'replacement'), { revision: 'next' });
    const next = createLocalSemanticEmbedder({ dataDir: '', pack: nextPack.pack });
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.setReadGate(async () => { entered(); await gate; });
    f.runtime.refreshLocalSemantic(next);
    await started;
    const closing = f.runtime.dispose();
    resume();
    await closing;
    await expect(f.encoder.prepare()).rejects.toThrow('disposed');
    await expect(next.prepare()).rejects.toThrow('disposed');
  } finally { f.setReadGate(); await f.close(); }
});

it('reuses the active local generation when the same verified component bytes are reimported', async () => {
  const f = await fixture(false, true);
  try {
    await f.run();
    const identical = await localComponentFixture(join(f.directory, 'same-bytes'));
    const next = createLocalSemanticEmbedder({ dataDir: '', pack: identical.pack });
    expect(next.localExecution!.identity).toEqual(f.encoder.localExecution!.identity);
    f.runtime.refreshLocalSemantic(next); await f.runtime.drain();
    await expect(next.prepare()).rejects.toThrow('disposed');
    const before = (await f.component!.calls()).length;
    f.versionCheck.mockClear(); await f.run();
    expect(await f.component!.calls()).toHaveLength(before);
    await f.encoder.prepare();
  } finally { await f.close(); }
});

it('keeps managed cold queries under their owner-qualified cache without local source lookup or indexing', async () => {
  const f = await fixture(false, false, true);
  try {
    const result = await f.run();
    expect(result.hits).toEqual([]);
    expect(result.scope).toEqual({ scopeKind: 'workspace', scopeId: f.source.cacheWorkspaceId });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.versionCheck).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
