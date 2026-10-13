/** Re-establish only a durably accepted resource observer, after recording its observation gap. */
import { isDeepStrictEqual } from 'node:util';
import { McpAuthorityError, type McpResourceObserver, type McpResourceChange } from '@varin/pi-host/mcp-authority';
import { evaluateGate, type PermissionPolicy } from '@varin/protocol';
import type { McpResourcePending, LaunchSource, McpBinding } from './protocol.generated.js';
import { createMcpOriginalOwnerRecovery, type McpOriginalOwnerOptions } from './mcp-original-owner.js';
export function createMcpResourceRecovery(options: McpOriginalOwnerOptions & {
    currentPolicy(cwd: string, trusted: boolean): Promise<PermissionPolicy>;
}): (op: McpResourcePending, signal: AbortSignal, onChange: (change: McpResourceChange) => void) => Promise<McpResourceObserver> {
    const original = createMcpOriginalOwnerRecovery(options);
    return async (op, signal, onChange) => {
        const selected = op.subscription;
        if (!selected.acceptanceRef || op.cancelRequested)
            throw new McpAuthorityError('mcp-resource-original-subscription-unavailable');
        const context = await options.kernel.agentRuntimeRequest<{
            threadId: string;
            source: LaunchSource | null;
            binding: McpBinding;
        }, 'runtime.mcp.resource.context'>('runtime.mcp.resource.context', { operationId: op.operationId }, signal);
        const lease = await original(op.runId, selected.binding.endpoint, context, signal);
        const configuration = context.binding.provenance.servers[selected.binding.endpoint.server]!.owner.configuration;
        const allowed = async () => {
            const current = await options.currentPolicy(configuration.config_cwd, configuration.project_trusted);
            if (evaluateGate('mcp_subscribe_resource', { server: selected.binding.endpoint.server, schemaVersion: selected.binding.schemaVersion, uri: selected.binding.uri }, current).decision === 'deny')
                throw new McpAuthorityError('mcp-resource-permission-revoked');
        };
        try {
            const service = await lease.prepareService(selected.binding.endpoint.server, 'resources', selected.binding.schemaVersion, signal);
            if (!isDeepStrictEqual(lease.resourceEndpoint(service), selected.binding.endpoint))
                throw new McpAuthorityError('mcp-resource-original-endpoint-changed');
            return await lease.observeResource(service, selected.binding.uri, { signal, beforeDispatch: allowed, onChange: change => {
                    void allowed().then(() => onChange(change), () => onChange({ kind: 'unavailable', problem: 'mcp-resource-permission-revoked' }));
                } });
        }
        finally {
            lease.release();
        }
    };
}
