import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  HostServiceRegistry, type ApplicationExtensionRuntime, type HostServiceBinding, type HostServiceHandler,
  type HostServiceOwnerIdentity, type HostServicePreparationOptions,
} from '@varin/extension-host';
import {
  VARIN_CONTEXT_FRAGMENTS_SERVICE, VARIN_CONTEXT_BUDGET_SERVICE,
  type VarinExtensionServiceInvocationRequest, type VarinExtensionServiceProvision,
  type VarinHostServiceComposition, type VarinExtensionServiceRoutingDocument,
  type VarinContextBudgetInput, type VarinRunActivityDelivery,
  parseVarinExtensionServiceProvision,
} from '@varin/extension-contract';
import { createContextComposition } from './context-composition.js';
import { createContextBudget } from './context-budget.js';
import { createRetrievalComposition, type RetrievalSemanticLease } from './retrieval-composition.js';
import { RunObservers } from './run-observers.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** The real registry owns every lease and callback. Only catalog/Run I/O is in-memory. */
function fixture(descriptor: VarinExtensionServiceProvision) {
  const services = new HostServiceRegistry('consumer-test');
  const held = new Set<HostServiceBinding>();
  let generation = 0;
  let current!: { owner: HostServiceOwnerIdentity; composition: VarinHostServiceComposition; providerId: string };
  let listener = () => {};
  let beforeReturn: ((binding: HostServiceBinding, options?: HostServicePreparationOptions) => Promise<void>) | undefined;
  let onRelease: ((binding: HostServiceBinding) => void) | undefined;
  let prepares = 0;
  const providerKey = `review.consumer:host:${descriptor.id}@${descriptor.version}`;
  const document: VarinExtensionServiceRoutingDocument = { schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(),
    rules: [{ serviceId: descriptor.id, version: descriptor.version, providerKeys: [providerKey], scope: { userId: 'default' }, allowFallback: false }] };
  const prepare = async (request: VarinExtensionServiceInvocationRequest, options?: HostServicePreparationOptions) => {
    options?.signal?.throwIfAborted();
    assert.equal(request.serviceId, descriptor.id);
    prepares++;
    const original = services.bind(descriptor.id, descriptor.version, current.providerId);
    const binding: HostServiceBinding = { ...original, release() {
      original.release();
      if (held.delete(binding)) onRelease?.(binding);
    } };
    held.add(binding);
    await beforeReturn?.(binding, options);
    return binding;
  };
  const runtime = {
    routing: { read: async () => ({ authoritative: true, document }) }, services,
    catalog: { snapshot: async () => ({ authoritative: true, extensions: [{ manifest: { id: 'review.consumer',
      version: '1.0.0', entrypoints: { host: {} }, provides: { services: [descriptor] } }, desired: { enabled: true },
      selectedVersion: '1.0.0', integrity: current.composition.root }] }) },
    prepareService: prepare,
    prepareServiceCollection: async (request: VarinExtensionServiceInvocationRequest, options?: HostServicePreparationOptions) =>
      ({ bindings: [await prepare(request, options)], routingRevision: document.revision }),
    resolveServiceCompositions: async (_request: unknown, options?: HostServicePreparationOptions) => {
      options?.signal?.throwIfAborted();
      if (options?.expectedRoutingRevision !== undefined) assert.equal(options.expectedRoutingRevision, document.revision);
      return { services: [{ providerKey, descriptor, composition: current.composition }], routingRevision: document.revision };
    },
    supervisor: { getActiveArtifactIdentity: () => current.composition.root, getRetainedArtifactIdentity: () => current.composition.root },
    subscribe(callback: () => void) { listener = callback; return () => { listener = () => {}; }; },
  } as unknown as ApplicationExtensionRuntime;
  return { runtime, services, held, document, get current() { return current; }, get prepares() { return prepares; },
    beforeReturn(callback?: typeof beforeReturn) { beforeReturn = callback; },
    onRelease(callback?: typeof onRelease) { onRelease = callback; }, notify() { listener(); },
    publish(root: string, handler: HostServiceHandler) {
      const previous = current;
      const owner = { extensionId: 'review.consumer', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: root, generation: ++generation };
      const composition: VarinHostServiceComposition = { schemaVersion: 1, root, nodes: [{ id: root,
        extensionId: owner.extensionId, entrypointId: 'host', extensionVersion: owner.extensionVersion,
        artifactIntegrity: root, activationConfiguration: null, grants: [], dependencies: [] }] };
      const replacement = services.prepareOwnerReplacement(owner, [{ descriptor, handler }],
        { composition, ...(previous ? { previousOwners: [previous.owner] } : {}) });
      replacement.commit();
      current = { owner, composition, providerId: services.getSnapshot().providers.find(provider => provider.generation === generation)!.providerId };
      return { previous, finalized: replacement.finalize() };
    },
  };
}

test('context caches only proven declarations and releases preparation on error/cancellation without faking drain', { timeout: 5000 }, async () => {
  const f = fixture(parseVarinExtensionServiceProvision(VARIN_CONTEXT_FRAGMENTS_SERVICE));
  let descriptions = 0;
  const describe = () => { descriptions++; return { sections: [{ name: 'scope', kind: 'data', content: 'original' }] }; };
  await f.publish('original', describe).finalized;
  const prepare = createContextComposition(f.runtime);
  const first = await prepare({ threadId: 'thread' });
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), false);
  const old = f.current;
  await f.services.retireOwner(old.owner);
  f.services.removeOwner(old.owner);
  await f.publish('original', describe).finalized;
  assert.deepEqual(await prepare({ threadId: 'thread' }), first);
  assert.equal(descriptions, 1);
  assert.equal(f.prepares, 1, 'an unchanged graph needs no worker even after the describing generation was removed');
  await f.publish('changed', () => ({ sections: [{ name: 'scope', kind: 'data', content: 'changed' }] })).finalized;
  assert.equal((await prepare({ threadId: 'thread' }))?.transforms[0]?.sections[0]?.content, 'changed');
  assert.equal(f.held.size, 0);
  await f.publish('invalid', () => ({ sections: 'invalid' })).finalized;
  await assert.rejects(prepare({ threadId: 'thread' }), /sections array/);
  assert.equal(f.held.size, 0);

  const entered = deferred(), finish = deferred();
  await f.publish('slow', async () => { entered.resolve(); await finish.promise; return { sections: [] }; }).finalized;
  const controller = new AbortController();
  const pending = prepare({ threadId: 'thread' }, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await entered.promise;
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), true, 'the actual callback is still running');
  finish.resolve();
  await f.services.retireOwner(f.current.owner);
  assert.equal(f.services.ownerInUse(f.current.owner), false);
});

test('a cancelled budget decision releases its consumer leases while the original callback drains', { timeout: 5000 }, async () => {
  const f = fixture(VARIN_CONTEXT_BUDGET_SERVICE);
  const entered = deferred(), finish = deferred();
  let decisionSignal: AbortSignal | undefined;
  await f.publish('budget', async (method, _args, call) => {
    if (method === 'describe') return { identity: { name: 'test', version: '1' }, configuration: {} };
    decisionSignal = call.signal;
    entered.resolve(); await finish.promise;
    return { kind: 'keep' };
  }).finalized;
  const input: VarinContextBudgetInput = { boundary: 'before_model_dispatch', requestId: 'request',
    estimate: { estimatedTokens: 10, unmeasuredMedia: 0, unmeasuredProviderItems: 0, method: 'fixture' },
    capacityTokens: 100, inputBudgetTokens: 80, settings: { reserveTokens: 20, keepRecentTokens: 10, backgroundPreparation: false, preparationWaterline: 0.7 }, candidates: [] };
  const controller = new AbortController();
  const pending = createContextBudget(f.runtime).decide({ threadId: 'thread' }, input, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await entered.promise;
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(decisionSignal?.aborted, true);
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), true);
  finish.resolve();
  await f.services.retireOwner(f.current.owner);
});

test('retrieval owns query pins independently and keeps an older query live when a new candidate fails', { timeout: 5000 }, async () => {
  const f = fixture({ id: 'varin.retrieval.plan', version: 1 });
  const leases: Array<{ released: boolean }> = [];
  const models: Array<{ released: boolean }> = [];
  let semanticFailure = false;
  const semanticGate = deferred<RetrievalSemanticLease>();
  let delaySemantic = false;
  const semanticWaiting = deferred();
  const composition = createRetrievalComposition(f.runtime, { prepareSemantic: async (): Promise<RetrievalSemanticLease> => {
    if (semanticFailure) throw new Error('semantic failed');
    if (delaySemantic) { semanticWaiting.resolve(); return semanticGate.promise; }
    const state = { released: false }; leases.push(state);
    return { stage: { providerId: 'semantic', configurationId: 'configuration', status: 'unavailable' },
      metadata: { bindingState: 'unavailable', providerId: null, modelId: null, configurationId: null,
        spaceId: null, recipeId: null, publishedRevision: null, processEpoch: null, coverage: 'empty', lifecycle: 'idle' },
      assertAvailable() { assert.equal(state.released, false); }, async validateAvailable() {}, release() { state.released = true; } };
  }, prepareModel: async () => {
    const state = { released: false }; models.push(state);
    return { stage: { providerId: 'model', configurationId: 'model-configuration', status: 'unavailable' },
      assertAvailable() { assert.equal(state.released, false); }, async validateAvailable() {}, release() { state.released = true; } };
  } });
  await f.publish('one', () => ({ configurationId: 'one', structure: 'disabled', semantic: 'builtin' })).finalized;
  const firstOwner = f.current.owner;
  const first = await composition.prepare({ threadId: 'thread' });
  assert.equal(f.held.size, 0, 'only the independent query pin survives preparation');
  assert.equal(f.services.ownerInUse(firstOwner), true);
  semanticFailure = true;
  const replacement = f.publish('two', () => ({ configurationId: 'two', structure: 'disabled', semantic: 'builtin' }));
  await assert.rejects(composition.prepare({ threadId: 'thread' }), /semantic failed/);
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), false);
  first.assertAvailable();
  assert.equal(leases[0]!.released, false);
  assert.equal(models[0]!.released, false);
  first.release(); first.release();
  await replacement.finalized;
  assert.equal(leases[0]!.released, true);
  assert.equal(models[0]!.released, true);
  semanticFailure = false;
  const second = await composition.prepare({ threadId: 'thread' });
  assert.equal(second.selection.configurationId, 'two');
  second.release();
  assert.equal(f.services.ownerInUse(f.current.owner), false);
  delaySemantic = true;
  const controller = new AbortController();
  const pending = composition.prepare({ threadId: 'thread' }, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await semanticWaiting.promise;
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), false);
  const lateReleased = deferred();
  semanticGate.resolve({ stage: { providerId: 'late', configurationId: 'late', status: 'unavailable' },
    metadata: { bindingState: 'unavailable', providerId: null, modelId: null, configurationId: null,
      spaceId: null, recipeId: null, publishedRevision: null, processEpoch: null, coverage: 'empty', lifecycle: 'idle' },
    assertAvailable() {}, async validateAvailable() {}, release() { lateReleased.resolve(); } });
  await lateReleased.promise;
});

function observerRuntime() {
  const phases: string[] = [];
  let supplied = false;
  const runtime = {
    onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {},
    status: async () => ({ eventCursor: 1 }), threads: async () => [{ thread_id: 'thread', branches: [], parent_thread_id: null, observer_project_ids: [null] }],
    observerEvents: async () => {
      if (supplied) return [];
      supplied = true;
      return [{ cursor: 1, subject: 'run', revision: 1, kind: 'run.accepted', data: { state: 'accepted' } }];
    },
    observerDelivery: async (_id: string, _thread: string, _cursor: number, phase: string) => { phases.push(phase); },
  } as unknown as AgentRuntimeClient;
  return { runtime, phases };
}

test('observer replacements release subscriptions but keep each delivery pinned until its real callback finishes', { timeout: 5000 }, async () => {
  const f = fixture({ id: 'varin.run.activity', version: 1 });
  const entered = deferred(), finish = deferred(), replaced = deferred();
  await f.publish('one', async (_method, args) => {
    const delivery = args[0] as unknown as VarinRunActivityDelivery;
    entered.resolve(); await finish.promise;
    return { subscriptionId: delivery.subscriptionId, deliveryId: delivery.deliveryId, cursor: delivery.fact.cursor };
  }).finalized;
  const firstOwner = f.current.owner;
  const source = observerRuntime();
  const errors: unknown[] = [];
  const observers = new RunObservers(source.runtime, f.runtime, (_thread, error) => errors.push(error));
  await entered.promise;
  const readmitted = deferred();
  f.onRelease(() => readmitted.resolve());
  f.document.revision += 1;
  f.document.rules.push({ serviceId: 'review.dependency', version: 1, providerKeys: ['review.dependency:host:review.dependency@1'],
    scope: { userId: 'default' }, allowFallback: false });
  f.notify();
  await readmitted.promise;
  assert.equal(f.prepares, 2, 'dependency routing changes re-admit the existing observer composition');
  f.onRelease(() => replaced.resolve());
  const replacement = f.publish('two', () => null);
  f.notify();
  await replaced.promise;
  assert.equal(f.held.size, 1);
  assert.equal(f.services.ownerInUse(firstOwner), true);
  observers.stop();
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(firstOwner), true);
  finish.resolve();
  await replacement.finalized;
  await turn();
  assert.equal(source.phases.includes('committed'), false, 'stop cancels ACK admission without claiming the callback already drained');
  assert.deepEqual(errors, []);
});

test('observer stop releases a binding that completes after its selection was abandoned', { timeout: 5000 }, async () => {
  const f = fixture({ id: 'varin.run.activity', version: 1 });
  await f.publish('one', () => null).finalized;
  const acquired = deferred(), finish = deferred(), released = deferred();
  let signal: AbortSignal | undefined;
  f.beforeReturn(async (_binding, options) => { signal = options?.signal; acquired.resolve(); await finish.promise; });
  f.onRelease(() => released.resolve());
  const observers = new RunObservers(observerRuntime().runtime, f.runtime, () => {});
  await acquired.promise;
  observers.stop();
  assert.equal(signal?.aborted, true);
  finish.resolve();
  await released.promise;
  assert.equal(f.held.size, 0);
  assert.equal(f.services.ownerInUse(f.current.owner), false);
});
