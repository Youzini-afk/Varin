import { expect, it, vi } from 'vitest';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { CredentialBridge } from './credential-bridge.js';
import { createChildProfilePreparer } from './child-profiles.js';
import { createPolicyModelPreparer } from './policy-models.js';
import { createRetrievalModelStage } from './retrieval-model.js';
import { createMemoryInference } from '../memory/memory-inference.js';
import { modelCredentialBindingIdentity } from './model-binding-lifetime.js';
import type { ThreadModelAuthority } from './thread-adapter.js';
import type { ModelSessionConfiguration, RetrievalQuery } from './protocol.generated.js';
import type { InferenceCall } from '../knowledge/semantic/inference-requests.js';

const scope = { reference: 'original-model', authority: 'extension-auth', account: 'original-account', generation: 1 };
const configuration: ModelSessionConfiguration = { providerId: 'original-channel', providerFamily: 'openai-completions', model: 'original-model',
  endpoint: 'https://model.invalid/v1/chat/completions', credentialEnvironment: null, maxOutputTokens: null, allowAnonymous: false, configurationGeneration: 1 };
const selection = { providerId: configuration.providerId!, modelId: configuration.model };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function captured(currentScope = async () => scope) {
  const released = vi.fn();
  const owner = new ExistingHostCredentialOwner({ providerId: selection.providerId, providerFamily: configuration.providerFamily,
    endpoint: configuration.endpoint, currentScope, runtime: { getAuth: async () => ({ auth: { apiKey: 'fixture-only' } }) }, release: released });
  return { owner, released, model: { configuration, credentialOwner: owner, acceptsImages: false } };
}
const agent = { name: 'Precise', description: 'Original profile', instructions: '', enabled: true, tools: [], worktree: 'none',
  workFocus: [], modelSettings: { temperature: 0 } };
const parent = { configuration, credential_scope: scope };

it('live binding identity distinguishes adapter instances with the same durable configuration', () => {
  const first = { ...configuration, adapterBindingId: 'original-instance' };
  const second = { ...configuration, adapterBindingId: 'restarted-instance' };
  expect(modelCredentialBindingIdentity(first)).not.toBe(modelCredentialBindingIdentity(second));
  expect(modelCredentialBindingIdentity({ ...first })).toBe(modelCredentialBindingIdentity(first));
});

it('child metadata validates the inherited generation in its normalized capture and releases it', async () => {
  const normalized = captured();
  const resolveModel = vi.fn(async () => normalized.model), rebindModel = vi.fn();
  const prepare = createChildProfilePreparer({ settings: async () => ({ harness: { agents: { precise: agent } } }), capabilities: async () => [],
    models: { resolveModel, rebindModel } });
  const result = await prepare({ parent });
  expect(result.presets.find(value => value.id === 'custom:precise')).toMatchObject({ model: { configuration }, inherit_base: parent, unavailable: null });
  expect(resolveModel).toHaveBeenCalledWith({ ...selection, temperature: 0 }, { configuration, credentialScope: scope });
  expect(rebindModel).not.toHaveBeenCalled();
  expect(normalized.released).toHaveBeenCalledOnce();
});

it.each(['resolve', 'scope'] as const)('cancelled child %s releases its late capture without waiting for it', async phase => {
  const late = deferred<void>(), controller = new AbortController();
  const currentScope = vi.fn(async () => { if (phase === 'scope') await late.promise; return scope; });
  const normalized = captured(currentScope);
  const models: ThreadModelAuthority = { resolveModel: vi.fn(async () => { if (phase === 'resolve') await late.promise; return normalized.model; }),
    rebindModel: vi.fn() };
  const prepare = createChildProfilePreparer({ settings: async () => ({ harness: { agents: { precise: agent } } }), capabilities: async () => [], models });
  const pending = prepare({ parent }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(phase === 'resolve' ? models.resolveModel : currentScope).toHaveBeenCalledOnce());
  controller.abort(); await rejected;
  expect(normalized.released).not.toHaveBeenCalled();
  late.resolve();
  await vi.waitFor(() => expect(normalized.released).toHaveBeenCalledOnce());
});

it('policy model preparation releases failures and cancelled late captures, but transfers successful captures', async () => {
  const broken = captured(async () => { throw new Error('Scope unavailable'); });
  const good = captured(), late = captured(), gate = deferred<void>();
  const models: ThreadModelAuthority = { resolveModel: vi.fn(async () => broken.model), rebindModel: vi.fn() };
  const prepare = createPolicyModelPreparer({ models, settings: async () => ({ global: { harness: { models: { agentPlanning: selection } } } }) });
  const input = { threadId: 'thread:original', generation: 1, requestedModelRoles: ['agentPlanning'] as const };
  expect((await prepare(input))[0]!.capability.status).toBe('unavailable');
  expect(broken.released).toHaveBeenCalledOnce();
  vi.mocked(models.resolveModel).mockResolvedValueOnce(good.model);
  const [prepared] = await prepare(input);
  expect(prepared!.capability.status).toBe('available');
  expect(good.released).not.toHaveBeenCalled();
  prepared!.credentialOwner!.release(); expect(good.released).toHaveBeenCalledOnce();
  vi.mocked(models.resolveModel).mockImplementationOnce(async () => { await gate.promise; return late.model; });
  const controller = new AbortController(), pending = prepare(input, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(models.resolveModel).toHaveBeenCalledTimes(3));
  controller.abort(); await rejected; gate.resolve();
  await vi.waitFor(() => expect(late.released).toHaveBeenCalledOnce());
});

it('retrieval keeps one capture across two real Explore operations and releases it with the stage', async () => {
  const model = captured(), controller = new AbortController();
  const bridge = new CredentialBridge(() => 'epoch', async () => {}, () => { throw new Error('Unexpected transport'); });
  const settings = { harness: { codeRetrieval: { decision: 'llm' }, models: { explore: selection } } };
  const query = { runId: 'run:original', inferenceOwner: { kind: 'external', identity: 'retrieval', epoch: 'epoch' },
    source: { mode: 'fixed_branch' }, question: 'How does the request handler choose a model?' } as RetrievalQuery;
  let generated = 0;
  const generate = vi.fn<InferenceCall['generate']>(async input => {
    const ordinal = ++generated;
    const id = `operation:${ordinal}`;
    await input.check(controller.signal);
    await input.register(id, controller.signal);
    try {
      await model.owner.resolve(scope);
      expect(model.released).not.toHaveBeenCalled();
      return ordinal === 1 ? JSON.stringify({ groups: [{ expressions: ['handler'] }] }) : JSON.stringify({ groups: [], done: true });
    } finally { input.release(id); }
  });
  const stage = await createRetrievalModelStage({ models: { resolveModel: async () => model.model, rebindModel: vi.fn() },
    readGlobalSettings: async () => settings, inference: { captureDecision: vi.fn(), captureRerank: vi.fn() },
    kernel: { kernelEpoch: 'epoch', registerCredentialOwner: (...args) => bridge.register(...args), unregisterCredentialOwner: (...args) => bridge.unregister(...args) },
    sources: { validate: async () => {}, read: vi.fn() },
  }).prepare(query, controller.signal, { operationId: 'retrieval', signal: controller.signal, generate } as unknown as InferenceCall);
  try {
    const implementation = stage.stage.implementation;
    if (implementation?.kind !== 'progressive') throw new Error('Expected progressive stage');
    const view = { viewId: 'view', path: 'handler.ts', revision: 'original', startLine: 1, endLine: 1, ranges: [], assessment: 'pending', text: 'original source' };
    const run = { signal: controller.signal, question: query.question, deadlineAt: Infinity, parsed: { objects: [], relation: null, domain: null },
      refreshVocab: async () => {}, vocab: () => ({}), sourceStates: () => [], submitPlan: async () => ({ launched: ['search'] }),
      actionCandidates: async () => [], collect: () => ({ views: [view], pending: false, unevaluated: 0, sequence: 1 }),
      applySelection: () => ({ accepted: [], rejected: [], selectedViews: [] }) };
    const result = await implementation.select({ run, validateMaterials: async () => {} } as unknown as Parameters<typeof implementation.select>[0], controller.signal);
    expect(result.model).toMatchObject({ plan: 'used', select: 'used' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(model.released).not.toHaveBeenCalled();
  } finally { stage.release(); bridge.close(); }
  expect(model.released).toHaveBeenCalledOnce();
});

it('memory binding replacement and shutdown release cached captures, including a bind that settles after close', async () => {
  const first = captured(), second = captured(), late = captured(), gate = deferred<void>();
  const resolveModel = vi.fn(async () => first.model).mockResolvedValueOnce(first.model).mockResolvedValueOnce(second.model)
    .mockImplementationOnce(async () => { await gate.promise; return late.model; });
  const inference = createMemoryInference({ models: { resolveModel } as never, kernel: {} as never,
    runtime: { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} } as never,
    authority: {} as never, decision: {} as never, validateScope: async () => {}, canExecuteScope: async () => true });
  await inference.bind(selection); await inference.bind(selection);
  expect(first.released).toHaveBeenCalledOnce(); expect(second.released).not.toHaveBeenCalled();
  const pending = inference.bind(selection), rejected = expect(pending).rejects.toThrow('closed');
  await inference.close([]); expect(second.released).toHaveBeenCalledOnce();
  gate.resolve(); await rejected; expect(late.released).toHaveBeenCalledOnce();
});

it('an admitted parent selection retains the child implementation after metadata capture returns', async () => {
  const main = captured(), child = captured();
  const bridge = new CredentialBridge(() => 'epoch', async () => {}, () => {});
  const prepare = createChildProfilePreparer({ settings: async () => ({ harness: { agents: { selected: { ...agent, model: selection } } } }), capabilities: async () => [],
    models: { resolveModel: async () => child.model, rebindModel: vi.fn() } });
  const profiles = await prepare({ parent, modelOwner: main.owner });
  expect(profiles.presets.find(value => value.id === 'custom:selected')?.model).toEqual(parent);
  expect(child.released).not.toHaveBeenCalled();
  await bridge.register('run:parent', main.owner);
  main.owner.release();
  expect(main.released).not.toHaveBeenCalled(); expect(child.released).not.toHaveBeenCalled();
  bridge.unregister('run:parent');
  expect(main.released).toHaveBeenCalledOnce(); expect(child.released).toHaveBeenCalledOnce();
});

it('model-only child handoff survives parent terminal until late child registration, with exact rollback and authority', async () => {
  const { ToolBridge } = await import('./tool-bridge.js');
  const frames: import('./tool-bridge.js').PrivateToolFrame[] = [];
  const credentials = new CredentialBridge(() => 'epoch', async () => {}, () => {});
  const bridge = new ToolBridge(() => 'epoch', async frame => { frames.push(frame); }, () => {},
    (runId, terminal) => { if (terminal) credentials.unregister(runId); }, undefined,
    { retain: (binding, model, selection) => credentials.retainChildModel(binding, model, selection),
      release: (runId, operation) => credentials.releaseChildModel(runId, operation),
      reconcile: children => credentials.reconcileChildModels(children) });
  const parent = captured(), childReleased = vi.fn(), siblingReleased = vi.fn();
  const childConfiguration = { ...configuration, model: 'frozen-child', adapterBindingId: 'original-child-instance' };
  const childIdentity = modelCredentialBindingIdentity(childConfiguration);
  const child = new ExistingHostCredentialOwner({ providerId: selection.providerId, providerFamily: configuration.providerFamily,
    endpoint: configuration.endpoint, bindingIdentity: childIdentity, currentScope: async () => scope,
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fixture-only' } }) }, release: childReleased });
  const siblingConfiguration = { ...childConfiguration, model: 'sibling-preset' };
  const siblingIdentity = modelCredentialBindingIdentity(siblingConfiguration);
  const sibling = new ExistingHostCredentialOwner({ providerId: selection.providerId, providerFamily: configuration.providerFamily,
    endpoint: configuration.endpoint, bindingIdentity: siblingIdentity, currentScope: async () => scope,
    runtime: { getAuth: async () => undefined }, release: siblingReleased });
  await sibling.scope(); parent.owner.retainDependency(sibling); sibling.release();
  await child.scope(); parent.owner.retainDependency(child); child.release();
  await credentials.register('parent', parent.owner); parent.owner.release();
  const model = { configuration: childConfiguration, credential_scope: scope };
  const frame = (id: string, operation = 'child-operation', parentRunId = 'parent') => ({
    v: 1, kind: 'host-tool-child-retain', kernelEpoch: 'epoch', id, parentRunId, childOperationId: operation,
    executionOwner: { kind: 'kernel' }, executionEpoch: 7, mcpBinding: null, extensionBindings: [], modelBinding: model,
  });
  const response = async (id: string, ok: boolean) => {
    await vi.waitFor(() => expect(frames.find(value => value.kind === 'host-tool-response' && value.id === id)).toMatchObject({ kind: 'host-tool-response', ok }));
  };
  try {
    // Another Run with the same configuration cannot borrow this parent's credential graph.
    bridge.consume(frame('unrelated', 'other-operation', 'unrelated-parent')); await response('unrelated', false);
    bridge.consume({ ...frame('wrong-account'), modelBinding: { ...model, credential_scope: { ...scope, account: 'different' } } });
    await response('wrong-account', false);
    bridge.consume(frame('accepted')); await response('accepted', true);
    bridge.consume(frame('duplicate')); await response('duplicate', true);
    bridge.consume({ ...frame('changed-owner'), executionEpoch: 8 }); await response('changed-owner', false);
    bridge.consume(frame('rollback-ack', 'rollback')); await response('rollback-ack', true);
    bridge.consume(frame('report-ack', 'reported')); await response('report-ack', true);
    bridge.consume({ v: 1, kind: 'host-tool-owner-release', kernelEpoch: 'epoch', runId: 'parent' });
    expect(parent.released).not.toHaveBeenCalled(); expect(childReleased).not.toHaveBeenCalled();
    expect(siblingReleased).not.toHaveBeenCalled();
    const original = credentials.findOwner(childIdentity, scope)!;
    expect(original).toBeDefined();
    // Cold source/context preparation finishes only after the parent's terminal frame.
    await credentials.register('child-run', original); original.release();
    const inheritedSibling = credentials.findOwner(siblingIdentity, scope, 'child-run');
    expect(inheritedSibling).toBeDefined(); inheritedSibling!.release();
    bridge.consume({ ...frame('grandchild-accepted', 'grandchild-operation', 'child-run'),
      modelBinding: { configuration: siblingConfiguration, credential_scope: scope } });
    await response('grandchild-accepted', true);
    await bridge.releaseChild('parent', 'child-operation');
    await bridge.releaseChild('parent', 'child-operation');
    bridge.reconcileChildren([{ operation_id: 'reported', report: { state: 'done' } }, { operation_id: 'rollback', report: null }]);
    bridge.consume({ v: 1, kind: 'host-tool-child-release', kernelEpoch: 'epoch', parentRunId: 'parent', childOperationId: 'rollback' });
    bridge.consume({ v: 1, kind: 'host-tool-child-release', kernelEpoch: 'epoch', parentRunId: 'parent', childOperationId: 'rollback' });
    expect(childReleased).not.toHaveBeenCalled();
    credentials.unregister('child-run');
    expect(childReleased).not.toHaveBeenCalled(); expect(siblingReleased).not.toHaveBeenCalled();
    const grandchild = credentials.findOwner(siblingIdentity, scope)!;
    expect(grandchild).toBeDefined();
    await credentials.register('grandchild-run', grandchild); grandchild.release();
    await bridge.releaseChild('child-run', 'grandchild-operation');
    expect(siblingReleased).not.toHaveBeenCalled();
    credentials.unregister('grandchild-run');
    expect(childReleased).toHaveBeenCalledOnce();
    expect(parent.released).toHaveBeenCalledOnce(); expect(siblingReleased).toHaveBeenCalledOnce();
    expect(credentials.findOwner(childIdentity, scope)).toBeUndefined();
  } finally { bridge.close(); credentials.close(); }
  expect(childReleased).toHaveBeenCalledOnce();
});
