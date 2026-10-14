import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ContextJob } from '@varin/application-client';
import { canonicalServiceComposition } from '@varin/extension-contract';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextCompactionOwner } from './context-compaction.js';
import type { ContextCompactionCandidate, ContextJobPreviewParams } from './protocol.generated.js';
import { admitContextJobCandidate } from './context-job-preparation.js';
import { ThreadAdapter } from './thread-adapter.js';

const input: ContextJobPreviewParams = {
  key: 'original', branchId: 'branch:main', throughId: 'item:through', expectedRevision: 3,
  effectiveSystemPrompt: 'Frozen prompt', instructionSources: ['AGENTS.md'], memoryCheckpoint: null,
  configuration: { providerId: 'original-provider', model: 'original-model' },
  credentialScope: { reference: 'credential', authority: 'original', account: 'original', generation: 1 },
  summaryRecipe: { strategy: { kind: 'builtin', name: 'manual', version: '1' }, mode: 'manual', configurationIdentity: null, additionalInstructions: null },
};
const compositionNode = { extensionId: 'fixture.compaction', extensionVersion: '1', entrypointId: 'host' as const, artifactIntegrity: 'artifact', activationConfiguration: null, grants: [], dependencies: [] };
const root = createHash('sha256').update(canonicalServiceComposition(compositionNode)).digest('hex');
const candidate: ContextCompactionCandidate = { producer: { kind: 'extension', providerKey: 'fixture.compaction:host:varin.context.compaction@1', providerId: 'provider',
  extensionId: 'fixture.compaction', extensionVersion: '1', serviceId: 'varin.context.compaction', serviceVersion: 1, artifactIntegrity: 'artifact',
  composition: { schemaVersion: 1, root, nodes: [{ ...compositionNode, id: root }] }, configurationIdentity: 'configuration', declaredIdentity: { name: 'extractive', version: '1' } },
  plan: { kind: 'text', sourceCutHash: 'cut', text: 'Frozen pure summary' } };
function admitted(): ContextJob {
  return { request: { key: input.key, branch_id: input.branchId, through_id: input.throughId,
    expected_revision: input.expectedRevision, effective_system_prompt: input.effectiveSystemPrompt,
    instruction_sources: input.instructionSources, memory_checkpoint: input.memoryCheckpoint,
    summary_recipe: input.summaryRecipe, compaction: candidate },
    receipt: { thread_id: 'context-job-thread:original', branch_id: 'context-job-branch:original', run_id: 'summary', input_id: 'summary-input', cursor: 1 },
    compaction: { producer: candidate.producer, kind: 'text', sourceCutHash: 'cut', planHash: 'plan' },
  };
}
function fixture() {
  const revoked = new AbortController();
  const release = vi.fn();
  const owner: ContextCompactionOwner = { selected: vi.fn(async () => true), prepare: vi.fn(async () => ({
    candidate, signal: revoked.signal, assertAvailable: () => revoked.signal.throwIfAborted(), release,
  })) };
  const job = admitted();
  const runtime = { previewContextJob: vi.fn(async () => ({ sourceCutHash: 'cut', sources: [], modelBudget: { contextWindowTokens: null, maxOutputTokens: null, sourceBudgetTokens: null } })),
    createContextJob: vi.fn<AgentRuntimeClient['createContextJob']>(async () => job), contextJobs: vi.fn(async () => [] as ContextJob[]),
    run: vi.fn(async () => ({ configuration: input.configuration })), launch: vi.fn(async () => ({ selection: { credential_scope: input.credentialScope } })),
  };
  return { runtime, owner, job, revoked, release };
}
it('holds the original producer through create and recalls a committed original after lost ACK and pin revocation', async () => {
  const f = fixture();
  f.runtime.createContextJob.mockImplementationOnce(async request => {
    expect(request.compaction).toEqual(candidate); expect(f.release).not.toHaveBeenCalled();
    f.runtime.contextJobs.mockResolvedValue([f.job]); f.revoked.abort(new Error('Producer revoked after commit'));
    throw new Error('Admission ACK lost');
  });
  const result = await admitContextJobCandidate(f.runtime as unknown as AgentRuntimeClient, f.owner, { sessionId: 'thread:main' }, input, new AbortController().signal);
  expect(result).toEqual({ job: f.job, recovered: true });
  expect(f.owner.prepare).toHaveBeenCalledOnce(); expect(f.runtime.createContextJob).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});
it('does not accept another source recipe after an uncertain admission', async () => {
  const f = fixture(); const failure = new Error('Uncertain admission');
  f.runtime.createContextJob.mockRejectedValue(failure);
  f.runtime.contextJobs.mockResolvedValue([{ ...f.job, request: { ...f.job.request, effective_system_prompt: 'Different original body' } }]);
  await expect(admitContextJobCandidate(f.runtime as unknown as AgentRuntimeClient, f.owner, { sessionId: 'thread:main' }, input, new AbortController().signal)).rejects.toBe(failure);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.runtime.createContextJob).toHaveBeenCalledOnce();
});
it('drops a late pure plan after caller cancellation without native admission', async () => {
  const f = fixture(); const stop = new AbortController();
  const prepare = f.owner.prepare;
  f.owner.prepare = async (...args) => { const lease = await prepare(...args); stop.abort(new Error('Request closed')); return lease; };
  await expect(admitContextJobCandidate(f.runtime as unknown as AgentRuntimeClient, f.owner, { sessionId: 'thread:main' }, input, stop.signal)).rejects.toThrow('Request closed');
  expect(f.runtime.createContextJob).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});
it('recalls an accepted manual key and starts a frozen text job without current provider or model credentials', async () => {
  const f = fixture(); const identity = { runtime: 'agent' as const, threadId: 'thread:main', branchId: input.branchId };
  f.job.request.key = createHash('sha256').update(JSON.stringify([identity.threadId, identity.branchId, input.key])).digest('hex');
  const runtime = { ...f.runtime,
    thread: vi.fn(async () => ({ branches: [{ branch_id: identity.branchId }] })), contextJobs: vi.fn(async () => [f.job]),
    run: vi.fn(async () => ({ id: 'summary', thread_id: f.job.receipt.thread_id, branch_id: f.job.receipt.branch_id, configuration: input.configuration })),
    launch: vi.fn(async () => ({ startable: true, requires_rebind: true, selection: { credential_scope: input.credentialScope } })),
    contextJob: vi.fn(async () => f.job), startRun: vi.fn(async () => {}),
    withRunPreparation: async <T>(_id: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) => work(signal ?? new AbortController().signal),
  };
  const models = { resolveModel: vi.fn(async () => { throw new Error('Credential removed'); }), rebindModel: vi.fn(async () => { throw new Error('Credential removed'); }) };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, vi.fn(), vi.fn());
  adapter.bindCompaction(f.owner);
  const result = await adapter.compact({ ...identity, key: input.key, throughId: input.throughId, expectedRevision: input.expectedRevision,
    model: { providerId: 'original-provider', modelId: 'original-model' } });
  expect(result).toBe(f.job);
  await vi.waitFor(() => expect(runtime.startRun).toHaveBeenCalledOnce());
  expect(f.owner.selected).not.toHaveBeenCalled(); expect(f.owner.prepare).not.toHaveBeenCalled();
  expect(models.resolveModel).not.toHaveBeenCalled(); expect(models.rebindModel).not.toHaveBeenCalled();
  expect(runtime.createContextJob).not.toHaveBeenCalled();
  await expect(adapter.compact({ ...identity, key: input.key, throughId: input.throughId, expectedRevision: input.expectedRevision,
    model: { providerId: 'original-provider', modelId: 'another-model' } })).rejects.toThrow('another selection');
});

it('first manual text preparation uses real registered model description without entering any credential or routing owner', async () => {
  const { createModelAuthority } = await import('./model-authority.js');
  const f = fixture();
  const unavailable = vi.fn(async () => { throw new Error('No credential owner is available'); });
  const models = createModelAuthority({
    selectedModel: async () => ({ providerId: 'original-provider', modelId: 'original-model', name: 'Registered model',
      api: 'anthropic-messages', baseUrl: 'https://not-contacted.invalid', maxTokens: 100, contextWindow: 1000 }),
    listModels: async () => [], getAuth: unavailable, currentScope: unavailable, currentProviderAccount: unavailable,
    routingEnvironment: unavailable, anthropicAuthentication: unavailable, vertexAuthentication: unavailable,
  });
  const identity = { runtime: 'agent' as const, threadId: 'thread:main', branchId: input.branchId };
  const runtime = { ...f.runtime,
    thread: vi.fn(async () => ({ branches: [{ branch_id: identity.branchId }] })), context: vi.fn(async () => null),
  };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, vi.fn(), vi.fn());
  vi.spyOn(adapter, 'refreshContext').mockResolvedValue();
  const start = vi.spyOn(adapter, 'continueLaunch').mockResolvedValue();
  adapter.bindCompaction(f.owner);
  await adapter.compact({ ...identity, key: input.key, throughId: input.throughId, expectedRevision: input.expectedRevision,
    model: { providerId: 'original-provider', modelId: 'original-model' } });
  const request = runtime.createContextJob.mock.calls[0]![0];
  expect(request.configuration).toMatchObject({ providerId: 'original-provider', model: 'original-model', contextWindowTokens: 1000, maxOutputTokens: 100 });
  expect(request.credentialScope).toBeUndefined();
  expect(unavailable).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledWith('summary', {});
  expect(f.owner.prepare).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});

it('binds a model plan only after pure planning, retaining the same producer and cut through actual model admission', async () => {
  const f = fixture(); const original = f.owner.prepare;
  f.owner.prepare = async (...args) => {
    const lease = (await original(...args))!;
    return { ...lease, candidate: { ...candidate, plan: { kind: 'model_plan', sourceCutHash: 'cut',
      nodes: [{ id: 'one', instructions: null, inputs: [{ kind: 'source', sourceId: 'one', range: null }] }], finalNodeId: 'one' } } };
  };
  const description = { providerId: 'original-provider', model: 'original-model', contextWindowTokens: 1000, maxOutputTokens: 100 };
  const bind = vi.fn(async () => {
    expect(f.runtime.previewContextJob).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
    return { configuration: { ...description, providerFamily: 'openai-responses', endpoint: 'https://not-contacted.invalid/responses' }, credentialScope: input.credentialScope! };
  });
  const { credentialScope: _scope, ...previewInput } = input;
  await admitContextJobCandidate(f.runtime as unknown as AgentRuntimeClient, f.owner, { sessionId: 'thread:main' }, { ...previewInput, configuration: description }, new AbortController().signal, bind);
  expect(bind).toHaveBeenCalledOnce(); expect(original).toHaveBeenCalledOnce();
  expect(f.runtime.createContextJob.mock.calls[0]![0]).toMatchObject({ configuration: { providerFamily: 'openai-responses' }, credentialScope: input.credentialScope,
    compaction: { producer: candidate.producer, plan: { kind: 'model_plan', sourceCutHash: 'cut' } } });
  expect(f.release).toHaveBeenCalledOnce();
});


it('the actual Host start owner keeps a frozen summary tool-free even when current extension preparation is unavailable', async () => {
  const preparation = new AbortController();
  const launch = { startable: true, requires_rebind: true, selection: { policy: { name: 'context_compaction', version: '4' }, source: null, extension_bindings: [] } };
  const request = vi.fn(async (method: string) => {
    if (method === 'runtime.child.execution.for_run') return null;
    if (method === 'runtime.run.inspect') return { id: 'summary', thread_id: 'context-job-thread:original', state: 'runnable', cancel_requested: false };
    if (method === 'runtime.launch.inspect') return launch;
    if (method === 'runtime.memory.reconcile' || method === 'runtime.plan.reconcile') return {};
    if (method === 'runtime.run.start') return { runId: 'summary', epoch: 1 };
    throw new Error(`Unexpected summary preparation ${method}`);
  });
  const kernel = { subscribeExit: () => () => {}, onToolReleased: () => () => {}, mcpLiveBinding: () => undefined,
    beginRunPreparation: () => ({ signal: preparation.signal, release: () => {} }), agentRuntimeRequest: request };
  const extensions = vi.fn(async () => { throw new Error('Current tool owner unavailable'); });
  const runtime = new AgentRuntimeClient(kernel as unknown as import('./kernel-client.js').KernelClient, undefined, undefined, undefined, undefined, extensions);
  expect(await runtime.startRun('summary')).toEqual({ runId: 'summary', epoch: 1 });
  expect(extensions).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('runtime.run.start', { runId: 'summary' }, expect.any(AbortSignal));
});
