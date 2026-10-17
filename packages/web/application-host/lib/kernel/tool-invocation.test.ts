import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import { withToolInvocation, runToolDomainCall, requireToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const owner = { extensionId: 'example.integration', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'invocation-fixture', generation: 1 };
const authority: ToolInvocationAuthority = {
  callId: 'merge', executorOwner: { kind: 'kernel' }, invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'action:node:merge',
  origin: { kind: 'policy_action', action_id: 'action', node_id: 'merge' }, source: null,
  toolName: 'integrate_child', completion: 'result', operation: 'effect', arguments: { childOperationId: 'child', resultRevision: 2 },
};
const input = { operation: 'effect' as const, domain: 'collaboration.integrations', toolName: 'integrate_child', arguments: authority.arguments as { childOperationId: string; resultRevision: number } };
const receipt: ToolExecutionReceipt = { completion: { kind: 'result', outcome: 'indeterminate', effect: 'partial', content: { data: { status: 'conflict', appliedPaths: ['a'] }, parts: [] } }, executor_stopped: true };

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
  assert.deepEqual(observed?.completion, { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { data: { error: 'host_tool_effect_unknown' }, parts: [] } });
});

test('domain result and accepted job preserve JSON null; only a bodyless job projects its handle', async () => {
  for (const completion of [
    { kind:'result' as const,outcome:'succeeded' as const,effect:'confirmed' as const,content:{data:null,parts:[]} },
    { kind:'job_accepted' as const,operation_id:authority.operationId,phase:'accepted',effect:'confirmed' as const,lifetime:'thread' as const,content:{data:null,parts:[]} },
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


test('explicit output retains accepted order on callback failure and job output remains with its owning domain', async () => {
  const { emitToolOutput } = await import('./tool-invocation.js');
  const signal = new AbortController().signal;
  const parts: unknown[] = [];
  const image = { kind: 'media', media: { media_type: 'image/png', data_base64: 'aW1hZ2U=' } };
  await assert.rejects(withToolInvocation({ authority, owner, signal, onOutput: value => parts.push(...value) }, async invocation => {
    const context = { owner, signal, invocation };
    emitToolOutput(context, { kind: 'text', text: 'before' });
    emitToolOutput(context, image);
    assert.throws(() => emitToolOutput(context, { kind: 'media', media: { media_type: 'image/png', content_ref: { content_object: 'arbitrary' } } }), /media|output/i);
    throw new Error('outer callback failed');
  }), /outer callback failed/);
  assert.deepEqual(parts, [{ kind: 'text', text: 'before' }, image]);
  await withToolInvocation({ authority: { ...authority, completion: 'job' }, owner, signal, onOutput: value => assert.deepEqual(value, []) }, async invocation => {
    assert.throws(() => emitToolOutput({ owner, signal, invocation }, image), /owning domain.*acceptance or terminal/);
  });
});

test('frozen broker/native dependencies borrow only each actual root invocation and retain its real drain', { timeout: 30_000 }, async () => {
  const { ApplicationExtensionRuntime } = await import('@varin/extension-host');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { runNestedToolCall } = await import('./tool-invocation.js');
  for (const mode of ['brokered', 'native'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'varin-dependency-authority-'));
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3',
      brokerScript: fileURLToPath(new URL('../../../../extension-host/broker/broker-child.mjs', import.meta.url)) });
    await runtime.start();
    const contexts: HostCapabilityCallContext[] = [];
    let effects = 0, finish!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    runtime.capabilities.register('example.domain', (method, _params, context) => {
      contexts.push(context);
      const admitted = requireToolInvocation(context);
      if (method === 'effect') return runToolDomainCall(context, input, async () => { effects++; return receipt; });
      if (method === 'block') return runNestedToolCall(context, async () => { entered(); await blocked; return null; });
      return { runId: admitted.runId, operation: admitted.operation, toolName: admitted.toolName };
    });
    const install = async (id: string, dependency: boolean) => {
      const path = join(root, id); await mkdir(path);
      const descriptor = { id: dependency ? 'example.authority-dependency' : 'example.authority-root', version: 1 };
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
      await writeFile(join(path, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
        entrypoints: { host: { mode, file: 'host.cjs', activation: ['service-request'] } }, provides: { services: [descriptor] },
        ...(dependency ? { capabilities: { host: ['example.domain'] } } : { requires: { services: [{ realms: ['host'], id: 'example.authority-dependency', version: 1 }] } }) }));
      await writeFile(join(path, 'host.cjs'), `module.exports={activate(ctx){
        ${dependency ? '' : "const dependency=ctx.services.use('example.authority-dependency',1);"}
        ctx.services.provide(${JSON.stringify(descriptor)},{execute(method){return ${dependency ? "ctx.capabilities.call('example.domain',method,null)" : "dependency.call('execute',method)"}}});
      }};`);
      await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision, source: { kind: 'local', display: id, specifier: path } });
      if (dependency) await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision,
        decisions: [{ capability: 'example.domain', realm: 'host', granted: true }] });
      await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
    };
    let binding: Awaited<ReturnType<typeof runtime.prepareService>> | undefined;
    let pin: ReturnType<NonNullable<typeof binding>['pin']> | undefined;
    try {
      await install('example.authority-b', true); await install('example.authority-a', false);
      binding = await runtime.prepareService({ serviceId: 'example.authority-root', version: 1, method: 'execute', args: [] });
      pin = binding.pin();
      const selected = runtime.services.getSnapshot().providers.find(provider => provider.providerId === binding!.providerId)!;
      const invoke = (runId: string, operation: 'read' | 'effect', method: string, signal = new AbortController().signal) => {
        const callId = `call-${runId}`;
        return withToolInvocation({ owner: selected, signal, authority: { ...authority, runId, operation,
          callId, invocationId: runId, operationId: `action:node:${callId}`, origin: { kind: 'policy_action', action_id: 'action', node_id: callId } } },
        scope => pin!.invoke('execute', [method], signal, scope));
      };
      assert.deepEqual(await Promise.all([invoke('one', 'read', 'read'), invoke('two', 'effect', 'read')]), [
        { runId: 'one', operation: 'read', toolName: 'integrate_child' }, { runId: 'two', operation: 'effect', toolName: 'integrate_child' },
      ]);
      assert(contexts.every(context => context.owner.extensionId === 'example.authority-b'));
      for (const context of contexts) assert.throws(() => requireToolInvocation(context), /tool_invocation_unavailable/);
      await assert.rejects(invoke('read-denied', 'read', 'effect'), /tool_domain_call_changed/);
      assert.equal(effects, 0, 'a write-capable dependency cannot expand the root read admission');
      await invoke('effect-admitted', 'effect', 'effect'); assert.equal(effects, 1);
      const cancel = new AbortController(); let settled = false;
      const pending = invoke('cancelled', 'read', 'block', cancel.signal).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
      await started; cancel.abort(new Error('root cancelled')); binding.release(); pin.release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'cancellation cannot settle while the original dependent domain still owns real work');
      assert.throws(() => requireToolInvocation(contexts.at(-1)!), /tool_invocation_unavailable/);
      finish(); await pending;
    } finally { finish(); pin?.release(); binding?.release(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
  }
});
