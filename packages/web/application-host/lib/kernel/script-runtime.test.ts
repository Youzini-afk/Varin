import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SCRIPT_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { createScriptRuntime } from './script-runtime.js';
import { withToolInvocation } from './tool-invocation.js';

test('a new script reaches its own admission while an old environment is still draining', async () => {
  let release!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  let beginNew!: () => void;
  const newAdmission = new Promise<void>(resolve => { beginNew = resolve; });
  const old = { id: 'old-environment', managed_process: { purpose: { kind: 'script_environment' } },
    execution_owner: { kind: 'external', identity: 'old', epoch: 'old' } };
  const kernel = {
    kernelEpoch: 'current',
    async agentRuntimeRequest(method: string) {
      if (method === 'runtime.managed_process.pending') return [old];
      assert.equal(method, 'runtime.managed_process.begin'); beginNew();
    },
  };
  const runtime = {
    onEvent: () => () => {}, onReady: () => () => {},
    cancelOperation: () => draining,
    launch: async () => null,
  };
  const scripts = createScriptRuntime({ kernel: kernel as never, runtime: runtime as never,
    resolveLiveSource: async () => {}, onError: error => { throw error; } });
  const declaration = SCRIPT_TOOL_DECLARATIONS.find(value => value.tool?.name === 'script_open')!;
  const owner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'script-test', generation: 1 };
  const signal = new AbortController().signal;
  let call: Promise<unknown> | undefined;
  try {
    const configurationIdentity = (await scripts.prepareConfiguration(() => null, null))(declaration);
    call = withToolInvocation({ owner, signal, authority: {
      invocationId: 'new', operationId: 'request:tool:new', callId: 'new', runId: 'new-run', threadId: 'new-thread',
      executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'request' }, source: null,
      toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity, arguments: {},
    } }, async invocation => scripts.capability('open', {}, { owner, signal, invocation }));
    // This is before the old cancellation resolves. The new source admission is
    // intentionally absent; real evaluator/process behavior has its own Rust fixture.
    await newAdmission;
    assert.deepEqual(await call, { error: 'Script environment requires the original physical source' });
  } finally { release(); await call; await scripts.dispose(); }
});
