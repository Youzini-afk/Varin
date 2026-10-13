/** Target-side contribution views over the existing MCP authority. Catalog stays on A. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { McpAuthorityLease, McpAuthorityScope, McpAuthorityTool, McpAuthorityService, McpTransport, McpInteractionRequest, McpErrorInteraction } from '@varin/pi-host/mcp-authority';
import type { McpCompositions, McpCompositionScope } from '@varin/pi-host/mcp-authority';
import type { ManagedSourceLocalScope, ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { createManagedMcpTasks, mcpTaskFailure } from './managed-mcp-tasks.js';
import { createManagedMcpResources } from './managed-mcp-resources.js';
import { createManagedMcpInteractions } from './managed-mcp-interactions.js';
import { isManagedMcpTaskContinuation, isManagedMcpResourceContinuation, isManagedMcpInteractionContinuation } from './managed-mcp-contract.js';
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
  sealed?: boolean;
  closing?: Promise<{ executorStopped: boolean; taskControlsDrained: boolean }>;
}
export function createManagedMcpService(options: {
  compositions: Pick<McpCompositions, 'observe'>;
  kernel?: Pick<KernelClient, 'sourceRequest'>;
  agentDir: string;
  hostId: string;
  admitWorkspaceRegistration(id: string, signal?: AbortSignal): Promise<{ canonicalPath: string }>;
  admitSource(scope: ManagedSourceLocalScope, signal?: AbortSignal): Promise<void>;
  projectTrusted(cwd: string): boolean;
  transportOwner?(scope: ManagedSourceLocalScope, readmit: (signal: AbortSignal) => Promise<void>): NonNullable<Owner['transports']>;
}) {
  const owners = new Map<string, Owner>();
  type Address = Pick<ManagedSourceLocalScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>;
  const keyOf = (scope: Address) => JSON.stringify([scope.principal.principalId,
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
    return { resourceOwner: scope.source.resource_owner, sourceAuthority: { coordinator_host_id: scope.coordinatorHostId,
      authority_id: scope.authorityId, resource_epoch: scope.resourceEpoch }, configurationScopes: ['project'],
      agentDir: options.agentDir, configCwd: project.canonicalPath, projectTrusted: true,
      executionCwd: scope.physicalRoot.canonicalRoot, executionScope: 'workspace',
      environmentId: JSON.stringify([options.hostId, scope.principal.principalId, scope.coordinatorHostId, scope.source.execution_workspace_id,
        scope.authorityId, scope.resourceEpoch]), sessionId: `managed:${scope.coordinatorHostId}:${scope.scope.threadId}` };
  };
  const originalView = async (scope: Address, handleId: string, signal: AbortSignal) => {
    const owner = owners.get(keyOf(scope)), view = owner?.views.get(handleId);
    if (!owner || owner.closed || owner.sealed || !view) throw new ManagedMcpAdmissionError('mcp_original_view_unavailable');
    const beforeDispatch = async () => {
      if (owner.closed || owner.sealed || owner.views.get(handleId) !== view) throw new ManagedMcpAdmissionError('mcp_view_closed');
      await authorize(owner.scope, signal); signal.throwIfAborted();
      if (owner.closed || owner.sealed || owner.views.get(handleId) !== view) throw new ManagedMcpAdmissionError('mcp_view_closed');
    };
    await beforeDispatch(); return { lease: await view.work, beforeDispatch };
  };
  const tasks = options.kernel ? createManagedMcpTasks({ kernel: options.kernel, view: originalView }) : undefined;
  const resources = options.kernel ? createManagedMcpResources({ kernel: options.kernel, view: originalView }) : undefined;
  const interactions = options.kernel ? createManagedMcpInteractions({ kernel: options.kernel,
    authorizeRead: (scope, signal) => authorizeInteractionRead(scope, signal),
  }) : undefined;
  const originalInteractionOwner = (scope: McpAuthorityScope) => {
    const owner = [...owners.values()].find(owner => owner.authorityScope.environmentId === scope.environmentId
      && isDeepStrictEqual(owner.authorityScope.resourceOwner, scope.resourceOwner)
      && isDeepStrictEqual(owner.authorityScope.sourceAuthority, scope.sourceAuthority));
    if (!owner || owner.closed || !interactions) throw new ManagedMcpAdmissionError('mcp_original_interaction_owner_unavailable');
    return owner;
  };
  const release = async (scope: Address, options?: { retainMcpHolders: boolean }) => {
    const key = keyOf(scope), owner = owners.get(key);
    if (!owner) return { executorStopped: false, taskControlsDrained: true };
    if (owner.closing) return owner.closing;
    owner.sealed = true;
    if (options?.retainMcpHolders) {
      const views = [...owner.views.values()]; owner.views.clear();
      for (const changed of owner.changed) changed();
      await Promise.allSettled(views.map(async view => (await view.work).release()));
      // Existing SDK holders retain only their original connections. Do not wait on their
      // lifetime, or stop the original native daemon, when the ordinary Run view closes.
      (await owner.composition).release();
      return { executorStopped: false, taskControlsDrained: false };
    }
    owner.closed = true;
    for (const changed of owner.changed) changed();
    const views = [...owner.views.values()]; owner.views.clear();
    owner.closing = (async () => {
      const interactionClosing = interactions?.close(scope);
      await Promise.all([tasks?.close(scope), resources?.close(scope)]);
      await Promise.allSettled(views.map(async view => (await view.work).release()));
      // Native processes carry their own Storage tree receipts even if SDK close swallows an error.
      const results = await Promise.allSettled([owner.composition.then(composition => composition.releaseAndDrain(), error => {
        // Failed acquisition already drained its candidate. Preserve actual close failures.
        if ((error as { code?: unknown })?.code === 'mcp-close-failed') throw error;
      }), owner.transports?.drain(), interactionClosing]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Retain a failed close as unresolved; a second cleanup cannot turn it into success.
      if (owners.get(key) === owner) owners.delete(key);
      return { executorStopped: owner.transports?.executorsStopped() === true, taskControlsDrained: true };
    })();
    const closing = owner.closing;
    void closing.catch(() => { if (owner.closing === closing) delete owner.closing; });
    return closing;
  };
  const releaseView = async (scope: Address, action: Extract<ManagedMcpAction, { kind: 'release' }>): Promise<ManagedMcpReply> => {
    const owner = owners.get(keyOf(scope)), view = owner?.views.get(action.handleId);
    if (view && view.creationRequestId !== action.creationRequestId) throw new Error('mcp_view_creation_changed');
    owner?.views.delete(action.handleId); if (view) (await view.work).release();
    return { ok: true, value: null, executorStopped: true };
  };
  const execute = async (scope: ManagedSourceLocalScope, action: ManagedMcpAction, signal: AbortSignal): Promise<unknown> => {
    const key = keyOf(scope);
    // A view release carries no new effect authority. Source retirement also calls release().
    if (action.kind === 'release') {
      await releaseView(scope, action); return null;
    }
    if (isManagedMcpTaskContinuation(action)) return continueTask(scope, action, signal);
    if (isManagedMcpResourceContinuation(action)) return continueResource(scope, action, signal);
    if (isManagedMcpInteractionContinuation(action)) {
      if (!interactions) throw new ManagedMcpAdmissionError('mcp_interaction_source_unavailable');
      return interactions.request(scope, action, signal);
    }
    const authorityScope = await authorize(scope, signal);
    let owner = owners.get(key);
    if (action.kind === 'snapshot') {
      if (owner?.sealed) throw new Error('mcp_source_admission_closed');
      if (typeof action.handleId !== 'string' || !action.handleId) throw new Error('mcp_view_invalid');
      if (!owner) {
        const selected: Owner = { scope, authorityScope, incarnation: randomUUID(), revision: 0, changed: new Set(), views: new Map(),
          closed: false, composition: undefined as never };
        if (options.transportOwner) selected.transports = options.transportOwner(scope, async signal => {
          if (selected.closed || selected.sealed) throw new Error('mcp_source_view_closed');
          await authorize(scope, signal);
          if (selected.closed || selected.sealed) throw new Error('mcp_source_view_closed');
        });
        selected.composition = options.compositions.observe(authorityScope, () => {
          selected.revision++; for (const changed of selected.changed) changed();
        });
        owner = selected; owners.set(key, selected); interactions?.bind(scope);
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
      if (owner.closed || owner.sealed || signal.aborted || owner.views.get(action.handleId) !== view) {
        lease.release(); throw new Error('mcp_view_closed');
      }
      return { incarnation: owner.incarnation, revision: owner.revision, binding: lease.binding,
        implementationIdentity: lease.implementationIdentity, revocations: revoked(view) } satisfies ManagedMcpSnapshot;
    }
    if (!owner || owner.closed || owner.sealed) throw new Error('mcp_original_view_unavailable');
    if (action.kind === 'changed') {
      if (action.incarnation !== owner.incarnation || !Number.isSafeInteger(action.after) || action.after < 0 || action.after > owner.revision)
        throw new Error('mcp_original_view_changed');
      if (action.after === owner.revision) await new Promise<void>((resolve, reject) => {
        const changed = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { owner!.changed.delete(changed); signal.removeEventListener('abort', aborted); };
        owner!.changed.add(changed); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted(); else if (owner!.closed || owner!.sealed || owner!.revision !== action.after) changed();
      });
      if (owner.closed || owner.sealed) throw new Error('mcp_view_closed');
      return { incarnation: owner.incarnation, revision: owner.revision,
        revocations: Object.fromEntries([...owner.views].map(([handle, view]) => [handle, revoked(view)])) };
    }
    const view = owner.views.get(action.handleId);
    if (!view) throw new Error('mcp_original_view_unavailable');
    const lease = await view.work;
    if (owner.closed || owner.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
    // The original domain rechecks its current declaration, trust and credentials at dispatch.
    const beforeDispatch = async () => { await authorize(scope, signal); if (owner!.closed || owner!.sealed) throw new Error('mcp_view_closed'); };
    const retainTools = (tools: readonly McpAuthorityTool[]) => { for (const tool of tools) view.tools.set(targetKey(tool.name, tool.schemaVersion), tool); revoked(view); return tools; };
    const retainService = (service: McpAuthorityService) => { view.services.set(targetKey(service.server, service.schemaVersion), service); revoked(view); return service; };
    switch (action.kind) {
      case 'resource_subscribe':
        if (!resources) throw new ManagedMcpAdmissionError('mcp_resource_source_unavailable');
        return resources.subscribe(scope, action, signal);
      case 'task_prepare':
        if (!tasks) throw new ManagedMcpAdmissionError('mcp_task_source_unavailable');
        return tasks.prepare(scope, action.handleId, action.server, action.endpoint, signal);
      case 'task_start':
        if (!tasks) throw new ManagedMcpAdmissionError('mcp_task_source_unavailable');
        return tasks.start(scope, action, signal);
      case 'discover': return retainTools(await lease.discover(action.server, signal));
      case 'prepare_tool': { const tool = await lease.prepareTool(action.server, action.tool, action.schemaVersion, signal); retainTools([tool]); return tool; }
      case 'discover_services': return (await lease.discoverServices(action.server, signal)).map(retainService);
      case 'prepare_service': {
        const service = retainService(await lease.prepareService(action.server, action.serviceKind, action.schemaVersion, signal));
        return { service, ...(service.kind === 'resources' ? { endpoint: lease.resourceEndpoint(service) } : {}) };
      }
      case 'prepare_prompt': { const prompt = await lease.preparePrompt(action.server, action.name, action.schemaVersion, signal); retainService(prompt.service); return prompt; }
      case 'call': return lease.callTool(action.name, action.arguments, { schemaVersion: action.schemaVersion,
        signal: AbortSignal.any([signal, lease.revocationSignal(action.name, action.schemaVersion)]), beforeDispatch, ...(action.interaction ? { interaction: action.interaction } : {}) });
      case 'service': return lease.requestService(action.service, action.request, {
        signal: AbortSignal.any([signal, lease.serviceRevocationSignal(action.service)]), beforeDispatch, ...(action.interaction ? { interaction: action.interaction } : {}) });
    }
    throw new Error('mcp_source_action_invalid');
  };
  const authorizeContinuationRead = async (scope: Address, signal: AbortSignal) => {
    const owner = owners.get(keyOf(scope));
    if (!owner || owner.closed) throw new ManagedMcpAdmissionError('mcp_original_transport_unavailable');
    if (!scope.principal.capabilities.includes('filesystem:read')) throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
    const project = await options.admitWorkspaceRegistration(owner.scope.source.workspace_id, signal);
    if (project.canonicalPath !== owner.authorityScope.configCwd || !options.projectTrusted(project.canonicalPath))
      throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
  };
  const authorizeInteractionRead = async (scope: Address, signal: AbortSignal) => {
    // An SDK owner may already be closed while A still owes durable publication
    // of an original request. Historical body reads use the exact Source identity,
    // current project/read permission and the delivery's original active-grant fence.
    // This does not recreate a receiver, connection, or response admission.
    if (!scope.principal.capabilities.includes('filesystem:read') || !options.kernel)
      throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
    const authority = await options.kernel.sourceRequest<import('../kernel/protocol.generated.js').SourceAuthorityResult>('source.authority.inspect', {
      principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
      authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch,
    }, signal);
    if (authority.purpose !== 'mcp_owner' || authority.source.resource_owner.kind !== 'managed_host'
      || authority.source.resource_owner.hostId !== options.hostId) throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
    const project = await options.admitWorkspaceRegistration(authority.source.workspace_id, signal);
    if (!options.projectTrusted(project.canonicalPath)) throw new ManagedMcpAdmissionError('mcp_source_authority_denied');
  };
  const continueResource = async (scope: Address, action: Extract<ManagedMcpAction, { kind: 'resource_inspect' | 'resource_watch' | 'resource_release' }>, signal: AbortSignal) => {
    if (!resources) throw new ManagedMcpAdmissionError('mcp_resource_source_unavailable');
    if (action.kind === 'resource_inspect') return resources.inspect(scope, action.binding, action.fenceUnstarted, signal);
    if (action.kind === 'resource_release') {
      const unregister = action.interaction ? interactions?.registerCleanup(scope, action.interaction, {
        operationId: action.binding.operationId, executionOwner: action.binding.executionOwner,
        endpoint: action.binding.endpoint, purpose: 'resource_observer',
      }) : undefined;
      try { return await resources.release(scope, action.binding, action.interaction ? { interaction: action.interaction, signal } : undefined); }
      finally { unregister?.(); }
    }
    await authorizeContinuationRead(scope, signal);
    const observed = await resources.watch(scope, action, signal);
    await authorizeContinuationRead(scope, signal);
    return observed;
  };
  const continueTask = async (scope: Address, action: Extract<ManagedMcpAction, { kind: 'task_inspect' | 'task_get' | 'task_result' | 'task_cancel' | 'task_release' }>, signal: AbortSignal) => {
    if (!tasks) throw new ManagedMcpAdmissionError('mcp_task_source_unavailable');
    if (action.kind === 'task_inspect') return tasks.inspect(scope, action.binding, action.fenceUnstarted, signal);
    if (action.kind === 'task_release') return tasks.release(scope, action.binding);
    if (action.kind === 'task_get' || action.kind === 'task_result') await authorizeContinuationRead(scope, signal);
    return tasks.control(scope, action, signal);
  };
  const published = async <T>(scope: Address, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    finally {
      try { await interactions?.published(scope); }
      catch { throw Object.assign(new Error('mcp_interaction_publication_pending'), {
        code: 'mcp_interaction_publication_pending', dispatched: true, settlement: 'unknown',
      }); }
    }
  };
  const reply = async (work: () => Promise<unknown>): Promise<ManagedMcpReply> => {
    try { return { ok: true, value: await work(), executorStopped: true }; }
    catch (error) {
      const failure = mcpTaskFailure(error);
      return { ok: false, error: failure, executorStopped: !failure.dispatched || failure.settlement !== 'unknown' };
    }
  };
  return {
    adaptTransport(scope: McpAuthorityScope, transport: McpTransport): McpTransport {
      const owner = [...owners.values()].find(owner => owner.authorityScope.environmentId === scope.environmentId);
      if (!owner || owner.closed || owner.sealed || !owner.transports) throw new Error('mcp_original_source_transport_unavailable');
      return owner.transports.adapt(transport);
    },
    receiveInteraction(scope: McpAuthorityScope, input: McpInteractionRequest) {
      return interactions!.receive(originalInteractionOwner(scope).scope, input, 'elicitation') as Promise<import('@varin/protocol').McpElicitationResponse>;
    },
    receiveSampling(scope: McpAuthorityScope, input: McpInteractionRequest) {
      return interactions!.receive(originalInteractionOwner(scope).scope, input, 'sampling') as Promise<import('@varin/protocol').McpSamplingResult>;
    },
    receiveInteractionError(scope: McpAuthorityScope, input: McpErrorInteraction) {
      interactions!.receiveError(originalInteractionOwner(scope).scope, input);
    },
    interactionContinuation(scope: ManagedSourceCleanupScope, action: import('./managed-mcp-contract.js').ManagedMcpInteractionAction, signal?: AbortSignal) {
      return reply(async () => {
        if (!interactions) throw new ManagedMcpAdmissionError('mcp_interaction_source_unavailable');
        return interactions.request(scope, action, signal ?? new AbortController().signal);
      });
    },
    release, releaseView,
    close: () => Promise.allSettled([...owners.values()].map(owner => release(owner.scope))),
    taskContinuation(scope: ManagedSourceCleanupScope,
      action: Extract<ManagedMcpAction, { kind: 'task_inspect' | 'task_get' | 'task_result' | 'task_cancel' | 'task_release' }>, signal?: AbortSignal) {
      return reply(() => published(scope, () => continueTask(scope, action, signal ?? new AbortController().signal)));
    },
    resourceContinuation(scope: ManagedSourceCleanupScope,
      action: Extract<ManagedMcpAction, { kind: 'resource_inspect' | 'resource_watch' | 'resource_release' }>, signal?: AbortSignal) {
      return reply(() => published(scope, () => continueResource(scope, action, signal ?? new AbortController().signal)));
    },
    request(scope: ManagedSourceLocalScope, action: ManagedMcpAction, signal?: AbortSignal): Promise<ManagedMcpReply> {
      return reply(() => published(scope, () => execute(scope, action, signal ?? new AbortController().signal)));
    },
  };
}
