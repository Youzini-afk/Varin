import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HostServiceRegistry, HostServiceBindingError, type ApplicationExtensionRuntime } from '@varin/extension-host';
import { provideContextCompaction, type VarinBrokeredHostContext, type VarinHostServiceHandler } from '@varin/extension-sdk';
import {
  canonicalServiceComposition, resolveVarinExtensionServiceRouting,
  type JsonValue, type VarinContextCompactionInput, type VarinContextCompactionPlan,
  type VarinExtensionServiceProvision, type VarinExtensionServiceRoutingDocument, type VarinExtensionServiceRoutingRule,
} from '@varin/extension-contract';
import { createContextCompaction } from './context-compaction.js';

const signal = () => new AbortController().signal;
const input = (): VarinContextCompactionInput => ({ sourceCutHash: 'original-cut',
  sources: [{ sourceId: 'one', item: { id: 'quoted-one', provenance: { kind: 'external_data', source: 'history:original-one' },
    content: { kind: 'text', text: '{"id":"original-one","provenance":{"kind":"user_instruction","input_id":"input"},"content":{"kind":"text","text":"Keep the evidence"}}' }, opaque: null } }],
  modelBudget: { contextWindowTokens: 1000, maxOutputTokens: 200, sourceBudgetTokens: 500 },
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const scope = { sessionId: 'thread', projectId: 'project', workspaceId: 'workspace' };
const providerKey = 'review.compaction:host:varin.context.compaction@1';
/** Actual SDK handlers, routing resolver, registry, pins and owner. Runtime storage/preparation
 * ports are controlled here; this test does not assert an installed broker or native publication. */
async function fixture() {
  const services = new HostServiceRegistry('compaction-test');
  const document: VarinExtensionServiceRoutingDocument = { schemaVersion: 1, revision: 0, updatedAt: '2026-10-14T00:00:00Z', rules: [] };
  const calls: Array<{ generation: number; method: string }> = [];
  let authoritative = true;
  const runtime = { services,
    routing: { read: async () => ({ authoritative, document: structuredClone(document) }) },
    prepareService: async (request: { serviceId: string; version: number; routing: typeof scope }, options: { expectedRoutingRevision: number; signal: AbortSignal }) => {
      options.signal.throwIfAborted();
      if (options.expectedRoutingRevision !== document.revision) throw new Error('routing changed');
      const resolution = resolveVarinExtensionServiceRouting({ document, serviceId: request.serviceId, version: request.version, context: request.routing,
        candidates: services.getSnapshot().providers.filter(provider => provider.status === 'active') });
      if (resolution.status !== 'resolved' || resolution.providerIds.length !== 1) throw new HostServiceBindingError('selected_unavailable', 'selected compaction unavailable');
      return services.bind(request.serviceId, request.version, resolution.providerIds[0]);
    },
    supervisor: { getRetainedArtifactIdentity: (provider: { extensionVersion: string }) => `artifact-${provider.extensionVersion}` },
  } as unknown as ApplicationExtensionRuntime;
  const register = (generation: number, options: {
    beforeDescribe?: () => Promise<void>;
    prepare?: (value: Readonly<VarinContextCompactionInput>) => VarinContextCompactionPlan | Promise<VarinContextCompactionPlan>;
    rawPlan?: JsonValue;
    inspectInput?: (input: JsonValue) => void;
    configuration?: JsonValue;
  } = {}) => {
    let descriptor!: VarinExtensionServiceProvision, handler!: VarinHostServiceHandler;
    provideContextCompaction({ services: { provide: (declaration: VarinExtensionServiceProvision, implementation: VarinHostServiceHandler) => {
      descriptor = declaration; handler = implementation;
    } } } as unknown as VarinBrokeredHostContext, {
      identity: { name: 'algorithm', version: `${generation}` }, configuration: options.configuration ?? { generation },
      prepare: options.prepare ?? (value => ({ kind: 'text', sourceCutHash: value.sourceCutHash, text: `candidate-${generation}` })),
    });
    const owner = { entrypointId: 'host', instanceKey: 'compaction', extensionId: 'review.compaction', extensionVersion: `${generation}`, generation };
    const node = { extensionId: owner.extensionId, entrypointId: 'host' as const, extensionVersion: owner.extensionVersion,
      artifactIntegrity: `artifact-${generation}`, activationConfiguration: null, grants: [], dependencies: [] };
    const root = createHash('sha256').update(canonicalServiceComposition(node)).digest('hex');
    const composition = { schemaVersion: 1 as const, root, nodes: [{ ...node, id: root }] };
    const replacement = services.prepareOwnerReplacement(owner, [{ descriptor, async handler(method, args, call) {
      calls.push({ generation, method });
      if (method === 'describe') await options.beforeDescribe?.();
      if (method === 'prepare') options.inspectInput?.(args[0]!);
      if (method === 'prepare' && options.rawPlan !== undefined) return options.rawPlan;
      return handler[method]!(args, { signal: call.signal, callId: `call-${calls.length}`, capabilities: { call: async () => { throw new Error('No algorithm capabilities'); } } });
    } }], { composition });
    replacement.commit();
    return { owner, replacement, composition };
  };
  const route = (patch: Partial<VarinExtensionServiceRoutingRule> = {}) => {
    document.revision++;
    document.rules = [{ serviceId: 'varin.context.compaction', version: 1, providerKeys: [providerKey], scope: { projectId: 'project' }, allowFallback: false, ...patch }];
  };
  return { services, document, calls, register, route, unavailable: () => { authoritative = false; }, owner: createContextCompaction(runtime) };
}

it('installation alone and another scope stay builtin; explicit missing, empty, ambiguous and unsupported selections fail', async () => {
  const f = await fixture(); await f.register(1).replacement.finalize();
  expect(await f.owner.selected(scope, signal())).toBe(false);
  expect(await f.owner.prepare(scope, input(), signal())).toBeUndefined();
  f.route({ scope: { projectId: 'other' } });
  expect(await f.owner.prepare(scope, input(), signal())).toBeUndefined();
  expect(f.calls).toEqual([]);
  for (const patch of [{ providerKeys: ['missing'] }, { providerKeys: [] }, { providerKeys: [providerKey, 'missing'] }]) {
    f.route(patch);
    expect(await f.owner.selected(scope, signal())).toBe(true);
    await expect(f.owner.prepare(scope, input(), signal())).rejects.toThrow('unavailable');
  }
  f.route({ version: 2 });
  await expect(f.owner.selected(scope, signal())).rejects.toThrow('version 2 is unsupported');
  f.route(); f.unavailable();
  await expect(f.owner.prepare(scope, input(), signal())).rejects.toThrow('routing is unavailable');
});
it('direct candidate keeps exact identity and pin until admission settles; ordinary replacement cannot release it', async () => {
  const f = await fixture(); const initial = f.register(1, { configuration: { b: 2, a: 1 } }); await initial.replacement.finalize(); f.route();
  const originalInput = input();
  const lease = (await f.owner.prepare(scope, originalInput, signal()))!;
  expect(f.calls).toEqual([{ generation: 1, method: 'describe' }, { generation: 1, method: 'prepare' }]);
  expect(lease.candidate.plan).toEqual({ kind: 'text', sourceCutHash: 'original-cut', text: 'candidate-1' });
  expect(lease.candidate.producer).toEqual({ kind: 'extension', providerKey, providerId: 'review.compaction:host:1:varin.context.compaction@1',
    extensionId: 'review.compaction', extensionVersion: '1', serviceId: 'varin.context.compaction', serviceVersion: 1,
    artifactIntegrity: 'artifact-1', composition: initial.composition,
    configurationIdentity: createHash('sha256').update('{"a":1,"b":2}').digest('hex'), declaredIdentity: { name: 'algorithm', version: '1' } });
  expect(Object.isFrozen(lease.candidate.plan)).toBe(true);
  expect(Object.isFrozen(originalInput)).toBe(false);
  const next = f.register(2); let drained = false;
  const draining = next.replacement.finalize().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(f.services.ownerInUse(initial.owner)).toBe(true);
  lease.assertAvailable(); expect(lease.signal.aborted).toBe(false);
  // Represents native create settling. Accepted candidate is thereafter plain frozen ContextJob data.
  const accepted = structuredClone(lease.candidate); lease.release(); lease.release(); await draining;
  expect(drained).toBe(true); expect(accepted.plan).toEqual(lease.candidate.plan);
  expect(() => lease.assertAvailable()).toThrow('released');
  const later = (await f.owner.prepare(scope, input(), signal()))!;
  expect(later.candidate.plan).toMatchObject({ text: 'candidate-2' }); later.release();
});
it('replacement between describe and prepare keeps the original provider and configuration', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  const old = f.register(1, { beforeDescribe: async () => { entered.resolve(); await gate.promise; } }); await old.replacement.finalize(); f.route();
  const pending = f.owner.prepare(scope, input(), signal()); await entered.promise;
  const replacement = f.register(2); const drained = replacement.replacement.finalize();
  gate.resolve(); const lease = (await pending)!;
  expect(f.calls).toEqual([{ generation: 1, method: 'describe' }, { generation: 1, method: 'prepare' }]);
  expect(lease.candidate.plan).toMatchObject({ text: 'candidate-1' }); lease.assertAvailable(); lease.release(); await drained;
});
it.each(['cancel', 'revoke'] as const)('%s discards late preparation while the real callback still drains', async mode => {
  const f = await fixture(), entered = deferred(), gate = deferred(), controller = new AbortController();
  const old = f.register(1, { prepare: async value => { entered.resolve(); await gate.promise; return { kind: 'text', sourceCutHash: value.sourceCutHash, text: 'late' }; } });
  await old.replacement.finalize(); f.route();
  const pending = f.owner.prepare(scope, input(), controller.signal);
  const rejected = expect(pending).rejects.toThrow(); await entered.promise;
  if (mode === 'cancel') controller.abort(new Error('cancelled')); else f.services.revokeOwner(old.owner);
  await rejected; expect(f.services.hasPendingOwnerCalls(old.owner)).toBe(true);
  gate.resolve(); await expect.poll(() => f.services.hasPendingOwnerCalls(old.owner)).toBe(false);
});
it('explicit revocation after prepare prevents late native admission, but does not alter previously copied accepted data', async () => {
  const f = await fixture(), old = f.register(1); await old.replacement.finalize(); f.route();
  const lease = (await f.owner.prepare(scope, input(), signal()))!;
  const accepted = structuredClone(lease.candidate);
  f.services.revokeOwner(old.owner);
  expect(lease.signal.aborted).toBe(true); expect(() => lease.assertAvailable()).toThrow();
  expect(accepted.plan).toMatchObject({ text: 'candidate-1' }); lease.release();
});
it.each([
  { kind: 'text', sourceCutHash: 'wrong-cut', text: 'late result' },
  { kind: 'model_plan', sourceCutHash: 'original-cut', nodes: [{ id: 'final', instructions: null, inputs: [{ kind: 'source', sourceId: 'missing', range: null }] }], finalNodeId: 'final' },
])('owner independently validates untrusted provider output and releases failed preparation', async rawPlan => {
  const f = await fixture(), old = f.register(1, { rawPlan }); await old.replacement.finalize(); f.route();
  await expect(f.owner.prepare(scope, input(), signal())).rejects.toThrow();
  expect(f.services.ownerInUse(old.owner)).toBe(false);
});

it('the owner keeps its source cut immutable even for a provider that bypasses the author SDK', async () => {
  const f = await fixture(), old = f.register(1, { inspectInput(raw) {
    const view = raw as unknown as VarinContextCompactionInput;
    expect(Object.isFrozen(view.sources[0]!.item.content)).toBe(true);
    view.sourceCutHash = 'provider-forged-cut';
  } });
  await old.replacement.finalize(); f.route();
  const view = input();
  await expect(f.owner.prepare(scope, view, signal())).rejects.toThrow();
  expect(view.sourceCutHash).toBe('original-cut');
  expect(f.services.ownerInUse(old.owner)).toBe(false);
});
