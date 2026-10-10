import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { JsonValue, VarinExtensionServiceProvision } from '@varin/extension-contract';
import { ApplicationExtensionRuntime, type HostCapabilityCallContext, type HostInvocationScope } from '../src/index.js';

const capability = 'dev.tools.authority';
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const descriptor = (id: string): VarinExtensionServiceProvision => ({ id: `${id}.query`, version: 1,
  tool: { name: 'query', description: 'Inspect one value through its granted capability', inputSchema: true,
    outputSchema: true, completion: 'result', operation: 'read', examples: [null, {}], source: { path: 'host.ts', line: 1 } } });
const scope = (id: string): HostInvocationScope => Object.freeze({ id, value: { marker: Symbol(id), notSerializable: () => id } });

async function fixture(mode: 'brokered' | 'native' = 'brokered') {
  const root = await mkdtemp(join(tmpdir(), 'varin-tool-scope-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3',
    brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
  const seen: HostCapabilityCallContext[] = [];
  const gates = new Map<string, { entered: ReturnType<typeof deferred<HostCapabilityCallContext>>; release: ReturnType<typeof deferred<void>> }>();
  runtime.capabilities.register(capability, async (method, value, context) => {
    seen.push(context);
    if (method === 'gate') {
      const gate = gates.get(String(value)); assert.ok(gate);
      gate.entered.resolve(context); await gate.release.promise; return null;
    }
    return { scoped: context.invocation !== undefined, owner: context.owner.extensionId, value };
  });
  await runtime.start();
  async function source(id: string, version = '1.0.0', failure?: 'mismatch' | 'omit') {
    const directory = join(root, `${id}-${version}`); await mkdir(directory);
    const tool = descriptor(id);
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version,
      engines: { varin: '*' }, capabilities: { host: [capability] },
      entrypoints: { host: { mode, file: 'host.cjs', activation: ['service-request'] } },
      provides: { services: [tool, { id: `${id}.control`, version: 1 }] } }));
    await writeFile(join(directory, 'host.ts'), `
import { provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json';
export function activate(context) {
  let saved; let token;
  ${mode === 'brokered' ? `process.on('message', message => { if (message.kind === 'request' && message.params?.invocationId) token = message.params.invocationId; });` : ''}
  const declaration = manifest.provides.services[0];
  ${failure === 'mismatch' ? `declaration.tool.description = 'A different contract';` : ''}
  if (${failure !== 'omit'}) provideTool(context, declaration, async (input, call) => {
    saved = call.capabilities;
    if (input?.kind === 'missing') return undefined;
    if (input?.kind === 'value') return input.value;
    if (input?.kind === 'wait') {
      await call.capabilities.call('${capability}', 'gate', input.gate);
      if (input.late) return { version: manifest.version, late: true };
    }
    return { version: manifest.version,
      ambient: await context.capabilities.call('${capability}', 'read', input),
      scoped: await call.capabilities.call('${capability}', 'read', input) };
  });
  context.services.provide(manifest.provides.services[1], {
    stale() { return saved.call('${capability}', 'read', null); },
    token() { return token ?? null; },
    ${mode === 'brokered' ? `crash() { setImmediate(() => process.exit(17)); return null; },
    forge([invocationId]) {
      return new Promise((resolve, reject) => {
        const id = 'forged-' + Math.random();
        const listener = message => { if (message.kind !== 'response' || message.id !== id) return;
          process.off('message', listener); message.success ? resolve(message.result) : reject(new Error(message.error)); };
        process.on('message', listener);
        process.send({ kind: 'request', id, method: 'capability.call', params: { capability: '${capability}', method: 'read', params: null, invocationId } });
      });
    },` : ''}
  });
}
`);
    await build({ entryPoints: [join(directory, 'host.ts')], outfile: join(directory, 'host.cjs'), bundle: true,
      platform: 'node', format: 'cjs', alias: { '@varin/extension-sdk': fileURLToPath(new URL('../../extension-sdk/dist/index.js', import.meta.url)) } });
    return { kind: 'local' as const, display: id, specifier: directory };
  }
  async function install(id: string) {
    await runtime.installOrStage({ source: await source(id), expectedRevision: (await runtime.catalog.snapshot()).revision });
    await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: [{ capability, realm: 'host', granted: true }] });
    await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
    return runtime.prepareService({ serviceId: `${id}.query`, version: 1, method: 'execute', args: [null] });
  }
  const control = (id: string, method: string, args: JsonValue[] = []) => runtime.invokeService({ serviceId: `${id}.control`, version: 1, method, args });
  const gate = (id: string) => { const value = { entered: deferred<HostCapabilityCallContext>(), release: deferred() }; gates.set(id, value); return value; };
  return { runtime, seen, source, install, control, gate, cleanup: async () => {
    for (const gate of gates.values()) gate.release.resolve();
    try { await runtime.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  } };
}

for (const mode of ['brokered', 'native'] as const) {
  test(`${mode}: installed SDK tool preserves its one manifest and call-scoped capability authority`, { timeout: 30_000 }, async () => {
    const h = await fixture(mode); const id = `dev.tools.${mode}`;
    try {
      const bound = await h.install(id); const pin = bound.pin();
      try {
        assert.deepEqual(bound.descriptor, descriptor(id));
        assert.deepEqual(await pin.invoke('inspect', []), descriptor(id));
        const authority = scope('unserializable-host-authority');
        const result = await pin.invoke('execute', [null], undefined, authority) as Record<string, unknown>;
        assert.equal(result.version, '1.0.0');
        assert.equal(h.seen.length, 2);
        assert.ok(h.seen.every(context => context.invocation === authority));
        assert.ok(h.seen.every(context => context.owner.extensionId === id));
        const count = h.seen.length;
        await assert.rejects(h.control(id, 'stale'), /expired/);
        assert.equal(h.seen.length, count);
        await bound.invoke('execute', [{}]);
        assert.ok(h.seen.slice(count).every(context => context.invocation === undefined), 'ordinary service calls retain owner grants only');
        for (const value of [null, '', {}, [], false, 0, JSON.parse('{"__proto__":{"safe":true}}')]) assert.deepEqual(await pin.invoke('execute', [{ kind: 'value', value }]), value);
        await assert.rejects(pin.invoke('execute', [{ kind: 'missing' }]), /normal JSON/);
      } finally { pin.release(); }
    } finally { await h.cleanup(); }
  });
}

test('brokered scope is owner-bound, survives waiter cancellation until real callback completion, then expires', { timeout: 30_000 }, async () => {
  const h = await fixture();
  try {
    const a = await h.install('dev.tools.a'); await h.install('dev.tools.b');
    const pin = a.pin();
    const parallelA = h.gate('parallel-a'); const parallelB = h.gate('parallel-b');
    const scopeA = scope('parallel-a'); const scopeB = scope('parallel-b');
    const callA = pin.invoke('execute', [{ kind: 'wait', gate: 'parallel-a' }], undefined, scopeA);
    const callB = pin.invoke('execute', [{ kind: 'wait', gate: 'parallel-b' }], undefined, scopeB);
    assert.equal((await parallelA.entered.promise).invocation, scopeA);
    assert.equal((await parallelB.entered.promise).invocation, scopeB);
    parallelB.release.resolve(); await callB;
    assert.ok(h.seen.slice(-2).every(context => context.invocation === scopeB));
    parallelA.release.resolve(); await callA;
    assert.ok(h.seen.slice(-2).every(context => context.invocation === scopeA), 'concurrent callbacks retain separate async authority');
    const authority = scope('cancelled-call'); const gate = h.gate('hold');
    const abort = new AbortController(); let completed = false;
    const pending = pin.invoke('execute', [{ kind: 'wait', gate: 'hold', late: true }], abort.signal, authority)
      .finally(() => { completed = true; });
    const entered = await gate.entered.promise;
    assert.equal(entered.invocation, authority);
    const token = await h.control('dev.tools.a', 'token'); assert.equal(typeof token, 'string');
    const count = h.seen.length;
    await assert.rejects(h.control('dev.tools.b', 'forge', [token]), /expired|another owner/);
    assert.equal(h.seen.length, count);
    abort.abort(new Error('cancel requested')); await setImmediate();
    assert.equal(entered.signal.aborted, true);
    assert.equal(completed, false, 'cancel does not settle a live callback or release its scope');
    // A current cancelled token is recognized and rejects for its originating cancellation.
    await assert.rejects(h.control('dev.tools.a', 'forge', [token]), /cancel requested/);
    gate.release.resolve(); assert.deepEqual(await pending, { version: '1.0.0', late: true });
    await assert.rejects(h.control('dev.tools.a', 'forge', [token]), /expired|another owner/);
    pin.release();
  } finally { await h.cleanup(); }
});

test('a frozen installed tool makes its first call on v1 after v2 publishes and a mismatched candidate cannot replace it', { timeout: 30_000 }, async () => {
  const h = await fixture(); const id = 'dev.tools.replace';
  try {
    const original = await h.install(id); const old = original.pin();
    const originalOwner = h.runtime.services.getSnapshot().providers.find(provider => provider.providerId === original.providerId)!;
    const originalArtifact = h.runtime.supervisor.getRetainedArtifactIdentity(originalOwner);
    assert.ok(originalArtifact);
    const staged = await h.runtime.installOrStage({ source: await h.source(id, '2.0.0'), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
    const candidate = staged.extensions.find(entry => entry.manifest.id === id)!.candidate!;
    const requested = await h.runtime.requestCandidateApplication({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: staged.revision });
    const published = deferred();
    const unsubscribe = h.runtime.services.subscribe(() => {
      if (h.runtime.services.getSnapshot().providers.some(provider => provider.extensionVersion === '2.0.0' && provider.status === 'active')) published.resolve();
    });
    const selecting = h.runtime.selectCandidate({ extensionId: id, candidateIntegrity: candidate.integrity, expectedRevision: requested.revision });
    await published.promise; unsubscribe();
    assert.equal(old.revocationSignal.aborted, false);
    const v1 = await old.invoke('execute', [null], undefined, scope('first-v1')) as { version: string };
    assert.equal(v1.version, '1.0.0');
    assert.equal(h.runtime.supervisor.getActiveArtifactIdentity(originalOwner), undefined);
    assert.equal(h.runtime.supervisor.getRetainedArtifactIdentity(originalOwner), originalArtifact);
    const child = h.runtime.services.bindPinned(`${id}.query`, 1, original.providerId).pin();
    old.release();
    assert.equal((await child.invoke('execute', [null], undefined, scope('child-v1')) as { version: string }).version, '1.0.0');
    child.release(); await selecting;
    assert.equal(h.runtime.supervisor.getRetainedArtifactIdentity(originalOwner), undefined);
    const next = await h.runtime.prepareService({ serviceId: `${id}.query`, version: 1, method: 'execute', args: [] });
    assert.equal((await next.invoke('execute', [null]) as { version: string }).version, '2.0.0');
    for (const [version, failure] of [['3.0.0', 'mismatch'], ['4.0.0', 'omit']] as const) {
      const bad = await h.runtime.installOrStage({ source: await h.source(id, version, failure), expectedRevision: (await h.runtime.catalog.snapshot()).revision });
      const broken = bad.extensions.find(entry => entry.manifest.id === id)!.candidate!;
      await assert.rejects(h.runtime.prepareCandidate(id, broken.integrity), /declaration differs from manifest|did not register declared tool/);
      assert.equal((await next.invoke('execute', [null]) as { version: string }).version, '2.0.0');
    }
    const pin = next.pin();
    const revoked = new Promise<void>(resolve => pin.revocationSignal.addEventListener('abort', () => resolve(), { once: true }));
    const disabling = h.runtime.setEnabled(id, false, (await h.runtime.catalog.snapshot()).revision);
    await revoked; await assert.rejects(pin.invoke('execute', [null]), /released|revoked|unavailable/);
    await disabling; pin.release();
    await h.runtime.setEnabled(id, true, (await h.runtime.catalog.snapshot()).revision);
    const crashBinding = await h.runtime.prepareService({ serviceId: `${id}.query`, version: 1, method: 'execute', args: [] });
    const crashPin = crashBinding.pin();
    const crashed = new Promise<void>(resolve => crashPin.revocationSignal.addEventListener('abort', () => resolve(), { once: true }));
    await h.control(id, 'crash'); await crashed;
    await assert.rejects(crashPin.invoke('execute', [null]), /released|revoked|unavailable/);
    crashPin.release();
  } finally { await h.cleanup(); }
});
