import { createMcpSourceProcessAdmission } from './mcp-process-admission.js';
/** Reacquire an original frozen MCP owner without replacing its source, endpoint or credentials. */
import { stat } from 'node:fs/promises';
import { McpAuthorityError } from '../mcp/errors.js';
import type { McpAuthority, McpAuthorityLease } from '../mcp/authority.js';
import type { KernelClient } from './kernel-client.js';
import type { McpEndpoint, LaunchSource, McpBinding } from './protocol.generated.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
export interface McpOriginalOwnerOptions {
    kernel: KernelClient;
    authority: McpAuthority;
    agentDir: string;
    hostId: string;
    admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{
        canonicalPath: string;
    }>;
    projectTrusted(cwd: string): boolean;
    validateLiveSource(source: LaunchSource, signal: AbortSignal): Promise<void>;
}
export function createMcpOriginalOwnerRecovery(options: McpOriginalOwnerOptions) {
    return async (runId: string, endpoint: McpEndpoint, context: {
        threadId: string;
        source: LaunchSource | null;
        binding: McpBinding;
    }, signal: AbortSignal): Promise<McpAuthorityLease> => {
        const original = context.binding.provenance;
        const server = original.servers[endpoint.server];
        if (!server) throw new McpAuthorityError('mcp_original_endpoint_changed');
        const owner = server.owner, configuration = owner.configuration;
        if (owner.resource_owner.kind !== 'local')
            throw new McpAuthorityError('mcp_original_execution_view_unavailable');
        if (!server || server.definition_version !== endpoint.configurationVersion || server.resource_key !== endpoint.resourceKey
            || configuration.agent_dir !== options.agentDir)
            throw new McpAuthorityError('mcp_original_endpoint_changed');
        if (owner.execution_scope === 'workspace' && context.source?.resource_owner.kind === 'managed_host')
            throw new McpAuthorityError('mcp_original_execution_view_unavailable');
        const workspace = owner.execution_scope === 'workspace' && context.source
            ? await options.admitWorkspaceRegistration(context.source.workspace_id, signal) : undefined;
        const revalidate = async () => {
            if (!workspace || !context.source) return;
            await options.admitWorkspaceRegistration(context.source.workspace_id, signal);
            if (context.source.execution_workspace_id !== context.source.workspace_id)
                await options.admitWorkspaceRegistration(context.source.execution_workspace_id, signal);
            if (configuration.project_trusted && !options.projectTrusted(configuration.config_cwd))
                throw new McpAuthorityError('mcp_original_trust_revoked');
        };
        if (workspace && context.source?.execution_workspace_id !== context.source?.workspace_id)
            await options.admitWorkspaceRegistration(context.source!.execution_workspace_id, signal);
        if (configuration.config_cwd !== options.agentDir && configuration.config_cwd !== workspace?.canonicalPath)
            throw new McpAuthorityError('mcp_original_configuration_unavailable');
        if (configuration.project_trusted && (!workspace || !options.projectTrusted(configuration.config_cwd)))
            throw new McpAuthorityError('mcp_original_trust_revoked');
        let executionCwd = options.agentDir;
        if (owner.execution_scope === 'workspace') {
            const source = context.source;
            if (!workspace || !source || source.mode === 'fixed_branch')
                throw new McpAuthorityError('mcp_original_execution_view_unavailable');
            if (source.mode === 'live_root') {
                await options.validateLiveSource(source, signal);
                executionCwd = source.live_root!.canonicalRoot;
                const current = await canonicalizePathIdentity(executionCwd);
                if (normalizePathIdentity(current) !== normalizePathIdentity(executionCwd) || !(await stat(current)).isDirectory())
                    throw new McpAuthorityError('mcp_original_execution_view_unavailable');
            }
            else {
                const handshake = options.kernel.handshake ?? await options.kernel.start();
                executionCwd = await admitMaterializedRoot((await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? runId)).targetPath, signal);
            }
        }
        const admitProcess = workspace && context.source ? createMcpSourceProcessAdmission({ ...options, runId, source: context.source, executionCwd }) : undefined;
        const lease = await options.authority.acquire({ ...(admitProcess ? { admitProcess } : {}), resourceOwner: owner.resource_owner, agentDir: configuration.agent_dir, configCwd: configuration.config_cwd,
            projectTrusted: configuration.project_trusted, executionCwd, executionScope: owner.execution_scope,
            environmentId: workspace ? `${options.hostId}:${context.source!.execution_workspace_id}` : `${options.hostId}:global`, sessionId: `agent:${context.threadId}` }, { servers: [endpoint.server], signal, provenance: { ...original, servers: { [endpoint.server]: server } } });
        try { await revalidate(); signal.throwIfAborted(); return lease; }
        catch (error) { lease.release(); throw error; }
    };
}
