/** Ready MCP contributions over the sole connection/configuration authority. A scope prepares
 * each direct dependency independently; snapshots retain only their concrete selected leases. */
import { createHash, randomUUID } from 'node:crypto';
import { createMcpToolName } from '@earendil-works/pi-coding-agent';
import type { McpAuthority, McpAuthorityLease, McpAuthorityScope, McpAuthorityTool, McpChange } from './mcp-authority.js';

interface Generation {
  identity: string;
  lease: McpAuthorityLease;
  references: number;
  revoked: Map<string, AbortController>;
}
interface ServerSlot {
  version: string;
  current?: Generation;
  preparation?: AbortController;
}
const retain = (generation: Generation) => { generation.references++; return generation; };
const release = (generation: Generation) => { if (--generation.references === 0) generation.lease.release(); };
const generation = (lease: McpAuthorityLease): Generation => ({ identity: randomUUID(), lease, references: 1, revoked: new Map() });
const targetKey = (name: string, version: string) => JSON.stringify([name, version]);
function revoke(generation: Generation, tools?: readonly string[]): void {
  for (const tool of generation.lease.binding.tools) {
    if (tools && !tools.includes(tool.tool)) continue;
    let token = generation.revoked.get(tool.name);
    if (!token) { token = new AbortController(); generation.revoked.set(tool.name, token); }
    token.abort();
  }
}
export interface McpCompositionScope {
  snapshot(): McpAuthorityLease;
  restore(selection: McpCompositionSelection, signal?: AbortSignal): Promise<McpAuthorityLease>;
  release(): void;
}
export interface McpCompositionSelection {
  tools: readonly { name: string; version: string }[];
  resources: Readonly<Record<string, string>>;
}

class Scope {
  readonly observers = new Set<() => void>();
  readonly servers = new Map<string, ServerSlot>();
  readonly lifetime = new AbortController();
  gateway: Generation;
  unsubscribe?: () => void;
  closed = false;
  private revision = Symbol();
  private readonly changedTools = new Set<string>();
  private credentialsChanged = false;
  private readonly waiters = new Set<() => void>();

  constructor(readonly authority: McpAuthority, readonly scope: McpAuthorityScope, gateway: McpAuthorityLease,
    private readonly failed: (code: string, reference: string) => void) {
    this.gateway = generation(gateway);
    this.apply(gateway, false);
    void authority.subscribe(scope, change => this.refresh(change)).then(unsubscribe => {
      if (this.closed) unsubscribe(); else {
        this.unsubscribe = unsubscribe;
        // Close the initial read/watch-registration gap using the same configuration owner.
        this.refresh({ kind: 'configuration' });
      }
    }, () => { if (!this.closed) failed('mcp_configuration_watch_failed', gateway.binding.reference); });
  }
  notify(): void {
    queueMicrotask(() => {
      for (const waiter of this.waiters) waiter();
      if (!this.closed) for (const observer of this.observers) { try { observer(); } catch { /* Independent consumers cannot block publication. */ } }
    });
  }
  refresh(change: McpChange): void {
    if (this.closed) return;
    if (change.kind === 'tools') this.changedTools.add(change.server);
    if (change.kind === 'credentials') this.credentialsChanged = true;
    const revision = this.revision = Symbol();
    void this.authority.acquire(this.scope, { servers: [], signal: this.lifetime.signal }).then(lease => {
      if (this.closed || revision !== this.revision) { lease.release(); return; }
      const credentials = this.credentialsChanged; this.credentialsChanged = false;
      const tools = new Set(this.changedTools); this.changedTools.clear();
      if (lease.binding.generation === this.gateway.lease.binding.generation && !credentials && !tools.size) lease.release();
      else this.replaceGateway(lease);
      this.apply(this.gateway.lease, credentials, tools);
      this.notify();
    }, () => { if (!this.closed && revision === this.revision) this.failed('mcp_configuration_preparation_failed', this.gateway.lease.binding.reference); });
  }
  update(gateway: McpAuthorityLease): void {
    if (gateway.binding.generation === this.gateway.lease.binding.generation) { gateway.release(); return; }
    this.replaceGateway(gateway); this.apply(gateway, false); this.notify();
  }
  private replaceGateway(lease: McpAuthorityLease): void {
    const previous = this.gateway; this.gateway = generation(lease); release(previous);
  }
  private apply(lease: McpAuthorityLease, credentials: boolean, changedTools: ReadonlySet<string> = new Set()): void {
    // Malformed configuration does not establish that an existing dependency was removed.
    if (lease.binding.readiness.configErrorCount) return;
    const configured = new Map(lease.binding.servers.map(server => [server.name, server]));
    for (const [name, slot] of this.servers) {
      const server = configured.get(name);
      if (!server || server.status === 'disabled' || server.exposure === 'hidden' || !server.hasDirectTools) {
        slot.preparation?.abort();
        if (slot.current) {
          if (!server || server.status === 'disabled' || server.exposure === 'hidden') revoke(slot.current);
          release(slot.current);
        }
        this.servers.delete(name);
      }
    }
    for (const selection of lease.binding.serverSelections) {
      const server = configured.get(selection.name)!;
      if (server.status === 'disabled' || server.exposure === 'hidden' || !server.hasDirectTools) continue;
      let slot = this.servers.get(server.name);
      if (!slot) { slot = { version: '' }; this.servers.set(server.name, slot); }
      if (slot.current) {
        revoke(slot.current, selection.hiddenTools);
        if (credentials) {
          for (const tool of slot.current.lease.binding.tools) {
            try { slot.current.lease.assertCallable(tool.name, tool.schemaVersion); }
            catch { revoke(slot.current, [tool.tool]); }
          }
        }
      }
      if (slot.version === selection.configurationVersion && !credentials && !changedTools.has(server.name)) continue;
      slot.version = selection.configurationVersion;
      slot.preparation?.abort();
      const controller = new AbortController(); slot.preparation = controller;
      const selected = slot;
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
      void this.authority.acquire(this.scope, { servers: [server.name], signal }).then(candidate => {
        if (this.closed || signal.aborted || this.servers.get(server.name) !== selected || selected.preparation !== controller) { candidate.release(); return; }
        delete selected.preparation;
        const previous = selected.current;
        // Other configuration files or sibling readiness do not replace an unchanged endpoint.
        if (previous && previous.lease.implementationIdentity === candidate.implementationIdentity
          && ![...previous.revoked.values()].some(token => token.signal.aborted)
          && JSON.stringify(previous.lease.binding.tools) === JSON.stringify(candidate.binding.tools)) { candidate.release(); return; }
        selected.current = generation(candidate);
        if (previous) release(previous);
        this.notify();
      }, () => {
        if (!this.closed && !signal.aborted && selected.preparation === controller) { delete selected.preparation; this.notify(); }
      });
    }
  }
  private requiredServers(selection: McpCompositionSelection): Set<string> {
    const resources = new Set(selection.tools.map(tool => selection.resources[tool.name]).filter(value => typeof value === 'string'));
    const selected = new Set<string>();
    for (const server of this.gateway.lease.binding.servers) if (resources.delete(server.resourceKey)) selected.add(server.name);
    if (resources.size) throw new Error('mcp_saved_dependency_unavailable');
    return selected;
  }
  async restore(selection: McpCompositionSelection, caller?: AbortSignal): Promise<McpAuthorityLease> {
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal;
    for (;;) {
      signal.throwIfAborted();
      const required = this.requiredServers(selection);
      let preparing = false;
      for (const server of required) {
        const slot = this.servers.get(server);
        if (!slot) throw new Error('mcp_saved_dependency_unavailable');
        if (slot.preparation) { preparing = true; continue; }
        if (!slot.current) throw new Error('mcp_saved_dependency_failed');
      }
      if (!preparing) {
        const result = this.snapshot(selection);
        const versions = new Set(result.binding.tools.filter(tool => tool.exposure === 'direct').map(tool => targetKey(tool.name, tool.schemaVersion)));
        if (selection.tools.some(tool => selection.resources[tool.name] && !versions.has(targetKey(tool.name, tool.version)))) {
          result.release(); throw new Error('mcp_saved_schema_unavailable');
        }
        return result;
      }
      await new Promise<void>((resolve, reject) => {
        const changed = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new Error('mcp_composition_cancelled')); };
        const cleanup = () => { this.waiters.delete(changed); signal.removeEventListener('abort', aborted); };
        this.waiters.add(changed); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
  }
  snapshot(selection?: McpCompositionSelection): McpAuthorityLease {
    if (this.closed) throw new Error('mcp_composition_closed');
    const required = selection ? this.requiredServers(selection) : undefined;
    const gateway = retain(this.gateway);
    const versions = selection ? new Set(selection.tools.map(tool => tool.version)) : undefined;
    const contributions = [...this.servers].flatMap(([name, slot]) => slot.current && (!required || required.has(name)) ? [retain(slot.current)] : []);
    const targets = new Map<string, { generation: Generation; original: McpAuthorityTool }>();
    const discovered = new Set<string>();
    const source = contributions.flatMap(owner => owner.lease.binding.tools.filter(tool => tool.exposure !== 'direct' || !versions || versions.has(tool.schemaVersion)).map(tool => ({ owner, tool })));
    const plain = source.filter(({ tool }) => tool.exposure === 'direct').map(({ tool }) => createMcpToolName(tool.server, tool.tool));
    const counts = new Map<string, number>(); for (const name of plain) counts.set(name, (counts.get(name) ?? 0) + 1);
    const tools = source.map(({ owner, tool }) => {
      const name = tool.exposure === 'direct' ? createMcpToolName(tool.server, tool.tool, candidate => (counts.get(candidate) ?? 0) > 1) : tool.name;
      targets.set(targetKey(name, tool.schemaVersion), { generation: owner, original: tool });
      return Object.freeze({ ...tool, name });
    }).sort((a, b) => a.name.localeCompare(b.name));
    const readiness = gateway.lease.inspect();
    const binding = Object.freeze({ ...gateway.lease.binding, tools: Object.freeze(tools), readiness, servers: readiness.servers,
      generation: 1 + Number.parseInt(createHash('sha256').update(JSON.stringify([gateway.lease.binding.generation,
        readiness.configErrorCount, tools.filter(tool => tool.exposure === 'direct').map(tool => [tool.name, tool.schemaVersion, tool.exposure])])).digest('hex').slice(0, 12), 16) });
    let released = false;
    const target = (name: string, version: string) => {
      if (released) throw new Error('mcp_lease_released');
      const selected = targets.get(targetKey(name,version));
      if (!selected && !discovered.has(targetKey(name,version))) throw new Error('mcp_target_unbound');
      const owner = selected ? selected.generation : gateway;
      const original = selected ? selected.original.name : name;
      if (owner.revoked.get(original)?.signal.aborted) throw new Error('mcp_tool_revoked');
      return { owner, name: original };
    };
    return {
      binding,
      implementationIdentity:createHash('sha256').update(JSON.stringify([gateway.identity,
        contributions.map(owner=>owner.identity).sort(),tools.map(tool=>[tool.name,tool.schemaVersion])])).digest('hex'),
      inspect: () => { if (released) throw new Error('mcp_lease_released'); return gateway.lease.inspect(); },
      discover: async (server, signal) => {
        if (released) throw new Error('mcp_lease_released');
        const tools=await gateway.lease.discover(server,signal);
        for(const tool of tools) discovered.add(targetKey(tool.name,tool.schemaVersion));
        return tools;
      },
      prepareTool: async (server,tool,version,signal) => {
        if (released) throw new Error('mcp_lease_released');
        const selected=await gateway.lease.prepareTool(server,tool,version,signal);
        discovered.add(targetKey(selected.name,selected.schemaVersion));return selected;
      },
      assertCallable: (name,version) => { const selected=target(name,version); selected.owner.lease.assertCallable(selected.name,version); },
      revocationSignal: (name,version) => {
        const selected=target(name,version);
        let token=selected.owner.revoked.get(selected.name);
        if (!token) { token=new AbortController();selected.owner.revoked.set(selected.name,token); }
        return AbortSignal.any([token.signal, selected.owner.lease.revocationSignal(selected.name,version)]);
      },
      validateArguments: (name,version,args) => { const selected=target(name,version); selected.owner.lease.validateArguments(selected.name,version,args); },
      callTool: (name,args,options) => { const selected=target(name,options.schemaVersion); return selected.owner.lease.callTool(selected.name,args,options); },
      release: () => { if (released) return; released=true;release(gateway);for (const owner of contributions) release(owner); },
    };
  }
  close(): void {
    if (this.closed) return; this.closed=true;this.lifetime.abort();this.unsubscribe?.();this.observers.clear();
    release(this.gateway);
    for (const slot of this.servers.values()) { slot.preparation?.abort();if (slot.current) release(slot.current); }
    this.servers.clear();
  }
}

export class McpCompositions {
  private readonly scopes = new Map<string, Scope>();
  private closed = false;
  constructor(private readonly authority: McpAuthority, private readonly failed: (code: string, reference: string) => void) {}
  async observe(scope: McpAuthorityScope, notify: () => void, signal?: AbortSignal): Promise<McpCompositionScope> {
    if (this.closed) throw new Error('mcp_compositions_closed');
    const gateway=await this.authority.acquire(scope,{servers:[],...(signal?{signal}:{})});
    if (this.closed || signal?.aborted) {gateway.release();throw new Error('mcp_composition_cancelled');}
    const key=gateway.binding.reference;
    let owner=this.scopes.get(key);
    if (!owner) {owner=new Scope(this.authority,scope,gateway,this.failed);this.scopes.set(key,owner);}
    else owner.update(gateway);
    const observer=()=>notify();owner.observers.add(observer);
    const selected=owner;let released=false;
    return {snapshot:()=>{if(released)throw new Error('mcp_composition_released');return selected.snapshot();},
      restore:(selection,signal)=>{if(released)throw new Error('mcp_composition_released');return selected.restore(selection,signal);},release:()=>{
      if(released)return;released=true;selected.observers.delete(observer);
      if(!selected.observers.size && this.scopes.get(key)===selected){this.scopes.delete(key);selected.close();}
    }};
  }
  close():void {if(this.closed)return;this.closed=true;for(const scope of this.scopes.values())scope.close();this.scopes.clear();}
}
