import assert from 'node:assert/strict';
import test from 'node:test';
import { HostServiceRegistry } from '../src/service-registry.js';
const owner = (id: string, generation = 1) => ({ extensionId: id, entrypointId: 'host', extensionVersion: '1.0.0', generation });
const serviceId = 'dev.review.bound';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('a bound handle preserves provider selection and rejects pre-aborted dispatch', async () => {
  const services = new HostServiceRegistry('test'); let calls = 0;
  for (const id of ['dev.review.a', 'dev.review.b']) await services.replaceOwner(owner(id), [{ descriptor: { id: serviceId, version: 1, multiple: true }, handler: () => { calls++; return id; } }]);
  const [a, b] = services.getSnapshot().providers;
  services.setSelection(serviceId, 1, a!.providerId);
  const bound = services.bind(serviceId, 1);
  services.setSelection(serviceId, 1, b!.providerId);
  assert.equal(await bound.invoke('run', []), 'dev.review.a');
  assert.equal(await services.invoke({ serviceId, version: 1, method: 'run', args: [] }), 'dev.review.b');
  const pin = bound.pin();
  try {
    const signal = AbortSignal.abort(new Error('pre-aborted'));
    await assert.rejects(bound.invoke('run', [], signal), /pre-aborted/);
    await assert.rejects(pin.invoke('run', [], signal), /pre-aborted/);
    assert.equal(calls, 2, 'neither aborted request dispatched the handler');
  } finally { pin.release(); }
});

test('revoking an old owner releases idle exchange pins, preserves actual in-flight lifetime, and leaves newer owner available', async () => {
  const services = new HostServiceRegistry('test'); const release = deferred(); const entered = deferred();
  const old = owner('dev.review.owner'); const next = owner('dev.review.owner', 2);
  await services.replaceOwner(old, [{ descriptor: { id: serviceId, version: 1 }, handler: async () => { entered.resolve(); await release.promise; return 'old completion'; } }]);
  const bound = services.bind(serviceId, 1); const pin = bound.pin();
  const pending = pin.invoke('run', []); await entered.promise;
  const replacement = services.prepareOwnerReplacement(next, [{ descriptor: { id: serviceId, version: 1 }, handler: () => 'new' }]);
  replacement.commit();
  let retired = false; const retirement = replacement.finalize().then(() => { retired = true; });
  const draining = services.drainOwner(old);
  await assert.rejects(pin.invoke('run', []), /released|unavailable/);
  assert.equal(retired, false, 'revoking idle pin must not complete actual handler');
  assert.equal(await services.bind(serviceId, 1).invoke('run', []), 'new');
  release.resolve(); assert.equal(await pending, 'old completion');
  await Promise.all([retirement, draining]); pin.release();
  assert.equal(retired, true);
  assert.equal(await services.bind(serviceId, 1).invoke('run', []), 'new');
});
