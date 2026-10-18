import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultVarinExtensionServiceRoutingDocument, type VarinExtensionCapabilityGrant,
  type VarinExtensionHostEntrypoint, type VarinExtensionManifest, type VarinExtensionServiceProvision } from '@varin/extension-contract';
import { BrokeredHostSupervisor, type BrokeredHostSupervisorOptions } from '../src/broker-supervisor.js';
import { HostCapabilityRegistry } from '../src/capability-registry.js';
import { HostServiceRegistry } from '../src/service-registry.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
/** Only the Catalog facts consumed by this lifecycle harness are controlled. */
interface LifecycleEntry {
  manifest: VarinExtensionManifest & { entrypoints: { host: VarinExtensionHostEntrypoint }; provides: { services: VarinExtensionServiceProvision[] } };
  integrity: string;
  selectedVersion: string;
  desired: { enabled: boolean; revision: number };
  capabilityGrants: Array<Pick<VarinExtensionCapabilityGrant, 'capability' | 'realm' | 'granted' | 'manifestVersion'>>;
  actual: [];
  candidate?: { integrity: string; resolvedVersion: string; capabilitiesReviewed: boolean;
    capabilityGrants: LifecycleEntry['capabilityGrants']; manifest: LifecycleEntry['manifest']; applyRequested?: boolean };
}
const entry = (id: string, requires: string[] = [], service = id): LifecycleEntry => ({
  manifest: { schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' }, entrypoints: { host: { mode: 'brokered', file: 'host.cjs' } }, provides: { services: [{ id: service, version: 1 }] }, requires: { services: requires.map(id => ({ id, realms: ['host'], version: 1, binding: 'single' })) } },
  integrity: `${id}-v1`, selectedVersion: '1.0.0', desired: { enabled: true, revision: 1 }, capabilityGrants: [], actual: [],
});
const pin = (services: HostServiceRegistry, id: string) => { const binding = services.bind(id, 1); try { return binding.pin(); } finally { binding.release(); } };
const tick = () => new Promise<void>(r => setImmediate(r));
const bounded = async <T>(promise: Promise<T>, timeout = 1000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Operation blocked by unrelated lifecycle')), timeout); })]); }
  finally { clearTimeout(timer!); }
};
function harness(entries: [LifecycleEntry, ...LifecycleEntry[]]) {
  const snapshot = { hostId: 'test-host', authoritative: true, revision: 1, extensions: entries };
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const disposal = new Map<string, ReturnType<typeof deferred>>();
  const entered = new Map<string, ReturnType<typeof deferred>>();
  const counts = new Map<string, number>();
  const callGates = new Map<number, ReturnType<typeof deferred>>();
  const callEntered = new Map<number, ReturnType<typeof deferred>>();
  const ownerDisposal = new Map<number, ReturnType<typeof deferred>>();
  const disposed: number[] = [], forced: number[] = [];
  const services = new HostServiceRegistry('test-host');
  const selectEntered = deferred();
  let selectGate: ReturnType<typeof deferred> | undefined;
  let afterSelection: (() => void) | undefined;
  const crashes = new Map<number, (error: Error) => void>();
  const supervisor = new BrokeredHostSupervisor({
    brokerScript: '', capabilities: new HostCapabilityRegistry(), services,
    routing: { read: async () => ({ authoritative: true, document: defaultVarinExtensionServiceRoutingDocument() }), assertCurrentRevision: (revision: number) => assert.equal(revision, 0) } as unknown as BrokeredHostSupervisorOptions['routing'],
    catalog: { snapshot: async () => structuredClone(snapshot), reportActualState: async () => {} } as unknown as BrokeredHostSupervisorOptions['catalog'],
    packages: {
      resolveBrokeredHostEntrypoint: async () => ({ modulePath: '/unused', packageRoot: '/unused' }),
      selectCandidate: async ({ extensionId }: { extensionId: string }, validateBeforeCommit?: () => void) => {
        selectEntered.resolve(); await selectGate?.promise; validateBeforeCommit?.();
        const selected = snapshot.extensions.find(value => value.manifest.id === extensionId);
        assert(selected?.candidate);
        selected.integrity = selected.candidate.integrity; selected.manifest = selected.candidate.manifest;
        delete selected.candidate; afterSelection?.(); return structuredClone(snapshot);
      },
    } as unknown as BrokeredHostSupervisorOptions['packages'],
    storage: { read: async () => ({ document: { schemaVersion: 1, revision: 0, data: {} } }), prepareMigration: async () => null } as unknown as BrokeredHostSupervisorOptions['storage'],
    transportFactory: ({owner, onCrash}) => { crashes.set(owner.generation, onCrash); return {
      forceTerminate() { forced.push(owner.generation); },
      terminate: async () => { await disposal.get(owner.extensionId)?.promise; await ownerDisposal.get(owner.generation)?.promise; disposed.push(owner.generation); },
      request: async (method, _params, signal) => {
        if (method !== 'activate') { callEntered.get(owner.generation)?.resolve(); await callGates.get(owner.generation)?.promise; return owner.generation; }
        counts.set(owner.extensionId, (counts.get(owner.extensionId) ?? 0) + 1);
        entered.get(owner.extensionId)?.resolve();
        const gate = gates.get(owner.extensionId);
        if (gate) await Promise.race([gate.promise, new Promise<never>((_, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); })]);
        return { provisions: entries.find(e => e.manifest.id === owner.extensionId)!.manifest.provides.services };
      },
    }; },
  });
  return { supervisor, services, snapshot, gates, disposal, entered, counts, callGates, callEntered, ownerDisposal, disposed, forced,
    selectEntered, crashes, afterSelection: (callback: () => void) => { afterSelection = callback; }, blockSelection: () => selectGate = deferred() };
}

test('publication returns with old model pins retained; retirement and explicit teardown wait for callbacks and transport disposal', async () => {
  for (const path of ['candidate', 'selected']) for (const teardown of ['release', 'disable', 'shutdown']) {
    const id = 'dev.test.retirement', h = harness([entry(id)]);
    await h.supervisor.activateExtension(id);
    const old = pin(h.services, id);
    const selected = h.snapshot.extensions[0];
    if (path === 'candidate') {
      selected.candidate = { integrity: 'v2', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
        capabilityGrants: [], manifest: structuredClone(selected.manifest) };
      await bounded(h.supervisor.selectCandidate(id, 'v2', 1));
    } else {
      selected.integrity = 'v2';
      await bounded(h.supervisor.activateExtension(id));
    }
    let current = pin(h.services, id), generation = 2;
    assert.equal(await old.invoke('read', []), 1);
    assert.equal(await current.invoke('read', []), 2);
    assert.equal(h.disposed.length, 0);
    if (teardown === 'release') {
      current.release();
      if (path === 'candidate') {
        selected.candidate = { integrity: 'v3', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
          capabilityGrants: [], manifest: structuredClone(selected.manifest) };
        await bounded(h.supervisor.selectCandidate(id, 'v3', 1));
      } else {
        selected.integrity = 'v3'; await bounded(h.supervisor.activateExtension(id));
      }
      generation = 3; current = pin(h.services, id);
      await bounded((async () => { while (!h.disposed.includes(2)) await tick(); })());
      assert.equal(h.disposed.includes(1), false, 'A remains owned by its original pin');
      assert.equal(await old.invoke('read', []), 1);
    }

    const callback = deferred(), entered = deferred(), disposal = deferred();
    h.callGates.set(1, callback); h.callEntered.set(1, entered); h.ownerDisposal.set(1, disposal);
    const pending = old.invoke('hold', []); await entered.promise;
    old.release(); await tick();
    assert.equal(h.disposed.includes(1), false, 'releasing the model pin did not end its real callback');
    let ended = false;
    const stopping = teardown === 'release' ? undefined
      : (teardown === 'disable' ? h.supervisor.deactivateExtension(id) : h.supervisor.shutdown()).then(() => { ended = true; });
    await tick();
    if (stopping) { assert.equal(ended, false); assert.ok(h.forced.includes(1)); assert.equal(current.revocationSignal.aborted, true); }
    callback.resolve(); assert.equal(await pending, 1); await tick();
    assert.equal(h.disposed.includes(1), false, 'callback completion did not finish blocked transport cleanup');
    if (stopping) assert.equal(ended, false);
    disposal.resolve();
    if (stopping) await bounded(stopping);
    else {
      await bounded((async () => { while (!h.disposed.includes(1)) await tick(); })());
      assert.equal(await current.invoke('read', []), generation); current.release();
    }
    await h.supervisor.shutdown();
    assert.deepEqual(h.disposed.sort(), generation === 3 ? [1, 2, 3] : [1, 2]); assert.deepEqual(h.services.getSnapshot().providers, []);
  }
});

test('independent activation and disposal do not wait for a blocked owner', async () => {
  const h = harness([entry('dev.test.a'), entry('dev.test.b')]);
  const gate = deferred(); h.gates.set('dev.test.a', gate); const entered = deferred(); h.entered.set('dev.test.a', entered);
  const a = h.supervisor.activateExtension('dev.test.a'); await entered.promise;
  await bounded(h.supervisor.activateExtension('dev.test.b')); assert.deepEqual(h.supervisor.activeExtensions(), ['dev.test.b']);
  gate.resolve(); await a;
  const dispose = deferred(); h.disposal.set('dev.test.a', dispose); const stopA = h.supervisor.deactivateExtension('dev.test.a'); await tick();
  await bounded(h.supervisor.deactivateExtension('dev.test.b')); await bounded(h.supervisor.activateExtension('dev.test.b'));
  dispose.resolve(); await stopA; await h.supervisor.shutdown();
});

test('concurrent consumers prepare their shared dependency once and cycles reject without deadlock', async () => {
  const h = harness([entry('dev.test.a', ['dev.test.c']), entry('dev.test.b', ['dev.test.c']), entry('dev.test.c')]);
  await bounded(Promise.all([h.supervisor.activateExtension('dev.test.a'), h.supervisor.activateExtension('dev.test.b')]));
  assert.equal(h.counts.get('dev.test.c'), 1); await h.supervisor.shutdown();
  const cyclic = harness([entry('dev.test.a', ['dev.test.b']), entry('dev.test.b', ['dev.test.a'])]);
  const results = await bounded(Promise.allSettled([cyclic.supervisor.activateExtension('dev.test.a'), cyclic.supervisor.activateExtension('dev.test.b')]));
  assert.ok(results.every(x => x.status === 'rejected' && /cycle/.test(String(x.reason))));
  await cyclic.supervisor.shutdown();
  const joined = harness([entry('dev.test.joined')]), controller = new AbortController();
  const ready = deferred(), gate = deferred(); joined.entered.set('dev.test.joined', ready); joined.gates.set('dev.test.joined', gate);
  const first = joined.supervisor.prepareExtension('dev.test.joined', {}, controller.signal);
  const cancelled = assert.rejects(first, /cancelled/); await ready.promise;
  const second = joined.supervisor.prepareExtension('dev.test.joined'); await tick();
  controller.abort(new Error('first consumer cancelled')); await cancelled; gate.resolve();
  const lease = await second, binding = lease.bind('dev.test.joined', 1);
  try { assert.equal(await binding.invoke('read', []), 1); assert.equal(joined.counts.get('dev.test.joined'), 1); }
  finally { binding.release(); lease.release(); await joined.supervisor.shutdown(); }
});

test('disable and shutdown during activation cannot publish a stale generation', async () => {
  for (const shutdown of [false, true]) {
    const h = harness([entry('dev.test.a')]); const gate = deferred(); h.gates.set('dev.test.a', gate); const entered = deferred(); h.entered.set('dev.test.a', entered);
    const activating = h.supervisor.activateExtension('dev.test.a'); const rejected = assert.rejects(activating, /cancel|shutting|revoked/); await entered.promise;
    const stopping = shutdown ? h.supervisor.shutdown() : h.supervisor.deactivateExtension('dev.test.a');
    await bounded(Promise.all([rejected, stopping])); gate.resolve(); assert.deepEqual(h.supervisor.activeExtensions(), []); assert.deepEqual(h.services.getSnapshot().providers, []);
    await h.supervisor.shutdown();
  }
});

test('disable and grant revocation detach a pending dependent while another root keeps the shared dependency', async () => {
  for (const change of ['disable', 'grant']) {
    const h = harness([entry('dev.test.a', ['dev.test.b']), entry('dev.test.b')]);
    for (const extension of h.snapshot.extensions) extension.manifest.entrypoints.host.activation = ['service-request'];
    const a = h.snapshot.extensions[0];
    a.capabilityGrants = [{ capability: 'example.reviewed', realm: 'host', granted: true, manifestVersion: '1.0.0' }];
    const gate = deferred(), entered = deferred(); h.gates.set('dev.test.b', gate); h.entered.set('dev.test.b', entered);
    const dependent = h.supervisor.prepareExtension('dev.test.a');
    const rejected = assert.rejects(dependent, /revoked/); await entered.promise;
    const independent = h.supervisor.prepareExtension('dev.test.b'); await tick();
    try {
      if (change === 'disable') a.desired.enabled = false;
      else a.capabilityGrants[0]!.granted = false;
      a.desired.revision += 1;
      await bounded(h.supervisor.reconcile());
      await bounded(rejected);
      assert.equal(h.counts.has('dev.test.a'), false, 'A cancels before it starts a transport');
      assert.deepEqual(h.forced, [], 'A cancellation must not abort the shared B preparation');
      gate.resolve();
      const lease = await bounded(independent), binding = lease.bind('dev.test.b', 1);
      try { assert.equal(await binding.invoke('read', []), 1); assert.equal(h.counts.get('dev.test.b'), 1); }
      finally { binding.release(); lease.release(); }
    } finally { gate.resolve(); await Promise.allSettled([dependent, independent]); await h.supervisor.shutdown(); }
  }
});

test('shutdown during candidate catalog commit cannot publish the aborted generation', async () => {
  const h = harness([entry('dev.test.a')]);
  h.snapshot.extensions[0].candidate = { integrity: 'v2', resolvedVersion: '2.0.0', capabilitiesReviewed: true, capabilityGrants: [], manifest: { ...h.snapshot.extensions[0].manifest, version: '2.0.0' } };
  const gate = h.blockSelection();
  const selecting = h.supervisor.selectCandidate('dev.test.a', 'v2', 1);
  await h.selectEntered.promise;
  let published = false; h.services.subscribe(() => { if (h.services.getSnapshot().providers.some(p => p.status === 'active')) published = true; });
  const stopping = h.supervisor.shutdown(); gate.resolve();
  await Promise.allSettled([selecting, stopping]);
  assert.equal(published, false, 'aborted candidate was published after shutdown began');
});

test('optional prepared cleanup and a cancelled second selector cannot revoke an independent selection in commit', async () => {
  const id = 'dev.test.shared-selection', h = harness([entry(id)]);
  await h.supervisor.activateExtension(id);
  h.snapshot.extensions[0].candidate = { integrity: 'v2', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
    capabilityGrants: [], manifest: structuredClone(h.snapshot.extensions[0].manifest) };
  const gate = h.blockSelection(), controller = new AbortController();
  const selecting = h.supervisor.selectCandidate(id, 'v2', 1);
  await h.selectEntered.promise;
  const other = h.supervisor.selectCandidate(id, 'v2', 1, controller.signal);
  const cancelled = assert.rejects(other);
  await tick(); controller.abort();
  const cleanup = h.supervisor.discardPreparedCandidate(id, 'v2');
  await tick(); assert.equal(h.forced.includes(2), false);
  gate.resolve();
  const selected = await bounded(selecting); await bounded(Promise.all([cancelled, cleanup]));
  assert.equal(selected.extensions[0]!.integrity, 'v2');
  assert.equal(await h.services.invoke({ serviceId: id, version: 1, method: 'read', args: [] }), 2);
  assert.equal(h.forced.includes(2), false);
  await h.supervisor.shutdown();
});

const owner = (id: string, generation = 1) => ({ instanceKey: id, extensionId: id, entrypointId: 'host', generation, extensionVersion: `${generation}.0.0` });
const provision = (id: string, multiple = false) => ({ descriptor: { id, version: 1, multiple }, handler: () => id });
test('exclusive publication reservation blocks a racing owner and rollback releases only its reservation', async () => {
  const services = new HostServiceRegistry('test');
  const a = services.prepareOwnerReplacement(owner('dev.test.a'), [provision('dev.test.shared')]);
  assert.throws(() => services.prepareOwnerReplacement(owner('dev.test.b'), [provision('dev.test.shared')]), /exclusive/);
  await a.rollback();
  await services.replaceOwner(owner('dev.test.b'), [provision('dev.test.shared')]);
  assert.equal(services.getSnapshot().providers.length, 1);
});

test('failed owner replacement rollback preserves another owners concurrent providers', async () => {
  const services = new HostServiceRegistry('test');
  await services.replaceOwner(owner('dev.test.a'), [provision('dev.test.one', true)]);
  await services.replaceOwner(owner('dev.test.b'), [provision('dev.test.two', true)]);
  const retained = services.getSnapshot().providers.find(p => p.extensionId === 'dev.test.b')!.providerId;
  const replacement = services.prepareOwnerReplacement(owner('dev.test.a', 2), [provision('dev.test.one', true)]);
  replacement.commit();
  await services.replaceOwner(owner('dev.test.c'), [provision('dev.test.two', true)]);
  await replacement.rollback();
  services.assertBinding('dev.test.two', 1, retained);
  assert.equal(services.getSnapshot().providers.filter(p => p.descriptor.id === 'dev.test.two').length, 2);
  assert.equal(await services.invoke({ serviceId: 'dev.test.one', version: 1, method: 'read', args: [] }), 'dev.test.one');
});

test('drain revokes calls immediately but retains ownership until the callback settles', async () => {
  const services = new HostServiceRegistry('test'); const entered = deferred(); const cancelled = deferred(); const settled = deferred();
  await services.replaceOwner(owner('dev.test.a'), [{ descriptor: { id: 'dev.test.one', version: 1 }, handler: async (_m, _a, {signal}) => {
    entered.resolve(); await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { cancelled.resolve(); resolve(); }, {once:true}); }); await settled.promise; return 'cancelled';
  } }]);
  const controller = new AbortController(); const call = services.invoke({serviceId: 'dev.test.one', version: 1, method: 'run', args: []}, controller.signal); await entered.promise;
  let drained = false; const drain = services.drainOwner(owner('dev.test.a')).then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  await assert.rejects(services.invoke({serviceId: 'dev.test.one', version: 1, method: 'run', args: []}), /unavailable/);
  await bounded(cancelled.promise); controller.abort(); settled.resolve(); assert.equal(await call, 'cancelled'); await drain; assert.equal(drained, true);
});

test('public runtime activation lets an unrelated extension become callable while another prepares', async () => {
  const { ApplicationExtensionRuntime } = await import('../src/application-runtime.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'varin-public-parallel-'));
  const gate = deferred(); const entered = deferred();
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3', brokerScript: '', transportFactory: ({owner}) => ({
    forceTerminate() { gate.resolve(); }, terminate: async () => {},
    request: async (method) => {
      if (method !== 'activate') return owner.extensionId;
      if (owner.extensionId === 'dev.test.a') { entered.resolve(); await gate.promise; }
      return { provisions: [{id: owner.extensionId, version: 1}] };
    },
  }) });
  try {
    let revision = (await runtime.start()).catalog.revision;
    for (const id of ['dev.test.a', 'dev.test.b']) {
      const path = join(root, id); await mkdir(path);
      await writeFile(join(path, 'varin.extension.json'), JSON.stringify({schemaVersion:1,id,version:'1.0.0',engines:{varin:'*'},entrypoints:{host:{mode:'brokered',file:'host.cjs',activation:['service-request']}},provides:{services:[{id,version:1}]}}));
      await writeFile(join(path, 'host.cjs'), 'module.exports = { activate() {} };');
      revision = (await runtime.installOrStage({source:{kind:'local',display:id,specifier:path},expectedRevision:revision})).revision;
    }
    const first = runtime.activateExtension('dev.test.a'); await entered.promise;
    try {
      await bounded(runtime.activateExtension('dev.test.b'));
      assert.equal(await bounded(runtime.invokeService({serviceId:'dev.test.b',version:1,method:'read',args:[]})), 'dev.test.b');
    } finally { gate.resolve(); await first; }
  } finally { gate.resolve(); await runtime.stop(); await rm(root, {recursive:true,force:true}); }
});

test('removal cleanup cannot cancel a concurrently reinstalled owner with its stale catalog snapshot', async () => {
  const { ApplicationExtensionRuntime } = await import('../src/application-runtime.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'varin-reinstall-parallel-')); const id = 'dev.test.reinstall';
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion:'1.2.3', brokerScript:'', transportFactory: () => ({
    forceTerminate() {}, terminate: async () => {}, request: async method => method === 'activate' ? {provisions:[{id,version:1}]} : id,
  }) });
  const cleanup = deferred(); const entered = deferred();
  try {
    const path = join(root, 'source'); await mkdir(path);
    await writeFile(join(path,'varin.extension.json'),JSON.stringify({schemaVersion:1,id,version:'1.0.0',engines:{varin:'*'},entrypoints:{host:{mode:'brokered',file:'host.cjs',activation:['application-startup']}},provides:{services:[{id,version:1}]}}));
    await writeFile(join(path,'host.cjs'),'module.exports={activate(){}};');
    const source = {kind:'local',display:id,specifier:path};
    let revision = (await runtime.start()).catalog.revision;
    revision = (await runtime.installOrStage({source,expectedRevision:revision})).revision;
    revision = (await runtime.setEnabled(id,false,revision)).revision;
    const originalDelete = runtime.storage.deleteExtensionData.bind(runtime.storage);
    runtime.storage.deleteExtensionData = async extensionId => { entered.resolve(); await cleanup.promise; await originalDelete(extensionId); };
    const removing = runtime.removeExtension({extensionId:id,deleteData:true,expectedRevision:revision}); await entered.promise;
    const reinstalling = runtime.installOrStage({source,expectedRevision:(await runtime.catalog.snapshot()).revision})
      .then(snapshot => runtime.setEnabled(id, true, snapshot.revision));
    try {
      // This path publishes real files and starts the replacement, unlike the
      // in-memory lifecycle gates above. It must finish while old cleanup waits.
      await bounded(reinstalling, 10_000);
    } finally { cleanup.resolve(); }
    await bounded(removing, 10_000);
    assert.ok(runtime.supervisor.activeExtensions().includes(id), 'new installed owner was cancelled by old removal snapshot');
  } finally { cleanup.resolve(); await runtime.stop(); await rm(root,{recursive:true,force:true}); }
});


test('explicit update group validates the original Host preparation without gating selected startup or unrelated owners', async () => {
  const id = 'dev.test.group', selected = entry(id), h = harness([selected, entry('dev.test.independent')]);
  const group = { surfaceEntrypoints: ['panel'] };
  Object.assign(selected.manifest, { updateReadiness: group, entrypoints: { ...selected.manifest.entrypoints,
    surfaces: [{ id: 'panel', mode: 'managed', file: 'panel.cjs', supports: ['web'] }] } });
  await h.supervisor.activateExtension(id);
  const old = pin(h.services, id);
  h.snapshot.extensions[0].candidate = { integrity: 'v2', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
    capabilityGrants: [], applyRequested: true, manifest: structuredClone(selected.manifest) };
  await assert.rejects(h.supervisor.selectCandidate(id, 'v2', 1), /compatible Surface/);
  await bounded(h.supervisor.activateExtension('dev.test.independent'));
  assert.equal(await old.invoke('read', []), 1);
  const prepared = await h.supervisor.prepareCandidate(id, 'v2');
  const readiness = { hostPreparation: prepared.hostPreparation!, realmId: 'participating-window', surface: 'web' as const,
    members: [{ entrypointId: 'panel', generation: 7 }] };
  for (const evidence of [
    { ...readiness, members: [] },
    { ...readiness, hostPreparation: { ...readiness.hostPreparation, id: 'stale' } },
    { ...readiness, surface: 'mobile' as const },
  ]) await assert.rejects(h.supervisor.selectCandidate(id, 'v2', 1, undefined, evidence), /does not match/);
  assert.equal(h.snapshot.extensions[0].integrity, `${id}-v1`);
  await h.supervisor.selectCandidate(id, 'v2', 1, undefined, readiness);
  assert.equal(await old.invoke('read', []), 1);
  assert.equal(await h.services.invoke({ serviceId: id, version: 1, method: 'read', args: [] }), 2);
  old.release(); await h.supervisor.shutdown();
});

test('required group withdrawal before the actual catalog commit preserves selection and can retry the shared preparation', async () => {
  const id = 'dev.test.group-cancel', h = harness([entry(id)]);
  await h.supervisor.activateExtension(id);
  h.snapshot.extensions[0].candidate = { integrity: 'v2', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
    capabilityGrants: [], applyRequested: true, manifest: { ...structuredClone(h.snapshot.extensions[0].manifest),
      updateReadiness: { surfaceEntrypoints: ['panel'] }, entrypoints: { host: { mode: 'brokered', file: 'host.cjs' },
        surfaces: [{ id: 'panel', mode: 'managed', file: 'panel.cjs', supports: ['web'] }] } } };
  const prepared = await h.supervisor.prepareCandidate(id, 'v2');
  const readiness = { hostPreparation: prepared.hostPreparation!, realmId: 'window', surface: 'web' as const,
    members: [{ entrypointId: 'panel', generation: 2 }] };
  const gate = h.blockSelection(), controller = new AbortController();
  const selecting = h.supervisor.selectCandidate(id, 'v2', 1, controller.signal, readiness);
  const rejected = assert.rejects(selecting, /closed/);
  await h.selectEntered.promise; controller.abort(new Error('Surface preparation closed')); gate.resolve(); await rejected;
  assert.equal(h.snapshot.extensions[0].integrity, `${id}-v1`);
  assert.equal(await h.services.invoke({ serviceId: id, version: 1, method: 'read', args: [] }), 1);
  // Loader failure cleanup must not withdraw another Surface's shared candidate.
  await h.supervisor.discardPreparedCandidate(id, 'v2');
  await h.supervisor.selectCandidate(id, 'v2', 1, undefined, readiness);
  assert.equal(h.snapshot.extensions[0].integrity, 'v2');
  await h.supervisor.shutdown();
});


test('after selection a disconnected Surface cannot roll back and a crashed candidate recovers selected while retaining old pins', async () => {
  for (const failure of ['disconnect', 'crash']) {
    const id = 'dev.test.group-postcommit', h = harness([entry(id)]);
    await h.supervisor.activateExtension(id);
    const old = pin(h.services, id);
    h.snapshot.extensions[0].candidate = { integrity: 'v2', resolvedVersion: '1.0.0', capabilitiesReviewed: true,
      capabilityGrants: [], applyRequested: true, manifest: { ...structuredClone(h.snapshot.extensions[0].manifest),
        updateReadiness: { surfaceEntrypoints: ['panel'] }, entrypoints: { host: { mode: 'brokered', file: 'host.cjs' },
          surfaces: [{ id: 'panel', mode: 'managed', file: 'panel.cjs', supports: ['web'] }] } } };
    const prepared = await h.supervisor.prepareCandidate(id, 'v2'), controller = new AbortController();
    const readiness = { hostPreparation: prepared.hostPreparation!, realmId: 'window', surface: 'web' as const,
      members: [{ entrypointId: 'panel', generation: 2 }] };
    h.afterSelection(() => failure === 'disconnect' ? controller.abort(new Error('response connection closed'))
      : h.crashes.get(2)!(new Error('candidate process exited after catalog commit')));
    const selecting = h.supervisor.selectCandidate(id, 'v2', 1, controller.signal, readiness);
    if (failure === 'disconnect') await selecting;
    else {
      await assert.rejects(selecting, /cancelled/);
      assert.equal(h.services.getSnapshot().providers.some(provider => provider.status === 'active'), false);
      await h.supervisor.activateExtension(id);
    }
    assert.equal(h.snapshot.extensions[0].integrity, 'v2');
    assert.equal(h.snapshot.extensions[0].candidate, undefined);
    assert.equal(old.revocationSignal.aborted, false, 'the old process did not crash or lose its accepted exchange');
    assert.equal(await old.invoke('read', []), 1);
    assert.equal(await h.services.invoke({ serviceId: id, version: 1, method: 'read', args: [] }), failure === 'disconnect' ? 2 : 3);
    old.release(); await h.supervisor.shutdown();
  }
});
