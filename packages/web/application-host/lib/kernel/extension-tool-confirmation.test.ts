import { expect, it, vi } from 'vitest';
import { HostServiceRegistry, type ApplicationExtensionRuntime } from '@varin/extension-host';
import { retainExtensionTool } from './extension-tool-owner.js';
import { permissionService } from './permission-service.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall } from './protocol.generated.js';

async function fixture() {
  const descriptor = { id: 'example.gmail.send', version: 1, tool: { name: 'gmail_send',
    description: 'Send an email', operation: 'effect' as const, completion: 'result' as const,
    confirmation: 'always' as const, inputSchema: { type: 'object', required: ['to', 'subject', 'body'],
      properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' } },
      additionalProperties: false }, outputSchema: { type: 'object' } } };
  const owner = { extensionId: 'example.gmail', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'gmail-instance', generation: 1 };
  const executionOwner = { kind: 'kernel' as const };
  let opened!: { permissionId: string; call: HostToolCall; scope: Record<string, unknown> };
  let onOpen!: () => void;
  let waiting = new Promise<void>(resolve => { onOpen = resolve; });
  let activeCall!: HostToolCall;
  const executed = vi.fn(async () => ({ status: 'sent' }));
  const kernel = { subscribeExit: () => () => {}, agentRuntimeRequest: async (method: string, input: typeof opened) => {
    if (method === 'runtime.permission.open') { opened = structuredClone(input); onOpen(); return {}; }
    if (method === 'runtime.permission.decide') return { phase: 'running' };
    if (method === 'runtime.permission.consume') return {};
    if (method === 'runtime.operation.inspect') return { id: activeCall.operationId, run_id: activeCall.runId,
      phase: 'running', cancel_requested: false, execution_owner: executionOwner,
      intent: { origin: activeCall.origin, call: { call_id: activeCall.callId, name: activeCall.name,
        schema_version: activeCall.schemaVersion, arguments: activeCall.arguments } } };
    if (method === 'runtime.run.inspect') return { id: activeCall.runId, thread_id: 'thread', cancel_requested: false };
    if (method === 'runtime.launch.inspect') return { run_id: activeCall.runId, selection: { source: null } };
    throw new Error(`unexpected query ${method}`);
  } } as unknown as KernelClient;
  const services = new HostServiceRegistry('gmail-test-host');
  const registration = services.prepareOwnerReplacement(owner, [{ descriptor, handler: method => method === 'execute' ? executed() : {} }],
    { composition: { schemaVersion: 1, root: 'fixture', nodes: [] } });
  registration.commit(); await registration.finalize();
  const selected = services.bind(descriptor.id, descriptor.version);
  const runtime = { services,
    supervisor: { getRetainedArtifactIdentity: () => 'artifact' } } as unknown as ApplicationExtensionRuntime;
  const lease = await retainExtensionTool({ runtime, kernel, currentPolicy: async () => ({ mode: 'bypass', rules: [] }) }, selected);
  const preparePersistence = vi.fn(async () => ({ tool: 'gmail_send', scope: 'tool' as const, available: true }));
  permissionService(kernel).setPersistence({ prepare: preparePersistence, save: vi.fn(async () => ({ rules: [] })) });
  const call = (id: string): HostToolCall => ({ runId: 'run', operationId: `request:tool:${id}`,
    origin: { kind: 'model_step', request_id: 'request' }, callId: id, name: 'gmail_send',
    schemaVersion: lease.binding.tool.version, arguments: { to: ['recipient@example.test'], subject: 'Subject', body: 'Body' } });
  const start = (next: HostToolCall, signal: AbortSignal) => {
    activeCall = next; waiting = new Promise<void>(resolve => { onOpen = resolve; });
    return lease.lease.authorize(next, signal);
  };
  return { lease, kernel, call, start, executed, preparePersistence, executionOwner, services,
    wait: () => waiting, opened: () => opened };
}

it('requires a fresh exact confirmation even in bypass mode and rejects permanent approval', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  try {
    const first = f.call('one'), authorization = f.start(first, signal);
    await f.wait();
    await expect(f.services.invoke({ serviceId: 'example.gmail.send', version: 1, method: 'execute', args: [first.arguments] })).rejects.toThrow(/approved tool invocation/);
    expect(f.opened().call.arguments).toEqual(first.arguments);
    expect(f.opened().scope).toMatchObject({ confirmation: 'always' });
    expect(f.opened().scope.persistent).toBeUndefined();
    expect(f.preparePersistence).not.toHaveBeenCalled();
    await expect(permissionService(f.kernel).decide(first.operationId, f.opened().permissionId, 'allow_always')).rejects.toThrow();
    await permissionService(f.kernel).decide(first.operationId, f.opened().permissionId, 'allow_once');
    await authorization;
    expect(await f.lease.lease.execute(first, signal, f.executionOwner)).toMatchObject({ completion: { outcome: 'succeeded', effect: 'confirmed' } });
    expect(f.executed).toHaveBeenCalledTimes(1);
    const second = f.call('two'), next = f.start(second, signal);
    await f.wait();
    await permissionService(f.kernel).decide(second.operationId, f.opened().permissionId, 'deny');
    await expect(next).rejects.toThrow();
    expect(f.executed).toHaveBeenCalledTimes(1);
  } finally { f.lease.lease.release(); }
});

it('does not dispatch if the arguments change after approval', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  try {
    const call = f.call('changed'), authorization = f.start(call, signal);
    await f.wait();
    await permissionService(f.kernel).decide(call.operationId, f.opened().permissionId, 'allow_once');
    await authorization;
    const altered = { ...call, arguments: { to: ['other@example.test'], subject: 'Subject', body: 'Body' } };
    expect(await f.lease.lease.execute(altered, signal, f.executionOwner)).toMatchObject({ completion: { kind: 'not_dispatched' } });
    expect(f.executed).not.toHaveBeenCalled();
  } finally { f.lease.lease.release(); }
});
