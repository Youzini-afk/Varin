import { expect, it, vi } from 'vitest';
import { KernelClientError } from './kernel-error.js';
import { delegationModelIdentity } from '../models/delegation-catalog.js';
import { createDelegationModelSelection } from './delegation-model-selection.js';
import type { DelegatedExecution, DelegationModelSelection, InferenceStatus, ModelSessionConfiguration, Operation } from './protocol.generated.js';

function fixture(operation: 'chat' | 'decision' = 'chat') {
  const choices = [{ model: 'first', thinking: 'off' }, { model: 'second', thinking: 'high' }];
  const work = { operationId: 'selection:original', runId: 'selection-run', executionOwner: { kind: 'kernel' }, result: null, inference: [],
    recipe: { catalog: { candidates: choices.map(choice => ({ id: choice.model, providerId: 'execution-channel', modelId: choice.model, name: choice.model, channelName: 'Execution',
      configurationFingerprint: `fingerprint:${choice.model}`, input: ['text'], thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'off' })),
      selector: { providerId: 'selector-channel', modelId: 'selector', operation, configurationFingerprint: 'selector-fingerprint', thinkingLevel: operation === 'chat' ? 'low' : undefined } },
    choices, execution: { tools: ['read'], workMode: 'read_only', inputTypes: ['text'] }, input: { task: 'Implement the requested fix', tools: ['read'] }, messages: [{ id: 'latest', role: 'user', text: 'Preserve the original ownership.', recentAssistant: false }] } } as DelegationModelSelection;
  const controller = new AbortController(), statuses = new Map<string, InferenceStatus>(), receipts = new Map<string, Operation>();
  const child = { execution_id: 'child', trigger: { kind: 'dispatch' }, selected_profile: { model_selection_required: true } } as DelegatedExecution;
  const done = { ...child, selected_profile: { ...child.selected_profile, model_selection_required: false } };
  const scope = { reference: 'original', authority: 'host', account: 'original', generation: 1 };
  const selectorOwner = { scope: vi.fn(async () => scope), release: vi.fn() }, executorOwner = { scope: vi.fn(async () => scope), release: vi.fn() };
  const configuration: ModelSessionConfiguration = { providerId: 'selector-channel', providerFamily: 'openai-completions', model: 'selector', endpoint: 'https://selector.invalid/chat',
    credentialEnvironment: null, allowAnonymous: false, maxOutputTokens: 2000, contextWindowTokens: 16000, configurationGeneration: 1 };
  const models = { resolveModel: vi.fn(async (selection: { providerId: string }) => ({ configuration, credentialOwner: selection.providerId === 'selector-channel' ? selectorOwner : executorOwner })) };
  let text = JSON.stringify(choices[1]), finishReason = 'stop', count = (value: string) => Array.from(value).length;
  let onGenerated = () => {};
  let generationFailure: { code: string; message: string } | undefined;
  let admissionHold: KernelClientError | undefined, admitBeforeHold = false;
  let original = true, settings: unknown = { enabled: false };
  const terminal = (id: string): InferenceStatus => ({ operationId: id, requestKind: 'model_compute', phase: 'terminal', outcome: 'succeeded', live: false,
    dispatched: true, cancelRequested: false, recovered: false, receiptPending: false, receipt: { requestStarted: true, providerCompleted: true, localExecutorStopped: true,
      usage: { measurement: 'actual', inputTokens: 100, outputTokens: 10 }, httpStatus: 200, problem: null } });
  const kernel = { kernelEpoch: 'original-epoch', registerCredentialOwner: vi.fn(async () => scope), unregisterCredentialOwner: vi.fn(), retainSelectedChildModel: vi.fn(async () => scope),
    agentRuntimeRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.child.model.read') return original ? structuredClone(work) : null;
      if (method === 'runtime.child.model.prepare') return structuredClone(work);
      if (method === 'runtime.child.model.commit') { work.result = params.choice as typeof work.result; return {}; }
      if (method === 'runtime.tokenizers.open') return { leaseId: 'tokenizer' };
      if (method === 'runtime.tokenizers.close') return {};
      if (method === 'runtime.tokenizers.count') return { counts: (params.texts as string[]).map(count), tokenizer: 'fixture tokenizer' };
      if (method === 'runtime.inference.session') return { hasRequests: receipts.size > 0 };
      if (method === 'runtime.inference.generate') {
        const id = `inference:${params.parentOperationId}:${params.ordinal}`, status = terminal(id);
        if (generationFailure) {
          status.outcome = 'failed'; status.dispatched = false;
          status.receipt = { ...status.receipt!, requestStarted: false, providerCompleted: false, problem: 'not_dispatched',
            usage: { measurement: 'missing', inputTokens: null, outputTokens: null } };
        }
        receipts.set(id, { id, phase: 'terminal', outcome: status.outcome, result: { kind: 'control', value: { dispatched: status.dispatched, receipt: status.receipt,
          response: { text: generationFailure ? null : text, providerOutput: { finishReason: generationFailure ? null : finishReason }, ...(generationFailure ? { failure: generationFailure } : {}) } } } } as Operation);
        onGenerated(); return status;
      }
      if (method === 'runtime.inference.admit') {
        if (admissionHold && !admitBeforeHold) throw admissionHold;
        const id = `inference:${params.parentOperationId}:${params.ordinal}`;
        const status = { ...terminal(id), phase: 'running', live: true, outcome: null, dispatched: false, receipt: null } as InferenceStatus;
        statuses.set(id, status); receipts.set(id, { id, phase: 'running', outcome: null, execution_owner: params.executionOwner, intent: { binding: params.binding, request: params.request } } as Operation);
        if (admissionHold) throw admissionHold; return status;
      }
      const id = String(params.operationId);
      if (method === 'runtime.operation.inspect') return receipts.get(id);
      if (method === 'runtime.inference.dispatch') { const status = { ...statuses.get(id)!, dispatched: true }; statuses.set(id, status); return status; }
      if (method === 'runtime.inference.settle') {
        const outcome = (params.receipt as { problem?: string }).problem ? 'failed' : 'succeeded';
        const status = { ...terminal(id), outcome, receipt: params.receipt };
        Object.assign(receipts.get(id)!, { phase: 'terminal', outcome, result: { kind: 'control', value: { dispatched: true, receipt: params.receipt, response: params.response } } });
        return status;
      }
      if (method === 'runtime.retry.evaluate') return { retry: true, delayMs: 0, reason: 'rule', ruleIndex: 0 };
      if (method === 'runtime.operation.cancel') return {};
      throw new Error(`Unexpected method ${method}`);
    }) };
  const provider = { providerId: 'selector-channel', modelId: 'selector', requestModelId: 'selector', configurationId: 'original', api: 'typesafe-system-one', baseUrl: 'https://selector.invalid',
    requestUrl: 'https://selector.invalid/systemone', credentialScope: scope, contextWindow: 16000,
    routes: [{ requestUrl: 'https://selector.invalid/systemone', requestKind: 'model_compute' }], getAuth: vi.fn(async () => undefined), assertAvailable: vi.fn(async () => {}), release: vi.fn() };
  let response: unknown = { answers: { execution: { type: 'choice', choice: 'choice:1' } } };
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(response));
  const runtime = { childExecution: vi.fn(async () => done), onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} };
  const authority = { resolveDecisionBinding: vi.fn(async () => provider), readGlobalInferenceSettings: vi.fn(async () => ({ harness: { delegationModelSelection: settings } })),
    read: vi.fn(async () => ({ channels: [{ id: 'fresh-channel', name: 'Fresh', type: 'openai-compatible', enabled: true, parameters: {}, models: [
      { id: 'fresh-model', name: 'Fresh model', enabled: true, operations: ['chat'], reasoning: false, input: ['text'], maxOutputTokens: 2000, contextWindow: 16000 },
    ] }] })), types: new Map([['openai-compatible', { protocol: 'openai-completions' }]]),
    describeConfiguredModel: () => ({ providerId: 'fresh-channel', modelId: 'fresh-model', name: 'Fresh model', api: 'openai-completions', baseUrl: 'https://fresh.invalid', maxTokens: 2000, reasoning: false }),
  };
  const service = createDelegationModelSelection({ kernel, runtime, models, authority,
    inference: { kernel, runtime, egress: { prepare: async () => ({ fetch }) } } } as unknown as Parameters<typeof createDelegationModelSelection>[0]);
  return { service, prepare: () => service.prepare(child, controller.signal), work, child, done, models, kernel, authority, fetch, provider, controller, selectorOwner, executorOwner, receipts,
    output: (value: string, reason = 'stop') => { text = value; finishReason = reason; }, response: (value: unknown) => { response = value; },
    holdAdmission: (value: KernelClientError | undefined, accepted = false) => { admissionHold = value; admitBeforeHold = accepted; },
    failGeneration: (value: { code: string; message: string }) => { generationFailure = value; },
    fresh: (value: unknown) => { original = false; settings = value; }, accepted: () => { original = true; },
    counter: (value: typeof count) => { count = value; }, generated: (callback: () => void) => { onGenerated = callback; } };
}
const calls = (f: ReturnType<typeof fixture>, method: string) => f.kernel.agentRuntimeRequest.mock.calls.filter(([value]) => value === method);

it('uses one ordinary chat inference, frozen independent thinking and only the selected execution binding', async () => {
  const f = fixture(); try {
    expect(await f.prepare()).toEqual(f.done);
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
    expect(f.models.resolveModel.mock.calls).toEqual([[{ providerId: 'selector-channel', modelId: 'selector', thinkingLevel: 'low' }, undefined, 'selector-fingerprint'],
      [{ providerId: 'execution-channel', modelId: 'second', thinkingLevel: 'high' }, undefined, 'fingerprint:second']]);
    expect(calls(f, 'runtime.child.model.commit')[0]![1].choice).toEqual(f.work.recipe.choices[1]);
    expect(f.kernel.retainSelectedChildModel).toHaveBeenCalledWith(f.child, f.executorOwner, f.controller.signal);
    expect(f.selectorOwner.release).toHaveBeenCalledOnce(); expect(f.executorOwner.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('runs a normal classifier question once through the original inference owner', async () => {
  const f = fixture('decision'); try {
    await f.prepare(); expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.authority.resolveDecisionBinding).toHaveBeenCalledWith('selector-channel', 'selector', undefined, 'selector-fingerprint');
    expect(calls(f, 'runtime.inference.admit')).toHaveLength(1); expect(calls(f, 'runtime.inference.settle')).toHaveLength(1);
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
    expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(f.provider.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('fully configured choices bypass the selector and its tokenizer/auth', async () => {
  const f = fixture(); f.work.recipe.choices = [f.work.recipe.choices[0]!]; try {
    await f.prepare(); expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(calls(f, 'runtime.tokenizers.open')).toHaveLength(0);
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(0); expect(f.authority.resolveDecisionBinding).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it.each([['not JSON', 'stop', 'delegation-selection-invalid-response'], ['{"model":"unknown","thinking":"off"}', 'stop', 'delegation-selection-unknown-choice'],
  ['{"model":"second","thinking":"high"}', 'length', 'delegation-selection-failed']])('rejects %s / %s from original chat evidence without retry', async (text, reason, code) => {
  const f = fixture(); f.output(text, reason); try {
    await expect(f.prepare()).rejects.toMatchObject({ code }); expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
    expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(calls(f, 'runtime.child.model.commit')).toHaveLength(0);
  } finally { await f.service.close(); }
});

it('never semantically retries invalid classifier output, even under an accepting retry rule', async () => {
  const f = fixture('decision'); f.response({ answers: {} }); try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-invalid-response' }); expect(f.fetch).toHaveBeenCalledOnce();
    expect(calls(f, 'runtime.retry.evaluate')).toHaveLength(0); expect(f.models.resolveModel).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('reuses the complete original receipt after restart without selector acquisition, recounting or paid regeneration', async () => {
  const first = fixture(); await first.prepare(); const original = [...first.receipts.values()]; await first.service.close();
  const f = fixture(); f.work.inference = original; try {
    await f.prepare(); expect(calls(f, 'runtime.inference.generate')).toHaveLength(0); expect(calls(f, 'runtime.tokenizers.open')).toHaveLength(0);
    expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(f.work.result).toEqual(f.work.recipe.choices[1]);
  } finally { await f.service.close(); }
});

it('refuses indeterminate original inference without another paid request', async () => {
  const f = fixture(); f.work.inference = [{ phase: 'terminal', outcome: 'indeterminate', result: { kind: 'control', value: { dispatched: true } } } as Operation]; try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-indeterminate' }); expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
  } finally { await f.service.close(); }
});

it('rejects insufficient capacity before any generation without deleting candidates', async () => {
  const f = fixture(); f.counter(() => 20000); try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-capacity-insufficient' }); expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
    const inputs = calls(f, 'runtime.tokenizers.count').map(([, params]) => JSON.parse((params.texts as string[])[1]!));
    expect(inputs.every(input => input.candidates.length === 2 && input.choices.length === 2)).toBe(true);
    expect(f.selectorOwner.release).toHaveBeenCalledOnce(); expect(f.models.resolveModel).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('cancellation after selection receipt prevents selected executor acquisition', async () => {
  const f = fixture(); f.generated(() => f.controller.abort()); try {
    await expect(f.prepare()).rejects.toMatchObject({ name: 'AbortError' }); expect(f.models.resolveModel).toHaveBeenCalledOnce();
    expect(f.receipts.size).toBe(1); expect(calls(f, 'runtime.child.model.commit')).toHaveLength(0); expect(f.selectorOwner.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});


it('freezes current selector settings only at first preparation, then never rereads the configuration on replay', async () => {
  const f = fixture(); f.fresh({ enabled: true, model: { providerId: 'fresh-channel', modelId: 'fresh-model' } }); try {
    await f.prepare();
    expect(f.authority.readGlobalInferenceSettings).toHaveBeenCalledOnce(); expect(f.authority.read).toHaveBeenCalledOnce();
    expect(calls(f, 'runtime.child.model.prepare')[0]![1]).toMatchObject({ catalog: { selector: { providerId: 'fresh-channel', modelId: 'fresh-model', thinkingLevel: 'off' } } });
    f.accepted(); f.authority.readGlobalInferenceSettings.mockRejectedValue(new Error('Settings were edited after acceptance'));
    await f.prepare(); expect(f.authority.readGlobalInferenceSettings).toHaveBeenCalledOnce();
    expect(calls(f, 'runtime.child.model.prepare')[1]![1]).not.toHaveProperty('catalog');
  } finally { await f.service.close(); }
});

it('disabled implicit inheritance commits the original retained binding without consulting any candidate or acquiring a new owner', async () => {
  const f = fixture(); f.fresh({ enabled: false });
  const binding = { configuration: { model: 'inherited-executor' }, credential_scope: { reference: 'original' } };
  Object.assign(f.work.recipe, { inheritedBinding: binding, catalog: { candidates: [], selector: null }, choices: [{ model: 'inherit', thinking: 'off' }] });
  try {
    await f.prepare(); expect(f.authority.read).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.child.model.prepare')[0]![1]).toMatchObject({ catalog: { candidates: [], selector: null } });
    expect(calls(f, 'runtime.child.model.commit')[0]![1].binding).toEqual(binding); expect(f.kernel.retainSelectedChildModel).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});


it('reinterprets the original classifier response without recounting, auth or new transport', async () => {
  const first = fixture('decision'); await first.prepare(); const original = [...first.receipts.values()]; await first.service.close();
  const f = fixture('decision'); f.work.inference = original; try {
    await f.prepare(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.authority.resolveDecisionBinding).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.tokenizers.open')).toHaveLength(0); expect(f.work.result).toEqual(f.work.recipe.choices[1]);
  } finally { await f.service.close(); }
});

it.each([true, false])('llama selection uses one complete probability readout, not a correction loop (complete=%s)', async complete => {
  const f = fixture('decision'); f.provider.api = 'llama-cpp-classify'; f.provider.requestUrl = 'https://selector.invalid/completion';
  f.provider.routes = ['tokenize', 'apply-template', 'completion'].map(path => ({ requestUrl: `https://selector.invalid/${path}`, requestKind: path === 'completion' ? 'model_compute' : 'preparation' }));
  const depths: number[] = [];
  f.fetch.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/tokenize')) return Response.json({ tokens: Array.from(body.content as string).map(character => character.codePointAt(0)) });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: body.messages[1].content });
    depths.push(body.n_probs); return Response.json({ tokens_evaluated: 20, tokens_predicted: 1,
      completion_probabilities: [{ top_logprobs: (complete ? ['A', 'B'] : ['A']).map(label => ({ id: label.codePointAt(0), logprob: label === 'B' ? 0 : -100 })) }] });
  });
  try {
    if (complete) {
      await f.prepare(); expect(f.work.result).toEqual(f.work.recipe.choices[1]);
      // Reconstruct from original request input, not a newly packed/edited recipe.
      f.work.inference = [...f.receipts.values()]; f.work.result = null; f.work.recipe.messages[0]!.text = 'Changed after accepted selection';
      const callsBefore = f.fetch.mock.calls.length; await f.prepare(); expect(f.fetch.mock.calls).toHaveLength(callsBefore);
    } else await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-failed' });
    expect(depths).toEqual([32768]);
    expect(calls(f, 'runtime.inference.admit').filter(([, params]) => (params.binding as { requestKind: string }).requestKind === 'model_compute')).toHaveLength(1);
  } finally { await f.service.close(); }
});


it('cancellation while acquiring the classifier releases its late owner without selecting an executor', async () => {
  const f = fixture('decision'); let resolve!: () => void; const gate = new Promise<void>(done => { resolve = done; });
  f.authority.resolveDecisionBinding.mockImplementation(async () => { await gate; return f.provider; });
  try {
    const pending = f.prepare(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.authority.resolveDecisionBinding).toHaveBeenCalledOnce());
    f.controller.abort(); await rejected; expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    resolve(); await vi.waitFor(() => expect(f.provider.release).toHaveBeenCalledOnce());
  } finally { resolve(); await f.service.close(); }
});


it('fresh fully explicit dispatch never reads or resolves an unavailable selector', async () => {
  const f = fixture(); f.fresh({ enabled: true, model: { providerId: 'unavailable', modelId: 'missing' } });
  f.child.input = { model: 'fixed-public-id', thinking: 'default', task: 'Explicit task' };
  f.work.recipe.choices = [f.work.recipe.choices[0]!];
  f.authority.readGlobalInferenceSettings.mockRejectedValue(new Error('Selector settings must not be consulted'));
  try {
    await f.prepare(); expect(f.authority.readGlobalInferenceSettings).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.child.model.prepare')[0]![1]).toMatchObject({ catalog: { selector: null } });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(0); expect(f.models.resolveModel).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('transient classifier transport retries preserve the original input and ordinary receipt accounting', async () => {
  const f = fixture('decision'); f.fetch.mockImplementationOnce(async () => new Response('Temporary upstream failure', { status: 503 }));
  try {
    await f.prepare(); expect(f.fetch).toHaveBeenCalledTimes(2); expect(calls(f, 'runtime.inference.settle')).toHaveLength(2);
    const admitted = calls(f, 'runtime.inference.admit').map(([, params]) => params);
    expect(admitted[0]!.request).toEqual(admitted[1]!.request); expect(admitted[0]!.binding).toEqual(admitted[1]!.binding);
    expect(calls(f, 'runtime.retry.evaluate')).toHaveLength(1);
    f.work.inference = [...f.receipts.values()]; f.work.result = null;
    await f.prepare(); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.work.result).toEqual(f.work.recipe.choices[1]);
  } finally { await f.service.close(); }
});

it('a classifier option limit is a concrete admission failure, not permission to drop configurations', async () => {
  const f = fixture('decision'); f.provider.api = 'llama-cpp-classify';
  f.work.recipe.choices = Array.from({ length: 63 }, (_, index) => ({ model: `model:${index}`, thinking: 'off' }));
  try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-options-exceeded' });
    expect(f.fetch).not.toHaveBeenCalled(); expect(calls(f, 'runtime.tokenizers.open')).toHaveLength(0);
    expect(f.work.recipe.choices).toHaveLength(63); expect(f.models.resolveModel).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});


it.each(['delegation-selection-capacity-exceeded', 'delegation-selection-capacity-unknown'])('surfaces original native %s diagnostics live and after restart without another request', async code => {
  const f = fixture(); const message = 'Serialized selector input requires 1500 tokens; 1400 remain after output reserve';
  f.failGeneration({ code, message });
  try {
    await expect(f.prepare()).rejects.toMatchObject({ code, message });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1); expect(f.models.resolveModel).toHaveBeenCalledOnce();
    expect(calls(f, 'runtime.child.model.commit')).toHaveLength(0);
    f.work.inference = [...f.receipts.values()];
    await expect(f.prepare()).rejects.toMatchObject({ code, message });
    expect(calls(f, 'runtime.inference.generate')).toHaveLength(1); expect(f.models.resolveModel).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('preserves a concrete native failure code without exposing arbitrary provider/auth messages', async () => {
  const f = fixture(); f.failGeneration({ code: 'credential_unavailable', message: 'private provider or credential diagnostic' });
  try {
    const error = await f.prepare().catch(error => error as Error & { code: string });
    expect(error).toMatchObject({ code: 'credential_unavailable' });
    expect(String(error)).not.toContain('private provider or credential diagnostic');
    expect(f.models.resolveModel).toHaveBeenCalledOnce(); expect(calls(f, 'runtime.inference.generate')).toHaveLength(1);
  } finally { await f.service.close(); }
});


it.each(['catalogModelId', 'model'] as const)('disabled thinking-only selection narrows metadata to the original inherited %s', async identityField => {
  const f = fixture(); f.fresh({ enabled: false });
  f.child.input = { thinking: 'off', task: 'Use the inherited model' };
  f.child.configuration = { providerId: 'fresh-channel', model: 'fresh-model', ...(identityField === 'catalogModelId' ? { catalogModelId: 'fresh-model', model: 'raw-request-alias' } : {}) };
  f.work.recipe.choices = [f.work.recipe.choices[0]!];
  const snapshot = await f.authority.read();
  snapshot.channels[0]!.models.push({ ...snapshot.channels[0]!.models[0]!, id: 'unrelated-model' });
  f.authority.read.mockResolvedValue(snapshot);
  try {
    await f.prepare();
    const catalog = calls(f, 'runtime.child.model.prepare')[0]![1].catalog as { candidates: { id: string }[]; selector: unknown };
    expect(catalog.candidates.map(candidate => candidate.id)).toEqual([delegationModelIdentity('fresh-channel', 'fresh-model')]);
    expect(catalog.selector).toBeNull(); expect(calls(f, 'runtime.inference.generate')).toHaveLength(0);
  } finally { await f.service.close(); }
});

it('disabled thinking-only selection reports missing inherited identity without choosing a fallback', async () => {
  const f = fixture(); f.fresh({ enabled: false }); f.child.input = { thinking: 'off', task: 'Use the inherited model' };
  f.child.configuration = { model: 'missing-channel-identity' };
  try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-inherited-model-unavailable' });
    expect(f.authority.read).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.child.model.prepare')).toHaveLength(0);
  } finally { await f.service.close(); }
});


it('enabled thinking-only selection keeps the full model catalog instead of inheriting a fixed model', async () => {
  const f = fixture(); f.fresh({ enabled: true, model: { providerId: 'fresh-channel', modelId: 'fresh-model' } });
  f.child.input = { thinking: 'off', task: 'Choose a model for this fixed thinking mode' };
  const snapshot = await f.authority.read(); snapshot.channels[0]!.models.push({ ...snapshot.channels[0]!.models[0]!, id: 'second-eligible-model' });
  f.authority.read.mockResolvedValue(snapshot);
  try {
    await f.prepare();
    const catalog = calls(f, 'runtime.child.model.prepare')[0]![1].catalog as { candidates: { id: string }[] };
    expect(catalog.candidates.map(candidate => candidate.id).sort()).toEqual(['fresh-model', 'second-eligible-model'].map(id => delegationModelIdentity('fresh-channel', id)).sort());
  } finally { await f.service.close(); }
});


it('commits exactly the scope retained by the child handoff without a separate stale scope read', async () => {
  const f = fixture(); const retainedScope = { reference: 'retained', authority: 'host', account: 'account-after-refresh', generation: 19 };
  f.kernel.retainSelectedChildModel.mockResolvedValue(retainedScope);
  f.executorOwner.scope.mockRejectedValue(new Error('A separate scope read would introduce a race'));
  try {
    await f.prepare(); expect(f.executorOwner.scope).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.child.model.commit')[0]![1]).toMatchObject({ binding: { credential_scope: retainedScope } });
  } finally { await f.service.close(); }
});


it.each(['activation-held', 'bot-suspended'])('preserves exact pre-admission classifier %s and resumes only when no original request exists', async code => {
  const f = fixture('decision'), held = new KernelClientError({ code, message: 'Original execution is held' });
  f.holdAdmission(held);
  try {
    await expect(f.prepare()).rejects.toBe(held);
    expect(f.receipts.size).toBe(0); expect(f.fetch).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
    expect(calls(f, 'runtime.child.model.commit')).toHaveLength(0);
    f.holdAdmission(undefined); await f.prepare();
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.work.result).toEqual(f.work.recipe.choices[1]);
  } finally { await f.service.close(); }
});

it.each(['typesafe-system-one', 'llama-cpp-classify'])('does not treat %s accepted request evidence as a transparent pre-admission hold', async api => {
  const f = fixture('decision'), held = new KernelClientError({ code: 'bot-suspended', message: 'Held after original admission' });
  f.provider.api = api;
  if (api === 'llama-cpp-classify') {
    f.provider.requestUrl = 'https://selector.invalid/completion';
    f.provider.routes = ['tokenize', 'apply-template', 'completion'].map(path => ({ requestUrl: `https://selector.invalid/${path}`, requestKind: path === 'completion' ? 'model_compute' : 'preparation' }));
  }
  f.holdAdmission(held, true);
  try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delegation-selection-failed' });
    expect(f.receipts.size).toBeGreaterThan(0); expect(calls(f, 'runtime.inference.settle').length).toBeGreaterThan(0);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.models.resolveModel).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});
