import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import type { NestedToolReceipt, VarinHostServiceHandler, VarinHostServiceInvocationContext } from '@varin/extension-sdk';
import { runHostExtensionConformance } from '@varin/extension-sdk/testing';
import extension from './host.ts';

// A consumer unit harness: real SDK registration and invocation-scoped capability adaptation,
// with controlled completion inputs. No broker, permission authority or memory store is simulated.
async function withTool(check: (handler: VarinHostServiceHandler) => Promise<void>) {
  await runHostExtensionConformance({ dependencies: [], extensionId: 'example.nested-tools', activation: async context => {
    let handler: VarinHostServiceHandler | undefined;
    const provide = context.services.provide;
    context.services.provide = (descriptor, implementation) => {
      assert.equal(handler, undefined);
      handler = implementation;
      provide(descriptor, implementation);
    };
    await extension.activate(context);
    assert.ok(handler);
    await check(handler);
  } });
}

function invocation(invoke: (input: JsonValue) => NestedToolReceipt | Promise<NestedToolReceipt>): VarinHostServiceInvocationContext {
  return {
    callId: 'outer-consumer-fixture',
    signal: new AbortController().signal,
    capabilities: { async call(capability, method, input) {
      assert.equal(capability, 'runtime.tools');
      assert.equal(method, 'invoke');
      return parseVarinToolJson(await invoke(input));
    } },
  };
}

test('registered tool forwards only the supplied arguments and retains both original receipts', async () => {
  await withTool(async handler => {
    const calls: JsonValue[] = [];
    const memory: NestedToolReceipt = { operationId: 'fixture-memory', completion: {
      kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { opaqueDomainReceipt: 'fixture-only' },
    } };
    const read: NestedToolReceipt = { operationId: 'fixture-read', completion: {
      kind: 'result', outcome: 'failed', effect: 'none', content: { opaqueFailure: 'fixture-only' },
    } };
    let completeMemory!: (receipt: NestedToolReceipt) => void;
    const pendingMemory = new Promise<NestedToolReceipt>(resolve => { completeMemory = resolve; });
    const input = {
      memory: { action: 'save', scope: 'currentThread', content: 'Explicit test note', revision: 7 },
      read: { path: 'notes.txt', offset: 3, length: 12 },
    };
    const result = handler.execute!([input], invocation(value => {
      calls.push(value);
      return calls.length === 1 ? pendingMemory : read;
    }));
    assert.deepEqual([...calls], [{ callId: 'memory', name: 'memory', arguments: input.memory }]);
    completeMemory(memory);
    assert.deepEqual(await result, { memory, read: { status: 'invoked', receipt: read } });
    assert.deepEqual([...calls], [
      { callId: 'memory', name: 'memory', arguments: input.memory },
      { callId: 'read', name: 'file_read', arguments: input.read },
    ]);

    calls.length = 0;
    assert.deepEqual(await handler.execute!([{ memory: { action: 'read' } }], invocation(value => {
      calls.push(value);
      return memory;
    })), { memory, read: { status: 'not_requested' } });
    assert.deepEqual([...calls], [{ callId: 'memory', name: 'memory', arguments: { action: 'read' } }]);
  });
});

test('non-success and JobAccepted completions skip the optional read; transport errors still reject', async () => {
  await withTool(async handler => {
    const completions: NestedToolReceipt['completion'][] = [
      { kind: 'not_dispatched', reason: 'fixture denial' },
      ...(['failed', 'cancelled', 'indeterminate'] as const).map(outcome => ({
        kind: 'result' as const, outcome, effect: 'unknown' as const, content: null,
      })),
      { kind: 'job_accepted', operation_id: 'fixture-job', phase: 'running', effect: 'dispatched', lifetime: 'thread', content: {} },
    ];
    const input = { memory: { action: 'read' }, read: { path: 'notes.txt' } };
    for (const completion of completions) {
      const memory: NestedToolReceipt = { operationId: 'fixture-memory', completion };
      let calls = 0;
      assert.deepEqual(await handler.execute!([input], invocation(() => {
        calls++;
        return memory;
      })), { memory, read: { status: 'skipped', reason: 'memory_not_succeeded' } });
      assert.equal(calls, 1);
    }
    const unavailable = new Error('fixture capability transport unavailable');
    await assert.rejects(async () => handler.execute!([input], invocation(() => { throw unavailable; })), error => error === unavailable);
  });
});
