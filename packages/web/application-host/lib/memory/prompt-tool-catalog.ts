import type { AgentToolPrompt } from '@varin/protocol';
import type { ApplicationExtensionRuntime } from '@varin/extension-host';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { extensionToolSchema } from '../kernel/extension-tool-owner.js';
import { MCP_CAPABILITIES } from '../kernel/protocol.generated.js';
import type { McpAuthority, McpAuthorityScope } from '../mcp/authority.js';
import { getMcpToolExposure } from '../mcp/configuration.js';

export type PromptToolCatalog = (context: { projectId?: string; projectRoot?: string }, signal?: AbortSignal) => Promise<AgentToolPrompt[]>;
/** Settings reads declarations; a Thread preview instead reads its saved launch selection. */
export function createPromptToolCatalog(owners: {
  runtime: Pick<AgentRuntimeClient, 'toolCatalog'>;
  extensions: ApplicationExtensionRuntime;
  mcp: McpAuthority;
  mcpScope(cwd: string | undefined, signal: AbortSignal): Promise<McpAuthorityScope>;
}): PromptToolCatalog {
  return async (context: { projectId?: string; projectRoot?: string }, signal = new AbortController().signal): Promise<AgentToolPrompt[]> => {
    const [builtins, contracts, catalog, scope] = await Promise.all([
      owners.runtime.toolCatalog(signal),
      owners.extensions.queryContracts({ action: 'list', kind: 'service' }, { routing: context.projectId ? { projectId: context.projectId } : {} }, signal),
      owners.extensions.catalog.snapshot(),
      owners.mcpScope(context.projectRoot, signal),
    ]);
    signal.throwIfAborted();
    if (contracts.action !== 'list' || contracts.kind !== 'service' || !contracts.authoritative || !catalog.authoritative) throw new Error('Tool catalog is unavailable');
    const tools: AgentToolPrompt[] = builtins.map(({ name, description, schema }) => ({ name, description, schema }));
    for (const service of contracts.entries) {
      if (service.selection.status !== 'resolved') continue;
      for (const implementation of service.implementations) {
        if (!implementation.enabled || !service.selection.providerKeys?.includes(implementation.providerKey)) continue;
        const extension = catalog.extensions.find(entry => entry.manifest.id === implementation.extensionId);
        const declaration = extension?.manifest.provides?.services?.find(entry => entry.id === service.serviceId && entry.version === service.version);
        if (declaration?.tool) {
          const { name, description, schema } = extensionToolSchema(declaration);
          tools.push({ name, description, schema });
        }
      }
    }
    const cached = await owners.mcp.directory(scope, signal);
    const config = owners.mcp.configuration(scope);
    const servers = new Map(config.servers.filter(server => server.config.enabled !== false && server.config.exposure !== 'hidden').map(server => [server.name, server]));
    for (const tool of cached) {
      const server = servers.get(tool.server);
      if (server && getMcpToolExposure(server.config, tool.tool) === 'direct') tools.push({ name: tool.name, description: tool.description, schema: tool.inputSchema });
    }
    for (const { name, description, schema, route } of MCP_CAPABILITIES) {
      if (servers.size || config.errors.length || route.kind === 'task_control' || route.kind === 'resource_unsubscribe') tools.push({ name, description, schema });
    }
    signal.throwIfAborted();
    return tools.sort((left, right) => left.name.localeCompare(right.name));
  };
}
