/** A projection over retained MCP leases, never a configuration or connection authority. */
import { createHash } from 'node:crypto';
import { createMcpToolName } from '@earendil-works/pi-coding-agent';
import type {
  McpAuthorityBinding, McpAuthorityInspection, McpAuthorityLease, McpAuthorityTool,
} from './mcp-authority.js';

export interface McpAuthorityLeasePart {
  lease: McpAuthorityLease;
  /** The caller resolves configuration precedence before transferring the leases. */
  servers: readonly string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const targetKey = (name: string, version: string) => JSON.stringify([name, version]);
const concreteKey = (tool: McpAuthorityTool) => JSON.stringify([tool.server, tool.tool]);

/** Ownership transfers only on success. On rejection, the caller still owns every input lease.
 * Empty contributions are retained too, including their explicit configuration errors. */
export function composeMcpAuthorityLeases(parts: readonly McpAuthorityLeasePart[]): McpAuthorityLease {
  const owners = new Map<string, McpAuthorityLease>();
  const leases = new Map<McpAuthorityLease, string[]>();
  for (const { lease, servers } of parts) {
    let names = leases.get(lease);
    if (!names) { names = []; leases.set(lease, names); }
    for (const server of servers) {
      if (owners.has(server)) throw new Error('mcp_composition_duplicate_server');
      if (!Object.hasOwn(lease.binding.provenance.servers, server)) throw new Error('mcp_target_unbound');
      owners.set(server, lease); names.push(server);
    }
  }
  for (const names of leases.values()) names.sort();
  const names = [...owners.keys()].sort();
  const provenance = freeze({ servers: Object.fromEntries(names.map(name =>
    [name, structuredClone(owners.get(name)!.binding.provenance.servers[name]!)])) });
  const targets = new Map<string, { lease: McpAuthorityLease; original: string }>();
  // Published aliases never move to another concrete target, even after deferred discovery.
  const aliases = new Map<string, string>();
  const claimed = new Map<string, string>();
  let released = false;
  const assertLive = () => { if (released) throw new Error('mcp_lease_released'); };
  const serverOwner = (server: string) => {
    assertLive();
    const lease = owners.get(server);
    if (!lease) throw new Error('mcp_target_unbound');
    return lease;
  };
  const project = (source: readonly { lease: McpAuthorityLease; tool: McpAuthorityTool }[]): readonly McpAuthorityTool[] => {
    // Reserve the whole batch before allocating aliases, independent of contribution order.
    const sorted = [...source].sort((a, b) => concreteKey(a.tool).localeCompare(concreteKey(b.tool))
      || a.tool.schemaVersion.localeCompare(b.tool.schemaVersion));
    const pending = new Map<string, Set<string>>();
    for (const { lease, tool } of sorted) {
      if (owners.get(tool.server) !== lease || tool.resourceKey !== provenance.servers[tool.server]?.resource_key)
        throw new Error('mcp_target_unbound');
      let identities = pending.get(tool.name);
      if (!identities) { identities = new Set(); pending.set(tool.name, identities); }
      identities.add(concreteKey(tool));
    }
    return Object.freeze(sorted.map(({ lease, tool }) => {
      const key = concreteKey(tool);
      let name = aliases.get(key);
      if (!name) {
        const occupied = (candidate: string) => {
          const owner = claimed.get(candidate);
          return owner !== undefined && owner !== key
            || [...(pending.get(candidate) ?? [])].some(identity => identity !== key);
        };
        const allocated: string = occupied(tool.name) ? createMcpToolName(tool.server, tool.tool, occupied) : tool.name;
        // Do not let an unexpected naming collision silently replace an admitted target.
        if (occupied(allocated)) throw new Error('mcp_composition_tool_name_collision');
        aliases.set(key, allocated); claimed.set(allocated, key); name = allocated;
      }
      targets.set(targetKey(name, tool.schemaVersion), { lease, original: tool.name });
      return freeze({ ...structuredClone(tool), name });
    }).sort((a, b) => a.name.localeCompare(b.name)));
  };
  const tools = project([...leases].flatMap(([lease, selected]) => lease.binding.tools
    .filter(tool => selected.includes(tool.server)).map(tool => ({ lease, tool }))));
  const inspection = (read: (lease: McpAuthorityLease) => McpAuthorityInspection) => {
    const observations = [...leases].map(([lease, selected]) => ({ observed: read(lease), selected }));
    const servers = observations.flatMap(({ observed, selected }) =>
      observed.servers.filter(server => selected.includes(server.name))).sort((a, b) => a.name.localeCompare(b.name));
    return freeze(structuredClone({
      configErrorCount: observations.reduce((sum, { observed }) => sum + observed.configErrorCount, 0),
      configuredServerCount: servers.length,
      connectedServerCount: servers.filter(server => server.status === 'connected').length,
      cachedToolCount: servers.reduce((sum, server) => sum + server.cachedToolCount, 0),
      servers,
    }));
  };
  const readiness = inspection(lease => lease.binding.readiness);
  const identities = [...leases].map(([lease, servers]) => ({ reference: lease.binding.reference, servers,
    generation: lease.binding.generation, implementation: lease.implementationIdentity })).sort((a, b) =>
    stable([a.reference, a.servers]).localeCompare(stable([b.reference, b.servers])) || stable(a).localeCompare(stable(b)));
  const binding: McpAuthorityBinding = freeze({
    provenance,
    reference: `mcp-composition:${hash(Object.entries(provenance.servers).map(([name, server]) => [name, server.owner, server.resource_key]))}`,
    generation: 1 + Number.parseInt(hash([provenance, tools, readiness.configErrorCount]).slice(0, 12), 16),
    tools, readiness, servers: readiness.servers,
    serverSelections: [...leases].flatMap(([lease, selected]) => lease.binding.serverSelections
      .filter(server => selected.includes(server.name)).map(server => structuredClone(server)))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  const target = (name: string, version: string) => {
    assertLive();
    const selected = targets.get(targetKey(name, version));
    if (!selected) throw new Error('mcp_target_unbound');
    return selected;
  };
  return {
    binding,
    implementationIdentity: hash(identities),
    inspect: () => { assertLive(); return inspection(lease => lease.inspect()); },
    discover: async (server, signal) => {
      const lease = serverOwner(server);
      const discovered = await lease.discover(server, signal);
      assertLive();
      if (discovered.some(tool => tool.server !== server)) throw new Error('mcp_target_unbound');
      return project(discovered.map(tool => ({ lease, tool })));
    },
    prepareTool: async (server, tool, version, signal) => {
      const lease = serverOwner(server);
      const prepared = await lease.prepareTool(server, tool, version, signal);
      assertLive();
      if (prepared.server !== server || prepared.tool !== tool || prepared.schemaVersion !== version)
        throw new Error('mcp_target_unbound');
      return project([{ lease, tool: prepared }])[0]!;
    },
    discoverServices: (server, signal) => serverOwner(server).discoverServices(server, signal),
    prepareService: (server, kind, version, signal) => serverOwner(server).prepareService(server, kind, version, signal),
    preparePrompt: (server, name, version, signal) => serverOwner(server).preparePrompt(server, name, version, signal),
    assertService: service => serverOwner(service.server).assertService(service),
    serviceRevocationSignal: service => serverOwner(service.server).serviceRevocationSignal(service),
    validateServiceRequest: (service, request) => serverOwner(service.server).validateServiceRequest(service, request),
    requestService: (service, request, options) => serverOwner(service.server).requestService(service, request, options),
    resourceEndpoint: service => serverOwner(service.server).resourceEndpoint(service),
    observeResource: (service, uri, options) => serverOwner(service.server).observeResource(service, uri, options),
    // These returned handles already retain their original connection independently.
    taskOwner: (server, endpoint, signal) => serverOwner(server).taskOwner(server, endpoint, signal),
    assertCallable: (name, version) => { const selected = target(name, version); selected.lease.assertCallable(selected.original, version); },
    revocationSignal: (name, version) => { const selected = target(name, version); return selected.lease.revocationSignal(selected.original, version); },
    validateArguments: (name, version, args) => { const selected = target(name, version); selected.lease.validateArguments(selected.original, version, args); },
    callTool: (name, args, options) => { const selected = target(name, options.schemaVersion); return selected.lease.callTool(selected.original, args, options); },
    release: () => {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      for (const lease of leases.keys()) { try { lease.release(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'mcp_composition_release_failed');
    },
  };
}
