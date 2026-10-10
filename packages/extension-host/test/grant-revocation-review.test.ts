import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';

const id = 'dev.review.grants';
const serviceId = 'dev.review.service';
const protectedCapability = 'dev.review.protected';
const gateCapability = 'dev.review.gate';
const candidateCapability = 'dev.review.candidate';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(mode: 'brokered' | 'native', pauseDisposal = false, brokerShutdownGraceMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'varin-grant-review-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3', ...(brokerShutdownGraceMs === undefined ? {} : { brokerShutdownGraceMs }), brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
  const entered = deferred(); const release = deferred();
  const disposalEnteredPath = join(root, 'disposal-entered'); const disposalReleasePath = join(root, 'disposal-release');
  let privilegedCalls = 0;
  runtime.capabilities.register(protectedCapability, () => { privilegedCalls++; return 'allowed'; });
  runtime.capabilities.register(candidateCapability, () => 'allowed');
  runtime.capabilities.register(gateCapability, async () => { entered.resolve(); await release.promise; return null; });
  async function source(version: string, pauseActivation = false) {
    const path = join(root, version); await mkdir(path);
    await writeFile(join(path, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version, engines: { varin: '*' }, capabilities: { host: [protectedCapability, gateCapability, ...(pauseActivation ? [candidateCapability] : [])] }, entrypoints: { host: { mode, file: 'host.cjs', activation: ['service-request'] } }, provides: { services: [{ id: serviceId, version: 1 }] } }));
    await writeFile(join(path, 'host.cjs'), `module.exports = { async activate(context) {
      ${pauseActivation ? `await context.capabilities.call('${gateCapability}', 'wait', null);` : ''}
      await context.capabilities.call('${pauseActivation ? candidateCapability : protectedCapability}', 'read', null);
      ${pauseDisposal ? `context.effect(async () => { const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(disposalEnteredPath)}, 'entered'); while (!fs.existsSync(${JSON.stringify(disposalReleasePath)})) await new Promise(resolve => setTimeout(resolve, 5)); await context.capabilities.call('${protectedCapability}', 'read', null); });` : ''}
      context.services.provide({ id: '${serviceId}', version: 1 }, {
        async wait() { await context.capabilities.call('${gateCapability}', 'wait', null); return context.capabilities.call('${protectedCapability}', 'read', null); },
        read() { return context.capabilities.call('${protectedCapability}', 'read', null); },
        version() { return '${version}'; },
        pid() { return process.pid; }
      });
    } };`);
    return { kind: 'local' as const, display: id, specifier: path };
  }
  await runtime.start();
  await runtime.installOrStage({ source: await source('1.0.0'), expectedRevision: (await runtime.catalog.snapshot()).revision });
  await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision, decisions: [protectedCapability, gateCapability].map(capability => ({ capability, realm: 'host', granted: true })) });
  await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
  await runtime.activateExtension(id);
  const invoke = (method: string, providerId?: string) => runtime.invokeService({ serviceId, version: 1, method, args: [], ...(providerId ? {providerId} : {}) });
  return { runtime, source, entered, release, invoke,
    disposalEntered: async () => { while (!(await access(disposalEnteredPath).then(() => true, () => false))) await new Promise(r => setTimeout(r, 5)); },
    releaseDisposal: () => writeFile(disposalReleasePath, 'release'),
    privilegedCalls: () => privilegedCalls,
    revoke: async () => runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision, decisions: [{ capability: protectedCapability, realm: 'host', granted: false }] }),
    cleanup: async (allowStopFailure = false) => { release.resolve(); await writeFile(disposalReleasePath, 'release'); try { await runtime.stop(); } catch (error) { if (!allowStopFailure) throw error; } finally { await rm(root, { recursive: true, force: true }); } } };
}

for (const mode of ['brokered', 'native'] as const) {
  test(`${mode}: revocation reaches a real active callback even when replacement cannot activate`, { timeout: 30_000 }, async () => {
    const h = await fixture(mode);
    try {
      const providerId = h.runtime.services.getSnapshot().providers[0]!.providerId;
      const pending = h.invoke('wait', providerId); const rejected = assert.rejects(pending, /not granted/);
      await h.entered.promise;
      await h.revoke();
      h.release.resolve(); await rejected;
      await assert.rejects(h.invoke('read', providerId), /not granted/);
      assert.equal(h.privilegedCalls(), 1, 'no privileged handler entered after the initial activation');
      assert.ok(h.runtime.supervisor.activeExtensions().includes(id), 'old implementation remains live');
    } finally { await h.cleanup(); }
  });
}

test('revocation reaches a real draining callback from the previous selected version', { timeout: 30_000 }, async () => {
  const h = await fixture('brokered');
  try {
    const staged = await h.runtime.installOrStage({ source: await h.source('2.0.0'), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
    const candidate = staged.extensions.find(e => e.manifest.id === id)!.candidate!;
    const requested = await h.runtime.requestCandidateApplication({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: staged.revision });
    const providerId = h.runtime.services.getSnapshot().providers.find(p => p.status === 'active')!.providerId;
    const pending = h.invoke('wait', providerId).then(value => ({ value, error: '' }), error => ({ value: null, error: String(error) }));
    await h.entered.promise;
    const selecting = h.runtime.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: requested.revision });
    while (!h.runtime.services.getSnapshot().providers.some(p => p.extensionVersion === '2.0.0' && p.status === 'active')) await new Promise(r => setTimeout(r, 5));
    const revoking = h.revoke();
    while ((await h.runtime.catalog.snapshot()).extensions.find(e => e.manifest.id === id)!.capabilityGrants.find(g => g.capability === protectedCapability)!.granted) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 30));
    h.release.resolve();
    const result = await pending;
    await Promise.all([selecting, revoking]);
    assert.match(result.error, /not granted/);
    assert.ok(h.privilegedCalls() >= 2);
  } finally { await h.cleanup(); }
});


test('candidate grant revocation cancels pending real worker preparation despite unchanged artifact and desired revision', { timeout: 30_000 }, async () => {
  const h = await fixture('brokered');
  try {
    const staged = await h.runtime.installOrStage({ source: await h.source('2.0.0', true), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
    const candidate = staged.extensions.find(e => e.manifest.id === id)!.candidate!;
    const approved = await h.runtime.reviewCandidateCapabilities({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: staged.revision, decisions: [{ capability: candidateCapability, realm: 'host', granted: true }] });
    const desiredRevision = approved.extensions.find(e => e.manifest.id === id)!.desired.revision;
    const preparing = h.runtime.prepareCandidate(id, candidate.integrity);
    const failed = assert.rejects(preparing, /cancel|terminated|closed|exited/);
    await h.entered.promise;
    const reviewed = await h.runtime.reviewCandidateCapabilities({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: approved.revision, decisions: [{ capability: candidateCapability, realm: 'host', granted: false }] });
    h.release.resolve(); await failed;
    assert.equal(reviewed.extensions.find(e => e.manifest.id === id)!.desired.revision, desiredRevision);
    assert.equal(await h.invoke('read'), 'allowed', 'candidate denial does not revoke selected-version grant');
    await assert.rejects(h.runtime.prepareCandidate(id, candidate.integrity), /not granted/);
    assert.ok(h.runtime.services.getSnapshot().providers.every(p => p.extensionVersion === '1.0.0'));
  } finally { await h.cleanup(); }
});

for (const stopMode of ['disable', 'shutdown'] as const) {
test(`${stopMode} revokes a retired exchange pin without waiting for that pin to release itself`, { timeout: 30_000 }, async () => {
  const h = await fixture('brokered');
  let releasePin: (() => void) | undefined;
  try {
    const staged = await h.runtime.installOrStage({ source: await h.source('2.0.0'), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
    const candidate = staged.extensions.find(e => e.manifest.id === id)!.candidate!;
    const requested = await h.runtime.requestCandidateApplication({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: staged.revision });
    const binding = await h.runtime.prepareService({ serviceId, version: 1, method: 'version', args: [] });
    const pin = binding.pin(); releasePin = () => pin.release();
    const selecting = h.runtime.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: requested.revision });
    while (!h.runtime.services.getSnapshot().providers.some(p => p.extensionVersion === '2.0.0' && p.status === 'active')) await new Promise(r => setTimeout(r, 5));
    assert.equal(await pin.invoke('version', []), '1.0.0', 'ordinary replacement preserves frozen exchange');
    await assert.rejects(binding.invoke('version', []), /no longer available/);
    const disabling = stopMode === 'shutdown' ? h.runtime.stop() : h.runtime.setEnabled(id, false, (await h.runtime.catalog.snapshot()).revision);
    if (stopMode === 'disable') while ((await h.runtime.catalog.snapshot()).extensions.find(e => e.manifest.id === id)!.desired.enabled) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 30));
    const outcome = await pin.invoke('version', []).then(value => ({ value, error: '' }), error => ({ value: null, error: String(error) }));
    pin.release();
    if (stopMode === 'shutdown') { await Promise.allSettled([selecting]); await disabling; }
    else await Promise.all([selecting, disabling]);
    assert.match(outcome.error, /released|unavailable|no longer available/, `${stopMode} must stop new dispatch through a retired pin`);
  } finally { releasePin?.(); await h.cleanup(); }
});
}

test('public service preparation fails closed on stale scoped routing instead of choosing the sole provider', { timeout: 30_000 }, async () => {
  const h = await fixture('brokered');
  const read = h.runtime.routing.read.bind(h.runtime.routing);
  try {
    const original = await read();
    h.runtime.routing.read = async () => ({ ...original, authoritative: false });
    await assert.rejects(h.runtime.prepareService({ serviceId, version: 1, method: 'version', args: [] }), /stale (?:routing|selection state)/);
    const providerId = h.runtime.services.getSnapshot().providers.find(p => p.status === 'active')!.providerId;
    assert.equal(await h.invoke('version', providerId), '1.0.0', 'explicit exact-provider request does not consult scoped routing');
  } finally { h.runtime.routing.read = read; await h.cleanup(); }
});


for (const mode of ['brokered', 'native'] as const) {
  test(`${mode}: revocation still reaches a retiring transport while its async disposer runs`, { timeout: 30_000 }, async () => {
    const h = await fixture(mode, true);
    try {
      const disabling = h.runtime.setEnabled(id, false, (await h.runtime.catalog.snapshot()).revision);
      await h.disposalEntered();
      const revoking = h.revoke();
      while ((await h.runtime.catalog.snapshot()).extensions.find(e => e.manifest.id === id)!.capabilityGrants.find(g => g.capability === protectedCapability)!.granted) await new Promise(r => setTimeout(r, 5));
      await new Promise(r => setTimeout(r, 30));
      await h.releaseDisposal(); await Promise.allSettled([disabling, revoking]);
      assert.equal(h.privilegedCalls(), 1, 'retiring disposer entered privileged handler after revocation');
    } finally { await h.cleanup(); }
  });
}

for (const refresh of ['unchanged', 'changed-revision'] as const) {
test(`forced native owner cannot regain captured privileges on ${refresh} catalog reconciliation`, { timeout: 30_000 }, async () => {
  const h = await fixture('native');
  try {
    const pending = h.invoke('wait').then(value => ({ value, error: '' }), error => ({ value: null, error: String(error) }));
    await h.entered.promise;
    h.runtime.supervisor.forceTerminate(id);
    if (refresh === 'unchanged') await h.runtime.reconcile();
    else await h.runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await h.runtime.catalog.snapshot()).revision, decisions: [{ capability: gateCapability, realm: 'host', granted: false }] });
    h.release.resolve(); const outcome = await pending;
    assert.match(outcome.error, /not granted|inactive|cancel|abort|revoked/i);
    assert.equal(h.privilegedCalls(), 1, 'reconcile must not re-grant a force-disabled captured context');
  } finally { await h.cleanup(); }
});

}


test('new published generation prepares while the previous exchange remains pinned', { timeout: 15_000 }, async () => {
  const h = await fixture('brokered'); let releasePin: (() => void) | undefined;
  try {
    const staged = await h.runtime.installOrStage({ source: await h.source('2.0.0'), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
    const candidate = staged.extensions.find(e => e.manifest.id === id)!.candidate!;
    const requested = await h.runtime.requestCandidateApplication({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: staged.revision });
    const pin = (await h.runtime.prepareService({ serviceId, version: 1, method: 'version', args: [] })).pin(); releasePin = () => pin.release();
    const selecting = h.runtime.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: requested.revision });
    while (!h.runtime.services.getSnapshot().providers.some(p => p.extensionVersion === '2.0.0' && p.status === 'active')) await new Promise(r => setTimeout(r, 5));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bound = await Promise.race([h.runtime.prepareService({ serviceId, version: 1, method: 'version', args: [] }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('new generation blocked by old pin')), 1500); })]);
      assert.equal(await bound.invoke('version', []), '2.0.0');
      assert.equal(await pin.invoke('version', []), '1.0.0');
    } finally { clearTimeout(timer); pin.release(); await selecting; }
  } finally { releasePin?.(); await h.cleanup(); }
});

test('shutdown terminates a broker callback that ignores cooperative cancellation', { timeout: 15_000 }, async () => {
  const h = await fixture('brokered');
  try {
    const pending = h.invoke('wait').then(value => ({ value, error: '' }), error => ({ value: null, error: String(error) }));
    await h.entered.promise;
    const stopping = h.runtime.stop(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopping, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown blocked by hung broker callback')), 1500); })]);
      assert.match((await pending).error, /exited|disconnect|terminated/);
    } finally { clearTimeout(timer); h.release.resolve(); await stopping; }
  } finally { await h.cleanup(); }
});

test('shutdown does not wait forever for a broker disposer with no service call in flight', { timeout: 15_000 }, async () => {
  const h = await fixture('brokered', true, 100);
  try {
    const pid = await h.invoke('pid') as number;
    const stopping = h.runtime.stop().then(() => null, error => error as Error); let settled = false;
    void stopping.then(() => { settled = true; });
    await h.disposalEntered();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopping, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
      assert.equal(settled, true, 'shutdown remains blocked solely by an uncooperative worker disposer');
      assert.equal(await stopping, null, 'process shutdown succeeds while separately reporting unconfirmed cleanup');
      const catalog = await h.runtime.catalog.snapshot();
      const actual = catalog.extensions.find(e => e.manifest.id === id)!.actual;
      assert.ok(actual.some(state => state.diagnostics.some(diagnostic => diagnostic.code === 'broker_cleanup_unconfirmed')), 'forced shutdown must report unconfirmed cleanup');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'shutdown must observe actual broker process exit');
    } finally { clearTimeout(timer); await h.releaseDisposal(); await stopping; }
  } finally { await h.cleanup(true); }
});
