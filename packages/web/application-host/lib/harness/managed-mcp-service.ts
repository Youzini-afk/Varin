/** Target-side contribution views over the existing MCP authority. Catalog stays on A. */
import { randomUUID } from 'node:crypto';
import type { McpAuthorityLease, McpAuthorityScope, McpAuthorityTool, McpAuthorityService, McpTransport } from '@varin/pi-host/mcp-authority';
import type { McpCompositions, McpCompositionScope } from '@varin/pi-host/mcp-authority';
import type { ManagedSourceLocalScope } from './managed-remote-types.js';
import type { ManagedMcpAction, ManagedMcpReply, ManagedMcpSnapshot, ManagedMcpRevocations } from './managed-mcp-contract.js';
class ManagedMcpAdmissionError extends Error {
  readonly dispatched = false;
  constructor(readonly code: string) { super(code); }
}

interface View {
  work: Promise<McpAuthorityLease>;
  lease?: McpAuthorityLease;
  selection: string;
  creationRequestId: string;
  tools: Map<string, McpAuthorityTool>;
  services: Map<string, McpAuthorityService>;
  tokens: Map<string, AbortSignal>;
}
const targetKey = (name: string, schemaVersion: string) => JSON.stringify([name, schemaVersion]);
function revokedTarget(view: View, key: string, token: () => AbortSignal): boolean {
  let original = view.tokens.get(key);
  if (!original) {
    try { original = token(); view.tokens.set(key, original); }
    catch (error) {
      // A failed replacement or temporarily invalid config is not an explicit withdrawal.
      const code = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : undefined);
      return code === 'mcp_tool_revoked' || code === 'mcp_service_revoked' || code === 'mcp-credential-revoked' || code === 'mcp-owner-revoked';
    }
  }
  return original.aborted;
}
function revoked(view: View): ManagedMcpRevocations {
  const result: ManagedMcpRevocations = { tools: [], services: [] };
  if (!view.lease) return result;
  for (const tool of view.tools.values()) {
    if (revokedTarget(view, `tool:${targetKey(tool.name, tool.schemaVersion)}`, () => view.lease!.revocationSignal(tool.name, tool.schemaVersion)))
      result.tools.push({ name: tool.name, schemaVersion: tool.schemaVersion });
  }
  for (const service of view.services.values()) {
    if (revokedTarget(view, `service:${targetKey(service.server, service.schemaVersion)}`, () => view.lease!.serviceRevocationSignal(service)))
      result.services.push({ server: service.server, schemaVersion: service.schemaVersion });
  }
  return result;
}
interface Owner {
  scope: ManagedSourceLocalScope;
  authorityScope: McpAuthorityScope;
  transports?: { adapt(transport: McpTransport): McpTransport; drain(): Promise<void>; executorsStopped(): boolean };
  incarnation: string;
  revision: number;
  changed: Set<() => void>;
  views: Map<string, View>;
  composition: Promise<McpCompositionScope>;
  closed: boolean;
  closing?: Promise<{ executorStopped: boolean }>;
}
export function createManagedMcpService(options: {
  compositions: Pick<McpCompositions, 'observe'>;
  agentDir: string;
  hostId: string;
  admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{ canonicalPath: string }>;
  admitSource(scope: ManagedSourceLocalScope, signal?: AbortSignal): Promise<void>;
  projectTrusted(cwd: string): boolean;
  transportOwner?(scope: ManagedSourceLocalScope, readmit: (signal: AbortSignal) => Promise<void>): NonNullable<Owner['transports']>;
}) {
  const owners = new Map<string, Owner>();
  const keyOf = (scope: ManagedSourceLocalScope) => JSON.stringify([scope.principal.principalId,
    scope.coordinatorHostId, scope.authorityId, scope.resourceEpoch]);
  const authorize = async (scope: ManagedSourceLocalScope, signal?: AbortSignal): Promise<McpAuthorityScope> => {
    if (scope.source.resource_owner.kind !== 'managed_host' || scope.source.resource_owner.hostId !== options.hostId
      || scope.scope.kind !== 'run' || !scope.physicalRoot || scope.physicalRoot.hostId !== options.hostId || scope.source.mode === 'fixed_branch'
      || !['filesystem:read', 'terminal:use', 'process:control'].every(capability => scope.principal.capabilities.includes(capability)))
      throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
    const project = await options.admitWorkspaceRegistration(scope.source.workspace_id, signal);
    if (!options.projectTrusted(project.canonicalPath)) throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
    await options.admitSource(scope, signal);
    signal?.throwIfAborted();
    return { resourceOwner: scope.source.resource_owner, configurationScopes: ['project'],
      agentDir: options.agentDir, configCwd: project.canonicalPath, projectTrusted: true,
      executionCwd: scope.physicalRoot.canonicalRoot, executionScope: 'workspace',
      environmentId: JSON.stringify([options.hostId, scope.principal.principalId, scope.coordinatorHostId, scope.source.execution_workspace_id,
        scope.authorityId, scope.resourceEpoch]), sessionId: `managed:${scope.coordinatorHostId}:${scope.scope.threadId}` };
  };
  const release = async (scope: ManagedSourceLocalScope) => {
    const key = keyOf(scope), owner = owners.get(key);
    if (!owner) return { executorStopped: false };
    if (owner.closing) return owner.closing;
    owner.closed = true;
    for (const changed of owner.changed) changed();
    const views = [...owner.views.values()]; owner.views.clear();
    owner.closing = (async () => {
      await Promise.allSettled(views.map(async view => (await view.work).release()));
      // Native processes carry their own Storage tree receipts even if SDK close swallows an error.
      const results = await Promise.allSettled([owner.composition.then(composition => composition.releaseAndDrain(), error => {
        // Failed acquisition already drained its candidate. Preserve actual close failures.
        if ((error as { code?: unknown })?.code === 'mcp-close-failed') throw error;
      }), owner.transports?.drain()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Retain a failed close as unresolved; a second cleanup cannot turn it into success.
      if (owners.get(key) === owner) owners.delete(key);
      return { executorStopped: owner.transports?.executorsStopped() === true };
    })();
    const closing = owner.closing;
    void closing.catch(() => { if (owner.closing === closing) delete owner.closing; });
    return closing;
  };
  const execute = async (scope: ManagedSourceLocalScope, action: ManagedMcpAction, signal: AbortSignal): Promise<unknown> => {
    const key = keyOf(scope);
    // A view release carries no new effect authority. Source retirement also calls release().
    if (action.kind === 'release') {
      const owner = owners.get(key), view = owner?.views.get(action.handleId);
      if (view && view.creationRequestId !== action.creationRequestId) throw new Error('mcp_view_creation_changed');
      owner?.views.delete(action.handleId); if (view) (await view.work).release(); return null;
    }
    const authorityScope = await authorize(scope, signal);
    let owner = owners.get(key);
    if (action.kind === 'snapshot') {
      if (typeof action.handleId !== 'string' || !action.handleId) throw new Error('mcp_view_invalid');
      if (!owner) {
        const selected: Owner = { scope, authorityScope, incarnation: randomUUID(), revision: 0, changed: new Set(), views: new Map(),
          closed: false, composition: undefined as never };
        if (options.transportOwner) selected.transports = options.transportOwner(scope, async signal => {
          if (selected.closed) throw new Error('mcp_source_view_closed');
          await authorize(scope, signal);
          if (selected.closed) throw new Error('mcp_source_view_closed');
        });
        selected.composition = options.compositions.observe(authorityScope, () => {
          selected.revision++; for (const changed of selected.changed) changed();
        });
        owner = selected; owners.set(key, selected);
        void selected.composition.catch(() => undefined); // Original cleanup still owns its transport admission.
      }
      const selection = JSON.stringify(action.selection ?? null);
      let view = owner.views.get(action.handleId);
      if (view && (view.selection !== selection || view.creationRequestId !== action.creationRequestId)) throw new Error('mcp_view_selection_changed');
      if (!view) {
        const current = owner;
        const work = current.composition.then(composition => action.selection
          ? composition.restore(action.selection, signal) : composition.snapshot());
        view = { work, selection, creationRequestId: action.creationRequestId, tools: new Map(), services: new Map(), tokens: new Map() }; current.views.set(action.handleId, view);
        const created = view;
        void work.then(lease => { created.lease = lease;
          for (const tool of lease.binding.tools) created.tools.set(targetKey(tool.name, tool.schemaVersion), tool);
        }, () => undefined);
        void work.catch(() => { if (current.views.get(action.handleId) === created) current.views.delete(action.handleId); });
      }
      const lease = await view.work;
      if (owner.closed || signal.aborted || owner.views.get(action.handleId) !== view) {
        lease.release(); throw new Error('mcp_view_closed');
      }
      return { incarnation: owner.incarnation, revision: owner.revision, binding: lease.binding,
        implementationIdentity: lease.implementationIdentity, revocations: revoked(view) } satisfies ManagedMcpSnapshot;
    }
    if (!owner || owner.closed) throw new Error('mcp_original_view_unavailable');
    if (action.kind === 'changed') {
      if (action.incarnation !== owner.incarnation || !Number.isSafeInteger(action.after) || action.after < 0 || action.after > owner.revision)
        throw new Error('mcp_original_view_changed');
      if (action.after === owner.revision) await new Promise<void>((resolve, reject) => {
        const changed = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { owner!.changed.delete(changed); signal.removeEventListener('abort', aborted); };
        owner!.changed.add(changed); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted(); else if (owner!.closed || owner!.revision !== action.after) changed();
      });
      if (owner.closed) throw new Error('mcp_view_closed');
      return { incarnation: owner.incarnation, revision: owner.revision,
        revocations: Object.fromEntries([...owner.views].map(([handle, view]) => [handle, revoked(view)])) };
    }
    const view = owner.views.get(action.handleId);
    if (!view) throw new Error('mcp_original_view_unavailable');
    const lease = await view.work;
    if (owner.closed || owner.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
    // The original domain rechecks its current declaration, trust and credentials at dispatch.
    const beforeDispatch = async () => { await authorize(scope, signal); if (owner!.closed) throw new Error('mcp_view_closed'); };
    const retainTools = (tools: readonly McpAuthorityTool[]) => { for (const tool of tools) view.tools.set(targetKey(tool.name, tool.schemaVersion), tool); revoked(view); return tools; };
    const retainService = (service: McpAuthorityService) => { view.services.set(targetKey(service.server, service.schemaVersion), service); revoked(view); return service; };
    switch (action.kind) {
      case 'discover': return retainTools(await lease.discover(action.server, signal));
      case 'prepare_tool': { const tool = await lease.prepareTool(action.server, action.tool, action.schemaVersion, signal); retainTools([tool]); return tool; }
      case 'discover_services': return (await lease.discoverServices(action.server, signal)).map(retainService);
      case 'prepare_service': return retainService(await lease.prepareService(action.server, action.serviceKind, action.schemaVersion, signal));
      case 'prepare_prompt': { const prompt = await lease.preparePrompt(action.server, action.name, action.schemaVersion, signal); retainService(prompt.service); return prompt; }
      case 'call': return lease.callTool(action.name, action.arguments, { schemaVersion: action.schemaVersion,
        signal: AbortSignal.any([signal, lease.revocationSignal(action.name, action.schemaVersion)]), beforeDispatch });
      case 'service': return lease.requestService(action.service, action.request, {
        signal: AbortSignal.any([signal, lease.serviceRevocationSignal(action.service)]), beforeDispatch });
    }
    throw new Error('mcp_source_action_invalid');
  };
  return {
    adaptTransport(scope: McpAuthorityScope, transport: McpTransport): McpTransport {
      const owner = [...owners.values()].find(owner => owner.authorityScope.environmentId === scope.environmentId);
      if (!owner || owner.closed || !owner.transports) throw new Error('mcp_original_source_transport_unavailable');
      return owner.transports.adapt(transport);
    },
    release,
    close: () => Promise.allSettled([...owners.values()].map(owner => release(owner.scope))),
    async request(scope: ManagedSourceLocalScope, action: ManagedMcpAction, signal?: AbortSignal): Promise<ManagedMcpReply> {
      try { return { ok: true, value: await execute(scope, action, signal ?? new AbortController().signal), executorStopped: true }; }
      catch (error) {
        // Only the original trusted MCP owner can declare an entered/settled transport.
        const failure = error as { code?: unknown; dispatched?: unknown; settlement?: unknown; protocolError?: Record<string, unknown>; interactionProblem?: string } | null;
        const dispatched = failure?.dispatched === true;
        const settlement = failure?.settlement === 'session_expired' || failure?.settlement === 'rpc_response' ? failure.settlement : 'unknown';
        return { ok: false, error: { code: typeof failure?.code === 'string' ? failure.code : 'mcp_source_unavailable', dispatched, settlement,
          ...(failure?.protocolError ? { protocolError: failure.protocolError } : {}), ...(failure?.interactionProblem ? { interactionProblem: failure.interactionProblem } : {}) },
          executorStopped: !dispatched || settlement !== 'unknown' };
      }
    },
  };
}
