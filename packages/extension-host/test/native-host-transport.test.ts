import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { JsonValue } from '@varin/extension-contract';
import { HostCapabilityRegistry } from '../src/capability-registry.js';
import { NativeHostTransport } from '../src/native-host-transport.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
type Context = {
  signal: AbortSignal;
  capabilities: { call(capability: string, method: string, params: JsonValue): Promise<JsonValue> };
  effect(dispose: () => void | Promise<void>): void;
  storage: { refresh(): Promise<unknown> };
};

async function fixture(source = 'exports.activate = context => { exports.context = context; };') {
  const root = await mkdtemp(join(tmpdir(), 'varin-native-transport-'));
  const modulePath = join(root, 'host.cjs');
  await writeFile(modulePath, source);
  const registry = new HostCapabilityRegistry();
  const calls: Array<{ method: string; signal: AbortSignal }> = [];
  const owner = { extensionId: 'example.language', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'native', generation: 1 };
  const grants = [{ capability: 'workspace.language', realm: 'host' as const, manifestVersion: '1.0.0', granted: true, updatedAt: new Date().toISOString() }];
  let disposing = false;
  registry.register('workspace.language', (method, _params, context) => {
    calls.push({ method, signal: context.signal }); return null;
  }, { cleanupMethods: ['unregisterProvider'] });
  const transport = new NativeHostTransport({ requestFromExtension: async (method, value, signal) => {
    assert.equal(method, 'capability.call');
    const params = value as { capability: string; method: string; params: JsonValue };
    return registry.invoke(owner, grants, params.capability, params.method, params.params, signal, undefined, disposing);
  } });
  const activate = async () => {
    await transport.request('activate', { modulePath, packageRoot: root, dependencies: [] });
    return (createRequire(modulePath)(modulePath) as { context: Context }).context;
  };
  const terminate = () => { disposing = true; return transport.terminate(); };
  return { root, modulePath, transport, activate, terminate, calls, grants, cleanup: async () => {
    try { await terminate().catch(() => undefined); } finally { await rm(root, { recursive: true, force: true }); }
  } };
}

const inactive = (error: unknown) => /inactive|deactivated|expired|force-disabled/.test(String(error));

test('native SDK language cleanup unregisters its original provider after grant revocation', async () => {
  const f = await fixture();
  try {
    await build({ stdin: { contents: `
      import { defineLanguageProvider } from '@varin/extension-sdk';
      const provider = defineLanguageProvider({ providerId: 'example.language', command: 'language-server', languageIds: ['example'] });
      export let context;
      export const activate = value => { context = value; return provider.activate(value); };
    ` }, outfile: f.modulePath, bundle: true, platform: 'node', format: 'cjs',
    alias: { '@varin/extension-sdk': fileURLToPath(new URL('../../extension-sdk/src/index.ts', import.meta.url)) } });
    const context = await f.activate();
    assert.deepEqual(f.calls.map(call => call.method), ['registerProvider']);
    f.grants[0]!.granted = false;
    await f.terminate();
    assert.equal(context.signal.aborted, true);
    assert.deepEqual(f.calls.map(call => call.method), ['registerProvider', 'unregisterProvider']);
    assert.equal(f.calls[1]!.signal.aborted, true, 'cleanup signal expires after the disposer finishes');
    await assert.rejects(context.capabilities.call('workspace.language', 'unregisterProvider', {}), inactive);
    await assert.rejects(context.storage.refresh(), inactive);
  } finally { await f.cleanup(); }
});

test('concurrent termination joins all disposers, preserves failures, and closes admission immediately', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  const order: string[] = [];
  try {
    const context = await f.activate();
    context.effect(async () => {
      order.push('last');
      await context.capabilities.call('workspace.language', 'unregisterProvider', {});
    });
    context.effect(() => { order.push('failed'); throw new Error('disposer failure'); });
    context.effect(async () => { order.push('first'); entered.resolve(); await release.promise; });
    const first = f.terminate(), second = f.terminate();
    let finished = false;
    const result = Promise.allSettled([first, second]).then(value => { finished = true; return value; });
    await entered.promise;
    await assert.rejects(context.capabilities.call('workspace.language', 'registerProvider', {}), inactive);
    await assert.rejects(f.transport.request('activate', { modulePath: f.modulePath }), /inactive/);
    await assert.rejects(f.transport.request('storage.sync', {}), /inactive/);
    assert.equal(finished, false);
    release.resolve();
    const outcomes = await result;
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') assert.match(String(outcome.reason), /cleanup failed: disposer failure/);
    }
    assert.deepEqual(order, ['first', 'failed', 'last']);
    await assert.rejects(f.terminate(), /cleanup failed: disposer failure/);
    assert.deepEqual(order, ['first', 'failed', 'last']);
  } finally { release.resolve(); await f.cleanup(); }
});

test('native disposal retains Host cleanup permissions without admitting revoked or unknown capabilities', async () => {
  const f = await fixture();
  const releaseLate = deferred();
  let late!: Promise<unknown>;
  try {
    const context = await f.activate();
    context.effect(async () => {
      await assert.rejects(context.capabilities.call('workspace.language', 'registerProvider', {}), /not granted/);
      await assert.rejects(context.capabilities.call('workspace.unknown', 'unregisterProvider', {}), /not granted/);
      await context.capabilities.call('workspace.language', 'unregisterProvider', {});
      late = releaseLate.promise.then(() => context.capabilities.call('workspace.language', 'unregisterProvider', {}));
    });
    f.grants[0]!.granted = false;
    await f.terminate();
    releaseLate.resolve();
    await assert.rejects(late, inactive);
    assert.deepEqual(f.calls.map(call => call.method), ['unregisterProvider']);
    await f.terminate();
    assert.equal(f.calls.length, 1);
  } finally { releaseLate.resolve(); await f.cleanup(); }
});

test('force termination cancels cleanup calls but still waits for the real disposer to finish', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  try {
    const context = await f.activate();
    context.effect(async () => {
      await context.capabilities.call('workspace.language', 'unregisterProvider', {});
      entered.resolve(); await release.promise;
      await assert.rejects(context.capabilities.call('workspace.language', 'unregisterProvider', {}), inactive);
    });
    let stopped = false;
    const termination = f.terminate().then(() => { stopped = true; });
    await entered.promise;
    f.transport.forceTerminate();
    assert.equal(f.calls[0]!.signal.aborted, true);
    await setImmediate();
    assert.equal(stopped, false);
    release.resolve();
    await termination;
    assert.equal(f.calls.length, 1);
  } finally { release.resolve(); await f.cleanup(); }
});

test('a failed activation still runs its registered cleanup without hiding the activation error', async () => {
  const f = await fixture(`exports.activate = async context => {
    exports.context = context;
    await context.capabilities.call('workspace.language', 'registerProvider', {});
    context.effect(() => context.capabilities.call('workspace.language', 'unregisterProvider', {}).then(() => {}));
    throw new Error('activation failed');
  };`);
  try {
    await assert.rejects(f.activate(), /activation failed/);
    assert.deepEqual(f.calls.map(call => call.method), ['registerProvider', 'unregisterProvider']);
    await f.terminate();
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('replacement activation expires the old context without forbidding the existing nonterminal reuse', async () => {
  const f = await fixture();
  try {
    const first = await f.activate();
    first.effect(async () => { await first.capabilities.call('workspace.language', 'unregisterProvider', {}); });
    const second = await f.activate();
    await assert.rejects(first.capabilities.call('workspace.language', 'registerProvider', {}), inactive);
    await second.capabilities.call('workspace.language', 'registerProvider', {});
    assert.deepEqual(f.calls.map(call => call.method), ['unregisterProvider', 'registerProvider']);
    await f.terminate();
    await assert.rejects(f.activate(), /inactive/);
  } finally { await f.cleanup(); }
});

for (const force of [false, true]) test(`termination joins pending activation and its late returned disposer without publishing services (force=${force})`, async () => {
  const f = await fixture(`exports.activate = async context => {
    exports.context = context;
    exports.entered = true;
    await new Promise(resolve => { exports.finishActivation = resolve; });
    context.services.provide({ id: 'example.late', version: 1 }, { read() { return 'late'; } });
    return async () => {
      await context.capabilities.call('workspace.language', 'unregisterProvider', {});
      exports.disposed = true;
    };
  };`);
  const module = createRequire(f.modulePath)(f.modulePath) as {
    entered?: boolean; disposed?: boolean; finishActivation?: () => void;
  };
  try {
    const activation = f.activate();
    const rejected = assert.rejects(activation, inactive);
    await setImmediate();
    assert.equal(module.entered, true);
    let stopped = false;
    if (force) f.transport.forceTerminate();
    const termination = f.terminate().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false);
    module.finishActivation!();
    await Promise.all([rejected, termination]);
    assert.equal(module.disposed, true);
    assert.deepEqual(f.calls.map(call => call.method), ['unregisterProvider']);
    await assert.rejects(f.transport.request('service.invoke', { serviceId: 'example.late', version: 1, method: 'read' }), /inactive/);
    await f.terminate();
    assert.equal(f.calls.length, 1);
  } finally { module.finishActivation?.(); await f.cleanup(); }
});
