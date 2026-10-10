import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { JsonValue, VarinAgentPolicyInput } from '@varin/extension-contract';
import { afterEach, expect, it } from 'vitest';
import { resolveVarinExtensionServiceRouting } from '@varin/extension-contract';
import { ApplicationExtensionRuntime, HostServiceRegistry } from '@varin/extension-host';
import { createAgentPolicy } from './agent-policy.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-policy-binding-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  cleanups.push(async () => { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await runtime.start();
  const install = async (version: number, id = `review.policy-v${version}`) => {
    const folder = path.join(root, id); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: 'varin.agent.policy', version, multiple: true }] } }));
    await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'varin.agent.policy',version:${version},multiple:true},{
      describe(){${version === 3 ? "return {identity:{name:'installed-v3',version:'1'},configuration:{},modelRoles:[],stateTransition:'unsupported'}" : "throw new Error('Obsolete describe must never run')"}},
      decide(){return {action:{kind:'complete'},state:null}}
    })}}`);
    await runtime.installOrStage({ expectedRevision: (await runtime.state()).catalog.revision, source: { kind: 'local', display: id, specifier: folder } });
    return `${id}:host:varin.agent.policy@${version}`;
  };
  const route = async (version: number, providerKey: string, scope: { projectId?: string; sessionId?: string }, allowFallback = false) =>
    runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
      rule: { serviceId: 'varin.agent.policy', version, providerKey, scope, allowFallback } });
  return { root, runtime, install, route, prepare: createAgentPolicy(runtime) };
}

it('absence, unselected old installation and another scope do not block the default policy', async () => {
  const f = await fixture();
  const scope = { sessionId: 'thread', projectId: 'current' };
  expect(await f.prepare(scope)).toBeUndefined();
  const old = await f.install(1);
  expect(await f.prepare(scope)).toBeUndefined();
  await f.route(1, old, { projectId: 'other' });
  expect(await f.prepare(scope)).toBeUndefined();
  await f.runtime.setEnabled('review.policy-v1', false, (await f.runtime.state()).catalog.revision);
  expect(await f.prepare(scope)).toBeUndefined();
  const installed = await f.install(3);
  const lease = await f.prepare(scope);
  expect(lease?.binding.artifact.identity.name).toBe(`${installed}:installed-v3`);
  lease?.release();
});

it.each([false, true])('an explicit unsupported policy cannot be replaced by the default loop or an installed-only v3 (fallback=%s)', async allowFallback => {
  const f = await fixture();
  const old = await f.install(1);
  await f.route(1, old, { projectId: 'current' }, allowFallback);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  await f.install(3);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v3')).toBe(false);
});

it('conflicting unsupported rules cannot disappear into optional-policy absence', async () => {
  const f = await fixture();
  await f.route(1, 'review.one:host:varin.agent.policy@1', { projectId: 'current', sessionId: 'thread' });
  // User and project context have the same precedence within a session-specific rule.
  await f.runtime.upsertServiceRoutingRule({ expectedRevision: (await f.runtime.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 1, providerKey: 'review.two:host:varin.agent.policy@1', scope: { userId: 'owner', sessionId: 'thread' }, allowFallback: false } });
  const scope = { sessionId: 'thread', projectId: 'current', userId: 'owner' };
  expect(resolveVarinExtensionServiceRouting({ candidates: [], document: (await f.runtime.routing.read()).document, serviceId: 'varin.agent.policy', version: 1, context: scope }).status).toBe('ambiguous');
  await expect(f.prepare(scope)).rejects.toThrow(/version 1 is unsupported/);
});

it('a real v3 selection remains usable alongside old routes and preserves its exact provider generation', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.route(1, old, { projectId: 'current' });
  const selected = await f.install(3);
  await f.route(3, selected, { projectId: 'current' });
  const lease = await f.prepare({ sessionId: 'thread', projectId: 'current' });
  expect(lease?.binding.artifact.identity.name).toBe(`${selected}:installed-v3`);
  try {
    expect(await lease!.decide({ view: { run_id: 'run', state: 'runnable', history_count: 0, history_head_id: null, pending_tool_calls: 0, model_capabilities: [] }, event: { kind: 'started' }, state: null }, new AbortController().signal))
      .toEqual({ action: { kind: 'complete' }, state: null });
    const childProvider = await f.install(3, 'review.child-policy');
    await f.route(3, childProvider, { projectId: 'current', sessionId: 'thread:child' });
    const childPolicy = await f.prepare({ sessionId: 'thread:child', projectId: 'current' });
    try {
      expect(childPolicy!.binding.artifact.providerKey).toBe(childProvider);
      expect(childPolicy!.binding.artifact.providerKey).not.toBe(lease!.binding.artifact.providerKey);
      expect((await childPolicy!.decide({ view: { run_id: 'child-run', state: 'runnable', history_count: 1, history_head_id: 'child-task', pending_tool_calls: 0, model_capabilities: [] }, event: { kind: 'started' }, state: null }, new AbortController().signal)).action.kind).toBe('complete');
    } finally { childPolicy?.release(); }

  } finally { lease?.release(); }
});


it('an explicit unsupported registry selection is rejected without invoking its obsolete describe method', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.runtime.supervisor.activateExtension('review.policy-v1');
  const provider = f.runtime.services.getSnapshot().providers.find(provider => provider.providerKey === old)!;
  await f.runtime.setServiceSelection({ serviceId: 'varin.agent.policy', version: 1, providerId: provider.providerId });
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  await f.install(3);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v3')).toBe(false);
});


it('a routing change between version-intent inspection and provider preparation fails before the implicit provider activates', async () => {
  const f = await fixture();
  await f.install(3);
  const read = f.runtime.routing.read.bind(f.runtime.routing);
  let entered!: () => void; let release!: () => void; let reads = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.routing.read = async () => {
    const snapshot = await read();
    if (++reads === 1) { entered(); await releaseGate; }
    return snapshot;
  };
  const pending = f.prepare({ sessionId: 'thread', projectId: 'current' });
  try {
    await enteredGate;
    await f.route(1, 'review.policy-v1:host:varin.agent.policy@1', { projectId: 'current' });
    release();
    await expect(pending).rejects.toThrow(/routing changed during preparation/);
    expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v3')).toBe(false);
  } finally { release(); }
});


it('a registry selection arriving while v3 absence is being resolved cannot silently select the default loop', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.runtime.supervisor.activateExtension('review.policy-v1');
  const provider = f.runtime.services.getSnapshot().providers.find(provider => provider.providerKey === old)!;
  const read = f.runtime.routing.read.bind(f.runtime.routing);
  let entered!: () => void; let release!: () => void; let reads = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.routing.read = async () => {
    const snapshot = await read();
    if (++reads === 2) { entered(); await releaseGate; }
    return snapshot;
  };
  const pending = f.prepare({ sessionId: 'thread', projectId: 'current' });
  try {
    await enteredGate;
    await f.runtime.setServiceSelection({ serviceId: 'varin.agent.policy', version: 1, providerId: provider.providerId });
    release();
    await expect(pending).rejects.toThrow(/Policy selection changed during preparation/);
  } finally { release(); }
});


it('an installed child SDK policy preserves exact retirement/rebind across delivery/pause/resumed boundaries', async () => {
  const f = await fixture();
  const example = path.join(f.root, 'delivery-pause-policy'); await fs.mkdir(example);
  for (const file of ['package.json', 'varin.extension.json']) await fs.copyFile(path.join(repository, 'examples/extensions/delivery-pause-policy', file), path.join(example, file));
  const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
  await build({ entryPoints: [path.join(repository, 'examples/extensions/delivery-pause-policy/host.ts')], bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(example, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  await f.runtime.installOrStage({ expectedRevision: (await f.runtime.state()).catalog.revision,
    source: { kind: 'local', display: 'Delivery pause SDK example', specifier: example } });
  await f.route(3, 'example.delivery-pause-policy:host:varin.agent.policy@3', { sessionId: 'thread:child-delivery' });
  const lease = await f.prepare({ sessionId: 'thread:child-delivery' });
  expect(lease?.binding.artifact.identity.name).toContain('example.delivery-pause-policy:host:varin.agent.policy@3:delivery-pause');
  try {
    const input: VarinAgentPolicyInput = { view: { run_id: 'run:child-delivery', state: 'runnable', history_count: 1,
      history_head_id: 'user-input', pending_tool_calls: 0, model_capabilities: [] }, event: { kind: 'started' }, state: null };
    const signal = new AbortController().signal;
    const first = await lease!.decide(input, signal);
    expect(first.action).toMatchObject({ kind: 'deliver', text: expect.stringContaining('first result') });
    const pause = await lease!.decide({ ...input, state: first.state, event: { kind: 'delivered', action_id: 'delivery:first', item_id: 'history:first' } }, signal);
    expect(pause.action).toMatchObject({ kind: 'pause', reason: expect.stringContaining('Resume run') });
    // Normal installer replacement retires the old service, but the admitted Run's pin survives.
    await fs.appendFile(path.join(example, 'host.cjs'), '\n// same private state contract, new artifact\n');
    const staged = await f.runtime.reloadLocalSource({ extensionId: 'example.delivery-pause-policy', expectedRevision: (await f.runtime.state()).catalog.revision });
    if (staged.outcome !== 'staged') throw new Error('Expected a real installed candidate');
    await f.runtime.requestCandidateApplication({ extensionId: 'example.delivery-pause-policy', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.state()).catalog.revision });
    const selecting = f.runtime.selectCandidate({ extensionId: 'example.delivery-pause-policy', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.state()).catalog.revision });
    await expect.poll(() => f.runtime.services.getSnapshot().providers.find(provider => provider.extensionId === 'example.delivery-pause-policy' && provider.status === 'active')?.providerId).not.toBe(lease!.binding.reference);
    const restored = await f.prepare({ sessionId: 'thread:child-delivery', requiredBinding: lease!.binding.artifact });
    expect(restored!.binding.artifact).toEqual(lease!.binding.artifact);
    restored!.release();
    const candidate = await f.prepare({ sessionId: 'thread:child-delivery' });
    const from = { identity: lease!.binding.artifact.identity, declaredIdentity: lease!.binding.artifact.declaredIdentity };
    const resumed = { ...input, state: pause.state, event: { kind: 'resumed' as const, action_id: 'pause:first', wait_id: 'pause-wait:first' } };
    expect(candidate!.binding.artifact.identity).not.toEqual(lease!.binding.artifact.identity);
    expect(await candidate!.transitionState({ ...resumed, from }, signal)).toEqual({ kind: 'compatible', state: pause.state });
    expect((await candidate!.transitionState({ ...resumed, from: { ...from, declaredIdentity: { name: 'delivery-pause', version: '2' } } }, signal)).kind).toBe('incompatible');
    expect((await candidate!.transitionState({ ...resumed, state: { unknown: true }, from }, signal)).kind).toBe('incompatible');
    expect((await candidate!.transitionState({ ...resumed, event: { kind: 'input_delivered', input_ids: ['queued'] }, from }, signal)).kind).toBe('incompatible');
    expect((await lease!.decide(resumed, signal)).action.kind).toBe('deliver');
    const leaseIdentity = candidate!.binding.artifact.identity;
    candidate!.release(); lease!.release(); await selecting;
    await expect(f.prepare({ sessionId: 'thread:child-delivery', requiredBinding: lease!.binding.artifact })).rejects.toThrow('policy_exact_binding_unavailable');
    // Reacquiring the installed artifact keeps checkpoint identity; it grants no right to resume.
    const rebound = await f.prepare({ sessionId: 'thread:child-delivery' });
    try {
      expect(rebound!.binding.artifact.identity).toEqual(leaseIdentity);
      const unexpected = await rebound!.decide({ ...input, state: pause.state, event: { kind: 'input_delivered', input_ids: ['queued'] } }, signal);
      expect(unexpected.action.kind).toBe('fail');
      const second = await rebound!.decide({ ...input, state: pause.state, event: { kind: 'resumed', action_id: 'pause:first', wait_id: 'pause-wait:first' } }, signal);
      expect(second.action).toMatchObject({ kind: 'deliver', text: expect.stringContaining('explicitly resumed') });
      const end = await rebound!.decide({ ...input, state: second.state, event: { kind: 'delivered', action_id: 'delivery:second', item_id: 'history:second' } }, signal);
      expect(end.action.kind).toBe('complete');
    } finally { rebound?.release(); }
  } finally { lease?.release(); }
});


it('exact recovery binds the original installed artifact without consulting a changed route', async () => {
  const f = await fixture();
  const original = await f.install(3);
  await f.route(3, original, { sessionId: 'recover' });
  const first = await f.prepare({ sessionId: 'recover' });
  const requiredBinding = first!.binding.artifact;
  const other = await f.install(3, 'review.other-policy');
  await f.route(3, other, { sessionId: 'recover' });
  const current = await f.prepare({ sessionId: 'recover' });
  expect(current!.binding.artifact.providerKey).toBe(other);
  const recovered = await f.prepare({ sessionId: 'recover', requiredBinding });
  expect(recovered!.binding.artifact).toEqual(requiredBinding);
  await expect(f.prepare({ sessionId: 'recover', requiredBinding: { ...requiredBinding, configurationIdentity: 'changed' } })).rejects.toThrow('policy_exact_binding_unavailable');
  await expect(f.prepare({ sessionId: 'recover', requiredBinding: { ...requiredBinding, artifactIntegrity: 'missing' } })).rejects.toThrow('policy_exact_binding_unavailable');
  expect((await first!.decide({ view: { run_id: 'original', state: 'runnable', history_count: 0, history_head_id: null, pending_tool_calls: 0, model_capabilities: [] }, event: { kind: 'started' }, state: null }, new AbortController().signal)).action.kind).toBe('complete');
  await f.runtime.setEnabled('review.policy-v3', false, (await f.runtime.state()).catalog.revision);
  expect(first!.revocationSignal.aborted).toBe(true);
  await expect(f.prepare({ sessionId: 'recover', requiredBinding })).rejects.toThrow('policy_exact_binding_unavailable');
  recovered!.release(); current!.release(); first!.release();
});


it('policy observation tracks the admitted routing scope and ignores unrelated project intent', async () => {
  const f = await fixture(); const selected = await f.install(3);
  await f.route(3, selected, { sessionId: 'observed' });
  const retained = await f.prepare({ sessionId: 'observed' });
  const controller = new AbortController(); let changes = 0;
  const close = f.prepare.observe({ sessionId: 'observed' }, () => { changes++; }, controller.signal);
  try {
    await expect.poll(() => changes).toBe(1);
    const other = await f.install(3, 'review.unrelated-policy');
    await f.route(3, other, { sessionId: 'another-session' });
    await new Promise(resolve => setImmediate(resolve));
    expect(changes).toBe(1);
    await f.route(3, other, { sessionId: 'observed' });
    await expect.poll(() => changes).toBe(2);
  } finally { close(); controller.abort(); retained!.release(); }
});


it('exact policy recovery selects the complete configuration among retained generations of one artifact', async () => {
  const services = new HostServiceRegistry('policy-config-review');
  const owner = (generation: number) => ({ entrypointId: 'host', extensionId: 'review.configured-policy', extensionVersion: '1', generation });
  const provision = (configuration: string) => [{ descriptor: { id: 'varin.agent.policy', version: 3, multiple: true },
    handler(method: string): JsonValue {
      if (method === 'describe') return { identity: { name: 'configured-policy', version: '1' }, configuration: { selection: configuration }, modelRoles: [], stateTransition: 'unsupported' };
      return { action: { kind: 'complete' }, state: configuration };
    } }];
  await services.replaceOwner(owner(1), provision('old'));
  // Real registry and preparer; supervisor identity is a fixture for two generations of one package.
  const runtime = { services,
    routing: { read: async () => ({ authoritative: true, document: { schemaVersion: 1, revision: 0, updatedAt: '2026-10-10T00:00:00Z', rules: [] } }) },
    prepareService: async () => services.bind('varin.agent.policy', 3),
    supervisor: { getRetainedArtifactIdentity: () => 'same-artifact', getActiveArtifactIdentity: () => 'same-artifact' },
  } as unknown as ApplicationExtensionRuntime;
  const prepare = createAgentPolicy(runtime);
  const old = (await prepare({ sessionId: 'thread:old-child' }))!;
  const replacement = services.prepareOwnerReplacement(owner(2), provision('new'));
  replacement.commit();
  const current = (await prepare({ sessionId: 'thread:new-child' }))!;
  try {
    expect(old.binding.artifact.configurationIdentity).not.toBe(current.binding.artifact.configurationIdentity);
    for (const original of [current, old]) {
      const restored = await prepare({ sessionId: 'thread:restored-child', requiredBinding: original.binding.artifact });
      try { expect(restored!.binding.artifact).toEqual(original.binding.artifact); }
      finally { restored?.release(); }
    }
    await expect(prepare({ sessionId: 'thread:restored-child', requiredBinding: { ...current.binding.artifact, configurationIdentity: 'unavailable' } })).rejects.toThrow('policy_exact_binding_unavailable');
  } finally { current.release(); old.release(); await replacement.finalize(); }
  await expect(prepare({ sessionId: 'thread:old-child', requiredBinding: old.binding.artifact })).rejects.toThrow('policy_exact_binding_unavailable');
});
