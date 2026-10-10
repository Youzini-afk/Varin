import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokeredHostSupervisor } from '../src/broker-supervisor.js';
import { HostServiceRegistry } from '../src/service-registry.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const entry = (id: string, requires: string[] = [], service = id) => ({
  manifest: { schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' }, entrypoints: { host: { mode: 'brokered', file: 'host.cjs' } }, provides: { services: [{ id: service, version: 1 }] }, requires: { services: requires.map(id => ({ id, version: 1, binding: 'single' })) } },
  integrity: `${id}-v1`, selectedVersion: '1.0.0', desired: { enabled: true, revision: 1 }, capabilityGrants: [], actual: [],
});
const tick = () => new Promise<void>(r => setImmediate(r));
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Operation blocked by unrelated lifecycle')), 1000); })]); }
  finally { clearTimeout(timer!); }
};
function harness(entries: ReturnType<typeof entry>[]) {
  const snapshot: any = { hostId: 'test-host', authoritative: true, revision: 1, extensions: entries };
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const disposal = new Map<string, ReturnType<typeof deferred>>();
  const entered = new Map<string, ReturnType<typeof deferred>>();
  const counts = new Map<string, number>();
  const services = new HostServiceRegistry('test-host');
  const selectEntered = deferred();
  let selectGate: ReturnType<typeof deferred> | undefined;
  const supervisor = new BrokeredHostSupervisor({
    brokerScript: '', capabilities: {} as any, services,
    catalog: { snapshot: async () => structuredClone(snapshot), reportActualState: async () => {} } as any,
    packages: {
      resolveBrokeredHostEntrypoint: async () => ({ modulePath: '/unused', packageRoot: '/unused' }),
      selectCandidate: async ({extensionId}: any) => { selectEntered.resolve(); await selectGate?.promise; const e = snapshot.extensions.find((x: any) => x.manifest.id === extensionId); e.integrity = e.candidate.integrity; e.manifest = e.candidate.manifest; delete e.candidate; return structuredClone(snapshot); },
    } as any,
    storage: { read: async () => ({ document: { schemaVersion: 1, revision: 0, data: {} } }), prepareMigration: async () => null } as any,
    transportFactory: ({owner}) => ({
      forceTerminate() {},
      terminate: async () => { await disposal.get(owner.extensionId)?.promise; },
      request: async (method, _params, signal) => {
        if (method !== 'activate') return owner.extensionId;
        counts.set(owner.extensionId, (counts.get(owner.extensionId) ?? 0) + 1);
        entered.get(owner.extensionId)?.resolve();
        const gate = gates.get(owner.extensionId);
        if (gate) await Promise.race([gate.promise, new Promise<never>((_, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); })]);
        return { provisions: entries.find(e => e.manifest.id === owner.extensionId)!.manifest.provides.services };
      },
    }),
  });
  return { supervisor, services, snapshot, gates, disposal, entered, counts, selectEntered, blockSelection: () => selectGate = deferred() };
}

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
});

test('disable and shutdown during activation cannot publish a stale generation', async () => {
  for (const shutdown of [false, true]) {
    const h = harness([entry('dev.test.a')]); const gate = deferred(); h.gates.set('dev.test.a', gate); const entered = deferred(); h.entered.set('dev.test.a', entered);
    const activating = h.supervisor.activateExtension('dev.test.a'); const rejected = assert.rejects(activating, /cancel|shutting/); await entered.promise;
    const stopping = shutdown ? h.supervisor.shutdown() : h.supervisor.deactivateExtension('dev.test.a');
    await bounded(Promise.all([rejected, stopping])); gate.resolve(); assert.deepEqual(h.supervisor.activeExtensions(), []); assert.deepEqual(h.services.getSnapshot().providers, []);
    await h.supervisor.shutdown();
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

const owner = (id: string, generation = 1) => ({ extensionId: id, entrypointId: 'host', generation, extensionVersion: `${generation}.0.0` });
const provision = (id: string, multiple = false) => ({ descriptor: { id, version: 1, multiple }, handler: () => id });
test('exclusive publication reservation blocks a racing owner and rollback releases only its reservation', async () => {
  const services = new HostServiceRegistry('test');
  const a = services.prepareOwnerReplacement(owner('dev.test.a'), [provision('dev.test.shared')]);
  assert.throws(() => services.prepareOwnerReplacement(owner('dev.test.b'), [provision('dev.test.shared')]), /exclusive/);
  await a.rollback();
  await services.replaceOwner(owner('dev.test.b'), [provision('dev.test.shared')]);
  assert.equal(services.getSnapshot().providers.length, 1);
});

test('failed owner replacement rollback preserves another owners concurrent selection changes', async () => {
  const services = new HostServiceRegistry('test');
  await services.replaceOwner(owner('dev.test.a'), [provision('dev.test.one', true)]);
  await services.replaceOwner(owner('dev.test.b'), [provision('dev.test.two', true)]);
  await services.replaceOwner(owner('dev.test.c'), [provision('dev.test.two', true)]);
  const find = (id: string) => services.getSnapshot().providers.find(p => p.extensionId === id)!.providerId;
  services.setSelection('dev.test.one', 1, find('dev.test.a'));
  services.setSelection('dev.test.two', 1, find('dev.test.b'));
  const replacement = services.prepareOwnerReplacement(owner('dev.test.a', 2), [provision('dev.test.one', true)]);
  replacement.commit(); services.setSelection('dev.test.two', 1, find('dev.test.c')); await replacement.rollback();
  assert.equal(services.getSnapshot().selections['dev.test.two@1'], find('dev.test.c'));
  assert.equal(services.getSnapshot().selections['dev.test.one@1'], find('dev.test.a'));
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
    const reinstalling = runtime.installOrStage({source,expectedRevision:(await runtime.catalog.snapshot()).revision});
    try {
      await bounded((async () => { while (!(await runtime.catalog.snapshot()).extensions.some(e => e.manifest.id === id)) await tick(); })());
    } finally { cleanup.resolve(); }
    await bounded(Promise.all([removing,reinstalling]));
    assert.ok(runtime.supervisor.activeExtensions().includes(id), 'new installed owner was cancelled by old removal snapshot');
  } finally { cleanup.resolve(); await runtime.stop(); await rm(root,{recursive:true,force:true}); }
});
