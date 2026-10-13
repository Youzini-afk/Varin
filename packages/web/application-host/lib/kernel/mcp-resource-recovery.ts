/** Recover original acknowledgements/views; creation and cleanup never substitute a new owner. */
import { isDeepStrictEqual } from 'node:util';
import { McpAuthorityError } from '@varin/pi-host/mcp-errors';
import type { McpResourceObserver, McpResourceChange, McpResourceRelease } from '@varin/pi-host/mcp-authority';
import { evaluateGate, type PermissionPolicy } from '@varin/protocol';
import type { McpResourcePending, LaunchSource, McpBinding, SourceMcpCreationOutcome, SourceMcpCreationError, Operation } from './protocol.generated.js';
import type { McpResourceCreationRecovery } from './mcp-resource-runtime.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { createMcpOriginalOwnerRecovery, type McpOriginalOwnerOptions } from './mcp-original-owner.js';
import { createManagedMcpResourceObserver, requestManagedMcpResource } from './managed-mcp-resource-observer.js';
interface OriginalObservation {
  receipt: { requestHash: string; outcome: SourceMcpCreationOutcome | null } | null;
  released: boolean; live: boolean; listenerId: string | null; revision: number;
}
export function createMcpResourceRecovery(options: McpOriginalOwnerOptions & {
  currentPolicy(cwd: string, trusted: boolean): Promise<PermissionPolicy>;
  runtime?: Pick<AgentRuntimeClient, 'managedSource' | 'coordinatorHostId'>;
}) {
  const original = createMcpOriginalOwnerRecovery(options);
  const context = async (op: McpResourcePending, signal: AbortSignal) => {
    const saved = await options.kernel.agentRuntimeRequest<{ threadId: string; source: LaunchSource | null; binding: McpBinding }, 'runtime.mcp.resource.context'>(
      'runtime.mcp.resource.context', { operationId: op.operationId }, signal);
    const endpoint = op.subscription.binding.endpoint, server = saved.binding.provenance.servers[endpoint.server];
    if (!server || server.resource_key !== endpoint.resourceKey || server.definition_version !== endpoint.configurationVersion)
      throw new McpAuthorityError('mcp-resource-original-endpoint-changed');
    return { saved, server };
  };
  const managed = async (selected: Awaited<ReturnType<typeof context>>, signal: AbortSignal) => {
    const owner = selected.server.owner, source = owner.source_authority;
    if (owner.resource_owner.kind !== 'managed_host' || !source || !options.runtime
      || source.coordinator_host_id !== options.runtime.coordinatorHostId) throw new McpAuthorityError('mcp-resource-original-source-unavailable');
    const client = await options.runtime.managedSource(owner.resource_owner, signal);
    return { client, address: { coordinatorHostId: source.coordinator_host_id, authorityId: source.authority_id, resourceEpoch: source.resource_epoch } };
  };
  const recover = async (op: McpResourcePending, signal: AbortSignal, onChange: (change: McpResourceChange) => void): Promise<McpResourceObserver> => {
    const subscription = op.subscription;
    if (!subscription.acceptanceRef || op.cancelRequested) throw new McpAuthorityError('mcp-resource-original-subscription-unavailable');
    const selected = await context(op, signal), configuration = selected.server.owner.configuration;
    const remote = selected.server.owner.resource_owner.kind === 'managed_host';
    const allowed = async () => {
      // Coordinator policy belongs to A. B's config_cwd is never read as an A path;
      // the target independently rechecks its current read/trust/credential authority.
      const current = await options.currentPolicy(remote ? options.agentDir : configuration.config_cwd,
        remote ? false : configuration.project_trusted);
      if (evaluateGate('mcp_subscribe_resource', { server: subscription.binding.endpoint.server,
        schemaVersion: subscription.binding.schemaVersion, uri: subscription.binding.uri }, current).decision === 'deny')
        throw new McpAuthorityError('mcp-resource-permission-revoked');
    };
    const receive = (change: McpResourceChange) => {
      void allowed().then(() => onChange(change), () => onChange({ kind: 'unavailable', problem: 'mcp-resource-permission-revoked' }));
    };
    if (remote) {
      await allowed();
      const target = await managed(selected, signal);
      const observed = await requestManagedMcpResource<OriginalObservation>(target.client, target.address,
        { kind: 'resource_inspect', binding: subscription.binding }, signal);
      if (observed.released || !observed.live || !observed.listenerId || observed.receipt?.outcome?.kind !== 'subscribed'
        || observed.receipt.outcome.listenerId !== observed.listenerId || !Number.isSafeInteger(observed.revision) || observed.revision < 0)
        throw new McpAuthorityError('mcp-resource-original-observation-unavailable');
      signal.throwIfAborted();
      return createManagedMcpResourceObserver({ ...target, binding: subscription.binding, listenerId: observed.listenerId,
        acknowledgement: observed.receipt.outcome.acknowledgement, revision: observed.revision, onChange: receive });
    }
    const lease = await original(op.runId, subscription.binding.endpoint, selected.saved, signal);
    try {
      const service = await lease.prepareService(subscription.binding.endpoint.server, 'resources', subscription.binding.schemaVersion, signal);
      if (!isDeepStrictEqual(lease.resourceEndpoint(service), subscription.binding.endpoint))
        throw new McpAuthorityError('mcp-resource-original-endpoint-changed');
      return await lease.observeResource(service, subscription.binding.uri, { signal, beforeDispatch: allowed, onChange: receive });
    } finally { lease.release(); }
  };
  return Object.assign(recover, {
    async recoverCreation(op: McpResourcePending, signal: AbortSignal): Promise<McpResourceCreationRecovery | null> {
      const selected = await context(op, signal);
      if (selected.server.owner.resource_owner.kind === 'local') return null;
      const target = await managed(selected, signal);
      const observed = await requestManagedMcpResource<OriginalObservation>(target.client, target.address,
        { kind: 'resource_inspect', binding: op.subscription.binding, fenceUnstarted: true }, signal);
      if (observed.released && !observed.receipt?.outcome) {
        // Target release may have preceded a lost Catalog cleanup ACK. Recall the
        // original finite failure before its target body is legitimately GC'd.
        const operation = await options.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>(
          'runtime.operation.inspect', { operationId: op.operationId }, signal);
        if (!isDeepStrictEqual(operation.mcp_resource_subscription?.binding, op.subscription.binding)
          || !isDeepStrictEqual(operation.execution_owner, op.subscription.binding.executionOwner))
          throw new McpAuthorityError('mcp-resource-original-receipt-changed');
        const receipt = operation.external_receipt;
        if (receipt?.executor_stopped) {
          const data = receipt.result.data as { error?: Partial<SourceMcpCreationError> } | null;
          const error = data?.error;
          if (error && typeof error.code === 'string' && typeof error.dispatched === 'boolean'
            && (!error.dispatched && receipt.effect === 'none' || error.dispatched && ['rpc_response', 'session_expired'].includes(error.settlement ?? '') && receipt.effect === 'unknown'))
            return { kind: 'failed', error: error as SourceMcpCreationError };
          if (receipt.effect === 'none') return { kind: 'failed', error: { code: 'mcp_resource_original_not_dispatched', dispatched: false, settlement: 'unknown' } };
          if (receipt.effect === 'unknown') return { kind: 'cleanup_pending' };
        }
        if (!observed.receipt) return { kind: 'failed', error: { code: 'mcp_resource_original_creation_fenced', dispatched: false, settlement: 'unknown' } };
      }
      if (observed.receipt?.outcome?.kind === 'accepted') throw new McpAuthorityError('mcp-resource-original-receipt-changed');
      return observed.receipt?.outcome ?? null;
    },
    async cleanup(op: McpResourcePending, signal: AbortSignal): Promise<McpResourceRelease> {
      const selected = await context(op, signal);
      if (selected.server.owner.resource_owner.kind !== 'managed_host') throw new McpAuthorityError('mcp-resource-cleanup-owner-changed');
      const target = await managed(selected, signal);
      const released = await requestManagedMcpResource<{ controlsDrained: boolean; retire: boolean; release: McpResourceRelease }>(target.client, target.address,
        { kind: 'resource_release', binding: op.subscription.binding }, signal);
      if (released.controlsDrained !== true || typeof released.retire !== 'boolean'
        || !['acknowledged', 'shared', 'unknown'].includes(released.release?.status)) throw new McpAuthorityError('mcp_resource_cleanup_receipt_invalid');
      if (released.retire) {
        const retired = await target.client.release({ ...target.address, mode: 'retire' }, signal) as { phase?: string };
        if (retired.phase !== 'retired' && retired.phase !== 'revoked') throw new McpAuthorityError('mcp_resource_original_retirement_pending');
      }
      return released.release;
    },
  });
}
