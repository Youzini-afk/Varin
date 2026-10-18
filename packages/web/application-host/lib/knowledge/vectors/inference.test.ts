import { afterEach, expect, it, vi } from 'vitest';
import { createSemanticInference } from '../semantic/runtime-inference.js';
import { createKnowledgeInference } from './inference.js';
import type { KnowledgeInferenceView, Operation, KnowledgeInferenceAdmit, KnowledgeInferenceReadParams, KnowledgeInferenceFinish,
  InferenceAdmitParams, InferenceSettleParams, InferenceSessionParams, InferenceReceipt } from '../../kernel/protocol.generated.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture() {
  const roots = new Map<string, KnowledgeInferenceView>();
  const operations = new Map<string, Operation>();
  type Request = KnowledgeInferenceAdmit & KnowledgeInferenceReadParams & KnowledgeInferenceFinish
    & InferenceAdmitParams & InferenceSettleParams & InferenceSessionParams;
  const methods: Array<{ method: string; params: Request }> = [];
  let revoked = false;
  let fetchResult: () => Promise<Response> = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.6, 0.8] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
  const fetch = vi.fn(async () => fetchResult());
  const status = (id: string) => { const operation = operations.get(id)!; const state = operation.result?.kind === 'control'
    ? operation.result.value as { dispatched?: boolean; receipt?: InferenceReceipt } : {}; return {
    operationId: id, live: operation.phase !== 'terminal', phase: operation.phase, dispatched: state.dispatched ?? false, recovered: false,
    cancelRequested: false, receipt: state.receipt ?? null, outcome: operation.outcome,
  }; };
  const kernel = { agentRuntimeRequest: async (method: string, params: Request) => {
    methods.push({ method, params });
    if (method === 'runtime.knowledge_inference.read') return roots.get(params.operationId) ?? null;
    if (method === 'runtime.knowledge_inference.admit') {
      const root: KnowledgeInferenceView = { operationId: `knowledge-inference:${params.key}`, runId: `run:${params.key}`, executionOwner: params.executionOwner, recipe: structuredClone(params.recipe), inference: [], cancelled: false, finished: false };
      roots.set(root.operationId, root); return root;
    }
    if (method === 'runtime.knowledge_inference.cancel') { const root = roots.get(params.operationId); if (root) root.cancelled = true; return root; }
    if (method === 'runtime.knowledge_inference.finish') { const root = roots.get(params.operationId)!; root.finished = true; return root; }
    if (method === 'runtime.inference.session') return { hasRequests: roots.get(params.parentOperationId)!.inference.length > 0 };
    if (method === 'runtime.inference.admit') {
      const operation = { id: `inference:${params.parentOperationId}:${params.ordinal}`, phase: 'running', outcome: null,
        intent: params, execution_owner: params.executionOwner, result: { kind: 'control', value: { dispatched: false } } } as unknown as Operation;
      operations.set(operation.id, operation); roots.get(params.parentOperationId)!.inference.push(operation); return status(operation.id);
    }
    if (method === 'runtime.inference.dispatch') { operations.get(params.operationId)!.result = { kind: 'control', value: { dispatched: true } }; return status(params.operationId); }
    if (method === 'runtime.inference.settle') { const operation = operations.get(params.operationId)!; operation.phase = 'terminal'; operation.outcome = params.receipt.problem ? 'failed' : 'succeeded';
      operation.result = { kind: 'control', value: { dispatched: true, receipt: params.receipt, response: params.response } }; return status(params.operationId); }
    if (method === 'runtime.inference.status') return status(params.operationId);
    if (method === 'runtime.operation.inspect') return operations.get(params.operationId) ?? null;
    throw new Error(`Unexpected ${method}`);
  } };
  const credentialScope = { reference: 'account', authority: 'host', account: 'user', generation: 1 };
  const inference = createSemanticInference({
    readGlobalInferenceSettings: async () => ({ harness: { embedding: { enabled: true, providerId: 'provider', modelId: 'embed', protocol: 'openai-compatible', dimensions: 2 } } }),
    resolveEmbeddingBinding: async () => ({ providerId: 'provider', modelId: 'embed', baseUrl: 'https://example.invalid/v1', requestUrl: 'https://example.invalid/v1/embeddings', configurationId: 'generation', credentialRef: 'account', credentialScope,
      assertAvailable: async () => { if (revoked) throw new Error('credential-scope-changed'); }, currentScope: async () => credentialScope, getAuth: async () => ({ auth: { apiKey: 'fixture-secret' } }), allowAnonymous: true }),
  }, undefined, { requests: { kernel: kernel as never, runtime: { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} } as never,
    egress: { prepare: async () => ({ fetch }) } as never } });
  const knowledge = createKnowledgeInference({ kernel: kernel as never, inference });
  closes.push(() => inference.close(), () => knowledge.close());
  return { roots, methods, fetch, knowledge, inference, revoke: () => { revoked = true; }, response: (value: () => Promise<Response>) => { fetchResult = value; } };
}
it('uses the original Knowledge utility parent, records actual usage, and restores completed bytes without another HTTP request', async () => {
  const f = fixture(); const lease = await f.inference.capture(); const embedder = await f.knowledge.resolve('bot:original', lease); lease.release();
  expect(await embedder.embed(['original source'], { purpose: 'query' })).toEqual([[0.6, 0.8]]);
  const admission = f.methods.find(call => call.method === 'runtime.knowledge_inference.admit')!.params;
  expect(admission).toMatchObject({ scopeId: 'bot:original', purpose: 'knowledge-query-embedding', executionOwner: { identity: 'knowledge.inference.v1' }, recipe: { params: { items: [{ text: 'original source' }] } } });
  expect(f.methods.find(call => call.method === 'runtime.inference.admit')!.params).toMatchObject({ parentOperationId: `knowledge-inference:${admission.key}`, binding: { purpose: 'knowledge-query-embedding' } });
  expect(f.methods.find(call => call.method === 'runtime.inference.settle')!.params.receipt).toMatchObject({ localExecutorStopped: true, providerCompleted: true, usage: { measurement: 'actual', inputTokens: 3 } });
  expect(await embedder.embed(['original source'], { purpose: 'query' })).toEqual([[0.6, 0.8]]);
  expect(f.fetch).toHaveBeenCalledOnce();
  f.revoke(); await expect(embedder.prepare()).rejects.toThrow('credential-scope-changed');
});
it('never automatically repeats a dispatched request whose outcome failed or is unknown', async () => {
  const f = fixture(); f.response(async () => { throw new Error('network lost after dispatch'); });
  const lease = await f.inference.capture(); const embedder = await f.knowledge.resolve('user', lease); lease.release();
  await expect(embedder.embed(['private memory'], { purpose: 'document' })).rejects.toThrow();
  await expect(embedder.embed(['private memory'], { purpose: 'document' })).rejects.toThrow('will not be replayed');
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.methods.find(call => call.method === 'runtime.knowledge_inference.finish')!.params.succeeded).toBe(false);
});
it('cancellation retains body drain and original settlement before finishing the utility parent', async () => {
  const f = fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.response(async () => { const response = new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })); const read = response.arrayBuffer.bind(response);
    Object.defineProperty(response, "arrayBuffer", { value: async () => { await held; return read(); } }); return response; });
  const lease = await f.inference.capture(); const embedder = await f.knowledge.resolve('thread:original', lease); lease.release();
  const controller = new AbortController(); const work = embedder.embed(['original'], { purpose: 'query', signal: controller.signal });
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce()); controller.abort(); await expect(work).rejects.toThrow();
  expect(f.methods.some(call => call.method === 'runtime.knowledge_inference.finish')).toBe(false);
  release(); await vi.waitFor(() => expect(f.methods.some(call => call.method === 'runtime.knowledge_inference.finish')).toBe(true));
  expect(f.methods.findIndex(call => call.method === 'runtime.inference.settle')).toBeLessThan(f.methods.findIndex(call => call.method === 'runtime.knowledge_inference.finish'));
});
