import { afterEach, expect, it, vi } from 'vitest';
import { AgentPolicyBridge, type AgentPolicyLease, type PrivatePolicyResponse } from './agent-policy.js';
import { AgentRuntimeClient, type RunPolicyPreparer } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { PolicyModelPreparer } from './policy-models.js';
import { createPolicyModelPreparer } from './policy-models.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import type { AgentPolicyArtifactBinding, LaunchIntent, PolicySelections, PolicySelectParams, PolicyReadyParams, PolicyFailParams, PolicyCancelParams, Run, ModelSessionConfiguration } from './protocol.generated.js';
import type { VarinAgentPolicyDecision, VarinAgentPolicyInput } from '@varin/extension-contract';

const artifact = (name: string): AgentPolicyArtifactBinding => ({ providerKey: `${name}:host:varin.agent.policy@3`, extensionId: name,
  extensionVersion: '1', serviceId: 'varin.agent.policy', serviceVersion: 3, artifactIntegrity: `artifact-${name}`, configurationIdentity: 'configuration',
  declaredIdentity: { name: 'test-policy', version: '1' }, identity: { name, version: `identity-${name}` }, modelRoles: ['agentPlanning'], stateTransition: 'explicit' });
const input: VarinAgentPolicyInput = { view: { run_id: 'run', state: 'waiting', history_count: 1, history_head_id: 'history', pending_tool_calls: 0, model_capabilities: [] },
  event: { kind: 'resumed', action_id: 'pause', wait_id: 'wait' }, state: 'old-state' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  let current = artifact('old'), prepareFailure = false, changed!: () => void, beforeSelect: (() => void) | undefined;
  const replies: PrivatePolicyResponse[] = [], leases: Array<AgentPolicyLease & { released: boolean; revoke: AbortController }> = [];
  const requests: Array<{ method: string; params: unknown }> = [], scopes: unknown[] = [], credentials = new Set<string>();
  let epoch = 'epoch';
  const preparations = new Set<AbortController>();
  let nextLaunchPreparation: (() => Promise<LaunchIntent>) | undefined;
  let nextCancelReply: (() => Promise<void>) | undefined;
  const bridge = new AgentPolicyBridge(() => epoch, async response => { replies.push(response); }, () => { throw new Error('Unexpected transport error'); });
  cleanups.push(() => bridge.close());
  const selection: PolicySelections = { active: { generation: 0, target: { kind: 'extension', artifact: current }, identity: current.identity, activation_cursor: null }, desired: null };
  const run: Run = { id: 'run', thread_id: 'thread:original', branch_id: 'branch', state: 'waiting', waiting_on: 'wait', revision: 1, epoch: 1, configuration: {}, cancel_requested: false };
  const launch: LaunchIntent = { policy_preparable: false, policy_generation: 0, policy_target: selection.active.target, run_id: run.id,
    revision: 1, startable: false, requires_rebind: false, bound_epoch: 1, preparation_failure: null, pause: { action_id: 'pause', wait_id: 'wait', reason: 'Explicit resume required' },
    selection: { policy: current.identity, policy_models: [], extension_bindings: [], mcp_binding: null, credential_scope: null, connection_identity: 'model', provider_family: 'model',
      model: 'model', configuration_generation: 1, tool_schema_generation: 1, tools: [], source: null } };
  let counter = 0, generation = 0, loseReady = false;
  let heldDecision: { name: string; work: () => Promise<VarinAgentPolicyDecision> } | undefined;
  const preparer: RunPolicyPreparer = {
    async prepare(scope) {
      scopes.push(structuredClone(scope));
      if (prepareFailure) throw Object.assign(new Error('PRIVATE provider detail'), { code: 'selected_unavailable' });
      const selected = scope.requiredBinding ?? current, revoke = new AbortController();
      const lease: AgentPolicyLease & { released: boolean; revoke: AbortController } = { binding: { reference: `provider-${++counter}`, artifact: structuredClone(selected) },
        revoke, revocationSignal: revoke.signal, released: false,
        async decide() { if (selected.identity.name === heldDecision?.name) return heldDecision.work(); return { action: { kind: 'complete' }, state: selected.identity.name }; },
        async transitionState(value) { return { kind: 'compatible', state: value.state }; },
        release() { lease.released = true; },
      };
      leases.push(lease); return lease;
    },
    observe(scope, callback) { scopes.push(structuredClone(scope)); changed = callback; return () => {}; },
  };
  const prepareModels = vi.fn<PolicyModelPreparer>(async ({ generation }) => [{ capability: { capability_id: 'agentPlanning', purpose: 'planning', status: 'available', supported_operation: 'tool_free_text',
    binding_id: `policy:${generation}:agentPlanning:configuration`, configuration_identity: 'configuration', binding: null, configuration: {} as ModelSessionConfiguration,
    credential_scope: { reference: 'credential', authority: 'owner', account: 'account', generation: 1 } }, credentialOwner: {} as ExistingHostCredentialOwner }]);
  const kernel = {
    get kernelEpoch() { return epoch; },
    subscribeExit: () => () => {}, onToolReleased: () => () => {}, beginRunPreparation: () => {
      const controller = new AbortController(); preparations.add(controller);
      return { signal: controller.signal, release() { preparations.delete(controller); } };
    },
    registerCredentialOwner: async (_run: string, _owner: ExistingHostCredentialOwner, _signal: AbortSignal, bindingId: string) => {
      if (credentials.has(bindingId)) throw new Error('Credential collision'); credentials.add(bindingId);
      return { reference: 'credential', authority: 'owner', account: 'account', generation: 1 };
    },
    unregisterCredentialOwner: (_run: string, bindingId?: string | null) => { if (bindingId === undefined) credentials.clear(); else if (bindingId) credentials.delete(bindingId); },
    registerPolicyOwner: async (run: string, generation: number, lease: AgentPolicyLease) => bridge.register(run, generation, lease),
    policyBinding: (run: string, generation: number) => bridge.binding(run, generation),
    unregisterPolicyOwner: (run: string, generation: number) => bridge.unregister(run, generation),
    releaseRunPolicyOwners: (run: string) => bridge.releaseRun(run),
    async agentRuntimeRequest(method: string, params: unknown) {
      requests.push({ method, params: structuredClone(params) });
      if (method === 'runtime.run.inspect') return structuredClone(run);
      if (method === 'runtime.launch.inspect') return structuredClone(launch);
      if (method === 'runtime.run.scope') return { projectId: 'original-project' };
      if (method === 'runtime.child.for_thread') return null;
      if (method === 'runtime.launch.policy.prepare') {
        const pending = nextLaunchPreparation; nextLaunchPreparation = undefined;
        return pending ? await pending() : structuredClone(launch);
      }
      if (method === 'runtime.policy.inspect') return structuredClone(selection);
      if (method === 'runtime.policy.select') {
        beforeSelect?.(); beforeSelect = undefined;
        const request = params as PolicySelectParams;
        if (request.expectedGeneration !== selection.active.generation || request.expectedSelectionId !== (selection.desired?.selection_id ?? null)) throw new Error('policy_selection_changed');
        if (selection.desired) bridge.unregister('run', selection.desired.generation);
        selection.desired = { selection_id: request.selectionId, run_id: 'run', generation: ++generation, expected_generation: request.expectedGeneration, expected_selection_id: request.expectedSelectionId,
          target: request.target, state_mode: request.stateMode, status: 'preparing', failure: null, activation_cursor: null };
        return structuredClone(selection.desired);
      }
      if (method === 'runtime.policy.ready') {
        const request = params as PolicyReadyParams;
        if (selection.desired?.selection_id !== request.selectionId || selection.desired.generation !== request.generation) throw new Error('policy_selection_changed');
        selection.desired.status = 'ready';
        if (loseReady) {
          const old = selection.active.generation;
          selection.desired.status = 'active'; selection.desired.activation_cursor = 9;
          selection.active = { generation: request.generation, target: selection.desired.target, identity: selection.desired.target.kind === 'extension' ? selection.desired.target.artifact.identity : artifact('default').identity, activation_cursor: 9 };
          launch.policy_generation = request.generation; launch.policy_target = selection.desired.target;
          bridge.unregister('run', old); throw new Error('Ready reply lost after commit');
        }
        return structuredClone(selection.desired);
      }
      if (method === 'runtime.policy.cancel' || method === 'runtime.policy.fail') {
        const request = params as PolicyFailParams | PolicyCancelParams;
        if (selection.desired?.selection_id !== request.selectionId) throw new Error('policy_selection_changed');
        selection.desired.status = method === 'runtime.policy.cancel' ? 'cancelled' : 'failed';
        selection.desired.failure = 'code' in request ? request.code : null;
        bridge.unregister('run', selection.desired.generation);
        const receipt = structuredClone(selection.desired);
        if (method === 'runtime.policy.cancel') { const delay = nextCancelReply; nextCancelReply = undefined; await delay?.(); }
        return receipt;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };
  const runtime = new AgentRuntimeClient(kernel as unknown as KernelClient, undefined, preparer, prepareModels);
  return { runtime, bridge, selection, run, launch, leases, replies, credentials, requests, scopes, prepareModels,
    route: (name: string) => { current = artifact(name); }, notify: () => changed(), failPreparation: () => { prepareFailure = true; },
    race: (action: () => void) => { beforeSelect = action; }, holdOld: (work: () => Promise<VarinAgentPolicyDecision>) => { heldDecision = { name: 'old', work }; }, hold: (name: string, work: () => Promise<VarinAgentPolicyDecision>) => { heldDecision = { name, work }; }, loseReady: () => { loseReady = true; }, current: () => current,
    holdNextLaunch: (work: () => Promise<LaunchIntent>) => { nextLaunchPreparation = work; },
    holdNextCancelReply: (work: () => Promise<void>) => { nextCancelReply = work; },
    reconnect: () => { epoch = 'new-epoch'; credentials.clear(); bridge.close(); for (const controller of preparations) controller.abort(); } };
}

it('a ready candidate retains the old in-flight decision, own credentials and the original Pause', async () => {
  const f = fixture(), old = await f.runtime.preparePolicy('run');
  expect(old?.generation).toBe(0);
  let finish!: (decision: VarinAgentPolicyDecision) => void;
  f.holdOld(() => new Promise(resolve => { finish = resolve; }));
  f.bridge.consume({ v: 1, kind: 'agent-policy-request', kernelEpoch: 'epoch', runId: 'run', generation: 0, id: 'held-old', binding: old, input });
  await tick();
  f.route('new'); await f.runtime.refreshPolicy('run');
  expect(f.selection.active.generation).toBe(0); expect(f.selection.desired?.status).toBe('ready');
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration', 'policy:1:agentPlanning:configuration']));
  expect(f.bridge.binding('run', 0)).toEqual(old); expect(f.leases[0]!.released).toBe(false);
  finish({ action: { kind: 'complete' }, state: 'original-result' }); await tick();
  expect(f.replies.find(reply => reply.id === 'held-old')).toMatchObject({ generation: 0, ok: true, decision: { state: 'original-result' } });
  expect(f.run.waiting_on).toBe('wait');
  expect(f.requests.some(request => ['runtime.run.start', 'runtime.run.resume'].includes(request.method))).toBe(false);
  expect(f.scopes.every(scope => (scope as { projectId: string }).projectId === 'original-project')).toBe(true);
  await f.runtime.cancelPolicyUpdate('run', f.selection.desired!.selection_id);
  expect(f.bridge.binding('run', 1)).toBeUndefined(); expect(f.bridge.binding('run', 0)).toEqual(old);
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration']));
});

it('pre-select errors are safe live diagnostics and returning routing withdraws only the pending candidate', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run');
  f.route('new'); await f.runtime.refreshPolicy('run');
  f.route('old'); await f.runtime.refreshPolicy('run');
  expect(f.selection.desired?.status).toBe('cancelled'); expect(f.selection.active.generation).toBe(0);
  expect(f.bridge.binding('run', 1)).toBeUndefined();
  f.failPreparation(); await expect(f.runtime.refreshPolicy('run')).rejects.toThrow();
  expect((await f.runtime.inspectPolicy('run')).preparation).toEqual({ status: 'failed', code: 'policy_route_unavailable' });
  expect(f.requests.some(request => request.method === 'runtime.launch.failed')).toBe(false);
  expect(f.bridge.binding('run', 0)).toBeDefined();
});

it('late generation cancel/release and callback results cannot remove or impersonate the new owner', async () => {
  const f = fixture(), old = await f.runtime.preparePolicy('run');
  f.route('new'); await f.runtime.refreshPolicy('run');
  const current = f.bridge.binding('run', 1)!;
  let finish!: (decision: VarinAgentPolicyDecision) => void;
  f.holdOld(() => new Promise(resolve => { finish = resolve; }));
  f.bridge.consume({ v: 1, kind: 'agent-policy-request', kernelEpoch: 'epoch', runId: 'run', generation: 0, id: 'old-held', binding: old, input });
  await tick();
  f.bridge.consume({ v: 1, kind: 'agent-policy-release', kernelEpoch: 'epoch', runId: 'run', generation: 0 });
  f.bridge.consume({ v: 1, kind: 'agent-policy-cancel', kernelEpoch: 'epoch', runId: 'run', generation: 0, id: 'same-id' });
  f.bridge.consume({ v: 1, kind: 'agent-policy-request', kernelEpoch: 'epoch', runId: 'run', generation: 0, id: 'late', binding: old, input });
  f.bridge.consume({ v: 1, kind: 'agent-policy-request', kernelEpoch: 'epoch', runId: 'run', generation: 1, id: 'same-id', binding: current, input });
  await tick();
  expect(f.replies.find(reply => reply.id === 'late')).toMatchObject({ generation: 0, ok: false });
  expect(f.replies.find(reply => reply.id === 'same-id')).toMatchObject({ generation: 1, ok: true, decision: { state: 'new' } });
  finish({ action: { kind: 'complete' }, state: 'late-result' }); await tick();
  expect(f.replies.some(reply => reply.id === 'old-held')).toBe(false);
  expect(f.bridge.binding('run', 1)).toEqual(current);
  expect(f.credentials).toEqual(new Set(['policy:1:agentPlanning:configuration']));
});

it('revocation releases only its candidate and a stale restart cannot replace a different displayed selection', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run'); f.route('new'); await f.runtime.refreshPolicy('run');
  f.hold('new', () => new Promise(() => {}));
  f.bridge.consume({ v: 1, kind: 'agent-policy-request', kernelEpoch: 'epoch', runId: 'run', generation: 1, id: 'revoked-request', binding: f.bridge.binding('run', 1), input });
  await tick();
  f.leases.at(-1)!.revoke.abort(); await tick();
  expect(f.replies.find(reply => reply.id === 'revoked-request')).toMatchObject({ generation: 1, ok: false, error: { code: 'policy_owner_revoked' } });
  expect(f.selection.desired?.failure).toBe('policy_binding_revoked');
  expect(f.bridge.binding('run', 1)).toBeUndefined(); expect(f.bridge.binding('run', 0)).toBeDefined();
  const displayed = f.selection.desired!.selection_id;
  f.race(() => { f.selection.desired = { ...f.selection.desired!, selection_id: 'newer-selection', target: { kind: 'extension', artifact: artifact('other') } }; });
  await expect(f.runtime.restartPolicy('run', displayed)).rejects.toThrow('policy_selection_changed');
  expect(f.selection.desired!.selection_id).toBe('newer-selection');
  expect(f.selection.active.generation).toBe(0);
});

it('main-model continuation cleanup preserves all pinned policy credential generations', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run'); f.route('new'); await f.runtime.refreshPolicy('run');
  f.credentials.add('model:active');
  f.runtime.releaseMainModelCredentials('run', { active: { binding_id: 'model:active' } as never, desired: null });
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration', 'policy:1:agentPlanning:configuration']));
  expect(f.bridge.binding('run', 0)).toBeDefined(); expect(f.bridge.binding('run', 1)).toBeDefined();
});

it('planning recovery uses committed configuration and generation without consulting newer settings', async () => {
  const scope = { reference: 'ref', authority: 'owner', account: 'account', generation: 1 };
  const configuration: ModelSessionConfiguration = { providerId: 'planner', providerFamily: 'openai-responses', model: 'small', endpoint: 'https://example.test/responses',
    credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const owner = new ExistingHostCredentialOwner({ providerId: 'planner', providerFamily: 'openai-responses', endpoint: configuration.endpoint, currentScope: async () => scope,
    runtime: { getAuth: async () => { throw new Error('No inference'); } } });
  const settings = vi.fn(async () => ({ global: { harness: { models: { agentPlanning: { enabled: true, providerId: 'planner', modelId: 'small' } } } } }));
  const rebindModel = vi.fn(async () => owner);
  const prepare = createPolicyModelPreparer({ settings, models: { resolveModel: async () => ({ configuration, credentialOwner: owner }), rebindModel } });
  const [first] = await prepare({ threadId: 'thread', generation: 7, requestedModelRoles: ['agentPlanning'] });
  expect(first!.capability.binding_id).toContain('policy:7:');
  settings.mockImplementation(async () => { throw new Error('Current settings unavailable'); });
  const saved = await prepare({ threadId: 'thread', generation: 7, requestedModelRoles: ['agentPlanning'], savedCapabilities: [first!.capability] });
  expect(saved[0]!.capability).toEqual(first!.capability); expect(settings).toHaveBeenCalledOnce();
  expect(rebindModel).toHaveBeenCalledWith(configuration, scope);
  await expect(prepare({ threadId: 'thread', generation: 8, requestedModelRoles: ['agentPlanning'], savedCapabilities: [first!.capability] })).rejects.toThrow('policy-model-selection-changed');
});


it('superseded slow preparation releases its pin without disturbing a newer ready credential owner', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run');
  const original = await vi.mocked(f.prepareModels).mock.results[0]!.value as Awaited<ReturnType<PolicyModelPreparer>>;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(f.prepareModels).mockImplementationOnce(async ({ generation }) => {
    await pending;
    return original.map(entry => ({ ...entry, capability: { ...entry.capability, binding_id: `policy:${generation}:agentPlanning:configuration` } }));
  });
  f.route('slow'); const slow = f.runtime.refreshPolicy('run');
  const rejected = expect(slow).rejects.toThrow();
  await vi.waitFor(() => expect(f.selection.desired?.generation).toBe(1));
  f.route('fast'); await f.runtime.refreshPolicy('run'); await rejected;
  expect(f.leases.find(lease => lease.binding.artifact.identity.name === 'slow')!.released).toBe(true);
  expect(f.bridge.binding('run', 0)).toBeDefined(); expect(f.bridge.binding('run', 2)).toBeDefined();
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration', 'policy:2:agentPlanning:configuration']));
  finish(); await tick();
  expect(f.bridge.binding('run', 1)).toBeUndefined();
  expect(f.selection.desired?.target).toEqual({ kind: 'extension', artifact: artifact('fast') });
});

it('a lost publication reply retains the committed generation instead of rolling back or freeing its credentials', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run'); f.route('new'); f.loseReady();
  await expect(f.runtime.refreshPolicy('run')).resolves.toMatchObject({ active: { generation: 1 } });
  expect((await f.runtime.inspectPolicy('run')).preparation).toBeNull();
  expect(f.selection.active.generation).toBe(1); expect(f.bridge.binding('run', 1)).toBeDefined();
  expect(f.bridge.binding('run', 0)).toBeUndefined();
  expect(f.credentials).toEqual(new Set(['policy:1:agentPlanning:configuration']));
  expect(f.requests.some(request => request.method === 'runtime.policy.fail')).toBe(false);
});

it('first observation after reconnect does not silently retry a cancelled same-target update', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run'); f.route('new'); await f.runtime.refreshPolicy('run');
  await f.runtime.cancelPolicyUpdate('run', f.selection.desired!.selection_id);
  const count = f.requests.filter(request => request.method === 'runtime.policy.select').length;
  f.notify(); await tick(); await tick();
  expect(f.requests.filter(request => request.method === 'runtime.policy.select')).toHaveLength(count);
  expect(f.selection.desired!.status).toBe('cancelled');
  f.notify(); await tick(); await tick();
  expect(f.requests.filter(request => request.method === 'runtime.policy.select')).toHaveLength(count + 1);
});


it('an old preparation finally cannot delete credentials rebuilt for the same committed generation after reconnect', async () => {
  const f = fixture(); let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.holdNextLaunch(async () => { await pending; return structuredClone(f.launch); });
  const old = f.runtime.preparePolicy('run'); const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(f.requests.some(request => request.method === 'runtime.launch.policy.prepare')).toBe(true));
  f.reconnect();
  const current = await f.runtime.preparePolicy('run'); expect(current?.generation).toBe(0);
  finish(); await rejected;
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration']));
  expect(f.bridge.binding('run', 0)).toEqual(current);
  expect(f.leases[0]!.released).toBe(true); expect(f.leases[1]!.released).toBe(false);
});


it('a delayed cancellation acknowledgement cannot abort a newer route preparation', async () => {
  const f = fixture(); await f.runtime.preparePolicy('run'); f.route('first'); await f.runtime.refreshPolicy('run');
  let cancelReply!: () => void;
  const reply = new Promise<void>(resolve => { cancelReply = resolve; });
  f.holdNextCancelReply(() => reply);
  const cancelled = f.runtime.cancelPolicyUpdate('run', f.selection.desired!.selection_id);
  await vi.waitFor(() => expect(f.selection.desired?.status).toBe('cancelled'));
  const original = await f.prepareModels.mock.results[0]!.value as Awaited<ReturnType<PolicyModelPreparer>>;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.prepareModels.mockImplementationOnce(async ({ generation }) => {
    await pending;
    return original.map(entry => ({ ...entry, capability: { ...entry.capability, binding_id: `policy:${generation}:agentPlanning:configuration` } }));
  });
  f.route('second'); const preparing = f.runtime.refreshPolicy('run');
  await vi.waitFor(() => expect(f.selection.desired?.generation).toBe(2));
  cancelReply(); expect((await cancelled).status).toBe('cancelled');
  finish(); await preparing;
  expect(f.selection.desired?.status).toBe('ready');
  expect(f.selection.desired?.target).toEqual({ kind: 'extension', artifact: artifact('second') });
  expect(f.bridge.binding('run', 2)).toBeDefined(); expect(f.bridge.binding('run', 0)).toBeDefined();
  expect(f.credentials).toEqual(new Set(['policy:0:agentPlanning:configuration', 'policy:2:agentPlanning:configuration']));
});
