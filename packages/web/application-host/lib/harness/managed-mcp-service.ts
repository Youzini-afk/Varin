/** Target-side contribution views over the existing MCP authority. Catalog stays on A. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { McpAuthority, McpCompositionSnapshot, McpAuthorityScope, McpAuthorityTool, McpAuthorityService, McpTransport, McpInteractionRequest, McpErrorInteraction } from '../mcp/authority.js';
import type { McpCompositions, McpCompositionScope } from '../mcp/authority.js';
import type { ManagedSourceLocalScope, ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { createManagedMcpTasks, mcpTaskFailure } from './managed-mcp-tasks.js';
import { createManagedMcpChildren } from './managed-mcp-children.js';
import { createManagedMcpDerivations } from './managed-mcp-derivation.js';
import { createManagedMcpResources } from './managed-mcp-resources.js';
import { createManagedMcpInteractions } from './managed-mcp-interactions.js';
import { isManagedMcpChildContinuation, isManagedMcpDerivationContinuation, isManagedMcpTaskContinuation, isManagedMcpResourceContinuation, isManagedMcpInteractionContinuation } from './managed-mcp-contract.js';
import type { ManagedMcpAction, ManagedMcpReply, ManagedMcpSnapshot, ManagedMcpRevocations, ManagedMcpDerivationSnapshot, ManagedMcpDerivationInspection } from './managed-mcp-contract.js';
class ManagedMcpAdmissionError extends Error {
  readonly dispatched = false;
  constructor(readonly code: string) { super(code); }
}
/** Request cancellation leaves the original derivation and exact cleanup duty intact. */
async function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

interface View {
  work: Promise<McpCompositionSnapshot>;
  lease?: McpCompositionSnapshot;
  selection: string;
  creationRequestId: string;
  tools: Map<string, McpAuthorityTool>;
  services: Map<string, McpAuthorityService>;
  tokens: Map<string, AbortSignal>;
  derivation?: Extract<ManagedMcpAction, { kind: 'derive' }>;
  changed?: () => void;
  withdrawals?: Map<string, AbortController>;
  /** A settled child root outlives an attached coordinator projection. */
  detached?: boolean;
  lifetime?: AbortController;
}
const targetKey = (name: string, schemaVersion: string) => JSON.stringify([name, schemaVersion]);
const explicitlyWithdrawn = (error: unknown) => ['mcp-tool-revoked', 'mcp-service-revoked', 'mcp-credential-revoked',
  'mcp-owner-revoked', 'mcp-schema-generation-mismatch'].includes(String((error as { code?: unknown })?.code
    ?? (error instanceof Error ? error.message : '')).replaceAll('_', '-'));
function revokedTarget(view: View, key: string, token: () => AbortSignal): boolean {
  let original = view.tokens.get(key);
  if (!original) {
    try {
      original = token();
      if (view.withdrawals) {
        let withdrawal = view.withdrawals.get(key);
        if (!withdrawal) { withdrawal = new AbortController(); view.withdrawals.set(key, withdrawal); }
        original = AbortSignal.any([original, withdrawal.signal]);
      }
      view.tokens.set(key, original);
      if (view.changed) original.addEventListener('abort', view.changed, { once: true });
    }
    catch (error) {
      // A failed replacement or temporarily invalid config is not an explicit withdrawal.
      return explicitlyWithdrawn(error);
    }
  }
  return original.aborted;
}
function refreshDerivedRevocations(view: View): void {
  if (!view.lease || !view.withdrawals) return;
  const check = (key: string, assert: () => void) => {
    try { assert(); }
    catch (error) {
      if (!explicitlyWithdrawn(error)) return;
      let token = view.withdrawals!.get(key);
      if (!token) { token = new AbortController(); view.withdrawals!.set(key, token); }
      token.abort();
    }
  };
  for (const tool of view.tools.values()) check(`tool:${targetKey(tool.name, tool.schemaVersion)}`,
    () => view.lease!.assertCallable(tool.name, tool.schemaVersion));
  for (const service of view.services.values()) check(`service:${targetKey(service.server, service.schemaVersion)}`,
    () => view.lease!.assertService(service));
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
  composition?: Promise<McpCompositionScope>;
  subscription?: Promise<() => void>;
  closed: boolean;
  sealed?: boolean;
  closing?: Promise<{ executorStopped: boolean; taskControlsDrained: boolean }>;
}
export function createManagedMcpService(options: {
  compositions: Pick<McpCompositions, 'observe'>;
  authority?: Pick<McpAuthority, 'acquire' | 'subscribe'>;
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
    if (!owner || owner.closed || owner.sealed || !view || view.detached) throw new ManagedMcpAdmissionError('mcp_original_view_unavailable');
    const beforeDispatch = async () => {
      if (owner.closed || owner.sealed || view.detached || owner.views.get(handleId) !== view) throw new ManagedMcpAdmissionError('mcp_view_closed');
      await authorize(owner.scope, signal); signal.throwIfAborted();
      if (owner.closed || owner.sealed || view.detached || owner.views.get(handleId) !== view) throw new ManagedMcpAdmissionError('mcp_view_closed');
    };
    await beforeDispatch(); return { lease: await view.work, beforeDispatch };
  };
  const children = options.kernel ? createManagedMcpChildren({ kernel: options.kernel, view: originalView }) : undefined;
  const derivations = options.kernel && options.authority && children
    ? createManagedMcpDerivations({ kernel: options.kernel, authority: options.authority, children }) : undefined;
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
    if (!owner) {
      if (!options?.retainMcpHolders) await Promise.all([children?.close(scope), derivations?.close(scope)]);
      return { executorStopped: false, taskControlsDrained: true };
    }
    if (owner.closing) return owner.closing;
    owner.sealed = true;
    if (options?.retainMcpHolders) {
      const views = [...owner.views.values()]; owner.views.clear();
      for (const changed of owner.changed) changed();
      const derivationSealing = derivations?.seal(scope);
      await Promise.allSettled(views.map(async view => (await view.work).release()));
      await derivationSealing;
      // Existing SDK holders retain only their original connections. Do not wait on their
      // lifetime, or stop the original native daemon, when the ordinary Run view closes.
      (await owner.composition)?.release();
      (await owner.subscription)?.();
      return { executorStopped: false, taskControlsDrained: false };
    }
    owner.closed = true;
    for (const changed of owner.changed) changed();
    const views = [...owner.views.values()]; owner.views.clear();
    owner.closing = (async () => {
      const interactionClosing = interactions?.close(scope);
      const holdersClosing = Promise.all([tasks?.close(scope), resources?.close(scope), children?.close(scope), derivations?.close(scope)]);
      const viewsClosing = Promise.allSettled(views.map(async view => (await view.work).release()));
      // Native processes carry their own Storage tree receipts even if SDK close swallows an error.
      // Explicit Source close starts that exact stop before joining an outstanding
      // subscribe ACK or callback. Ordinary retirement above still retains holders.
      const results = await Promise.allSettled([owner.composition?.then(composition => composition.releaseAndDrain(), error => {
        // Failed acquisition already drained its candidate. Preserve actual close failures.
        if ((error as { code?: unknown })?.code === 'mcp-close-failed') throw error;
      }), owner.subscription?.then(unsubscribe => unsubscribe(), () => undefined), owner.transports?.drain(), interactionClosing,
      holdersClosing, viewsClosing]);
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
    // Reserve the fence before waiting for a late acquisition, including a lost preparation reply.
    if (view?.derivation) { view.detached = true; view.lifetime?.abort(); }
    else owner?.views.delete(action.handleId);
    // A failed first cleanup keeps its candidate in the derivation entry even after
    // ordinary RPC admission was removed. A retry must drain that exact candidate.
    await derivations?.releaseView(scope, action.handleId, action.creationRequestId);
    if (view?.derivation) {
      await view.work.catch(() => undefined);
    } else if (view) (await view.work).release();
    return { ok: true, value: null, executorStopped: true };
  };
  const execute = async (scope: ManagedSourceLocalScope, action: ManagedMcpAction, signal: AbortSignal): Promise<unknown> => {
    const key = keyOf(scope);
    // A view release carries no new effect authority. Source retirement also calls release().
    if (action.kind === 'release') {
      await releaseView(scope, action); return null;
    }
    if (isManagedMcpChildContinuation(action)) return continueChild(scope, action, signal);
    if (isManagedMcpDerivationContinuation(action)) return continueDerivation(scope, action, signal);
    if (action.kind === 'child_retain') {
      if (!children) throw new ManagedMcpAdmissionError('mcp_child_source_unavailable');
      return children.retain(scope, action, signal);
    }
    if (isManagedMcpTaskContinuation(action)) return continueTask(scope, action, signal);
    if (isManagedMcpResourceContinuation(action)) return continueResource(scope, action, signal);
    if (isManagedMcpInteractionContinuation(action)) {
      if (!interactions) throw new ManagedMcpAdmissionError('mcp_interaction_source_unavailable');
      return interactions.request(scope, action, signal);
    }
    const authorityScope = await authorize(scope, signal);
    let owner = owners.get(key);
    if (action.kind === 'snapshot' || action.kind === 'derive') {
      if (action.kind === 'derive' && (!derivations || scope.source.mode !== 'materialized'))
        throw new ManagedMcpAdmissionError('mcp_child_derivation_unavailable');
      if (owner?.sealed) throw new Error('mcp_source_admission_closed');
      if (typeof action.handleId !== 'string' || !action.handleId) throw new Error('mcp_view_invalid');
      if (!owner && action.kind === 'snapshot' && action.selection && options.kernel) {
        const original = await options.kernel.sourceRequest<import('../kernel/protocol.generated.js').SourceAuthorityResult>('source.authority.inspect', {
          principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
          authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch,
        }, signal);
        if (original.mcpDerivation) throw new ManagedMcpAdmissionError('mcp_child_original_derivation_unavailable');
        owner = owners.get(key);
        if (owner?.sealed) throw new Error('mcp_source_admission_closed');
      }
      if (!owner) {
        const selected: Owner = { scope, authorityScope, incarnation: randomUUID(), revision: 0, changed: new Set(), views: new Map(),
          closed: false };
        if (options.transportOwner) selected.transports = options.transportOwner(scope, async signal => {
          if (selected.closed || selected.sealed) throw new Error('mcp_source_view_closed');
          await authorize(scope, signal);
          if (selected.closed || selected.sealed) throw new Error('mcp_source_view_closed');
        });
        if (action.kind === 'snapshot') selected.composition = options.compositions.observe(authorityScope, () => {
          selected.revision++; for (const changed of selected.changed) changed();
        });
        owner = selected; owners.set(key, selected); interactions?.bind(scope);
        if (action.kind === 'derive') {
          selected.subscription = options.authority!.subscribe(authorityScope, () => {
            for (const view of selected.views.values()) refreshDerivedRevocations(view);
            selected.revision++; for (const changed of selected.changed) changed();
          });
          void selected.subscription.catch(() => undefined);
        }
        void selected.composition?.catch(() => undefined); // Original cleanup still owns its transport admission.
      }
      if (action.kind === 'derive') {
        if (!derivations) throw new ManagedMcpAdmissionError('mcp_child_derivation_unavailable');
        if (scope.source.mode !== 'materialized' || owner.composition) throw new ManagedMcpAdmissionError('mcp_child_derivation_source_invalid');
        let view = owner.views.get(action.handleId);
        if (view && !isDeepStrictEqual(view.derivation, action)) throw new Error('mcp_view_selection_changed');
        const current = owner;
        const readmit = async (active: AbortSignal) => {
          if (current.closed || current.sealed || view?.detached || current.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
          await current.subscription;
          await authorize(current.scope, active);
          if (current.closed || current.sealed || view?.detached || current.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
        };
        // Register in the ordinary owner before derivation can adapt a transport or receive an interaction.
        if (!view) {
          view = { work: undefined as never, derivation: structuredClone(action), selection: JSON.stringify(action),
            creationRequestId: action.creationRequestId, tools: new Map(), services: new Map(), tokens: new Map(),
            withdrawals: new Map(), lifetime: new AbortController(),
            changed: () => { current.revision++; for (const changed of current.changed) changed(); } };
          current.views.set(action.handleId, view);
        }
        if (view.detached) { view.detached = false; view.lifetime = new AbortController(); }
        const original = view;
        const work = Promise.resolve().then(() => derivations.derive(scope, action, authorityScope, readmit, candidate => {
          original.lease = candidate.lease;
          for (const tool of candidate.lease.binding.tools) original.tools.set(targetKey(tool.name, tool.schemaVersion), tool);
          revoked(original);
        }));
        view.work = work.then(result => result.lease);
        void view.work.catch(() => undefined);
        const prepared = await waitFor(work, signal);
        await readmit(signal);
        view.lease = prepared.lease;
        for (const tool of prepared.lease.binding.tools) view.tools.set(targetKey(tool.name, tool.schemaVersion), tool);
        return { snapshot: { incarnation: current.incarnation, revision: current.revision, binding: prepared.lease.binding,
          implementationIdentity: prepared.lease.implementationIdentity, revocations: revoked(view) }, receipt: prepared.receipt } satisfies ManagedMcpDerivationSnapshot;
      }
      if (!owner.composition) throw new Error('mcp_child_derivation_required');
      const selection = JSON.stringify(action.selection ?? null);
      let view = owner.views.get(action.handleId);
      if (view && (view.selection !== selection || view.creationRequestId !== action.creationRequestId)) throw new Error('mcp_view_selection_changed');
      if (!view) {
        const current = owner;
        const work = current.composition!.then(composition => action.selection
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
    if (!view || view.detached) throw new Error('mcp_original_view_unavailable');
    const lease = await view.work;
    if (owner.closed || view.detached || owner.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
    const active = view.lifetime ? AbortSignal.any([signal, view.lifetime.signal]) : signal;
    // The original domain rechecks its current declaration, trust and credentials at dispatch.
    const beforeDispatch = async () => {
      await authorize(scope, active);
      if (owner!.closed || owner!.sealed || view.detached || owner!.views.get(action.handleId) !== view) throw new Error('mcp_view_closed');
    };
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
      case 'discover': return retainTools(await lease.discover(action.server, active));
      case 'cached_tools': return lease.cachedTools(active);
      case 'prepare_tool': { const tool = await lease.prepareTool(action.server, action.tool, action.schemaVersion, active); retainTools([tool]); return tool; }
      case 'discover_services': return (await lease.discoverServices(action.server, active)).map(retainService);
      case 'prepare_service': {
        const service = retainService(await lease.prepareService(action.server, action.serviceKind, action.schemaVersion, active));
        return { service, ...(service.kind === 'resources' ? { endpoint: lease.resourceEndpoint(service) } : {}) };
      }
      case 'prepare_prompt': { const prompt = await lease.preparePrompt(action.server, action.name, action.schemaVersion, active); retainService(prompt.service); return prompt; }
      case 'call': {
        const withdrawal = view.withdrawals?.get(`tool:${targetKey(action.name, action.schemaVersion)}`)?.signal;
        if (withdrawal?.aborted) throw new ManagedMcpAdmissionError('mcp_tool_revoked');
        return lease.callTool(action.name, action.arguments, { schemaVersion: action.schemaVersion,
          signal: AbortSignal.any([active, lease.revocationSignal(action.name, action.schemaVersion), ...(withdrawal ? [withdrawal] : [])]),
          beforeDispatch, ...(action.interaction ? { interaction: action.interaction } : {}) });
      }
      case 'service': {
        const withdrawal = view.withdrawals?.get(`service:${targetKey(action.service.server, action.service.schemaVersion)}`)?.signal;
        if (withdrawal?.aborted) throw new ManagedMcpAdmissionError('mcp_service_revoked');
        return lease.requestService(action.service, action.request, {
          signal: AbortSignal.any([active, lease.serviceRevocationSignal(action.service), ...(withdrawal ? [withdrawal] : [])]),
          beforeDispatch, ...(action.interaction ? { interaction: action.interaction } : {}) });
      }
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
  const continueChild = async (scope: Address, action: Extract<ManagedMcpAction, { kind: 'child_inspect' | 'child_release' }>, signal: AbortSignal) => {
    if (!children) throw new ManagedMcpAdmissionError('mcp_child_source_unavailable');
    return action.kind === 'child_inspect' ? children.inspect(scope, action.binding, signal) : children.release(scope, action.binding);
  };
  const continueDerivation = async (scope: Address,
    action: Extract<ManagedMcpAction, { kind: 'derivation_inspect' | 'derivation_release' }>, signal: AbortSignal) => {
    if (!derivations) throw new ManagedMcpAdmissionError('mcp_child_derivation_unavailable');
    if (action.kind === 'derivation_release') return derivations.release(scope, action.executionId);
    const inspected = await derivations.inspect(scope, action.executionId, signal);
    const owner = owners.get(keyOf(scope));
    if (!inspected.live || !inspected.candidate || !inspected.action || !owner || owner.closed || owner.sealed)
      return { ...inspected.result, live: false } satisfies ManagedMcpDerivationInspection;
    const { lease, receipt } = inspected.candidate;
    const original = inspected.action;
    let view = owner.views.get(original.handleId);
    if (view && !isDeepStrictEqual(view.derivation, original)) throw new Error('mcp_view_selection_changed');
    if (!view) {
      // Restore only the original Source-owned root. No new authority observation,
      // definition acquisition, SDK dispatch, or durable proof is created here.
      view = { work: Promise.resolve(lease), derivation: original, selection: JSON.stringify(original),
        creationRequestId: original.creationRequestId, tools: new Map(), services: new Map(), tokens: new Map(), withdrawals: new Map(), lifetime: new AbortController(),
        changed: () => { owner.revision++; for (const changed of owner.changed) changed(); } };
      owner.views.set(original.handleId, view);
    }
    if (view.detached) { view.detached = false; view.lifetime = new AbortController(); }
    view.lease = lease; view.work = Promise.resolve(lease);
    for (const tool of lease.binding.tools) view.tools.set(targetKey(tool.name, tool.schemaVersion), tool);
    return { ...inspected.result, live: true, prepared: { snapshot: { incarnation: owner.incarnation, revision: owner.revision,
      binding: lease.binding, implementationIdentity: lease.implementationIdentity, revocations: revoked(view) }, receipt } } satisfies ManagedMcpDerivationInspection;
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
    const confirmPublication = async () => {
      try { await interactions?.published(scope); }
      catch { throw Object.assign(new Error('mcp_interaction_publication_pending'), {
        code: 'mcp_interaction_publication_pending', dispatched: true, settlement: 'unknown',
      }); }
    };
    let result: T;
    try { result = await work(); }
    catch (error) { await confirmPublication(); throw error; }
    await confirmPublication();
    return result;
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
    childContinuation(scope: ManagedSourceCleanupScope,
      action: Extract<ManagedMcpAction, { kind: 'child_inspect' | 'child_release' }>, signal?: AbortSignal) {
      return reply(() => continueChild(scope, action, signal ?? new AbortController().signal));
    },
    derivationContinuation(scope: ManagedSourceCleanupScope,
      action: Extract<ManagedMcpAction, { kind: 'derivation_inspect' | 'derivation_release' }>, signal?: AbortSignal) {
      return reply(() => continueDerivation(scope, action, signal ?? new AbortController().signal));
    },
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
