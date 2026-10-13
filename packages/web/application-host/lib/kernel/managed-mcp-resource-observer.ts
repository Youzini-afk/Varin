/** Local notification projection of one original target observer. No remote replay cursor. */
import { randomUUID } from 'node:crypto';
import { McpAuthorityError } from '@varin/pi-host/mcp-errors';
import type { McpResourceObserver, McpResourceChange, McpResourceRelease } from '@varin/pi-host/mcp-authority';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';
import type { ManagedMcpResourceAction, ManagedMcpResourceSnapshot } from '../harness/managed-mcp-contract.js';
import type { McpResourceBinding } from './protocol.generated.js';

export async function requestManagedMcpResource<T>(client: ManagedSourceClient, address: ManagedSourceAddress,
  action: ManagedMcpResourceAction, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new McpAuthorityError('mcp_resource_request_cancelled');
  let reply;
  try { reply = await client.service({ ...address, requestId: `mcp-resource:${randomUUID()}`, operation: { kind: 'mcp', action } }, signal); }
  catch { throw new McpAuthorityError('mcp_resource_source_response_lost', true); }
  if (!reply.ok) throw new McpAuthorityError(reply.error.code, reply.error.dispatched, reply.error.settlement,
    reply.error.protocolError, reply.error.interactionProblem);
  return reply.value as T;
}
export function createManagedMcpResourceObserver(input: {
  client: ManagedSourceClient; address: ManagedSourceAddress; binding: McpResourceBinding;
  listenerId: string; acknowledgement: Record<string, unknown>; revision: number;
  onChange(change: McpResourceChange): void;
}): McpResourceObserver {
  const lifetime = new AbortController();
  const listenerId = `mcp-resource-view:${randomUUID()}`;
  let after = input.revision, cleanup: Promise<McpResourceRelease> | undefined;
  const disconnect = () => lifetime.abort();
  void (async () => {
    while (!lifetime.signal.aborted) {
      try {
        const next = await requestManagedMcpResource<ManagedMcpResourceSnapshot>(input.client, input.address, {
          kind: 'resource_watch', binding: input.binding, listenerId: input.listenerId, after,
        }, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (next.listenerId !== input.listenerId || !Number.isSafeInteger(next.revision) || next.revision <= after
          || !Array.isArray(next.changes) || next.changes.some(entry => !Number.isSafeInteger(entry.revision)
            || entry.revision <= after || entry.revision > next.revision || !entry.change
            || !['updated', 'unresolved_association', 'gap', 'unavailable'].includes(entry.change.kind)))
          throw new McpAuthorityError('mcp_resource_original_watch_changed');
        after = next.revision;
        for (const entry of next.changes) {
          if (lifetime.signal.aborted) return;
          if (entry.change.kind === 'updated' && entry.change.notification?.uri !== input.binding.uri)
            throw new McpAuthorityError('mcp_resource_original_notification_changed');
          input.onChange(entry.change);
          if (entry.change.kind === 'gap' || entry.change.kind === 'unavailable') return;
        }
      } catch (error) {
        if (!lifetime.signal.aborted) input.onChange(error instanceof McpAuthorityError && !error.dispatched
          ? { kind: 'unavailable', problem: error.code } : { kind: 'gap' });
        return;
      }
    }
  })();
  return {
    endpoint: input.binding.endpoint, listenerId, acknowledgement: input.acknowledgement, disconnect,
    detach(options) {
      disconnect();
      return cleanup ??= requestManagedMcpResource<{ controlsDrained: boolean; release: McpResourceRelease }>(input.client, input.address,
        { kind: 'resource_release', binding: input.binding }, options?.signal).then(result => {
          if (result.controlsDrained !== true || !['acknowledged', 'shared', 'unknown'].includes(result.release?.status))
            throw new McpAuthorityError('mcp_resource_cleanup_receipt_invalid');
          return result.release;
        });
    },
  };
}
