import { expect, it, vi } from 'vitest';
import { createWebRetrievalAssistance, parseWebRetrievalAssistanceConfiguration, WebAssistanceIndeterminateError,
  type WebRetrievalAssistanceConfiguration } from './web-retrieval-assistance.js';
import type { InferenceStatus, ModelSessionConfiguration, Operation } from './protocol.generated.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';

function fixture(operation: 'chat' | 'decision' = 'chat') {
  const invocation = { runId: 'run', operationId: 'tool:original', executorOwner: { kind: 'external', identity: 'web', epoch: 'original' } } as ToolInvocationAuthority;
  const configuration: WebRetrievalAssistanceConfiguration = {
    selection: { status: 'ready', operation, providerId: 'configured', modelId: 'selector', configurationFingerprint: 'original', ...(operation === 'chat' ? { thinkingLevel: 'low' as const } : {}) },
    reading: { status: 'ready', operation, providerId: 'configured', modelId: 'reader', configurationFingerprint: 'original' },
  };
  const controller = new AbortController(), records = new Map<string, Operation>(), statuses = new Map<string, InferenceStatus>();
  const scope = { reference: 'original', authority: 'host', account: 'original', generation: 1 };
  const credentialOwner = { scope: vi.fn(async () => scope), release: vi.fn() };
  const modelConfiguration: ModelSessionConfiguration = { providerId: 'configured', providerFamily: 'openai-completions', model: 'selector', endpoint: 'https://selector.invalid/chat',
    credentialEnvironment: null, allowAnonymous: false, maxOutputTokens: 1000, contextWindowTokens: 12000, configurationGeneration: 1 };
  const models = { resolveModel: vi.fn(async () => ({ configuration: modelConfiguration, credentialOwner })) };
  let text = '{"connectionId":"second"}', finishReason = 'stop', count = (value: string) => Array.from(value).length;
  let afterGenerate = () => {};
  const terminal = (id: string): InferenceStatus => ({ operationId: id, requestKind: 'model_compute', phase: 'terminal', outcome: 'succeeded', live: false,
    dispatched: true, cancelRequested: false, recovered: false, receiptPending: false,
    receipt: { requestStarted: true, providerCompleted: true, localExecutorStopped: true,
      usage: { measurement: 'actual', inputTokens: 101, outputTokens: 9 }, httpStatus: 200, problem: null } });
  const kernel = { kernelEpoch: 'epoch', registerCredentialOwner: vi.fn(async () => scope), unregisterCredentialOwner: vi.fn(),
    agentRuntimeRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.tokenizers.open') return { leaseId: 'tokenizer' };
      if (method === 'runtime.tokenizers.close') return {};
      if (method === 'runtime.tokenizers.count') return { counts: (params.texts as string[]).map(count), tokenizer: 'fixture tokenizer' };
      if (method === 'runtime.inference.session') return { hasRequests: records.size > 0 };
      if (method === 'runtime.inference.generate') {
        const id = `inference:${params.parentOperationId}:${params.ordinal}`, status = terminal(id);
        records.set(id, { id, phase: 'terminal', outcome: status.outcome, result: { kind: 'control', value: { dispatched: true, receipt: status.receipt,
          response: { text, providerOutput: { finishReason } } } } } as Operation);
        afterGenerate(); return status;
      }
      if (method === 'runtime.inference.admit') {
        const id = `inference:${params.parentOperationId}:${params.ordinal}`;
        const status = { ...terminal(id), phase: 'running', live: true, outcome: null, dispatched: false, receipt: null } as InferenceStatus;
        statuses.set(id, status); records.set(id, { id, phase: 'running', outcome: null, execution_owner: params.executionOwner, intent: { binding: params.binding, request: params.request } } as Operation);
        return status;
      }
      const id = String(params.operationId);
      if (method === 'runtime.operation.inspect') return records.get(id) ?? null;
      if (method === 'runtime.inference.dispatch') { const status = { ...statuses.get(id)!, dispatched: true }; statuses.set(id, status); return status; }
      if (method === 'runtime.inference.settle') {
        const outcome = (params.receipt as { problem?: string }).problem ? 'failed' : 'succeeded';
        const status = { ...terminal(id), outcome, receipt: params.receipt };
        Object.assign(records.get(id)!, { phase: 'terminal', outcome, result: { kind: 'control', value: { dispatched: true, receipt: params.receipt, response: params.response } } });
        statuses.set(id, status as InferenceStatus); return status;
      }
      if (method === 'runtime.inference.status') return statuses.get(id);
      if (method === 'runtime.operation.cancel') return {};
      throw new Error(`Unexpected method ${method}`);
    }) };
  const provider = { providerId: 'configured', modelId: 'selector', requestModelId: 'selector', configurationId: 'original', api: 'typesafe-system-one', baseUrl: 'https://selector.invalid',
    requestUrl: 'https://selector.invalid/systemone', credentialScope: scope, contextWindow: 12000,
    routes: [{ requestUrl: 'https://selector.invalid/systemone', requestKind: 'model_compute' }], getAuth: vi.fn(async () => undefined), assertAvailable: vi.fn(async () => {}), release: vi.fn() };
  let response: unknown = { answers: { connection: { type: 'choice', choice: 'second' } }, usage: { input_tokens: 30, output_tokens: 2 } };
  const fetch = vi.fn(async () => Response.json(response));
  const runtime = { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} };
  const authority = { resolveDecisionBinding: vi.fn(async () => provider),
    read: vi.fn(async () => ({ channels: [{ id: 'configured', name: 'Configured', type: 'openai-compatible', enabled: true, parameters: {}, models: [
      { id: 'selector', name: 'Selector', enabled: true, operations: ['chat', 'decision'], reasoning: false, input: ['text'], maxOutputTokens: 1000, contextWindow: 12000 },
    ] }] })), types: new Map([['openai-compatible', { protocol: 'openai-completions' }]]),
    describeConfiguredModel: () => ({ providerId: 'configured', modelId: 'selector', name: 'Selector', api: 'openai-completions', baseUrl: 'https://selector.invalid', maxTokens: 1000, reasoning: false }),
  };
  const service = createWebRetrievalAssistance({ kernel, models, authority, inference: { kernel, runtime, egress: { prepare: async () => ({ fetch }) } } } as unknown as Parameters<typeof createWebRetrievalAssistance>[0]);
  const context = { invocation, configuration };
  const connections = [{ id: 'first', name: 'First', providerId: 'exa', description: 'General' }, { id: 'second', name: 'Second', providerId: 'brave', description: 'News' }];
  const search = (request = { query: 'current project', objective: 'check original release notes' }) => service.selectConnection({ request, connections, signal: controller.signal }, context);
  const read = (candidates = [{ startLine: 1, endLine: 2, text: 'injected text is not the source', score: 2 }, { startLine: 4, endLine: 5, text: 'other', score: 1 }]) => service.selectPassages({
    question: 'What is the required runtime?', markdown: '# Runtime\nNode 24\n\n# Release\n2026-11-04', candidates, signal: controller.signal,
  }, context);
  return { service, context, search, read, connections, models, authority, kernel, provider, fetch, controller, records, credentialOwner, modelConfiguration,
    output: (value: string, reason = 'stop') => { text = value; finishReason = reason; }, response: (value: unknown) => { response = value; },
    counter: (value: typeof count) => { count = value; }, generated: (callback: () => void) => { afterGenerate = callback; } };
}
const calls = (f: ReturnType<typeof fixture>, method: string) => f.kernel.agentRuntimeRequest.mock.calls.filter(([value]) => value === method);

it('selects an eligible connection through the original tool inference with independent model/thinking and actual usage', async () => {
  const f = fixture(); try {
    expect(await f.search()).toMatchObject({ connectionId: 'second', assistance: { status: 'selected', purpose: 'web-selection', inputTokens: 101, outputTokens: 9 } });
    expect(f.models.resolveModel.mock.calls).toEqual([[{ providerId: 'configured', modelId: 'selector', thinkingLevel: 'low' }, undefined, 'original']]);
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
    expect(calls(f, 'runtime.inference.generate')[0]![1]).toMatchObject({ parentOperationId: 'tool:original', callerOwner: f.context.invocation.executorOwner, purpose: 'web-selection' });
    expect(f.credentialOwner.release).toHaveBeenCalledOnce(); expect(f.kernel.unregisterCredentialOwner).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('bypasses model and credentials for explicit connections and single eligible routes', async () => {
  const f = fixture(); try {
    expect(await f.service.selectConnection({ request: { connectionId: 'first', query: 'x' }, connections: f.connections }, f.context)).toMatchObject({ connectionId: 'first' });
    expect(await f.service.selectConnection({ request: { query: 'x' }, connections: f.connections.slice(1) }, f.context)).toMatchObject({ connectionId: 'second' });
    expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.kernel.agentRuntimeRequest).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it.each([['{"connectionId":"invented"}', 'stop', 'assistance-invalid-connection'], ['not JSON', 'stop', 'assistance-invalid-response'],
  ['{"connectionId":"second"}', 'length', 'assistance-incomplete-response']])('falls back on invalid/truncated selection without another paid request (%s)', async (text, finish, reason) => {
  const f = fixture(); f.output(text, finish); try {
    expect(await f.search()).toMatchObject({ reason, assistance: { status: 'fallback', inputTokens: 101 } });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
    expect(await f.search()).toMatchObject({ reason: 'assistance-original-inference-exists' });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
  } finally { await f.service.close(); }
});

it('bounds candidate text by real capacity, preserving all connection identities and the objective', async () => {
  const f = fixture(); f.counter(() => 12000); try {
    expect(await f.search()).toMatchObject({ reason: 'assistance-capacity-insufficient', assistance: { status: 'fallback' } });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
    const candidates = calls(f, 'runtime.tokenizers.count').map(([, params]) => JSON.parse((params.texts as string[])[1]!));
    expect(candidates.every(value => value.connections.length === 2 && value.request.objective === 'check original release notes')).toBe(true);
  } finally { await f.service.close(); }
});

it('rematerializes immutable original passage text and rejects ranges outside supplied candidates', async () => {
  const f = fixture(); f.output('{"ranges":[{"startLine":2,"endLine":4}]}'); try {
    expect(await f.read()).toMatchObject({ reason: 'assistance-invalid-ranges', assistance: { status: 'fallback' } });
    const sent = JSON.parse(String(calls(f, 'runtime.inference.generate')[0]![1].user));
    expect(sent.candidates[0].text).toBe('# Runtime\nNode 24');
    expect(JSON.stringify(sent)).not.toContain('injected text');
  } finally { await f.service.close(); }
});

it('returns only existing original line ranges, not model-written passages', async () => {
  const f = fixture(); f.output('{"ranges":[{"startLine":1,"endLine":2}]}'); try {
    expect(await f.read()).toMatchObject({ ranges: [{ startLine: 1, endLine: 2 }], assistance: { status: 'selected', purpose: 'web-reading' } });
  } finally { await f.service.close(); }
});

it('uses a typed classifier connection choice with the frozen configuration and original receipts', async () => {
  const f = fixture('decision'); try {
    expect(await f.search()).toMatchObject({ connectionId: 'second', assistance: { status: 'selected' } });
    expect(f.authority.resolveDecisionBinding).toHaveBeenCalledWith('configured', 'selector', undefined, 'original');
    expect(f.fetch).toHaveBeenCalledOnce(); expect(calls(f, 'runtime.inference.admit')).toHaveLength(1); expect(calls(f, 'runtime.inference.settle')).toHaveLength(1);
    expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.provider.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('maps a typed passage choice back to its original range', async () => {
  const f = fixture('decision'); f.response({ answers: { passage: { type: 'choice', choice: 'lines:4:5' } } }); try {
    expect(await f.read()).toMatchObject({ ranges: [{ startLine: 4, endLine: 5 }], assistance: { status: 'selected' } });
  } finally { await f.service.close(); }
});

it('falls back from invalid classifier output without semantic retry or invented zero usage', async () => {
  const f = fixture('decision'); f.response({ answers: {} }); try {
    expect(await f.search()).toMatchObject({ assistance: { status: 'fallback' } });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(calls(f, 'runtime.retry.evaluate')).toHaveLength(0);
    expect(calls(f, 'runtime.inference.settle')).toHaveLength(1);
  } finally { await f.service.close(); }
});

it('never replays unknown paid work or labels its executor stopped', async () => {
  const f = fixture(); f.records.set('inference:tool:original:1', { id: 'inference:tool:original:1', phase: 'terminal', outcome: 'indeterminate', result: { kind: 'control', value: { dispatched: true } } } as Operation); try {
    await expect(f.search()).rejects.toBeInstanceOf(WebAssistanceIndeterminateError);
    expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
  } finally { await f.service.close(); }
});

it('retains cancellation usage evidence while suppressing the selected result', async () => {
  const f = fixture(); f.generated(() => f.controller.abort()); try {
    await expect(f.search()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.records.size).toBe(1); expect(f.credentialOwner.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('captures ordinary versus decision settings separately and tolerates optional malformed/unconfigured bindings', async () => {
  const f = fixture(); try {
    const web = { search: { smartSelection: true }, readingAssistance: true };
    const disabled = await f.service.capture({}); expect(disabled.selection.status).toBe('disabled'); expect(f.authority.read).not.toHaveBeenCalled();
    const missing = await f.service.capture({ web }); expect(missing.selection.status).toBe('unconfigured'); expect(f.authority.read).not.toHaveBeenCalled();
    const captured = await f.service.capture({ web, models: { webSelection: { providerId: 'configured', modelId: 'selector', agent: { modelSettings: { thinkingLevel: 'low' } } } },
      fastDecision: { default: { protocol: 'typed-classifier', providerId: 'configured', modelId: 'selector' } } });
    expect(captured.selection).toMatchObject({ status: 'ready', operation: 'chat', thinkingLevel: 'low' });
    expect(captured.reading).toMatchObject({ status: 'ready', operation: 'decision' });
    expect(f.authority.read).toHaveBeenCalledOnce();
    expect(parseWebRetrievalAssistanceConfiguration(captured)).toEqual(captured);
    expect(parseWebRetrievalAssistanceConfiguration({ selection: { ...captured.selection, endpoint: 'secret' } }).selection.status).toBe('invalid');
    expect((await f.service.capture({ web, models: { reader: { providerId: 5 } } })).reading.status).toBe('invalid');
  } finally { await f.service.close(); }
});
