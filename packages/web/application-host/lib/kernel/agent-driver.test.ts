import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_AGENT_DRIVER_CAPABILITY, VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY } from '@varin/extension-contract';
import { AgentDriverBridge, createAgentDriver, type AgentDriverLease, type PrivateDriverResponse } from './agent-driver.js';
import { runDriverCall } from './run-driver-invocation.js';
import { leafHostComposition } from './host-composition.test-helper.js';
import type { DriverRunInput } from './protocol.generated.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const repository = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const input = (runId = 'run-a'): DriverRunInput => ({ runId, epoch: 2, mode: 'start', history: [], tools: [], models: [], checkpoint: null, receipts: [] });
const frame = (reference: string) => ({ v: 1, kind: 'agent-driver-run', kernelEpoch: 'epoch-a', id: 'request', runId: 'run-a',
  generation: 2, reference, instanceId: 'native-instance', input: input() });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-driver-owner-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '0.9.36',
    brokerScript: join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  cleanups.push(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  await runtime.start();
  const install = async () => {
    const id = 'review.run-driver', directory = join(root, 'package'); await mkdir(directory);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      capabilities: { host: [VARIN_AGENT_DRIVER_CAPABILITY] }, entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
      provides: { services: [{ id: 'varin.agent.driver', version: 1, multiple: true }] } }));
    await writeFile(join(directory, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'varin.agent.driver',version:1,multiple:true},{
      describe(){return {identity:{name:'real-driver',version:'1'},configuration:{purpose:'review'},modelRoles:[],recovery:'none',checkpointSchema:null}},
      async run(args,call){await call.capabilities.call('runtime.driver','deliver',{id:'result',text:args[0].runId});return {kind:'complete'}}
    })}}`);
    await runtime.installOrStage({ expectedRevision: (await runtime.state()).catalog.revision, source: { kind: 'local', display: id, specifier: directory } });
    await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.state()).catalog.revision,
      decisions: [{ realm: 'host', capability: VARIN_AGENT_DRIVER_CAPABILITY, granted: true }] });
    await runtime.setEnabled(id, true, (await runtime.state()).catalog.revision);
    return `${id}:host:varin.agent.driver@1`;
  };
  const route = async (providerKey: string) => runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.driver', version: 1, providerKeys: [providerKey], scope: { userId: 'default' }, allowFallback: false } });
  return { runtime, install, route, prepare: createAgentDriver(runtime), scope: { userId: 'default', threadId: 'thread-a' } };
}

test('installing one real driver does not select it; explicit scoped routing can return to native default', async () => {
  const f = await fixture();
  assert.equal(await f.prepare(f.scope), undefined);
  const key = await f.install();
  assert.equal(await f.prepare(f.scope), undefined);
  await f.route(key);
  const lease = await f.prepare(f.scope); assert.ok(lease);
  assert.equal(lease.binding.artifact.providerKey, key);
  assert.equal(lease.binding.artifact.recovery, 'none');
  lease.release();
  await f.route(VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY);
  assert.equal(await f.prepare(f.scope), undefined);
  await f.route('missing:host:varin.agent.driver@1');
  await assert.rejects(f.prepare(f.scope), /unavailable|not available/);
});

test('real broker callback receives only its live Run capability and revocation prevents original binding restore', async () => {
  const f = await fixture(), key = await f.install(); await f.route(key);
  const observed: unknown[] = [];
  f.runtime.capabilities.register(VARIN_AGENT_DRIVER_CAPABILITY, (method, params, context) => runDriverCall(context, async authority => {
    observed.push({ method, params, authority }); return { id: 'result', historyId: 'delivery' };
  }));
  const lease = await f.prepare(f.scope); assert.ok(lease);
  const artifact = structuredClone(lease.binding.artifact), returned = deferred<PrivateDriverResponse>();
  const bridge = new AgentDriverBridge(() => 'epoch-a', async response => { if (response.kind === 'agent-driver-response') returned.resolve(response); }, async () => {}, () => { throw new Error('unexpected transport failure'); });
  bridge.register('run-a', lease);
  assert.equal(bridge.consume(frame(lease.binding.reference)), true);
  assert.equal((await returned.promise).ok, true);
  assert.deepEqual(observed, [{ method: 'deliver', params: { id: 'result', text: 'run-a' },
    authority: { runId: 'run-a', kernelEpoch: 'epoch-a', instanceId: 'native-instance' } }]);
  bridge.release('run-a');
  await f.runtime.reviewCapabilities({ extensionId: 'review.run-driver', expectedRevision: (await f.runtime.state()).catalog.revision,
    decisions: [{ realm: 'host', capability: VARIN_AGENT_DRIVER_CAPABILITY, granted: false }] });
  await assert.rejects(f.prepare({ ...f.scope, requiredBinding: artifact }), /capability|grant|review/i);
});

function heldLease() {
  const entered = deferred<void>(), exit = deferred<void>(), releasedDone = deferred<void>(), revoked = new AbortController(); let released = false;
  const owner = { extensionId: 'review.held-driver', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'original', generation: 1 };
  const artifactIntegrity = `sha256-${'a'.repeat(64)}`;
  const lease: AgentDriverLease = { owner, revocationSignal: revoked.signal,
    binding: { reference: 'original-provider', artifact: { providerKey: 'review.held-driver:host:varin.agent.driver@1', extensionId: owner.extensionId,
      extensionVersion: owner.extensionVersion, serviceId: 'varin.agent.driver', serviceVersion: 1, artifactIntegrity,
      composition: leafHostComposition({ extensionId: owner.extensionId, extensionVersion: owner.extensionVersion, artifactIntegrity }), configurationIdentity: 'config', identity: { name: 'held', version: '1' },
      modelRoles: [], recovery: 'checkpoint', checkpointSchema: 'one' } },
    run: async () => { entered.resolve(); await exit.promise; return { kind: 'complete' }; },
    release: () => { released = true; releasedDone.resolve(); },
  };
  return { lease, entered, exit, revoked, releasedDone: releasedDone.promise, released: () => released };
}

test('revocation requests native cancellation immediately but final response and lease wait for actual callback exit', async () => {
  const f = heldLease(), cancelled: string[] = [], responses: PrivateDriverResponse[] = [], responded = deferred<void>();
  const bridge = new AgentDriverBridge(() => 'epoch-a', async response => { if (response.kind === 'agent-driver-response') { responses.push(response); responded.resolve(); } },
    async runId => { cancelled.push(runId); }, () => { throw new Error('unexpected transport failure'); });
  bridge.register('run-a', f.lease); bridge.consume(frame(f.lease.binding.reference)); await f.entered.promise;
  f.revoked.abort();
  assert.deepEqual(cancelled, ['run-a']); assert.equal(f.released(), false); assert.equal(responses.length, 0);
  f.exit.resolve(); await responded.promise; await f.releasedDone;
  assert.equal(responses[0]!.ok, false); assert.equal(responses[0]!.error?.code, 'run_driver_cancelled'); assert.equal(f.released(), true);
});

test('a new kernel epoch cannot resume the same Run over a still-running original Host callback', async () => {
  const f = heldLease(); let epoch = 'epoch-a'; const responses: PrivateDriverResponse[] = [];
  const bridge = new AgentDriverBridge(() => epoch, async response => { if (response.kind === 'agent-driver-response') responses.push(response); }, async () => {}, () => {});
  bridge.register('run-a', f.lease); bridge.consume(frame(f.lease.binding.reference)); await f.entered.promise;
  bridge.close(); epoch = 'epoch-b';
  const next = heldLease(); assert.throws(() => bridge.register('run-a', next.lease), /original_callback_not_stopped/);
  assert.equal(f.released(), false); f.exit.resolve();
  await f.releasedDone;
  assert.equal(f.released(), true); assert.equal(responses.length, 0, 'an old epoch never sends completion to the new kernel');
  bridge.register('run-a', next.lease); bridge.close(); assert.equal(next.released(), true);
});
