import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';
import type { HostServiceBinding } from '../src/service-registry.js';

async function fixture(mode: 'brokered' | 'native' = 'brokered', reviewedDependency = false, rootBinding: 'selected' | 'all' | 'none' = 'selected') {
  const directory = await mkdtemp(join(tmpdir(), 'varin-scoped-composition-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(directory, 'data'), varinVersion: '1.2.3',
    brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
  await runtime.start();
  runtime.capabilities.register('example.reviewed', () => null);
  const install = async (id: string, dependency = false) => {
    const path = join(directory, id); await mkdir(path);
    const service = dependency ? { id: 'example.dependency', version: 1, multiple: true } : { id: 'example.composed', version: 1 };
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await writeFile(join(path, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      ...(reviewedDependency && id === 'example.b' ? { capabilities: { host: ['example.reviewed'] } } : {}),
      entrypoints: { host: { mode, file: 'host.cjs', activation: ['service-request'] } }, provides: { services: [service] },
      ...(dependency || rootBinding === 'none' ? {} : { requires: { services: [{ realms: ['host'], id: 'example.dependency', version: 1, binding: rootBinding }, ...(rootBinding === 'all' ? [{ realms: ['host'], id: 'example.absent', version: 1, optional: true }] : [])] } }) }));
    await writeFile(join(path, 'host.cjs'), `const {randomUUID}=require('node:crypto'); module.exports={activate(ctx){
      const identity=randomUUID(); ${dependency || rootBinding === 'none' ? '' : rootBinding === 'all' ? "const dependency=ctx.services.useAll('example.dependency',1); const absent=ctx.services.use('example.absent',1,{optional:true});" : "const dependency=ctx.services.use('example.dependency',1);"}
      ctx.services.provide(${JSON.stringify(service)},{async read(){${reviewedDependency && id === 'example.b' ? "await ctx.capabilities.call('example.reviewed','read',null);" : ''}return ${dependency ? `{name:'${id}',identity}` : rootBinding === 'none' ? '{identity}' : rootBinding === 'all' ? '{identity,dependencies:await Promise.all(dependency.map(client=>client.call("read"))),optionalAbsent:absent===undefined}' : '{identity,dependency:await dependency.call("read")}'}}${mode === 'brokered' ? `,crash(){${dependency ? 'process.exit(31)' : rootBinding === 'selected' ? 'return dependency.call("crash")' : 'return null'}}` : ''}});
    }};`);
    const installed = await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision,
      source: { display: id, kind: 'local', specifier: path } });
    if (reviewedDependency && id === 'example.b') await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision, decisions: [{ capability: 'example.reviewed', realm: 'host', granted: true }] });
    const entry = installed.extensions.find(entry => entry.manifest.id === id)!;
    if (!entry.desired.enabled) await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
  };
  await install('example.b', true); await install('example.c', true); await install('example.a');
  const route = async (projectId: string, provider: string, allowFallback = false) => runtime.upsertServiceRoutingRule({
    expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { serviceId: 'example.dependency', version: 1, scope: { projectId }, providerKeys: [`${provider}:host:example.dependency@1`], allowFallback } });
  const prepare = (projectId: string, threadId: string) => runtime.prepareService({ serviceId: 'example.composed', version: 1,
    method: 'read', args: [], routing: { projectId, threadId } });
  return { runtime, route, prepare, directory, async close() { await runtime.stop(); await rm(directory, { recursive: true, force: true }); } };
}
for (const mode of ['brokered', 'native'] as const) test(`${mode}: activation captures scoped dependencies and identical graphs share`, { timeout: 30_000 }, async () => {
  const f = await fixture(mode); const leases: HostServiceBinding[] = [];
  try {
    await f.route('p', 'example.b'); await f.route('q', 'example.c');
    const [p, p2, q] = await Promise.all([f.prepare('p', 'one'), f.prepare('p', 'two'), f.prepare('q', 'three')]);
    leases.push(p, p2, q);
    assert.equal(p.providerId, p2.providerId, 'Thread identity cannot split the same composition');
    assert.notEqual(p.providerId, q.providerId, 'A captures different actual dependencies before activate');
    const values = await Promise.all(leases.map(lease => lease.invoke('read', []))) as Array<{ identity: string; dependency: { name: string; identity: string } }>;
    assert.equal(values[0]!.dependency.name, 'example.b'); assert.equal(values[2]!.dependency.name, 'example.c');
    assert.deepEqual(values[0], values[1]);
    assert.equal(f.runtime.services.getSnapshot().providers.filter(provider => provider.extensionId === 'example.a').length, 2,
      'ordinary single-provider declaration permits multiple legal instances of the same implementation');
    assert.equal(p.composition?.nodes.length, 2); assert.deepEqual(p.composition, p2.composition);
  } finally { leases.forEach(lease => lease.release()); await f.close(); }
});

test('selected dependency uses the original whole-rule allowFallback result', { timeout: 30_000 }, async () => {
  const f = await fixture(); let binding: HostServiceBinding | undefined;
  try {
    await f.runtime.setEnabled('example.c', false, (await f.runtime.catalog.snapshot()).revision);
    await f.route('p', 'example.missing', true);
    binding = await f.prepare('p', 'one');
    assert.equal((await binding.invoke('read', []) as { dependency: { name: string } }).dependency.name, 'example.b');
  } finally { binding?.release(); await f.close(); }
});

test('explicit grant revocation follows actual dependency edges and preserves the other A composition', { timeout: 30_000 }, async () => {
  const f = await fixture('brokered', true); const leases: HostServiceBinding[] = [];
  try {
    await f.route('p', 'example.b'); await f.route('q', 'example.c');
    const p = await f.prepare('p', 'one'), q = await f.prepare('q', 'two'); leases.push(p, q);
    const pPin = p.pin(), qPin = q.pin();
    try {
      const before = await qPin.invoke('read', []);
      await f.runtime.reviewCapabilities({ extensionId: 'example.b', expectedRevision: (await f.runtime.catalog.snapshot()).revision,
        decisions: [{ capability: 'example.reviewed', realm: 'host', granted: false }] });
      assert.equal(pPin.revocationSignal.aborted, true);
      await assert.rejects(pPin.invoke('read', []), /released|revoked|unavailable/);
      assert.equal(qPin.revocationSignal.aborted, false);
      assert.deepEqual(await qPin.invoke('read', []), before, 'revocation cannot sweep the same service or extension name across unrelated actual graphs');
    } finally { pPin.release(); qPin.release(); }
  } finally { leases.forEach(lease => lease.release()); await f.close(); }
});

for (const mode of ['brokered', 'native'] as const) test(`${mode}: all and optional dependencies are frozen before activate`, { timeout: 30_000 }, async () => {
  const f = await fixture(mode, false, 'all'); let binding: HostServiceBinding | undefined;
  try {
    binding = await f.prepare('p', 'one');
    const result = await binding.invoke('read', []) as { dependencies: Array<{ name: string }>; optionalAbsent: boolean };
    assert.deepEqual(result.dependencies.map((value) => value.name), ['example.b', 'example.c']);
    assert.equal(result.optionalAbsent, true);
    assert.equal(binding.composition?.nodes.length, 3);
    assert.deepEqual(binding.composition?.nodes.find(node => node.extensionId === 'example.a')?.dependencies.find(value => value.id === 'example.absent')?.providers, []);
  } finally { binding?.release(); await f.close(); }
});

test('one shared A candidate resolves every current root scope, while old exchange pins do not invent a scope', { timeout: 30_000 }, async () => {
  const f = await fixture('brokered', false, 'none'); const leases: HostServiceBinding[] = [];
  try {
    await f.route('p', 'example.b'); await f.route('q', 'example.c');
    const p = await f.prepare('p', 'one'), q = await f.prepare('q', 'two'); leases.push(p, q);
    assert.equal(p.providerId, q.providerId);
    const old = p.pin();
    const manifestPath = join(f.directory, 'example.a', 'varin.extension.json');
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.requires = { services: [{ realms: ['host'], id: 'example.dependency', version: 1, binding: 'selected' }] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(f.directory, 'example.a', 'host.cjs'), `module.exports={activate(ctx){const dependency=ctx.services.use('example.dependency',1);ctx.services.provide({id:'example.composed',version:1},{read(){return dependency.call('read')}})}};`);
    try {
      const staged = await f.runtime.reloadLocalSource({ extensionId: 'example.a', expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      assert.equal(staged.outcome, 'staged'); if (staged.outcome !== 'staged') throw new Error('Missing candidate');
      await f.runtime.requestCandidateApplication({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      await f.runtime.selectCandidate({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      const nextP = await f.prepare('p', 'three'), nextQ = await f.prepare('q', 'four'); leases.push(nextP, nextQ);
      assert.notEqual(nextP.providerId, nextQ.providerId);
      assert.equal((await nextP.invoke('read', []) as { name: string }).name, 'example.b');
      assert.equal((await nextQ.invoke('read', []) as { name: string }).name, 'example.c');
      assert.equal(typeof (await old.invoke('read', []) as { identity: string }).identity, 'string');
      p.release(); q.release();
      await writeFile(join(f.directory, 'example.a', 'host.cjs'), '// next scoped revision\n' + await readFile(join(f.directory, 'example.a', 'host.cjs'), 'utf8'));
      const revised = await f.runtime.reloadLocalSource({ extensionId: 'example.a', expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      assert.equal(revised.outcome, 'staged'); if (revised.outcome !== 'staged') throw new Error('Missing scoped candidate');
      const beforeRelease = await f.runtime.prepareCandidate('example.a', revised.candidateIntegrity);
      assert.equal(beforeRelease.providers.filter(provider => provider.extensionId === 'example.a').length, 2);
      const qCall = nextQ.pin();
      try {
        nextP.release();
        await f.route('p', 'example.missing');
        await f.runtime.requestCandidateApplication({ extensionId: 'example.a', candidateIntegrity: revised.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
        await f.runtime.selectCandidate({ extensionId: 'example.a', candidateIntegrity: revised.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
        assert.equal((await qCall.invoke('read', []) as { name: string }).name, 'example.c', 'Q old invocation keeps its exact dependency');
        assert(!f.runtime.services.getSnapshot().providers.some(provider => beforeRelease.providers.some(previous => previous.providerId === provider.providerId)), 'obsolete candidate roots actually retire');
        const revisedQ = await f.prepare('q', 'latest'); leases.push(revisedQ);
        assert.equal((await revisedQ.invoke('read', []) as { name: string }).name, 'example.c');
      } finally { qCall.release(); }
      for (const lease of leases.splice(0)) lease.release();
      await writeFile(join(f.directory, 'example.a', 'host.cjs'), '// next cold revision\n' + await readFile(join(f.directory, 'example.a', 'host.cjs'), 'utf8'));
      const cold = await f.runtime.reloadLocalSource({ extensionId: 'example.a', expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      assert.equal(cold.outcome, 'staged'); if (cold.outcome !== 'staged') throw new Error('Missing cold candidate');
      // Only the original old exchange remains. There is no global dependency routing rule.
      const prepared = await f.runtime.prepareCandidate('example.a', cold.candidateIntegrity);
      assert.deepEqual(prepared.providers, []);
      assert.equal(typeof (await old.invoke('read', []) as { identity: string }).identity, 'string');
    } finally { old.release(); }
  } finally { leases.forEach(lease => lease.release()); await f.close(); }
});


test('candidate publication synchronously rejects routing changed after its final async plan', { timeout: 30_000 }, async () => {
  const f = await fixture(); let binding: HostServiceBinding | undefined;
  let entered!: () => void, resume!: () => void;
  const atCommit = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  try {
    await f.route('p', 'example.b'); binding = await f.prepare('p', 'one');
    const previous = (await f.runtime.catalog.snapshot()).extensions.find(entry => entry.manifest.id === 'example.a')!.integrity;
    const path = join(f.directory, 'example.a', 'host.cjs'); await writeFile(path, '// changed artifact\n' + await readFile(path, 'utf8'));
    const staged = await f.runtime.reloadLocalSource({ extensionId: 'example.a', expectedRevision: (await f.runtime.catalog.snapshot()).revision });
    if (staged.outcome !== 'staged') throw new Error('Missing candidate');
    await f.runtime.requestCandidateApplication({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
    const select = f.runtime.packages.selectCandidate.bind(f.runtime.packages);
    f.runtime.packages.selectCandidate = async (...args) => { entered(); await gate; return select(...args); };
    const publishing = f.runtime.selectCandidate({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
    const rejected = assert.rejects(publishing, /routing changed before candidate publication/);
    await atCommit; await f.route('p', 'example.c'); resume(); await rejected;
    assert.equal((await f.runtime.catalog.snapshot()).extensions.find(entry => entry.manifest.id === 'example.a')!.integrity, previous);
    assert.equal((await binding.invoke('read', []) as { dependency: { name: string } }).dependency.name, 'example.b');
  } finally { resume(); binding?.release(); await f.close(); }
});

test('dependency crash revokes a retired A graph without revoking the separate A to C graph', { timeout: 30_000 }, async () => {
  const f = await fixture(); const bindings: HostServiceBinding[] = [];
  try {
    await f.route('p', 'example.b'); await f.route('q', 'example.c');
    const p = await f.prepare('p', 'one'), q = await f.prepare('q', 'two'); bindings.push(p, q);
    const oldP = p.pin(), other = q.pin();
    try {
      const before = await other.invoke('read', []);
      const path = join(f.directory, 'example.a', 'host.cjs'); await writeFile(path, '// next artifact\n' + await readFile(path, 'utf8'));
      const staged = await f.runtime.reloadLocalSource({ extensionId: 'example.a', expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      if (staged.outcome !== 'staged') throw new Error('Missing candidate');
      await f.runtime.requestCandidateApplication({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      await f.runtime.selectCandidate({ extensionId: 'example.a', candidateIntegrity: staged.candidateIntegrity, expectedRevision: (await f.runtime.catalog.snapshot()).revision });
      p.release(); q.release();
      assert.equal(f.runtime.services.getSnapshot().providers.find(provider => provider.providerId === p.providerId)?.status, 'draining');
      await assert.rejects(oldP.invoke('crash', []));
      assert.equal(oldP.revocationSignal.aborted, true);
      assert.equal(other.revocationSignal.aborted, false);
      assert.deepEqual(await other.invoke('read', []), before);
    } finally { oldP.release(); other.release(); }
  } finally { bindings.forEach(binding => binding.release()); await f.close(); }
});
