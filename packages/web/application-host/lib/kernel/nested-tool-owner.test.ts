import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import { createNestedToolOwner } from './nested-tool-owner.js';
import type { KernelClient } from './kernel-client.js';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import { toolOperationId, validToolOrigin, type NestedToolInvokeParams, type NestedToolInspectParams } from './protocol.generated.js';
const owner = { extensionId: 'example.compose', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'nested-tool-owner-fixture', generation: 4 };
const authority: ToolInvocationAuthority = {
  invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'request:tool:outer', callId: 'outer',
  executorOwner: { kind: 'external', identity: 'retained-host-tool', epoch: 'original-epoch' },
  origin: { kind: 'model_step', request_id: 'request' }, source: null, completion: 'result', toolName: 'compose', operation: 'effect', arguments: {},
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('nested capability uses only original verified caller authority and drains detached actual RPC', async () => {
  const entered = deferred<void>(), result = deferred<unknown>();
  let request!: NestedToolInvokeParams;
  const handler = createNestedToolOwner({ async agentRuntimeRequest(method: string, params: NestedToolInvokeParams, signal?: AbortSignal) {
    assert.equal(method, 'runtime.tools.invoke'); assert.equal(signal, undefined, 'observer abort is not completion evidence');
    request = params; entered.resolve(); return result.promise;
  } } as KernelClient);
  const cancel = new AbortController(); let context!: HostCapabilityCallContext;
  let settled = false;
  const work = withToolInvocation({ authority, owner, signal: cancel.signal }, async invocation => {
    context = { owner, signal: cancel.signal, invocation };
    void handler('invoke', { callId: 'inner', name: 'memory', arguments: { action: 'read' } }, context);
    await entered.promise;
    return 'callback returned';
  }).then(value => { settled = true; return value; });
  await entered.promise; await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(request, { parentOperationId: authority.operationId, executorOwner: authority.executorOwner,
    call: { callId: 'inner', name: 'memory', arguments: { action: 'read' } } });
  cancel.abort();
  await assert.rejects(async () => await handler('invoke', { callId: 'late', name: 'memory', arguments: {} }, context), /tool_invocation_unavailable/);
  assert.equal(settled, false);
  result.resolve({ operationId: toolOperationId({ kind: 'nested_call', parent_operation_id: authority.operationId }, 'inner'),
    completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { data: null, parts: [] } } });
  assert.equal(await work, 'callback returned');
});

test('original scope supplies authority while complete input reaches the canonical Rust decoder', async () => {
  const calls: NestedToolInvokeParams[] = [];
  const handler = createNestedToolOwner({ agentRuntimeRequest: async (_method: string, params: NestedToolInvokeParams) => {
    calls.push(params); throw new Error('canonical decoder rejected input');
  } } as unknown as KernelClient);
  const signal = new AbortController().signal;
  await withToolInvocation({ authority, owner, signal }, async invocation => {
    for (const extra of [{ schemaVersion: 'borrowed' }, { runId: 'other' }, { source: {} }, { executorOwner: { kind: 'kernel' } }]) {
      const input = { callId: 'inner', name: 'memory', arguments: {}, ...extra };
      await assert.rejects(async () => await handler('invoke', input, { owner, signal, invocation }), /canonical decoder rejected input/);
      assert.deepEqual(calls.at(-1), { parentOperationId: authority.operationId, executorOwner: authority.executorOwner, call: input });
    }
    await assert.rejects(async () => await handler('invoke', { callId: 'inner', name: 'memory', arguments: {} }, { owner: { ...owner, generation: 5 }, signal, invocation }), /tool_invocation_unavailable/);
  });
  assert.equal(calls.length, 4, 'an unavailable scope never forwards a request');
});

test('shared origin helper preserves Unicode bytes and distinct deep invocation identities', () => {
  const parent = 'request:tool:é外'; const origin = { kind: 'nested_call' as const, parent_operation_id: parent };
  assert.equal(toolOperationId(origin, 'call'), `nested:18:${parent}:call`);
  assert.notEqual(toolOperationId(origin, 'x:nested:y'), toolOperationId({ kind: 'nested_call', parent_operation_id: toolOperationId(origin, 'x') }, 'y'));
  assert.equal(validToolOrigin(origin), true);
  assert.equal(validToolOrigin({ ...origin, request_id: 'invented' }), false);
});

test('tool discovery sends only the live original invocation and expires with its callback', async () => {
  const calls: NestedToolInspectParams[] = [];
  const handler = createNestedToolOwner({ async agentRuntimeRequest(method: string, params: NestedToolInspectParams) {
    assert.equal(method, 'runtime.tools.inspect'); calls.push(params);
    return params.name ? { action: 'describe', origin: 'accepted_run', permission: 'checked_on_invocation', runId: 'run', generation: 9, tool: null }
      : { action: 'list', origin: 'accepted_run', permission: 'checked_on_invocation', runId: 'run', generation: 9, tools: [] };
  } } as KernelClient);
  const signal = new AbortController().signal;
  let context!: HostCapabilityCallContext;
  await withToolInvocation({ authority, owner, signal }, async invocation => {
    context = { owner, signal, invocation };
    await handler('list', {}, context);
    await handler('describe', { name: 'not-selected' }, context);
    assert.deepEqual(calls, [
      { parentOperationId: authority.operationId, executorOwner: authority.executorOwner },
      { parentOperationId: authority.operationId, executorOwner: authority.executorOwner, name: 'not-selected' },
    ]);
    for (const [method, params] of [['list', { runId: 'other' }], ['describe', { name: 'read', generation: 100 }], ['describe', { name: '' }]] as const) {
      await assert.rejects(async () => handler(method, params, context), /inspection_invalid/);
    }
    await assert.rejects(async () => handler('list', {}, { ...context, owner: { ...owner, generation: 5 } }), /invocation_unavailable/);
  });
  await assert.rejects(async () => handler('list', {}, context), /invocation_unavailable/);
  assert.equal(calls.length, 2);
});
