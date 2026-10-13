/** Exact original Source dependency cleanup. No acquisition or replay happens here. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { McpBinding, SourceMcpChildBinding, McpServerOwner } from './protocol.generated.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';

export async function releaseManagedChildReference(client: ManagedSourceClient, address: ManagedSourceAddress,
  binding: SourceMcpChildBinding, signal?: AbortSignal): Promise<void> {
  const reply = await client.service({ ...address, requestId: `mcp-child-release:${randomUUID()}`,
    operation: { kind: 'mcp', action: { kind: 'child_release', binding } } }, signal);
  if (!reply.ok) throw new Error(reply.error.code);
  const value = reply.value as { retire?: unknown; dependenciesDrained?: unknown };
  if (value?.dependenciesDrained !== true || typeof value.retire !== 'boolean')
    throw new Error('mcp_child_dependency_cleanup_unconfirmed');
  if (value.retire) await client.release({ ...address, mode: 'retire' }, signal);
}

export async function releaseManagedChildDependencies(runtime: AgentRuntimeClient,
  binding: SourceMcpChildBinding, selection: McpBinding | null, signal?: AbortSignal): Promise<void> {
  if (!selection) return;
  const originals: McpServerOwner[] = [];
  for (const server of Object.values(selection.provenance.servers)) {
    const owner = server.owner;
    if (owner.resource_owner.kind === 'local') continue;
    if (!owner.source_authority || owner.source_authority.coordinator_host_id !== runtime.coordinatorHostId)
      throw new Error('mcp_child_original_source_changed');
    if (!originals.some(original => isDeepStrictEqual(original.resource_owner, owner.resource_owner)
      && isDeepStrictEqual(original.source_authority, owner.source_authority))) originals.push(owner);
  }
  // Each original Source owns its own tombstone and drain. A failed sibling leaves
  // the same Catalog cleanup duty pending; successful releases are idempotent.
  const results = await Promise.allSettled(originals.map(async owner => {
    if (owner.resource_owner.kind !== 'managed_host') throw new Error('mcp_child_original_source_changed');
    const client = await runtime.managedSource(owner.resource_owner, signal);
    const source = owner.source_authority!;
    await releaseManagedChildReference(client, { coordinatorHostId: source.coordinator_host_id,
      authorityId: source.authority_id, resourceEpoch: source.resource_epoch }, binding, signal);
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Original MCP child dependency cleanup failed');
}
