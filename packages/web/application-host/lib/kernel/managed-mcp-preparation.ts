/** Independent target readiness. Pending B contributions do not block A's ready global tools. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { McpAuthorityLease } from '../mcp/authority.js';
import type { AgentRuntimeClient, McpPreparation } from './agent-runtime-client.js';
import type { ManagedSourceAccess } from './managed-source-consumers.js';
import type { McpBinding, SourceResourceOwner } from './protocol.generated.js';
import type { createManagedMcpLease, ManagedMcpLease } from './managed-mcp-lease.js';
import type { ManagedMcpSnapshot, ManagedMcpRevocations } from '../harness/managed-mcp-contract.js';
import { isManagedMcpRevocations } from '../harness/managed-mcp-contract.js';

/** A dependency cut, not a new configuration owner. Gateways remain constrained by this server set. */
export function selectMcpServers(binding: McpBinding, predicate: (owner: SourceResourceOwner) => boolean): McpBinding {
  const servers = Object.fromEntries(Object.entries(binding.provenance.servers).filter(([, server]) => predicate(server.owner.resource_owner)));
  const resources = new Set(Object.values(servers).map(server => server.resource_key));
  const tools = binding.tools.filter(tool => !binding.resources[tool.name] || resources.has(binding.resources[tool.name]!));
  return { ...binding, provenance: { servers }, tools,
    routes: Object.fromEntries(Object.entries(binding.routes).filter(([name]) => tools.some(tool => tool.name === name))),
    resources: Object.fromEntries(Object.entries(binding.resources).filter(([name, resource]) =>
      name.startsWith('server:') ? name.slice(7) in servers : resources.has(resource) && tools.some(tool => tool.name === name))) };
}
interface Scope {
  owner: SourceResourceOwner;
  controller: AbortController;
  ready: Promise<void>;
  revocations: Map<string, ManagedMcpRevocations>;
  listeners: Map<string, (facts: ManagedMcpRevocations) => void>;
  access?: ManagedSourceAccess;
  initial?: { lease: ManagedMcpLease; snapshot: ManagedMcpSnapshot };
  failure?: unknown;
  incarnation?: string;
  revision?: number;
}
export function createManagedMcpPreparer(options: {
  runtime(): AgentRuntimeClient;
  createLease: typeof createManagedMcpLease;
  changed(runId: string): void;
  onError(): void;
}) {
  const scopes = new Map<string, Scope>();
  const watch = async (runId: string, scope: Scope, snapshot: ManagedMcpSnapshot) => {
    scope.incarnation = snapshot.incarnation; scope.revision = snapshot.revision;
    while (!scope.controller.signal.aborted && scopes.get(runId) === scope) {
      const access = scope.access!;
      const reply = await access.client.service({ coordinatorHostId: options.runtime().coordinatorHostId,
        authorityId: access.binding.authorityId, resourceEpoch: access.binding.resourceEpoch,
        requestId: `mcp-change:${randomUUID()}`, operation: { kind: 'mcp', action: {
          kind: 'changed', incarnation: scope.incarnation!, after: scope.revision! } } }, scope.controller.signal);
      if (!reply.ok) throw new Error(reply.error.code);
      const change = reply.value as { incarnation?: unknown; revision?: unknown; revocations?: Record<string, ManagedMcpRevocations> };
      if (change?.incarnation !== scope.incarnation || !Number.isSafeInteger(change.revision)
        || Number(change.revision) <= scope.revision! || !change.revocations || typeof change.revocations !== 'object'
        || Array.isArray(change.revocations) || !Object.values(change.revocations).every(isManagedMcpRevocations)) throw new Error('mcp_change_owner_invalid');
      scope.revision = Number(change.revision);
      for (const handle of scope.revocations.keys()) if (!(handle in change.revocations)) scope.revocations.delete(handle);
      for (const [handle, facts] of Object.entries(change.revocations ?? {})) {
        scope.revocations.set(handle, facts); scope.listeners.get(handle)?.(facts);
      }
      options.changed(runId);
    }
  };
  const observeRevocations = (scope: Scope) => (handle: string, receive: (facts: ManagedMcpRevocations) => void) => {
    scope.listeners.set(handle, receive); const facts = scope.revocations.get(handle); if (facts) receive(facts);
    return () => { scope.listeners.delete(handle); scope.revocations.delete(handle); };
  };
  const release = (runId: string) => {
    const scope = scopes.get(runId); if (!scope) return;
    scopes.delete(runId); scope.controller.abort(); scope.initial?.lease.release(); delete scope.initial;
  };
  return {
    release,
    close: () => { for (const runId of scopes.keys()) release(runId); },
    sourceReached(owner: SourceResourceOwner) {
      for (const [runId, scope] of scopes) if (scope.failure && isDeepStrictEqual(scope.owner, owner)) {
        release(runId); options.changed(runId);
      }
    },
    async prepare(input: McpPreparation, signal?: AbortSignal): Promise<ManagedMcpLease | undefined> {
      const source = input.source;
      if (!source || source.resourceOwner.kind !== 'managed_host' || source.mode === 'fixed_branch') return undefined;
      // Child re-derivation needs the original mixed-owner handoff, not a new latest candidate.
      if (input.fixed) throw new Error('Managed MCP child contribution preparation is unavailable');
      let scope = scopes.get(input.runId);
      if (scope && !isDeepStrictEqual(scope.owner, source.resourceOwner)) { release(input.runId); scope = undefined; }
      const selection = input.requiredBinding ? selectMcpServers(input.requiredBinding,
        owner => isDeepStrictEqual(owner, source.resourceOwner)) : undefined;
      const originals = Object.values(selection?.provenance.servers ?? {}).map(server => server.owner.source_authority);
      if (originals.some(original => !original || !isDeepStrictEqual(original, originals[0]))) throw new Error('mcp_original_source_authority_changed');
      if (!scope) {
        const selected: Scope = { owner: source.resourceOwner, controller: new AbortController(), ready: undefined as never, revocations: new Map(), listeners: new Map() };
        scopes.set(input.runId, selected); scope = selected;
        selected.ready = options.runtime().withManagedSourceAuthority<void>(input.runId, { ...source, tools: [...source.tools] }, async access => {
          selected.access = access;
          const initial = await options.createLease({ access, coordinatorHostId: options.runtime().coordinatorHostId,
            owner: source.resourceOwner, ...(selection ? { selection } : {}), lifetime: selected.controller.signal, observeRevocations: observeRevocations(selected) });
          if (scopes.get(input.runId) !== selected || selected.controller.signal.aborted) { initial.lease.release(); return; }
          selected.initial = initial;
          void watch(input.runId, selected, initial.snapshot).catch(error => {
            if (selected.controller.signal.aborted) return;
            selected.failure = error; selected.controller.abort(); options.onError();
          });
          options.changed(input.runId);
        }, selected.controller.signal, { purpose: 'mcp_owner', ...(originals[0] ? { original: originals[0] } : {}) }).catch(error => {
          selected.failure = error; if (!selected.controller.signal.aborted) options.onError();
        });
      }
      // Only a saved original dependency waits here; a fresh Run publishes already-ready A tools.
      if (selection && Object.keys(selection.provenance.servers).length) await scope.ready;
      if (scope.failure) { if (selection && Object.keys(selection.provenance.servers).length) throw scope.failure; return undefined; }
      if (scope.initial) {
        signal?.throwIfAborted(); const initial = scope.initial; delete scope.initial; return initial.lease;
      }
      if (!scope.access || !scope.incarnation) return undefined;
      const current = await options.createLease({ access: scope.access, coordinatorHostId: options.runtime().coordinatorHostId,
        owner: source.resourceOwner, ...(selection ? { selection } : {}), lifetime: scope.controller.signal, observeRevocations: observeRevocations(scope), ...(signal ? { signal } : {}) });
      return current.lease;
    },
  };
}
