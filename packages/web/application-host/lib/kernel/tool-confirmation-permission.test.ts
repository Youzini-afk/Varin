import { expect, it, vi } from 'vitest';
import { PermissionService } from './permission-service.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall } from './protocol.generated.js';

it('exact confirmation never prepares or saves an always rule, and consumes only after allow_once', async () => {
  let opened!: { permissionId: string; scope: unknown };
  const agentRuntimeRequest = vi.fn(async (method: string, input: unknown) => {
    if (method === 'runtime.permission.open') opened = input as typeof opened;
    return { id: 'operation', phase: 'waiting' };
  });
  const service = new PermissionService({ agentRuntimeRequest, subscribeExit: () => () => {} } as unknown as KernelClient);
  const prepare = vi.fn(), save = vi.fn(); service.setPersistence({ prepare, save });
  const call = { operationId: 'operation', runId: 'run', name: 'send', arguments: { body: 'full content' } } as HostToolCall;
  const pending = service.authorize(call, { ownerReference: 'owner', ownerGeneration: 1, toolSchemaVersion: '1', policyGeneration: '1', reason: 'exact action', confirmation: 'always',
    persistent: { tool: 'send', scope: 'tool', available: true } }, new AbortController().signal, { name: 'send', arguments: call.arguments as Record<string, unknown> });
  await vi.waitFor(() => expect(opened).toBeDefined());
  expect(opened.scope).not.toHaveProperty('persistent'); expect(prepare).not.toHaveBeenCalled();
  await expect(service.decide('operation', opened.permissionId, 'allow_always')).rejects.toMatchObject({ code: 'permission_persistence_unavailable' });
  expect(save).not.toHaveBeenCalled();
  expect(agentRuntimeRequest.mock.calls.some(([method]) => method === 'runtime.permission.consume')).toBe(false);
  await service.decide('operation', opened.permissionId, 'allow_once'); await pending;
  expect(agentRuntimeRequest.mock.calls.filter(([method]) => method === 'runtime.permission.consume')).toHaveLength(1);
});
