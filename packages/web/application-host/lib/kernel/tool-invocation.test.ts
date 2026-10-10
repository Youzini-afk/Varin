import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import { withToolInvocation, runToolDomainEffect, requireToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const owner = { extensionId: 'example.integration', extensionVersion: '1.0.0', entrypointId: 'host', generation: 1 };
const authority: ToolInvocationAuthority = {
  invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'action:node:merge',
  origin: { kind: 'policy_action', action_id: 'action', node_id: 'merge' }, source: null,
  toolName: 'integrate_child', operation: 'effect', arguments: { childOperationId: 'child', resultRevision: 2 },
};
const input = { domain: 'collaboration.integrations', toolName: 'integrate_child', arguments: authority.arguments as { childOperationId: string; resultRevision: number } };
const receipt: ToolExecutionReceipt = { completion: { kind: 'result', outcome: 'indeterminate', effect: 'partial', content: { status: 'conflict', appliedPaths: ['a'] } }, executor_stopped: true };

test('a returned broker callback cannot retire its still-running domain effect or forge its receipt', async () => {
  const signal = new AbortController().signal;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  let callbackReturned!: () => void;
  const returned = new Promise<void>(resolve => { callbackReturned = resolve; });
  let context!: HostCapabilityCallContext;
  let observed: ToolExecutionReceipt | undefined;
  let calls = 0;
  let settled = false;
  const work = withToolInvocation({ authority, owner, signal, onEffectReceipt: value => { observed = value; } }, async invocation => {
    context = { owner, signal, invocation };
    const execute = async () => { calls += 1; await blocked; return receipt; };
    void runToolDomainEffect(context, input, execute);
    void runToolDomainEffect(context, input, execute);
    callbackReturned();
    return { fakeEffect: 'none' };
  }).then(value => { settled = true; return value; });
  await returned;
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  assert.equal(observed, undefined);
  assert.throws(() => requireToolInvocation(context), /tool_invocation_unavailable/);
  finish();
  assert.deepEqual(await work, { fakeEffect: 'none' });
  assert.deepEqual(observed, receipt);
  assert.throws(() => runToolDomainEffect(context, input, async () => receipt), /tool_invocation_unavailable/);
});

test('a domain effect requires the exact permission-admitted arguments and original live owner', async () => {
  const signal = new AbortController().signal;
  let executed = false;
  await withToolInvocation({ authority, owner, signal }, async invocation => {
    const context = { owner, signal, invocation };
    assert.throws(() => runToolDomainEffect(context, { ...input, arguments: { childOperationId: 'other', resultRevision: 2 } }, async () => { executed = true; return receipt; }), /tool_domain_call_changed/);
    assert.throws(() => runToolDomainEffect({ ...context, owner: { ...owner, generation: 2 } }, input, async () => receipt), /tool_invocation_unavailable/);
  });
  await withToolInvocation({ authority: { ...authority, operation: 'read' }, owner, signal }, async invocation => {
    assert.throws(() => runToolDomainEffect({ owner, signal, invocation }, input, async () => { executed = true; return receipt; }), /tool_domain_call_changed/);
  });
  assert.equal(executed, false);
});


test('lost domain transport remains unknown and occupied after the broker callback returns', async () => {
  const signal = new AbortController().signal;
  let observed: ToolExecutionReceipt | undefined;
  await withToolInvocation({ authority, owner, signal, onEffectReceipt: value => { observed = value; } }, async invocation => {
    await assert.rejects(runToolDomainEffect({ owner, signal, invocation }, input, async () => { throw new Error('file response lost'); }), /file response lost/);
    return { pretendSuccess: true };
  });
  assert.equal(observed?.executor_stopped, false);
  assert.deepEqual(observed?.completion, { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { error: 'host_tool_effect_unknown' } });
});
