/** Original MCP definitions rebound to an admitted child's own execution view.
 * Configuration, transports and credentials remain owned by the shared McpAuthority. */
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { composeMcpAuthorityLeases, type McpAuthority, type McpAuthorityOwnedLease } from '../mcp/authority.js';
import type { McpProvenance, McpServerOwner, PermissionPolicy } from '@varin/protocol';
import type { McpPreparation } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { McpResourceRuntime } from './mcp-resource-runtime.js';
import type { McpTaskRuntime } from './mcp-task-runtime.js';
import type { McpToolLease } from './tool-bridge.js';
import { createMcpLease } from './mcp-owner.js';
import { derivedChildMcpSelection, type ManagedChildMcpPreparer, type ManagedChildMcpContribution } from './managed-child-mcp-preparation.js';
import { selectMcpServers } from './managed-mcp-preparation.js';

export function createChildMcpPreparer(owners: {
  authority: McpAuthority;
  managed?: ManagedChildMcpPreparer;
  tasks?:()=>McpTaskRuntime;
  resources?:()=>McpResourceRuntime;
  kernel: KernelClient;
  agentDir: string;
  hostId: string;
  admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{ canonicalPath: string }>;
  projectTrusted(cwd: string): boolean;
  currentPolicy(cwd: string, trusted: boolean): Promise<PermissionPolicy>;
  processAdmission?(input: McpPreparation): import('../process/types.js').ManagedProcessAdmission;
}): (input: McpPreparation, signal?: AbortSignal) => Promise<McpToolLease> {
  owners = { ...owners, agentDir: resolve(owners.agentDir) };
  return async (input, signal) => {
    signal?.throwIfAborted();
    const selection = input.delegatedBinding ?? input.requiredBinding;
    if (!selection)
      throw new Error('Child MCP preparation requires its original dependency selection');
    // A dependency cut groups complete frozen owners, not just their physical Host.
    // Configuration precedence was already resolved by the original selection.
    const groups: Array<{ owner: McpServerOwner; provenance: McpProvenance }> = [];
    for (const [name, server] of Object.entries(selection.provenance.servers)) {
      if (server.owner.resource_owner.kind !== 'local') continue;
      let group = groups.find(candidate => isDeepStrictEqual(candidate.owner, server.owner));
      if (!group) {
        group = { owner: server.owner, provenance: { servers: {} } };
        groups.push(group);
      }
      group.provenance.servers[name] = server;
    }
    const hasManaged = Object.values(selection.provenance.servers).some(server => server.owner.resource_owner.kind === 'managed_host');
    if (hasManaged && !owners.managed) throw new Error('Child MCP requires its original target Host execution owner');
    // Catalog-owned controls need no endpoint, but keep the existing neutral lease.
    if (!groups.length && !hasManaged) groups.push({ owner: {
      resource_owner: { kind: 'local' }, source_authority: null,
      configuration: { agent_dir: owners.agentDir, config_cwd: owners.agentDir, project_trusted: false },
      execution_scope: 'global',
    }, provenance: { servers: {} } });
    const needsWorkspace = groups.some(group => group.owner.execution_scope === 'workspace');
    if (needsWorkspace && input.source?.resourceOwner.kind === 'managed_host')
      throw new Error('Local project MCP requires a local child execution view');
    if (needsWorkspace && (!input.source || !input.executionCwd))
      throw new Error('Child MCP requires an execution view matching its fixed source');
    const workspace = needsWorkspace && input.source
      ? { canonicalPath: resolve((await owners.admitWorkspaceRegistration(input.source.workspaceId, signal)).canonicalPath) } : undefined;
    signal?.throwIfAborted();
    for (const { owner } of groups) {
      const configuration = owner.configuration;
      if (configuration.agent_dir !== owners.agentDir ||
        (configuration.config_cwd !== owners.agentDir &&
          (owner.execution_scope !== 'workspace' || configuration.config_cwd !== workspace?.canonicalPath)))
        throw new Error('Child MCP configuration source is unavailable for its actual execution view');
    }
    const assertTrust = () => {
      for (const { owner } of groups) {
        const configuration = owner.configuration;
        if (configuration.project_trusted &&
          (owner.execution_scope !== 'workspace' || !workspace || !owners.projectTrusted(configuration.config_cwd)))
          throw new Error('Child MCP project trust was revoked or its consistent execution view is unavailable');
      }
    };
    assertTrust();
    // Use only the admitted original project's Host policy merge. A neutral-only
    // selection keeps global policy even when the child also has a private Source.
    const projectGroups = groups.filter(group => group.owner.configuration.config_cwd === workspace?.canonicalPath);
    const policyConfiguration = (projectGroups.find(group => group.owner.configuration.project_trusted)
      ?? projectGroups[0] ?? groups[0])?.owner.configuration
      ?? { agent_dir: owners.agentDir, config_cwd: owners.agentDir, project_trusted: false };
    const directResources = new Set(selection.tools
      .filter(tool => ['direct', 'direct_task'].includes(selection.routes[tool.name]?.kind ?? ''))
      .map(tool => selection.resources[tool.name]).filter(Boolean));
    const attempt = new AbortController();
    const abort = () => attempt.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const acquired: Array<Pick<McpAuthorityOwnedLease, 'releaseAndDrain'>> = [];
    let managed: ManagedChildMcpContribution | undefined;
    try {
      const candidates: Array<Promise<{ lease: import('../mcp/authority.js').McpAuthorityLease; servers: string[] }>> = groups.map(async ({ owner, provenance }) => {
        try {
          attempt.signal.throwIfAborted();
          const configuration = owner.configuration;
          const workspaceScope = owner.execution_scope === 'workspace';
          const lease = await owners.authority.acquire({
            ...(workspaceScope && owners.processAdmission ? { admitProcess: owners.processAdmission(input) } : {}),
            resourceOwner: owner.resource_owner,
            agentDir: configuration.agent_dir,
            configCwd: configuration.config_cwd,
            projectTrusted: configuration.project_trusted,
            executionCwd: workspaceScope ? input.executionCwd! : owners.agentDir,
            environmentId: workspaceScope
              ? `${owners.hostId}:${input.source!.executionWorkspaceId}` : `${owners.hostId}:global`,
            executionScope: owner.execution_scope,
            sessionId: `agent:${input.threadId}`,
          }, {
            servers: Object.entries(provenance.servers)
              .filter(([, server]) => directResources.has(server.resource_key)).map(([name]) => name),
            provenance,
            signal: attempt.signal,
          });
          acquired.push(lease);
          attempt.signal.throwIfAborted();
          assertTrust();
          return { lease, servers: Object.keys(provenance.servers) };
        } catch (error) {
          attempt.abort(error);
          throw error;
        }
      });
      if (hasManaged) candidates.push((async () => {
        try {
          attempt.signal.throwIfAborted();
          managed = await owners.managed!(input, attempt.signal);
          acquired.push(managed.lease);
          attempt.signal.throwIfAborted();
          return { lease: managed.lease, servers: Object.keys(managed.lease.binding.provenance.servers) };
        } catch (error) { attempt.abort(error); throw error; }
      })());
      const prepared = await Promise.allSettled(candidates);
      attempt.signal.throwIfAborted();
      const parts = prepared.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      assertTrust();
      // Preserve the original single-owner identity; mixed owners have one composed
      // binding, validated once against the whole frozen dependency selection.
      const lease = parts.length === 1 ? parts[0]!.lease : composeMcpAuthorityLeases(parts);
      const bindingSelection = managed?.receipt ? derivedChildMcpSelection(selection, managed.receipt) : selection;
      const result = createMcpLease({
        lease,
        kernel: owners.kernel,
        ...(owners.tasks ? { tasks: owners.tasks() } : {}),
        ...(owners.resources ? { resources: owners.resources() } : {}),
        selection: bindingSelection,
        ...(managed ? { retainChild: (binding, selected) => {
          const target = selectMcpServers(selected, owner => owner.kind === 'managed_host');
          return Object.keys(target.provenance.servers).length
            ? managed!.lease.retainChild(binding, target) : Promise.resolve({ release: async () => {} });
        } } : {}),
        retarget: Boolean(input.delegatedBinding),
        currentPolicy: async () => {
          assertTrust();
          return owners.currentPolicy(policyConfiguration.config_cwd, policyConfiguration.project_trusted);
        },
      });
      return Object.assign(result, {
        ...(managed?.receipt ? { derivations: [managed.receipt] } : {}),
        ...(managed ? { releaseDerivations: () => managed!.releaseDerivation() } : {}),
      });
    } catch (error) {
      attempt.abort(error);
      // Every acquisition has settled, including late replies. Drain these actual
      // candidates, never reopen the old parent dependency to perform cleanup.
      const drained = await Promise.allSettled(acquired.map(async lease => lease.releaseAndDrain()));
      const failures = drained.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)], 'Child MCP preparation cleanup failed');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
}
