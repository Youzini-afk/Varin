import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parseVarinRuntimeContractResult, type VarinExtensionServiceProvision, type VarinRuntimeContractRequest,
} from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';

const serviceId = 'example.contract';
const declaration = (): VarinExtensionServiceProvision => ({
  id: serviceId, version: 1, multiple: true,
  contract: { participation: 'provider', methods: {
    read: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: { type: 'string' }, source: { path: 'host.cjs' } },
  }, events: { changed: { schema: { type: 'object', required: ['revision'], properties: { revision: { type: 'integer' } } } } } },
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-contracts-'));
  const descriptors = new Map<string, VarinExtensionServiceProvision>();
  const returned = new Map<string, VarinExtensionServiceProvision[]>();
  let activations = 0, calls = 0;
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3', brokerScript: '',
    transportFactory: ({ owner }) => ({
      forceTerminate() {}, terminate: async () => {},
      request: async method => {
        if (method === 'activate') { activations++; return { provisions: returned.get(owner.extensionId) ?? [descriptors.get(owner.extensionId)] }; }
        calls++; return 'actual result';
      },
    }),
  });
  await runtime.start();
  const install = async (id: string, descriptor = declaration()) => {
    descriptors.set(id, descriptor);
    const directory = join(root, id); await mkdir(directory);
    await writeFile(join(directory, 'host.cjs'), 'throw new Error("Queries must never load this source");');
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { activation: ['service-request'], file: 'host.cjs', mode: 'brokered' } }, provides: { services: [descriptor] } }));
    await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision,
      source: { kind: 'local', display: id, specifier: directory } });
  };
  const query = async (request: VarinRuntimeContractRequest, projectId?: string) => parseVarinRuntimeContractResult(await runtime.queryContracts(request,
    projectId ? { routing: { projectId } } : {}));
  return { root, runtime, descriptors, returned, install, query, counts: () => ({ activations, calls }),
    close: async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('cold service discovery shares scoped routing without migration, activation or arbitrary inspect', async () => {
  const h = await fixture();
  try {
    await h.install('example.first'); await h.install('example.second');
    h.runtime.workbench.read = async () => { throw new Error('A metadata query must not run workbench migration'); };
    h.runtime.workbench.setWorkspaceScopeResolver(async () => { throw new Error('A metadata query must not resolve/migrate workspace paths'); });
    const request = { action: 'describe', kind: 'service', serviceId, version: 1, member: { kind: 'method', name: 'read' } } as const;
    const ambiguous = await h.query(request);
    assert.equal(ambiguous.action === 'describe' && ambiguous.status, 'unresolved');
    const current = await h.runtime.routing.read();
    await h.runtime.routing.upsertRule({ expectedRevision: current.document.revision,
      rule: { serviceId, version: 1, scope: { projectId: 'selected-project' }, providerKey: 'example.second:host:example.contract@1', allowFallback: false } });
    h.runtime.storage.update = async () => { throw new Error('A metadata query must not persist configuration'); };
    const selected = await h.query(request, 'selected-project');
    assert.ok(selected.action === 'describe' && selected.kind === 'service');
    assert.equal(selected.status, 'found');
    assert.equal(selected.service?.selection.providerKey, 'example.second:host:example.contract@1');
    assert.equal(selected.service?.selection.providerId, undefined);
    assert.deepEqual(selected.member?.contract, h.descriptors.get('example.second')!.contract!.methods.read);
    assert.equal(selected.service?.implementations[0]?.registration, 'declared');
    assert.deepEqual(h.counts(), { activations: 0, calls: 0 });
    assert.equal(JSON.stringify(selected).includes('varin-contracts-'), false, 'Host paths never become source metadata');
    const inherited = await h.query({ ...request, extensionId: 'example.second', member: { kind: 'method', name: 'toString' } });
    assert.equal(inherited.action === 'describe' && inherited.status, 'missing');
    await assert.rejects(h.runtime.queryContracts({ ...request, runId: 'forged' }), /unknown field/);
  } finally { await h.close(); }
});

test('actual service preparation and its exact method query share the original declaration and generation', async () => {
  const h = await fixture();
  try {
    await h.install('example.first');
    const binding = await h.runtime.prepareService({ serviceId, version: 1, method: 'read', args: [] });
    assert.equal(await binding.invoke('read', []), 'actual result');
    const result = await h.query({ action: 'describe', kind: 'service', serviceId, version: 1,
      member: { kind: 'event', name: 'changed' } });
    assert.ok(result.action === 'describe' && result.kind === 'service');
    assert.equal(result.status, 'found');
    assert.equal(result.service?.selection.providerId, binding.providerId);
    assert.deepEqual(result.member?.contract, h.descriptors.get('example.first')!.contract!.events!.changed);
    assert.deepEqual(h.counts(), { activations: 1, calls: 1 });
    const pin = binding.pin();
    const original = h.runtime.services.getSnapshot().providers.find(provider => provider.providerId === binding.providerId)!;
    const replacement = h.runtime.services.prepareOwnerReplacement({ ...original, generation: original.generation + 1 }, [{
      descriptor: declaration(), handler: () => 'replacement',
    }]);
    replacement.commit();
    const draining = await h.query({ action: 'describe', kind: 'service', serviceId, version: 1 });
    assert.ok(draining.action === 'describe' && draining.kind === 'service');
    assert.equal(draining.service?.instances.find(instance => instance.providerId === binding.providerId)?.status, 'draining');
    assert.equal(await pin.invoke('read', []), 'actual result');
    pin.release(); await replacement.finalize();
  } finally { await h.close(); }
});

test('undeclared metadata, disabled declarations and failed activation stay distinct without executing query callbacks', async () => {
  const h = await fixture();
  try {
    await h.install('example.undeclared', { id: 'example.opaque', version: 1 });
    const absent = await h.query({ action: 'describe', kind: 'service', serviceId: 'example.opaque', version: 1,
      member: { kind: 'method', name: 'read' } });
    assert.equal(absent.action === 'describe' && absent.status, 'undeclared');
    await h.install('example.broken');
    h.returned.set('example.broken', [{ ...declaration(), contract: { methods: {} } }]);
    await assert.rejects(h.runtime.prepareService({ serviceId, version: 1, method: 'read', args: [] }), /differs from manifest/);
    const failed = await h.query({ action: 'describe', kind: 'service', serviceId, version: 1, extensionId: 'example.broken' });
    assert.ok(failed.action === 'describe' && failed.kind === 'service');
    assert.ok(failed.service?.implementations[0]?.actual.some(actual => actual.status === 'failed'));
    assert.equal(failed.service?.instances.length, 0);
    await h.runtime.catalog.setEnabled('example.broken', false, (await h.runtime.catalog.snapshot()).revision);
    const disabled = await h.query({ action: 'describe', kind: 'service', serviceId, version: 1, extensionId: 'example.broken',
      member: { kind: 'method', name: 'read' } });
    assert.ok(disabled.action === 'describe' && disabled.kind === 'service');
    assert.equal(disabled.status, 'found');
    assert.equal(disabled.service?.implementations[0]?.enabled, false);
    assert.equal(disabled.service?.selection.status, 'unavailable');
    assert.deepEqual(h.counts(), { activations: 1, calls: 0 });
  } finally { await h.close(); }
});

test('same-version candidate publication never labels the old descriptor as the current contract', async () => {
  const h = await fixture();
  let markPublished!: () => void;
  let release!: () => void;
  const published = new Promise<void>(resolve => { markPublished = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let selecting: Promise<unknown> | undefined;
  try {
    const id = 'example.revision';
    await h.install(id);
    const binding = await h.runtime.prepareService({ serviceId, version: 1, method: 'read', args: [] });
    const snapshot = await h.runtime.catalog.snapshot();
    const file = join(h.root, id, 'varin.extension.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const next = declaration();
    next.contract!.methods.read!.outputSchema = { type: 'number' };
    manifest.provides.services = [next];
    await writeFile(file, JSON.stringify(manifest));
    h.descriptors.set(id, next);
    const staged = await h.runtime.reloadLocalSource({ extensionId: id, expectedRevision: snapshot.revision });
    assert.equal(staged.outcome, 'staged');
    const candidate = staged.snapshot.extensions.find(entry => entry.manifest.id === id)!.candidate!;
    const requested = await h.runtime.requestCandidateApplication({ extensionId: id, candidateIntegrity: candidate.integrity,
      expectedRevision: staged.snapshot.revision });
    const originalSelect = h.runtime.packages.selectCandidate.bind(h.runtime.packages);
    h.runtime.packages.selectCandidate = async request => {
      const result = await originalSelect(request);
      markPublished();
      await gate;
      return result;
    };
    selecting = h.runtime.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity,
      expectedRevision: requested.revision });
    await Promise.race([published, selecting.then(() => { throw new Error('Publication gate was not reached'); })]);
    const request = { action: 'describe', kind: 'service', serviceId, version: 1,
      member: { kind: 'method', name: 'read' } } as const;
    const during = await h.query(request);
    assert.ok(during.action === 'describe' && during.kind === 'service');
    assert.equal(during.service?.implementations[0]?.registration, 'declared');
    assert.equal(during.service?.selection.providerId, undefined);
    assert.deepEqual(during.member?.contract, next.contract!.methods.read);
    h.runtime.services.setSelection(serviceId, 1, binding.providerId);
    const explicit = await h.query(request);
    assert.ok(explicit.action === 'describe' && explicit.kind === 'service');
    assert.equal(explicit.status, 'unresolved');
    assert.equal(explicit.service?.selection.status, 'stale');
    assert.equal(explicit.service?.instances[0]?.providerId, binding.providerId);
    assert.equal(await binding.invoke('read', []), 'actual result');
    release();
    await selecting;
    const ready = await h.query(request);
    assert.ok(ready.action === 'describe' && ready.kind === 'service');
    assert.equal(ready.status, 'found');
    assert.equal(ready.service?.implementations[0]?.registration, 'registered');
    assert.notEqual(ready.service?.selection.providerId, binding.providerId);
  } finally { release(); await selecting?.catch(() => undefined); await h.close(); }
});

for (const mode of ['brokered', 'native'] as const) {
  test(`${mode} registration checks declared methods with the same lookup as actual invocation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'varin-contract-methods-'));
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3',
      brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
    try {
      await runtime.start();
      for (const supported of [true, false]) {
        const id = supported ? 'example.inherited' : 'example.missing';
        const directory = join(root, id); await mkdir(directory);
        const descriptor = declaration();
        await writeFile(join(directory, 'host.cjs'), `module.exports = { activate(context) {
          class Handler { ${supported ? "read() { return 'inherited method'; }" : ''} }
          context.services.provide(${JSON.stringify(descriptor)}, new Handler());
        } };`);
        await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
          entrypoints: { host: { activation: ['service-request'], file: 'host.cjs', mode } }, provides: { services: [descriptor] } }));
        await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision,
          source: { kind: 'local', display: id, specifier: directory } });
        if (supported) {
          await runtime.activateExtension(id);
          const provider = runtime.services.getSnapshot().providers.find(provider => provider.extensionId === id)!;
          assert.equal(await runtime.services.bind(serviceId, 1, provider.providerId).invoke('read', []), 'inherited method');
        } else {
          await assert.rejects(runtime.activateExtension(id), /declared method is unavailable/);
          assert.equal(runtime.services.getSnapshot().providers.some(provider => provider.extensionId === id), false);
        }
      }
    } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
  });
}
