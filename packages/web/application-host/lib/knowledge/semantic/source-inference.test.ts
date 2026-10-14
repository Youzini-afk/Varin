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

async function fixture(failSource: boolean, local = false, managed = false) {
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
  const documents = { inspectWorkspace: unavailable, read: unavailable, watch: unavailable } as unknown as DocumentAuthority;
  const component = local ? await localComponentFixture(join(directory, 'component')) : undefined;
  const encoder = component ? createLocalSemanticEmbedder({ dataDir: '', pack: component.pack }) : createHashEmbedder();
  const runtime = createWorkspaceSemanticRuntime({ dataDir: directory, hostId: 'source-inference',
    documents, structureSource: managed ? new Proxy({} as StructureSource, { get: () => { throw new Error('Managed source cannot use coordinator grammars'); } }) : structure,
    ...(managed ? { getIndexScope: () => { throw new Error('Managed source cannot use coordinator index selection'); } } : {}), scheduler: createEmbedScheduler(), embedder: encoder, runtimeInference: inference });
  let invocation = 0;
  const run = (beforeSearch?: () => void) => inference.requests!.run({ operationId: `original-query-${++invocation}`,
    executorOwner: { kind: 'external', identity: 'source-test', epoch: 'original-epoch' } }, new AbortController().signal, async call => {
    await call.assertFresh();
    const lease = await runtime.acquireQuery({ workspaceId: 'original-workspace', inference: call, roots: [''], signal: call.signal,
      sourceView: source, assertAuthorized() {}, authorize: async () => {} });
    try {
      expect(versionCheck).not.toHaveBeenCalled(); beforeSearch?.();
      if (lease.stage.status !== 'ready' || !lease.stage.implementation) throw new Error('Embedding binding unavailable');
      return await lease.stage.implementation.search('source meaning', 5, call.signal);
    } finally { lease.release(); }
  });
  return { source, frames, fetch, versionCheck, embedding, run, runtime, inference, component, directory, encoder,
    select: (value: unknown) => { selection = value; }, setReadGate: (gate?: () => Promise<void>) => { readGate = gate; }, close: async () => {
    await runtime.dispose(); await inference.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

it('checks complete document versions once at real egress and once before source publication', async () => {
  const f = await fixture(false);
  try {
    const result = await f.run();
    expect(result.hits).toHaveLength(1); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.versionCheck).toHaveBeenCalledTimes(2);
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.admit').map(frame => (frame.params.binding as { purpose: string }).purpose))
      .toEqual(['code-retrieval-document-embedding', 'code-retrieval-query-embedding']);
    const settled = f.frames.filter(frame => frame.method === 'runtime.inference.settle');
    expect(settled).toHaveLength(2);
    expect(settled.every(frame => (frame.params.receipt as { requestStarted: boolean }).requestStarted)).toBe(true);
    f.versionCheck.mockClear(); f.fetch.mockClear();
    await expect(f.run(() => { f.embedding.enabled = false; })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.versionCheck).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps original admission and dispatch intent when the last document fence prevents all HTTP', async () => {
  const f = await fixture(true);
  try {
    const result = await f.run();
    expect(result.hits).toEqual([]); expect(f.fetch).not.toHaveBeenCalled(); expect(f.versionCheck).toHaveBeenCalledOnce();
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.admit')).toHaveLength(1);
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.dispatch')).toHaveLength(1);
    const settled = f.frames.filter(frame => frame.method === 'runtime.inference.settle');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.params.receipt).toMatchObject({ requestStarted: false, providerCompleted: false, localExecutorStopped: true, problem: 'not_dispatched' });
  } finally { await f.close(); }
});

it('routes unconfigured native source/query through installed local identity and keeps explicit selections authoritative', async () => {
  const f = await fixture(false, true);
  try {
    const result = await f.run();
    expect(result.hits).toHaveLength(1);
    expect(f.fetch).not.toHaveBeenCalled();
    const admitted = f.frames.filter(frame => frame.method === 'runtime.inference.admit');
    expect(admitted).toHaveLength(2);
    expect(admitted.every(frame => (frame.params.binding as { executor: { kind: string } }).executor.kind === 'local_component')).toBe(true);
    expect(admitted.map(frame => frame.params.ordinal)).toEqual([1, 2]);
    const before = (await f.component!.calls()).length;
    f.versionCheck.mockClear();
    await f.run();
    expect(await f.component!.calls()).toHaveLength(before);
    expect(f.frames.filter(frame => frame.method === 'runtime.inference.admit')).toHaveLength(2);
    for (const selection of [{ enabled: false }, { protocol: 'invalid', providerId: 'bad' }, { ...f.embedding, providerId: 'unavailable' }]) {
      f.select(selection); f.versionCheck.mockClear();
      await expect(f.run()).rejects.toThrow('Embedding binding unavailable');
      expect(await f.component!.calls()).toHaveLength(before);
    }
    f.select(f.embedding); f.versionCheck.mockClear();
    await f.run(); expect(f.fetch).toHaveBeenCalled();
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

it('queries managed live source units under an owner-qualified cache with coordinator inference and no local source lookup', async () => {
  const f = await fixture(false, false, true);
  try {
    const result = await f.run();
    expect(result.hits).toHaveLength(1);
    expect(result.scope).toEqual({ scopeKind: 'workspace', scopeId: f.source.cacheWorkspaceId });
    expect(result.hits[0]?.body).toContain('export const source = 42');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.versionCheck).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
