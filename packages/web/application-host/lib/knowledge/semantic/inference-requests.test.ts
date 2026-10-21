import { expect, it, vi } from 'vitest';
import { createInferenceRequests } from './inference-requests.js';
import type { InferenceSettleParams, InferenceStatus } from '../../kernel/protocol.generated.js';

function fixture() {
  const settled: InferenceSettleParams[] = [];
  const bodies: string[] = [];
  const authorizations: string[] = [];
  const evaluated: unknown[] = [];
  const statuses = new Map<string, InferenceStatus>();
  const controller = new AbortController();
  let policy: (params: unknown) => unknown = () => ({ retry: true, delayMs: 0, reason: 'transient', ruleIndex: null });
  let response: () => Promise<Response> = async () => bodies.length === 1
    ? Response.json({ error: { code: 'busy', message: 'Try again' } }, { status: 503, headers: { 'x-request-id': 'failed-attempt' } })
    : Response.json({ result: 'complete', usage: { inputTokens: 9, outputTokens: 2 } });
  const kernel = { agentRuntimeRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'runtime.retry.evaluate') { evaluated.push(params); return policy(params); }
    if (method === 'runtime.inference.admit') {
      const operationId = `inference:${params.parentOperationId}:${params.ordinal}`;
      const status: InferenceStatus = { operationId, requestKind: 'model_compute', phase: 'running', outcome: null,
        live: true, dispatched: false, cancelRequested: false, recovered: false, receiptPending: false, receipt: null };
      statuses.set(operationId, status); return status;
    }
    const id = String(params.operationId);
    if (method === 'runtime.inference.dispatch') { const status = { ...statuses.get(id)!, dispatched: true }; statuses.set(id, status); return status; }
    if (method === 'runtime.inference.settle') {
      settled.push(params as unknown as InferenceSettleParams);
      const status = { ...statuses.get(id)!, phase: 'terminal', live: false, receipt: params.receipt };
      return status;
    }
    throw new Error(`Unexpected ${method}`);
  }) };
  const owner = createInferenceRequests({ kernel: kernel as never, runtime: { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} }, egress: {} as never,
    readRetrySettings: async () => ({ initialDelayMs: 0 }) });
  let checked = 0;
  const run = () => owner.run({ operationId: 'original', executorOwner: { kind: 'external', identity: 'fixture', epoch: 'host' } }, controller.signal,
    call => call.request({ binding: { requestKind: 'model_compute', purpose: 'code-retrieval-rerank', providerId: 'provider', modelId: 'model', configurationId: 'config',
      executor: { kind: 'http', api: 'rerank', endpoint: 'https://model.invalid/rerank', credentialScope: { reference: 'key', authority: 'host', account: 'original', generation: 1 } } },
    request: { input: 'unchanged' }, destination: 'https://model.invalid/rerank', init: { method: 'POST', body: 'frozen body' },
    connection: { fetch: async (_url: string, init: RequestInit) => {
      // A later paid attempt cannot precede publication of the previous receipt.
      expect(settled).toHaveLength(bodies.length);
      bodies.push(String(init.body)); authorizations.push(new Headers(init.headers).get('authorization')!); return response();
    } } as never,
    check: async signal => { signal.throwIfAborted(); checked++; },
    prepareHeaders: async () => ({ authorization: `refreshed-${bodies.length + 1}` }),
    observe: raw => ({ valid: typeof raw === 'object' && raw !== null && 'result' in raw,
      ...(typeof raw === 'object' && raw !== null && 'usage' in raw ? { usage: { measurement: 'actual' as const, inputTokens: 9, outputTokens: 2 } } : {}), rawUsage: null }),
  }));
  return { run, owner, controller, settled, bodies, authorizations, evaluated, checks: () => checked,
    policy: (next: typeof policy) => { policy = next; }, response: (next: typeof response) => { response = next; } };
}

it('admits each retry separately after settlement, keeps unknown usage and refreshes credentials', async () => {
  const f = fixture();
  try {
    expect(await (await f.run()).json()).toMatchObject({ result: 'complete' });
    expect(f.bodies).toEqual(['frozen body', 'frozen body']);
    expect(f.authorizations).toEqual(['refreshed-1', 'refreshed-2']);
    expect(f.settled.map(entry => entry.operationId)).toEqual(['inference:original:1', 'inference:original:2']);
    expect(f.settled[0]).toMatchObject({ receipt: { httpStatus: 503, usage: { measurement: 'missing', inputTokens: null } }, response: { providerRequestId: 'failed-attempt' } });
    expect(f.settled[1]).toMatchObject({ receipt: { usage: { measurement: 'actual', inputTokens: 9 } } });
    expect(f.evaluated).toMatchObject([{ retriesUsed: 0, failure: { code: 'busy', message: 'Try again' } }]);
  } finally { await f.owner.close(); }
});

it('cancels a backoff immediately without another transport or erasing the first receipt', async () => {
  const f = fixture();
  f.policy(() => { queueMicrotask(() => f.controller.abort()); return { retry: true, delayMs: 60000, reason: 'transient', ruleIndex: null }; });
  try { await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' }); expect(f.bodies).toHaveLength(1); expect(f.settled).toHaveLength(1); }
  finally { await f.owner.close(); }
});

it('returns an upstream rejection unchanged when the policy excludes it', async () => {
  const f = fixture();
  f.policy(() => ({ retry: false, delayMs: 0, reason: 'rule', ruleIndex: 0 }));
  try { expect((await f.run()).status).toBe(503); expect(f.bodies).toHaveLength(1); }
  finally { await f.owner.close(); }
});
