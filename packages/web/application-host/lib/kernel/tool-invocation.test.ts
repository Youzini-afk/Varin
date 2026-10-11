import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import { withToolInvocation, runToolDomainCall, requireToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const owner = { extensionId: 'example.integration', extensionVersion: '1.0.0', entrypointId: 'host', generation: 1 };
const authority: ToolInvocationAuthority = {
  callId: 'merge', executorOwner: { kind: 'kernel' }, invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'action:node:merge',
  origin: { kind: 'policy_action', action_id: 'action', node_id: 'merge' }, source: null,
  toolName: 'integrate_child', operation: 'effect', arguments: { childOperationId: 'child', resultRevision: 2 },
};
const input = { operation: 'effect' as const, domain: 'collaboration.integrations', toolName: 'integrate_child', arguments: authority.arguments as { childOperationId: string; resultRevision: number } };
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
    void runToolDomainCall(context, input, execute);
    void runToolDomainCall(context, input, execute);
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
  assert.throws(() => runToolDomainCall(context, input, async () => receipt), /tool_invocation_unavailable/);
});

test('a domain effect requires the exact permission-admitted arguments and original live owner', async () => {
  const signal = new AbortController().signal;
  let executed = false;
  await withToolInvocation({ authority, owner, signal }, async invocation => {
    const context = { owner, signal, invocation };
    assert.throws(() => runToolDomainCall(context, { ...input, arguments: { childOperationId: 'other', resultRevision: 2 } }, async () => { executed = true; return receipt; }), /tool_domain_call_changed/);
    assert.throws(() => runToolDomainCall({ ...context, owner: { ...owner, generation: 2 } }, input, async () => receipt), /tool_invocation_unavailable/);
  });
  await withToolInvocation({ authority: { ...authority, operation: 'read' }, owner, signal }, async invocation => {
    assert.throws(() => runToolDomainCall({ owner, signal, invocation }, input, async () => { executed = true; return receipt; }), /tool_domain_call_changed/);
  });
  assert.equal(executed, false);
});


test('lost domain transport remains unknown and occupied after the broker callback returns', async () => {
  const signal = new AbortController().signal;
  let observed: ToolExecutionReceipt | undefined;
  await withToolInvocation({ authority, owner, signal, onEffectReceipt: value => { observed = value; } }, async invocation => {
    await assert.rejects(runToolDomainCall({ owner, signal, invocation }, input, async () => { throw new Error('file response lost'); }), /file response lost/);
    return { pretendSuccess: true };
  });
  assert.equal(observed?.executor_stopped, false);
  assert.deepEqual(observed?.completion, { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { error: 'host_tool_effect_unknown' } });
});

test('domain result and accepted job preserve JSON null; only a bodyless job projects its handle', async () => {
  for (const completion of [
    { kind:'result' as const,outcome:'succeeded' as const,effect:'confirmed' as const,content:null },
    { kind:'job_accepted' as const,operation_id:authority.operationId,phase:'accepted',effect:'confirmed' as const,lifetime:'thread' as const,content:null },
    { kind:'job_accepted' as const,operation_id:authority.operationId,phase:'awaiting_job',effect:'none' as const,lifetime:'thread' as const },
  ]) {
    const signal=new AbortController().signal;
    const value=await withToolInvocation({authority,owner,signal},invocation=>runToolDomainCall({owner,signal,invocation},input,async()=>({executor_stopped:false,completion})));
    assert.deepEqual(value,completion.kind==='job_accepted'&&completion.content===undefined?{operationId:authority.operationId,phase:'awaiting_job'}:null);
  }
});

test('actual live nested ancestry attaches Computer use only to its own cell and proves exact self-wait cycles', async () => {
  const { withScriptCell, noteInvocationComputerUse, assertNoScriptCellCycle, assertNoScriptComputerStopCycle } = await import('./tool-invocation.js');
  const { toolOperationId } = await import('./protocol.generated.js');
  const signal = new AbortController().signal;
  const desktops = new Set<string>();
  const cancellations = new Set<(reason: unknown) => void>();
  const dispatch = new AbortController();
  await withToolInvocation({ authority, owner, signal }, async invocation => {
    const outer = { owner, signal, invocation };
    await withScriptCell(outer, { environmentId: 'environment-A', computerCancellation(cancel) { cancellations.add(cancel); return () => { cancellations.delete(cancel); }; }, computerUsed: id => { desktops.add(id); }, usesComputer: id => desktops.has(id) }, async () => {
      const origin = { kind: 'nested_call' as const, parent_operation_id: authority.operationId };
      await withToolInvocation({ authority: { ...authority, invocationId: 'nested', callId: 'computer', operationId: toolOperationId(origin, 'computer'), origin }, owner, signal }, async nested => {
        const context = { owner, signal, invocation: nested };
        assert.doesNotThrow(() => assertNoScriptComputerStopCycle(context, 'desktop-1'));
        const remove = noteInvocationComputerUse(context, 'desktop-1', reason => dispatch.abort(reason));
        assert.equal(cancellations.size, 1);
        for (const cancel of cancellations) cancel(new Error('cell stop'));
        assert.equal(dispatch.signal.aborted, true);
        remove();
        assert.equal(cancellations.size, 0);
        assert.deepEqual([...desktops], ['desktop-1']);
        assert.throws(() => assertNoScriptCellCycle(context, 'environment-A'), /dependency_cycle/);
        assert.doesNotThrow(() => assertNoScriptCellCycle(context, 'environment-B'));
        assert.throws(() => assertNoScriptComputerStopCycle(context, 'desktop-1'), /independent ordinary tool call/);
        assert.doesNotThrow(() => assertNoScriptComputerStopCycle(context, 'desktop-2'));
      });
    });
    // A later work segment cannot inherit the ended cell's desktop use.
    const origin = { kind: 'nested_call' as const, parent_operation_id: authority.operationId };
    await withToolInvocation({ authority: { ...authority, invocationId: 'later', callId: 'later', operationId: toolOperationId(origin, 'later'), origin }, owner, signal }, async invocation => {
      assert.doesNotThrow(() => assertNoScriptComputerStopCycle({ owner, signal, invocation }, 'desktop-1'));
    });
  });
});
