import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';

const id = 'dev.native-cleanup';
const serviceId = 'dev.native-cleanup.control';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture({ pause = false, invalid = false, probeRevocation = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'varin-native-cleanup-'));
  const packageRoot = join(root, 'package'); await mkdir(packageRoot);
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3',
    brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
  const entered = deferred(), release = deferred(), aborted = deferred(), unregistered = deferred();
  const calls: string[] = [];
  runtime.capabilities.register('workspace.language', async (method, _params, context) => {
    calls.push(method);
    if (method === 'activationGate') {
      context.signal.addEventListener('abort', aborted.resolve, { once: true });
      entered.resolve(); await release.promise;
    }
    if (method === 'unregisterProvider') unregistered.resolve();
    return null;
  }, { cleanupMethods: ['unregisterProvider'] });
  await writeFile(join(packageRoot, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0',
    engines: { varin: '*' }, capabilities: { host: ['workspace.language'] },
    entrypoints: { host: { mode: 'native', file: 'host.cjs', activation: ['service-request'] } },
    provides: { services: [{ id: serviceId, version: 1 }] } }));
  await build({ stdin: { contents: `
    import { defineLanguageProvider } from '@varin/extension-sdk';
    const provider = defineLanguageProvider({ providerId: '${id}', command: 'language-server', languageIds: ['example'] });
    export async function activate(context) {
      await provider.activate(context);
      ${probeRevocation ? `context.effect(async () => {
        try { await context.capabilities.call('workspace.language', 'registerProvider', { providerId: 'late' }); }
        catch { /* Revoked ordinary calls must remain rejected during cleanup. */ }
      });` : ''}
      ${pause ? `await context.capabilities.call('workspace.language', 'activationGate', {});` : ''}
      context.services.provide({ id: '${invalid ? 'dev.undeclared' : serviceId}', version: 1 }, { read() { return null; } });
    }
  ` }, outfile: join(packageRoot, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs',
    alias: { '@varin/extension-sdk': fileURLToPath(new URL('../../extension-sdk/src/index.ts', import.meta.url)) } });
  await runtime.start();
  await runtime.installOrStage({ source: { kind: 'local', display: id, specifier: packageRoot }, expectedRevision: (await runtime.catalog.snapshot()).revision });
  await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision,
    decisions: [{ capability: 'workspace.language', realm: 'host', granted: true }] });
  await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
  return { runtime, calls, entered, release, aborted, unregistered,
    prepare: (signal?: AbortSignal) => runtime.prepareService({ serviceId, version: 1, method: 'read', args: [] }, signal ? { signal } : undefined),
    cleanup: async () => { release.resolve(); try { await runtime.stop(); } finally { await rm(root, { recursive: true, force: true }); } },
  };
}

test('disabling an active native SDK language extension unregisters despite preparation force cancellation', { timeout: 30_000 }, async () => {
  const f = await fixture({ probeRevocation: true });
  try {
    const binding = await f.prepare();
    try {
      await f.runtime.setEnabled(id, false, (await f.runtime.catalog.snapshot()).revision);
      assert.deepEqual(f.calls, ['registerProvider', 'unregisterProvider']);
    } finally { binding.release(); }
  } finally { await f.cleanup(); }
});

test('revoking a native grant during activation still permits only its original provider cleanup', { timeout: 30_000 }, async () => {
  const f = await fixture({ pause: true, probeRevocation: true });
  try {
    const preparing = f.prepare();
    const rejected = assert.rejects(preparing, /revoked|cancel|disabled|granted|inactive/i);
    await f.entered.promise;
    const revoking = f.runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await f.runtime.catalog.snapshot()).revision,
      decisions: [{ capability: 'workspace.language', realm: 'host', granted: false }] });
    await f.aborted.promise;
    f.release.resolve();
    await Promise.all([rejected, revoking, f.unregistered.promise]);
    assert.deepEqual(f.calls, ['registerProvider', 'activationGate', 'unregisterProvider']);
    assert.equal(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === id && provider.status === 'active'), false);
  } finally { await f.cleanup(); }
});

test('cancelling the last native activation waiter cleans the already registered provider after its callback settles', { timeout: 30_000 }, async () => {
  const f = await fixture({ pause: true });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(f.prepare(controller.signal), /caller cancelled/);
    await f.entered.promise;
    controller.abort(new Error('caller cancelled'));
    await f.aborted.promise;
    assert.deepEqual(f.calls, ['registerProvider', 'activationGate']);
    f.release.resolve();
    await Promise.all([rejected, f.unregistered.promise]);
    assert.deepEqual(f.calls, ['registerProvider', 'activationGate', 'unregisterProvider']);
  } finally { await f.cleanup(); }
});

test('post-activation provision validation failure retains original cleanup authorization through termination', { timeout: 30_000 }, async () => {
  const f = await fixture({ invalid: true, probeRevocation: true });
  try {
    await assert.rejects(f.prepare(), /undeclared service/);
    assert.deepEqual(f.calls, ['registerProvider', 'unregisterProvider']);
  } finally { await f.cleanup(); }
});
