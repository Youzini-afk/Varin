/** Ready MCP contributions over the sole connection/configuration authority. A scope prepares
 * each direct dependency independently; snapshots retain only their concrete selected leases. */
import { createHash, randomUUID } from 'node:crypto';
import { createMcpToolName } from '@earendil-works/pi-coding-agent';
import { isDeepStrictEqual } from 'node:util';
import type { McpProvenance, McpRoute } from '@varin/protocol';
import { McpAuthorityError, type McpAuthority, type McpAuthorityLease, type McpAuthorityOwnedLease, type McpAuthorityScope, type McpAuthorityTool, type McpChange, type McpDefinitionLease } from './mcp-authority.js';

interface Generation {
  identity: string;
  lease: McpAuthorityOwnedLease;
  drained: Promise<void>;
  resolveDrain(): void;
  rejectDrain(error: unknown): void;
  references: number;
  revoked: Map<string, AbortController>;
}
interface ServerSlot {
  version: string;
  current?: Generation;
  preparation?: AbortController;
}
const retain = (generation: Generation) => { generation.references++; return generation; };
const release = (generation: Generation) => {
  if (--generation.references === 0) generation.lease.releaseAndDrain().then(generation.resolveDrain, generation.rejectDrain);
};
function generation(lease: McpAuthorityOwnedLease): Generation {
  let resolveDrain!: () => void, rejectDrain!: (error: unknown) => void;
  const drained = new Promise<void>((resolve, reject) => { resolveDrain = resolve; rejectDrain = reject; });
  return { identity: randomUUID(), lease, references: 1, revoked: new Map(), drained, resolveDrain, rejectDrain };
}
const failedDrain = (error: unknown) => error instanceof McpAuthorityError && error.code === 'mcp-close-failed';
const targetKey = (name: string, version: string) => JSON.stringify([name, version]);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function revoke(generation: Generation, tools?: readonly string[]): void {
  if (!tools) for (const server of generation.lease.binding.servers.filter(server => server.selected)) {
    const key = `server:${server.name}`;
    let token = generation.revoked.get(key);
    if (!token) { token = new AbortController(); generation.revoked.set(key, token); }
    token.abort();
  }
  for (const tool of generation.lease.binding.tools) {
    if (tools && !tools.includes(tool.tool)) continue;
    let token = generation.revoked.get(tool.name);
    if (!token) { token = new AbortController(); generation.revoked.set(tool.name, token); }
    token.abort();
  }
}
/** Exact original generations held by one local composition snapshot, never a remote lease. */
export interface McpCompositionSnapshot extends McpAuthorityLease {
  retainDefinitions(exactProvenance: McpProvenance): McpCompositionDefinitions;
}
export interface McpCompositionDefinitions {
  readonly provenance: McpProvenance;
  readonly contributions: readonly McpDefinitionLease[];
  release(): void;
}
export interface McpCompositionScope {
  snapshot(): McpCompositionSnapshot;
  restore(selection: McpCompositionSelection, signal?: AbortSignal): Promise<McpCompositionSnapshot>;
  release(): void;
  /** Release this observation and await its last-owner preparation/SDK transport drainage.
   * Existing snapshot references retain their original lifetimes. No native tree receipt. */
  releaseAndDrain(): Promise<void>;
}
export interface McpCompositionSelection {
  provenance: McpProvenance;
  tools: readonly { name: string; version: string }[];
  resources: Readonly<Record<string, string>>;
  routes: Readonly<Record<string, McpRoute>>;
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
  private readonly pending = new Set<Promise<void>>();
  private draining?: Promise<void>;

  constructor(readonly authority: McpAuthority, readonly scope: McpAuthorityScope, gateway: McpAuthorityOwnedLease,
    private readonly failed: (code: string, reference: string) => void) {
    this.scope = freeze(structuredClone(scope));
    this.gateway = this.own(gateway);
    this.apply(gateway, false);
    this.track(authority.subscribe(this.scope, change => this.refresh(change)).then(unsubscribe => {
      if (this.closed) unsubscribe(); else {
        this.unsubscribe = unsubscribe;
        // Close the initial read/watch-registration gap using the same configuration owner.
        this.refresh({ kind: 'configuration' });
      }
    }, () => { if (!this.closed) failed('mcp_configuration_watch_failed', gateway.binding.reference); }));
  }
  private track(pending: Promise<void>): void {
    this.pending.add(pending);
    // Fulfilled work can be discarded; a rejected close remains part of the drain outcome.
    void pending.then(() => this.pending.delete(pending), () => undefined);
  }
  private own(lease: McpAuthorityOwnedLease): Generation {
    const owned = generation(lease); this.track(owned.drained); return owned;
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
    this.track(this.authority.acquire(this.scope, { servers: [], signal: this.lifetime.signal }).then(lease => {
      if (this.closed || revision !== this.revision) return lease.releaseAndDrain();
      const credentials = this.credentialsChanged; this.credentialsChanged = false;
      const tools = new Set(this.changedTools); this.changedTools.clear();
      if (lease.binding.generation === this.gateway.lease.binding.generation && !credentials && !tools.size) this.track(lease.releaseAndDrain());
      else this.replaceGateway(lease);
      this.apply(this.gateway.lease, credentials, tools);
      this.notify();
    }, error => {
      if (failedDrain(error)) throw error;
      if (!this.closed && revision === this.revision) this.failed('mcp_configuration_preparation_failed', this.gateway.lease.binding.reference);
    }));
  }
  update(gateway: McpAuthorityOwnedLease): void {
    if (gateway.binding.generation === this.gateway.lease.binding.generation) { this.track(gateway.releaseAndDrain()); return; }
    this.replaceGateway(gateway); this.apply(gateway, false); this.notify();
  }
  private replaceGateway(lease: McpAuthorityOwnedLease): void {
    const previous = this.gateway;
    // Explicit withdrawal also interrupts new service admissions retained by deferred snapshots.
    // Ordinary replacement retires the old binding without changing its granted lifetime.
    if (!lease.binding.readiness.configErrorCount) for (const server of previous.lease.binding.servers) {
      const next = lease.binding.servers.find(candidate => candidate.name === server.name);
      if (!next || next.status === 'disabled' || next.exposure === 'hidden') {
        const key = `server:${server.name}`;
        let token = previous.revoked.get(key);
        if (!token) { token = new AbortController(); previous.revoked.set(key, token); }
        token.abort();
      }
    }
    this.gateway = this.own(lease); release(previous);
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
      this.track(this.authority.acquire(this.scope, { servers: [server.name], signal }).then(candidate => {
        if (this.closed || signal.aborted || this.servers.get(server.name) !== selected || selected.preparation !== controller) return candidate.releaseAndDrain();
        delete selected.preparation;
        const previous = selected.current;
        // Other configuration files or sibling readiness do not replace an unchanged endpoint.
        if (previous && previous.lease.implementationIdentity === candidate.implementationIdentity
          && ![...previous.revoked.values()].some(token => token.signal.aborted)
          && JSON.stringify(previous.lease.binding.tools) === JSON.stringify(candidate.binding.tools)) return candidate.releaseAndDrain();
        selected.current = this.own(candidate);
        if (previous) release(previous);
        this.notify();
      }, error => {
        if (failedDrain(error)) throw error;
        if (!this.closed && !signal.aborted && selected.preparation === controller) { delete selected.preparation; this.notify(); }
      }));
    }
  }
  private requiredServers(selection: McpCompositionSelection): Set<string> {
    for (const [name, expected] of Object.entries(selection.provenance.servers)) {
      // A ready contribution can legitimately retain its original definition while a new
      // candidate prepares. The current gateway must not relabel that endpoint's identity.
      const actual = this.servers.get(name)?.current?.lease.binding.provenance.servers[name]
        ?? this.gateway.lease.binding.provenance.servers[name];
      if (!isDeepStrictEqual(actual, expected)) throw new Error('mcp_saved_definition_unavailable');
    }
    const resources = new Set(selection.tools.filter(tool => ['direct','direct_task'].includes(selection.routes[tool.name]?.kind ?? '')).map(tool => selection.resources[tool.name]).filter(value => typeof value === 'string'));
    const selected = new Set<string>();
    for (const [name, server] of Object.entries(selection.provenance.servers)) if (resources.delete(server.resource_key)) selected.add(name);
    if (resources.size) throw new Error('mcp_saved_dependency_unavailable');
    return selected;
  }
  async restore(selection: McpCompositionSelection, caller?: AbortSignal): Promise<McpCompositionSnapshot> {
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal;
    for (;;) {
      signal.throwIfAborted();
      const required = this.requiredServers(selection);
      let preparing = false;
      for (const server of required) {
        const slot = this.servers.get(server);
        if (!slot) throw new Error('mcp_saved_dependency_unavailable');
        if (slot.current) continue;
        if (slot.preparation) { preparing = true; continue; }
        throw new Error('mcp_saved_dependency_failed');
      }
      if (!preparing) {
        const result = this.snapshot(selection);
        if (selection.tools.some(tool => {
          const resource = selection.resources[tool.name];
          if (!resource) return false;
          const server = Object.entries(selection.provenance.servers).find(([, selected]) => selected.resource_key === resource)?.[0];
          // A cross-owner composition may disambiguate the public name. Restore by its exact
          // original server/schema; the outer adapter preserves that frozen public alias.
          return !result.binding.tools.some(actual => actual.exposure === 'direct' && actual.server === server && actual.schemaVersion === tool.version);
        })) {
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
  snapshot(selection?: McpCompositionSelection): McpCompositionSnapshot {
    if (this.closed) throw new Error('mcp_composition_closed');
    if (selection) this.requiredServers(selection);
    const gateway = retain(this.gateway);
    const versions = selection ? new Set(selection.tools.map(tool => tool.version)) : undefined;
    // Admitted servers may be used through resources/prompts without a direct tool. Keep
    // their exact ready contribution too, instead of substituting the current gateway.
    const contributions = [...this.servers].flatMap(([name, slot]) => slot.current && (!selection || name in selection.provenance.servers) ? [retain(slot.current)] : []);
    const targets = new Map<string, { generation: Generation; original: McpAuthorityTool }>();
    const discovered = new Map<string, Generation>();
    const source = contributions.flatMap(owner => owner.lease.binding.tools.filter(tool => tool.exposure !== 'direct' || !versions || versions.has(tool.schemaVersion)).map(tool => ({ owner, tool })));
    const plain = source.filter(({ tool }) => tool.exposure === 'direct').map(({ tool }) => createMcpToolName(tool.server, tool.tool));
    const counts = new Map<string, number>(); for (const name of plain) counts.set(name, (counts.get(name) ?? 0) + 1);
    const tools = source.map(({ owner, tool }) => {
      const name = tool.exposure === 'direct' ? createMcpToolName(tool.server, tool.tool, candidate => (counts.get(candidate) ?? 0) > 1) : tool.name;
      targets.set(targetKey(name, tool.schemaVersion), { generation: owner, original: tool });
      return Object.freeze({ ...tool, name });
    }).sort((a, b) => a.name.localeCompare(b.name));
    const inspect = () => {
      const observed = gateway.lease.inspect();
      if (!selection) return observed;
      const servers = observed.servers.filter(server => server.name in selection.provenance.servers);
      return { ...observed, servers, configuredServerCount: servers.length,
        connectedServerCount: servers.filter(server => server.status === 'connected').length,
        cachedToolCount: servers.reduce((sum, server) => sum + server.cachedToolCount, 0) };
    };
    const readiness = inspect();
    const provenance = structuredClone(gateway.lease.binding.provenance);
    for (const owner of contributions) for (const server of owner.lease.binding.servers.filter(server => server.selected)) {
      const original = owner.lease.binding.provenance.servers[server.name];
      if (original) provenance.servers[server.name] = structuredClone(original);
    }
    if (selection) provenance.servers = Object.fromEntries(Object.entries(provenance.servers).filter(([name]) => name in selection.provenance.servers));
    const binding = Object.freeze({ ...gateway.lease.binding, provenance: freeze(provenance), tools: Object.freeze(tools), readiness, servers: readiness.servers,
      generation: 1 + Number.parseInt(createHash('sha256').update(JSON.stringify([gateway.lease.binding.generation,
        readiness.configErrorCount, tools.filter(tool => tool.exposure === 'direct').map(tool => [tool.name, tool.schemaVersion, tool.exposure])])).digest('hex').slice(0, 12), 16) });
    let released = false;
    const target = (name: string, version: string) => {
      if (released) throw new Error('mcp_lease_released');
      const selected = targets.get(targetKey(name,version));
      if (!selected && !discovered.has(targetKey(name,version))) throw new Error('mcp_target_unbound');
      const owner = selected ? selected.generation : discovered.get(targetKey(name,version))!;
      const original = selected ? selected.original.name : name;
      if (owner.revoked.get(original)?.signal.aborted) throw new Error('mcp_tool_revoked');
      return { owner, name: original };
    };
    const serverOwner = (server: string) => {
      if (released) throw new Error('mcp_lease_released');
      const original = binding.provenance.servers[server];
      if (!original) throw new Error('mcp_target_unbound');
      const owner = contributions.find(owner => owner.lease.binding.servers.some(candidate => candidate.name === server && candidate.selected)
        && isDeepStrictEqual(owner.lease.binding.provenance.servers[server], original))
        ?? (isDeepStrictEqual(gateway.lease.binding.provenance.servers[server], original) ? gateway : undefined);
      if (!owner) throw new Error('mcp_saved_definition_unavailable');
      if (owner.revoked.get(`server:${server}`)?.signal.aborted) throw new Error('mcp_service_revoked');
      return owner;
    };
    return {
      binding,
      retainDefinitions: exact => {
        if (released) throw new Error('mcp_lease_released');
        const provenance = freeze(structuredClone(exact));
        const cuts = new Map<Generation, McpProvenance>();
        for (const [name, expected] of Object.entries(provenance.servers)) {
          if (!isDeepStrictEqual(binding.provenance.servers[name], expected)) throw new Error('mcp_saved_definition_unavailable');
          const owner = serverOwner(name);
          let cut = cuts.get(owner);
          if (!cut) { cut = { servers: {} }; cuts.set(owner, cut); }
          cut.servers[name] = expected;
        }
        const retained: McpDefinitionLease[] = [];
        try {
          for (const [owner, cut] of cuts) retained.push(owner.lease.retainDefinitions(cut));
        } catch (error) {
          for (const contribution of retained) contribution.release();
          throw error;
        }
        let definitionsReleased = false;
        return Object.freeze({ provenance, contributions: Object.freeze(retained), release: () => {
          if (definitionsReleased) return;
          definitionsReleased = true;
          for (const contribution of retained) contribution.release();
        } });
      },
      implementationIdentity:createHash('sha256').update(JSON.stringify([gateway.identity,
        contributions.map(owner=>owner.identity).sort(),tools.map(tool=>[tool.name,tool.schemaVersion])])).digest('hex'),
      inspect: () => { if (released) throw new Error('mcp_lease_released'); return inspect(); },
      discover: async (server, signal) => {
        if (released) throw new Error('mcp_lease_released');
        if (selection && !(server in selection.provenance.servers)) throw new Error('mcp_target_unbound');
        const owner=serverOwner(server);
        const tools=await owner.lease.discover(server,signal);
        for(const tool of tools) discovered.set(targetKey(tool.name,tool.schemaVersion),owner);
        return tools;
      },
      prepareTool: async (server,tool,version,signal) => {
        if (released) throw new Error('mcp_lease_released');
        if (selection && !(server in selection.provenance.servers)) throw new Error('mcp_target_unbound');
        const owner=serverOwner(server);
        const selected=await owner.lease.prepareTool(server,tool,version,signal);
        discovered.set(targetKey(selected.name,selected.schemaVersion),owner);return selected;
      },
      resourceEndpoint: service => serverOwner(service.server).lease.resourceEndpoint(service),
      observeResource: (service,uri,options) => serverOwner(service.server).lease.observeResource(service,uri,options),
      taskOwner: (server,endpoint,signal,origin) => serverOwner(server).lease.taskOwner(server,endpoint,signal,origin),
      discoverServices: (server,signal) => serverOwner(server).lease.discoverServices(server,signal),
      prepareService: (server,kind,version,signal) => serverOwner(server).lease.prepareService(server,kind,version,signal),
      preparePrompt: (server,name,version,signal) => serverOwner(server).lease.preparePrompt(server,name,version,signal),
      assertService: service => serverOwner(service.server).lease.assertService(service),
      serviceRevocationSignal: service => {
        const owner = serverOwner(service.server), key = `server:${service.server}`;
        let token = owner.revoked.get(key);
        if (!token) { token = new AbortController(); owner.revoked.set(key, token); }
        return AbortSignal.any([token.signal, owner.lease.serviceRevocationSignal(service)]);
      },
      validateServiceRequest: (service,request) => serverOwner(service.server).lease.validateServiceRequest(service,request),
      requestService: (service,request,options) => serverOwner(service.server).lease.requestService(service,request,options),
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
  closeAndDrain(): Promise<void> {
    this.close();
    if (!this.draining) {
      this.draining = Promise.allSettled([...this.pending]).then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
      void this.draining.catch(() => undefined);
    }
    return this.draining;
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
    if (this.closed || signal?.aborted) {await gateway.releaseAndDrain();throw new Error('mcp_composition_cancelled');}
    const key=gateway.binding.reference;
    let owner=this.scopes.get(key);
    if (!owner) {owner=new Scope(this.authority,scope,gateway,this.failed);this.scopes.set(key,owner);}
    else owner.update(gateway);
    const observer=()=>notify();owner.observers.add(observer);
    const selected=owner;let released=false;
    let draining: Promise<void> | undefined;
    const release = () => {
      if (released) return; released=true;selected.observers.delete(observer);
      if (selected.closed || !selected.observers.size && this.scopes.get(key)===selected) {
        this.scopes.delete(key);draining=selected.closeAndDrain();
      }
    };
    return {snapshot:()=>{if(released)throw new Error('mcp_composition_released');return selected.snapshot();},
      restore:(selection,signal)=>{if(released)throw new Error('mcp_composition_released');return selected.restore(selection,signal);},
      release,
      releaseAndDrain:()=>{release();return draining ?? Promise.resolve();},
    };
  }
  close():void {if(this.closed)return;this.closed=true;for(const scope of this.scopes.values())scope.close();this.scopes.clear();}
}
