/** Reopen only the original Catalog Task holder. No Run restart, task listing or dispatch. */
import { isDeepStrictEqual } from 'node:util';
import type { ManagedMcpTaskCreationReceipt } from '../harness/managed-mcp-contract.js';
import { McpTaskRequestError } from '../mcp/errors.js';
import type { McpAuthority, McpTaskLease } from '../mcp/authority.js';
import { createMcpOriginalOwnerRecovery } from './mcp-original-owner.js';
import { createManagedMcpTaskLease, requestManagedMcpTask } from './managed-mcp-task-lease.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostJobPending, LaunchSource, McpBinding, Operation, SourceMcpHolderBinding, SourceMcpCreationOutcome } from './protocol.generated.js';
export function createMcpTaskRecovery(options: {
  kernel: KernelClient; authority: McpAuthority; agentDir: string; hostId: string;
  interactions?: Pick<import('./managed-mcp-interactions.js').ManagedMcpInteractions, 'ensure'>;
  runtime?: Pick<AgentRuntimeClient, 'managedSource' | 'coordinatorHostId'>;
  admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{ canonicalPath: string }>;
  projectTrusted(cwd: string): boolean;
  validateLiveSource(source: LaunchSource, signal: AbortSignal): Promise<void>;
}) {
  const context = async (pending: HostJobPending, signal: AbortSignal) => {
    const subject = pending.binding.subject;
    if (pending.binding.domain !== 'mcp.task' || subject.kind !== 'mcp') throw new McpTaskRequestError('mcp_task_original_identity_missing', false, 'owner');
    const original = await options.kernel.agentRuntimeRequest<{ threadId: string; source: LaunchSource | null; binding: McpBinding }, 'runtime.host_job.task.context'>(
      'runtime.host_job.task.context', { operationId: pending.binding.operationId }, signal);
    const server = original.binding.provenance.servers[subject.endpoint.server];
    if (!server || server.resource_key !== subject.endpoint.resourceKey || server.definition_version !== subject.endpoint.configurationVersion)
      throw new McpTaskRequestError('mcp_task_original_endpoint_changed', false, 'owner');
    return { original, server, endpoint: subject.endpoint };
  };
  const managed = async (pending: HostJobPending, selected: Awaited<ReturnType<typeof context>>, signal: AbortSignal) => {
    const { owner } = selected.server, source = owner.source_authority;
    if (owner.resource_owner.kind !== 'managed_host' || !source || !options.runtime
      || source.coordinator_host_id !== options.runtime.coordinatorHostId) throw new McpTaskRequestError('mcp_task_original_source_unavailable', false, 'owner');
    const client = await options.runtime.managedSource(owner.resource_owner, signal);
    const address = { coordinatorHostId: source.coordinator_host_id, authorityId: source.authority_id, resourceEpoch: source.resource_epoch };
    const binding: SourceMcpHolderBinding = { operationId: pending.binding.operationId, executionOwner: pending.binding.executionOwner,
      purpose: 'task', endpoint: selected.endpoint };
    return { client, address, binding };
  };
  const recover = async (pending: HostJobPending, signal: AbortSignal): Promise<McpTaskLease> => {
    if (!pending.accepted || !pending.mcpTask) throw new McpTaskRequestError('mcp_task_original_identity_missing', false, 'owner');
    const selected = await context(pending, signal);
    if (selected.server.owner.resource_owner.kind === 'managed_host') {
      const target = await managed(pending, selected, signal);
      // Do not prepare a view or reconnect a replacement SDK heap on B. The original
      // receipt remains readable after Host restart even when its live transport is gone.
      const original = await requestManagedMcpTask<{ receipt: ManagedMcpTaskCreationReceipt | null; live: boolean; released: boolean }>(
        target.client, target.address, { kind: 'task_inspect', binding: target.binding }, signal);
      if (original.released || !original.live || original.receipt?.outcome?.kind !== 'accepted'
        || original.receipt.outcome.response.task.taskId !== pending.mcpTask.task.taskId
        || original.receipt.outcome.response.task.createdAt !== pending.mcpTask.task.createdAt)
        throw new McpTaskRequestError('mcp_task_original_transport_unavailable', false, 'owner');
      if (!options.interactions) throw new McpTaskRequestError('mcp_interaction_owner_unavailable', false, 'owner');
      await options.interactions.ensure({ ...target, origin: { operationId: target.binding.operationId, executionOwner: target.binding.executionOwner },
        server: { ...selected.server, server: selected.endpoint.server }, endpoint: selected.endpoint });
      return createManagedMcpTaskLease(target);
    }
    const lease = await createMcpOriginalOwnerRecovery(options)(pending.runId, selected.endpoint, selected.original, signal);
    try { return await lease.taskOwner(selected.endpoint.server, selected.endpoint, signal,
      { operationId: pending.binding.operationId, executionOwner: pending.binding.executionOwner }); } finally { lease.release(); }
  };
  return Object.assign(recover, {
    async recoverCreation(pending: HostJobPending, signal: AbortSignal): Promise<SourceMcpCreationOutcome | null> {
      if (!pending.accepted && pending.executorStopped) {
        const operation = await options.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>(
          'runtime.operation.inspect', { operationId: pending.binding.operationId }, signal);
        if (!isDeepStrictEqual(operation.host_job?.binding, pending.binding)) throw new McpTaskRequestError('mcp_task_original_identity_changed', false, 'owner');
        const receipt = operation.external_receipt;
        // Retain the positive Catalog no-effect proof even after B releases its receipt
        // body before A's cleanup acknowledgement. Stop by itself is never enough.
        if (receipt?.executor_stopped && receipt.effect === 'none') return { kind: 'failed', error: {
          code: 'mcp_task_original_not_dispatched', dispatched: false, settlement: 'unknown', taskKind: 'owner' } };
      }
      const selected = await context(pending, signal);
      if (selected.server.owner.resource_owner.kind === 'local') return null;
      const target = await managed(pending, selected, signal);
      const original = await requestManagedMcpTask<{ receipt: ManagedMcpTaskCreationReceipt | null; released: boolean }>(
        target.client, target.address, { kind: 'task_inspect', binding: target.binding, fenceUnstarted: true }, signal);
      // This is an atomic original-identity fence, not an inference from an absent
      // response. A delayed first dispatch now sees the same released tombstone.
      if (!original.receipt && original.released) return { kind: 'failed', error: {
        code: 'mcp_task_original_creation_fenced', dispatched: false, settlement: 'unknown', taskKind: 'owner' } };
      return original.receipt?.outcome ?? null;
    },
    async cleanup(pending: HostJobPending, signal: AbortSignal): Promise<void> {
      const selected = await context(pending, signal);
      if (selected.server.owner.resource_owner.kind === 'local') return;
      const target = await managed(pending, selected, signal);
      const released = await requestManagedMcpTask<{ retire: boolean; controlsDrained: boolean }>(target.client, target.address, { kind: 'task_release', binding: target.binding }, signal);
      if (typeof released?.retire !== 'boolean' || released.controlsDrained !== true) throw new McpTaskRequestError('mcp_task_cleanup_receipt_invalid', false, 'protocol');
      if (released.retire) {
        const retired = await target.client.release({ ...target.address, mode: 'retire' }, signal) as { phase?: string };
        if (retired.phase !== 'retired' && retired.phase !== 'revoked' && retired.phase !== 'retaining') throw new McpTaskRequestError('mcp_task_original_retirement_pending', false, 'owner');
      }
    },
  });
}
