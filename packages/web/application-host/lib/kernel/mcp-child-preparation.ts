/** Original MCP definitions rebound to an admitted child's own execution view.
 * Configuration, transports and credentials remain owned by the shared McpAuthority. */
import type { McpAuthority } from '@varin/pi-host/mcp-authority';
import type { PermissionPolicy } from '@varin/protocol';
import type { McpPreparation } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { McpToolLease } from './tool-bridge.js';
import { createMcpLease } from './mcp-owner.js';

export function createChildMcpPreparer(owners: {
  authority: McpAuthority;
  kernel: KernelClient;
  agentDir: string;
  hostId: string;
  inspectWorkspace(id: string): Promise<{ root: string }>;
  projectTrusted(cwd: string): boolean;
  currentPolicy(cwd: string, trusted: boolean): Promise<PermissionPolicy>;
}): (input: McpPreparation, signal?: AbortSignal) => Promise<McpToolLease> {
  return async (input, signal) => {
    signal?.throwIfAborted();
    const selection = input.delegatedBinding ?? input.requiredBinding;
    if (!selection)
      throw new Error(
        'Child MCP preparation requires its original dependency selection',
      );
    const configuration = selection.provenance.configuration;
    const needsWorkspace = selection.provenance.execution_scope === 'workspace';
    if (needsWorkspace && (!input.source || !input.executionCwd))
      throw new Error(
        'Child MCP requires an execution view matching its fixed source',
      );
    const workspace =
      needsWorkspace && input.source
        ? await owners.inspectWorkspace(input.source.workspaceId)
        : undefined;
    if (
      configuration.agent_dir !== owners.agentDir ||
      (configuration.config_cwd !== owners.agentDir &&
        configuration.config_cwd !== workspace?.root)
    ) {
      throw new Error(
        'Child MCP configuration source is unavailable for its actual execution view',
      );
    }
    const assertTrust = () => {
      if (
        configuration.project_trusted &&
        (!workspace || !owners.projectTrusted(configuration.config_cwd))
      ) {
        throw new Error(
          'Child MCP project trust was revoked or its consistent execution view is unavailable',
        );
      }
    };
    assertTrust();
    const directResources = new Set(
      selection.tools
        .map((tool) => selection.resources[tool.name])
        .filter(Boolean),
    );
    const servers = Object.entries(selection.provenance.servers)
      .filter(([, server]) => directResources.has(server.resource_key))
      .map(([name]) => name);
    const lease = await owners.authority.acquire(
      {
        agentDir: configuration.agent_dir,
        configCwd: configuration.config_cwd,
        projectTrusted: configuration.project_trusted,
        executionCwd: needsWorkspace ? input.executionCwd! : owners.agentDir,
        environmentId: workspace
          ? `${owners.hostId}:${input.source!.executionWorkspaceId}`
          : `${owners.hostId}:global`,
        executionScope: selection.provenance.execution_scope,
        sessionId: `agent:${input.threadId}`,
      },
      {
        servers,
        provenance: selection.provenance,
        ...(signal ? { signal } : {}),
      },
    );
    try {
      signal?.throwIfAborted();
      assertTrust();
      return createMcpLease({
        lease,
        kernel: owners.kernel,
        selection,
        retarget: Boolean(input.delegatedBinding),
        currentPolicy: async () => {
          assertTrust();
          return owners.currentPolicy(
            configuration.config_cwd,
            configuration.project_trusted,
          );
        },
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  };
}
