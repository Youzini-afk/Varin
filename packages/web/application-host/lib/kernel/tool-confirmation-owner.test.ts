import { expect, it, vi } from 'vitest';
import type { ApplicationExtensionRuntime, HostServiceBinding, HostInvocationScope } from '@varin/extension-host';
import { retainExtensionTool } from './extension-tool-owner.js';
import { permissionService } from './permission-service.js';
import { requireConfirmedToolInvocation } from './tool-confirmation.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall } from './protocol.generated.js';

it.each(['bypass', 'saved-allow'] as const)('requires exact approval despite %s, rejects concurrent execution and keeps lost response unknown', async mode => {
  const owner = { providerId: 'provider', providerKey: 'key', extensionId: 'fixture.effects', extensionVersion: '1', entrypointId: 'host', instanceKey: 'instance', generation: 1 };
  const signal = new AbortController().signal;
  const descriptor = { id: 'fixture.effect', version: 1, tool: { name: 'fixture_effect', description: 'Send exact content', operation: 'effect', completion: 'result', confirmation: 'always', inputSchema: { type: 'object' }, outputSchema: true } };
  const invoke = vi.fn(async (_method: string, args: unknown[], _signal: AbortSignal, scope: HostInvocationScope) => {
    requireConfirmedToolInvocation({ owner, signal, invocation: scope }, args[0]);
    throw new Error('response lost after dispatch');
  });
  const pin = { assertAvailable() {}, release() {}, revocationSignal: signal, invoke };
  const selected = { ...owner, descriptor, composition: { root: 'fixture' }, pin: () => pin, release() {} } as unknown as HostServiceBinding;
  const runtime = { services: { getSnapshot: () => ({ providers: [owner] }) }, supervisor: { getRetainedArtifactIdentity: () => 'artifact' } } as unknown as ApplicationExtensionRuntime;
  let permissionId = '';
  const executorOwner = { kind: 'kernel' as const };
  const kernel = { subscribeExit: () => () => {}, agentRuntimeRequest: vi.fn(async (method: string, input: { permissionId?: string }) => {
    if (method === 'runtime.permission.open') { permissionId = input.permissionId!; return {}; }
    if (method === 'runtime.permission.decide' || method === 'runtime.permission.consume') return {};
    if (method === 'runtime.operation.inspect') return { id: call.operationId, run_id: call.runId, phase: 'running', cancel_requested: false, execution_owner: executorOwner,
      intent: { origin: call.origin, call: { call_id: call.callId, name: call.name, schema_version: call.schemaVersion, arguments: call.arguments } } };
    if (method === 'runtime.run.inspect') return { id: call.runId, thread_id: 'thread', cancel_requested: false };
    if (method === 'runtime.launch.inspect') return { run_id: call.runId, selection: { source: null } };
    throw new Error(method);
  }) } as unknown as KernelClient;
  const retained = await retainExtensionTool({ runtime, kernel, currentPolicy: async () => ({ mode: mode === 'bypass' ? 'bypass' : 'normal', rules: mode === 'saved-allow' ? [{ tool: 'fixture_effect', decision: 'allow' }] : [] }) }, selected);
  const call = { operationId: 'request:tool:send', runId: 'run', callId: 'send', origin: { kind: 'model_step', request_id: 'request' }, name: 'fixture_effect', schemaVersion: retained.binding.tool.version, arguments: { from: 'sender', to: ['receiver'], body: 'Exact content' } } as HostToolCall;
  const authorization = retained.lease.authorize!(call, signal);
  await vi.waitFor(() => expect(permissionId).not.toBe(''));
  expect(invoke).not.toHaveBeenCalled();
  await permissionService(kernel).decide(call.operationId, permissionId, 'allow_once');
  await authorization;
  const [result, duplicate] = await Promise.all([
    retained.lease.execute(call, signal, executorOwner),
    retained.lease.execute(call, signal, executorOwner),
  ]);
  expect(duplicate.completion.kind).toBe('not_dispatched');
  expect(result.completion).toMatchObject({ outcome: 'indeterminate', effect: 'unknown' });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((await retained.lease.execute(call, signal, executorOwner)).completion.kind).toBe('not_dispatched');
  expect(invoke).toHaveBeenCalledTimes(1);
  retained.lease.release();
});
