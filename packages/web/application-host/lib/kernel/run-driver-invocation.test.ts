import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { HostCapabilityCallContext, HostInvocationScope } from '@varin/extension-host';
import { runDriverCall, withRunDriverInvocation } from './run-driver-invocation.js';

const owner = { extensionId: 'example.driver', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'driver-original', generation: 1 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('a real Run scope carries its original authority and drains concurrent work after algorithm return', async () => {
  const first = deferred<string>(), second = deferred<string>(), entered = deferred<void>();
  const cancel = new AbortController();
  let context!: HostCapabilityCallContext, completed = false;
  const work = withRunDriverInvocation({ owner, signal: cancel.signal, currentEpoch: () => 'epoch-a',
    authority: { runId: 'run-a', instanceId: 'original-instance', kernelEpoch: 'epoch-a' } }, async invocation => {
    context = { owner, signal: cancel.signal, invocation };
    void runDriverCall(context, async authority => {
      assert.deepEqual(authority, { runId: 'run-a', instanceId: 'original-instance', kernelEpoch: 'epoch-a' });
      return first.promise;
    });
    void runDriverCall(context, () => second.promise);
    entered.resolve();
    return 'algorithm returned';
  }).then(value => { completed = true; return value; });
  await entered.promise; await Promise.resolve();
  assert.equal(completed, false);
  assert.throws(() => runDriverCall(context, async () => 'late'), /invocation_unavailable/);
  cancel.abort(); first.resolve('first stopped');
  await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false);
  second.resolve('second stopped');
  assert.equal(await work, 'algorithm returned');
  assert.equal(completed, true);
});

test('shared workers cannot borrow another Run, generation or epoch through copied scope values', async () => {
  let epoch = 'epoch-a';
  const signal = new AbortController().signal;
  await withRunDriverInvocation({ owner, signal, currentEpoch: () => epoch,
    authority: { runId: 'run-a', instanceId: 'original-instance', kernelEpoch: epoch } }, async invocation => {
    const context = { owner, signal, invocation };
    assert.throws(() => runDriverCall({ ...context, invocation: { ...invocation } }, async () => null), /invocation_unavailable/);
    assert.throws(() => runDriverCall({ ...context, owner: { ...owner, generation: 2 } }, async () => null), /invocation_unavailable/);
    await withRunDriverInvocation({ owner, signal, currentEpoch: () => epoch,
      authority: { runId: 'run-b', instanceId: 'another-instance', kernelEpoch: epoch } }, async other => {
      const received = await Promise.all([runDriverCall(context, async value => value.runId),
        runDriverCall({ owner, signal, invocation: other }, async value => value.runId)]);
      assert.deepEqual(received, ['run-a', 'run-b']);
    });
    epoch = 'epoch-b';
    assert.throws(() => runDriverCall(context, async () => null), /invocation_unavailable/);
  });
});

test('only a verified dependency callback temporarily receives its originating Run scope', async () => {
  const signal = new AbortController().signal, dependency = { ...owner, instanceKey: 'dependency', extensionId: 'example.dependency' };
  let saved!: HostInvocationScope;
  await withRunDriverInvocation({ owner, signal, currentEpoch: () => 'epoch',
    authority: { runId: 'run', instanceId: 'instance', kernelEpoch: 'epoch' } }, async invocation => {
    saved = invocation;
    const context = { owner: dependency, signal, invocation };
    assert.throws(() => runDriverCall(context, async () => null), /invocation_unavailable/);
    await invocation.invokeDependency!(owner, dependency, async () => {
      assert.equal(await runDriverCall(context, async value => value.runId), 'run');
    });
    assert.throws(() => runDriverCall(context, async () => null), /invocation_unavailable/);
  });
  assert.throws(() => runDriverCall({ owner, signal, invocation: saved }, async () => null), /invocation_unavailable/);
});


test('callback closure wakes abandoned observers before drainage without cancelling accepted effect work', async () => {
  const observer = deferred<void>(), effect = deferred<void>(), closed = deferred<void>();
  const signal = new AbortController().signal; let completed = false;
  const work = withRunDriverInvocation({ owner, signal, currentEpoch: () => 'epoch',
    authority: { runId: 'run', instanceId: 'instance', kernelEpoch: 'epoch' },
    closing: async () => { observer.resolve(); closed.resolve(); } }, async invocation => {
    const call = { owner, signal, invocation };
    void runDriverCall(call, () => observer.promise);
    void runDriverCall(call, () => effect.promise);
    return 'actual callback returned';
  }).then(value => { completed = true; return value; });
  await closed.promise;
  assert.equal(completed, false);
  effect.resolve();
  assert.equal(await work, 'actual callback returned');
});
