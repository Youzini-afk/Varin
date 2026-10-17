import { expect, it, vi } from 'vitest';
import { createSemanticInference, type SemanticProviderBinding } from './runtime-inference.js';
import { createRerankInference } from './rerank-inference.js';
import { createDecisionInference } from './decision-inference.js';
import type { InferenceProviderBinding } from '../../models/service.js';
import type { InferenceCall, InferenceRequests, InferenceRequestsOptions } from './inference-requests.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const scope = { reference: 'provider', authority: 'original-extension', account: 'account', generation: 1 };
const model = { providerId: 'provider', modelId: 'model' };
const embedding = { ...model, protocol: 'openai-compatible', dimensions: 2, maxTokens: 4096 };
const settings = { harness: { embedding, rerank: { ...model, protocol: 'http-rerank' }, fastDecision: { default: { ...model, protocol: 'typed-classifier' } } } };
function provider() {
  const release = vi.fn();
  return { ...model, baseUrl: 'https://model.invalid/v1', requestUrl: 'https://model.invalid/v1/embeddings', api: 'typesafe-system-one',
    configurationId: 'original', credentialRef: 'provider', credentialScope: scope, routes: [], release,
    currentScope: async () => scope, assertAvailable: async () => {}, getAuth: vi.fn(async () => ({ auth: { apiKey: 'fixture-only' } })) } satisfies InferenceProviderBinding;
}
const forbidden = async () => { throw new Error('No model requests are allowed in capture tests'); };
it('embedding uses the selected model context capacity unless an explicit input budget overrides it', async () => {
  let budget: { maxTokens?: number } = {};
  const owner = createSemanticInference({
    readGlobalInferenceSettings: async () => ({ harness: { embedding: { ...model, protocol: 'openai-compatible', ...budget } } }),
    resolveEmbeddingBinding: async () => ({ ...provider(), contextWindow: 32768 }),
  });
  const original = await owner.capture();
  try {
    expect(original.binding.maxTokens).toBe(32768);
    budget = { maxTokens: 2048 };
    const next = await owner.capture();
    try { expect(next.binding.maxTokens).toBe(2048); } finally { next.release(); }
    expect(original.binding.maxTokens).toBe(32768);
  } finally { original.release(); await owner.close(); }
});
const requestOptions: InferenceRequestsOptions = { kernel: { agentRuntimeRequest: forbidden },
  runtime: { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} }, egress: { prepare: forbidden } };
const requestOwner = { run: forbidden } as unknown as InferenceRequests;
const purposes = ['embedding', 'rerank', 'decision'] as const;
function fixture(kind: typeof purposes[number], read = async (): Promise<unknown> => settings, resolve = async () => provider()) {
  if (kind === 'embedding') {
    const owner = createSemanticInference({ readGlobalInferenceSettings: read, resolveEmbeddingBinding: resolve });
    return { capture: () => owner.capture(), close: () => owner.close() };
  }
  const owner = kind === 'rerank' ? createRerankInference({ resolveRerankBinding: resolve }, read, requestOptions, requestOwner)
    : createDecisionInference({ resolveDecisionBinding: resolve }, read, requestOptions, requestOwner);
  return { capture: async () => { const result = await (kind === 'rerank' ? (owner as ReturnType<typeof createRerankInference>).capture() : (owner as ReturnType<typeof createDecisionInference>).capture('explore')); if (result.status !== 'ready') throw new Error(result.status); return result.lease; }, close: () => owner.close() };
}

it.each(purposes)('%s releases a captured provider when post-capture settings validation fails', async kind => {
  const captured = provider();
  let reads = 0;
  const f = fixture(kind, async () => { if (++reads > 1) throw new Error('Settings unavailable'); return settings; }, async () => captured);
  await expect(f.capture()).rejects.toThrow();
  expect(captured.release).toHaveBeenCalledOnce();
  await f.close(); expect(captured.release).toHaveBeenCalledOnce(); expect(captured.getAuth).not.toHaveBeenCalled();
});

it.each(purposes)('%s closes outstanding captures and rejects a capture that arrives after shutdown', async kind => {
  const accepted = provider(), late = provider(), gate = deferred<ReturnType<typeof provider>>();
  const resolve = vi.fn(async () => accepted).mockResolvedValueOnce(accepted).mockImplementationOnce(() => gate.promise);
  const f = fixture(kind, undefined, resolve);
  const lease = await f.capture();
  const pending = f.capture(), rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  await f.close(); expect(accepted.release).toHaveBeenCalledOnce();
  lease.release(); expect(accepted.release).toHaveBeenCalledOnce();
  gate.resolve(late); await rejected; expect(late.release).toHaveBeenCalledOnce();
});

it('embedding shares its captured provider across retained leases and waits for an in-progress authentication result', async () => {
  const captured = provider(), auth = deferred<{ auth: { apiKey: string } }>();
  captured.getAuth.mockImplementation(() => auth.promise);
  const request = vi.fn(forbidden);
  const options: InferenceRequestsOptions = { ...requestOptions, egress: { prepare: async () => ({}) as never } };
  const owner = createSemanticInference({ readGlobalInferenceSettings: async () => settings, resolveEmbeddingBinding: async (): Promise<SemanticProviderBinding> => captured }, undefined, { requests: options });
  const first = await owner.capture(), lease = first.retain();
  first.release(); expect(captured.release).not.toHaveBeenCalled();
  const call = { signal: new AbortController().signal, request } as unknown as InferenceCall;
  const pending = lease.consume(call, { ...lease.binding, batchId: 'batch', purpose: 'query', items: [{ id: 'query', text: 'query text' }], guard: async () => {} });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(captured.getAuth).toHaveBeenCalledOnce());
  lease.release(); await rejected;
  expect(captured.release).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  auth.resolve({ auth: { apiKey: 'late-fixture-only' } });
  await vi.waitFor(() => expect(captured.release).toHaveBeenCalledOnce());
  await owner.close(); expect(captured.release).toHaveBeenCalledOnce();
});

it.each(['query', 'index'] as const)('%s embeddings use the captured endpoint, headers and egress policy', async mode => {
  const captured = { ...provider(), endpoint: '/custom-embeddings', requestUrl: 'https://model.invalid/v1/custom-embeddings',
    headers: { 'X-Route': 'configured', 'X-Trace': 'configured' }, egressOverride: { mode: 'direct' as const },
    getAuth: async () => ({ auth: { headers: { 'x-trace': 'credential', authorization: 'Bearer fixture-only' } } }) };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(captured.requestUrl);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-route')).toBe('configured'); expect(headers.get('x-trace')).toBe('credential');
    expect(headers.get('authorization')).toBe('Bearer fixture-only');
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  const connection = { fetch, policy: {} as never };
  const prepare = vi.fn(async () => connection);
  const ledger = { admit: async () => ({ status: 'admitted' as const, token: 'original' }), settle: vi.fn(async () => {}),
    close: async () => {}, read: async () => null, list: async () => [] };
  const owner = createSemanticInference({ readGlobalInferenceSettings: async () => settings, resolveEmbeddingBinding: async () => captured }, undefined,
    { requests: { ...requestOptions, egress: { prepare } }, ledger });
  const lease = await owner.capture();
  try {
    const params = { ...lease.binding, batchId: 'batch', items: [{ id: 'text', text: 'Original source' }] };
    const signal = new AbortController().signal;
    const call = { signal, request: async (input: Parameters<InferenceCall['request']>[0]) => {
      expect(input.connection).toBe(connection);
      await input.check(signal);
      const { dispatcher: _dispatcher, ...requestInit }: RequestInit & { dispatcher?: unknown } = input.init;
      return input.connection.fetch(input.destination, requestInit);
    } } as unknown as InferenceCall;
    const result = mode === 'query' ? await lease.consume(call, { ...params, purpose: 'query', guard: async () => {} })
      : await lease.embed({ ...params, purpose: 'document', operationIdentity: { kind: 'index-build', hostId: 'host', workspaceId: 'workspace', recipeId: 'recipe', stage: 'document-embedding' } });
    expect(result.items[0]!.vector).toEqual([1, 0]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(captured.requestUrl, captured.egressOverride);
    expect(fetch).toHaveBeenCalledOnce();
    if (mode === 'index') expect(ledger.settle).toHaveBeenCalledOnce();
  } finally { lease.release(); await owner.close(); }
  expect(captured.release).toHaveBeenCalledOnce();
});
