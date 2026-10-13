/** A projection of the original target Task, independent of its creating Run view. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { McpTaskRequestError } from '@varin/pi-host/mcp-errors';
import type { McpTaskLease, McpTaskResponse } from '@varin/pi-host/mcp-authority';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';
import type { ManagedMcpTaskAction } from '../harness/managed-mcp-contract.js';
import type { SourceMcpHolderBinding } from './protocol.generated.js';
export async function requestManagedMcpTask<T>(client: ManagedSourceClient, address: ManagedSourceAddress, action: ManagedMcpTaskAction, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new McpTaskRequestError('mcp_task_request_cancelled', false, 'owner');
  let reply;
  try { reply = await client.service({ ...address, requestId: `mcp-task:${randomUUID()}`, operation: { kind: 'mcp', action } }, signal); }
  catch { throw new McpTaskRequestError('mcp_task_source_response_lost', true, 'transport'); }
  if (!reply.ok) throw new McpTaskRequestError(reply.error.code, reply.error.dispatched, reply.error.taskKind ?? 'owner',
    reply.error.rpcCode, reply.error.protocolError, reply.error.settlement, reply.error.interactionProblem);
  return reply.value as T;
}
export function createManagedMcpTaskLease(input: {
  client: ManagedSourceClient; address: ManagedSourceAddress; binding: SourceMcpHolderBinding;
  creation?: { handleId: string; lifetime: AbortSignal };
}): McpTaskLease {
  const lifetime = new AbortController();
  const request = <T>(action: ManagedMcpTaskAction, signal: AbortSignal) => requestManagedMcpTask<T>(input.client, input.address, action, AbortSignal.any([signal, lifetime.signal]));
  return {
    endpoint: input.binding.endpoint,
    async start(name, arguments_, options) {
      if (!input.creation || !isDeepStrictEqual(options.interaction, { operationId: input.binding.operationId, executionOwner: input.binding.executionOwner }))
        throw new McpTaskRequestError('mcp_task_original_dispatch_unavailable', false, 'owner');
      try {
        input.creation.lifetime.throwIfAborted(); options.signal.throwIfAborted(); lifetime.signal.throwIfAborted();
        await options.beforeDispatch?.();
      } catch { throw new McpTaskRequestError('mcp_task_dispatch_admission_rejected', false, 'owner'); }
      return request<McpTaskResponse>({ kind: 'task_start', handleId: input.creation.handleId, binding: input.binding, name,
        schemaVersion: options.schemaVersion, arguments: arguments_, ...(options.ttl === undefined ? {} : { ttl: options.ttl }) },
        AbortSignal.any([options.signal, input.creation.lifetime]));
    },
    get: (taskId, signal) => request({ kind: 'task_get', binding: input.binding, taskId }, signal),
    result: (taskId, signal) => request({ kind: 'task_result', binding: input.binding, taskId }, signal),
    cancel: (taskId, signal) => request({ kind: 'task_cancel', binding: input.binding, taskId }, signal),
    // A's existing scheduler observes Task status. B never starts a second poller.
    onChange: () => () => {},
    // Projection disposal must not release a durable holder at shutdown or Run end.
    // Catalog's pending owner cleanup invokes task_release separately and awaits it.
    release: () => lifetime.abort(),
  };
}
