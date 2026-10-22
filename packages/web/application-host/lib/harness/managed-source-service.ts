/** The target Host admits its own Source resources. Catalog execution facts stay
 * with the coordinator; this adapter stores neither operations nor grants. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import { KernelClientError, type KernelClient } from '../kernel/kernel-client.js';
import type { LiveSourceResolver } from '../kernel/live-source.js';
import type { LaunchSource, SourceAuthorityAddress, SourceAuthorityResult, SourceToolBinding } from '../kernel/protocol.generated.js';
import { admitMaterializedRoot, originalMaterializationLocation } from '../kernel/source-launch.js';
import { SourceAdmissionError, sourceReadError } from '../kernel/source-admission-error.js';
import { normalizeThreadSourcePreparation } from '../kernel/thread-sources.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { ManagedSourceDrainedError } from './managed-source-drain.js';
import { resolveScriptNodeBinding, scriptNodeSpawnInput } from '../kernel/script-node-binding.js';
import { isManagedMcpDerivationContinuation, isManagedMcpChildContinuation, isManagedMcpTaskContinuation, isManagedMcpResourceContinuation, isManagedMcpInteractionContinuation } from './managed-mcp-contract.js';
import { createManagedSourceProcesses } from './managed-source-processes.js';
import type { ManagedSourceAddress, ManagedSourceBindRequest, ManagedSourceBinding, ManagedSourceCapabilities,
  ManagedSourcePrincipal, ManagedSourceService, ManagedSourceServiceHandler, ManagedSourceLocalScope,
  ManagedSourceServiceRequest, ManagedSourceServiceCancelReceipt } from './managed-remote-types.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedRecoveryReply, ManagedRecoveryRequest } from './managed-recovery-contract.js';

export interface ManagedSourceServiceOptions {
  kernel: KernelClient;
  hostId: string;
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration' | 'resolveWorkspace' | 'inspectWorkspace'>;
  validateLiveSource: LiveSourceResolver;
  /** The target's local original preparer, never the coordinator's remote dispatcher. */
  prepareSource(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  serviceOperation?: ManagedSourceServiceHandler;
  readCodeExchange?(input: import('./managed-remote-types.js').ManagedSourceCodeExchangeRequest, signal?: AbortSignal): Promise<import('@varin/application-client').ThreadCodeExchange>;
  recovery?(principal: ManagedSourcePrincipal, input: ManagedRecoveryRequest, signal?: AbortSignal): Promise<ManagedRecoveryReply>;
  releaseMcpView?(scope: ManagedSourceCleanupScope,
    action: Extract<import('./managed-mcp-contract.js').ManagedMcpAction, { kind: 'release' }>): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  mcpDerivationContinuation?(scope: ManagedSourceCleanupScope,
    action: Extract<import('./managed-mcp-contract.js').ManagedMcpAction, { kind: 'derivation_inspect' | 'derivation_release' }>, signal?: AbortSignal): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  mcpChildContinuation?(scope: ManagedSourceCleanupScope,
    action: Extract<import('./managed-mcp-contract.js').ManagedMcpAction, { kind: 'child_inspect' | 'child_release' }>, signal?: AbortSignal): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  mcpTaskContinuation?(scope: ManagedSourceCleanupScope,
    action: Extract<import('./managed-mcp-contract.js').ManagedMcpAction, { kind: 'task_inspect' | 'task_get' | 'task_result' | 'task_cancel' | 'task_release' }>, signal?: AbortSignal): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  mcpResourceContinuation?(scope: ManagedSourceCleanupScope,
    action: Extract<import('./managed-mcp-contract.js').ManagedMcpAction, { kind: 'resource_inspect' | 'resource_watch' | 'resource_release' }>, signal?: AbortSignal): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  mcpInteractionContinuation?(scope: ManagedSourceCleanupScope, action: import('./managed-mcp-contract.js').ManagedMcpInteractionAction, signal?: AbortSignal): Promise<import('./managed-mcp-contract.js').ManagedMcpReply>;
  releaseSource?(scope: ManagedSourceCleanupScope, options?: { retainMcpHolders: boolean }): Promise<void | { mcpExecutorStopped: boolean; mcpTaskControlsDrained?: boolean }>;
  cleanupSource?(scope: ManagedSourceCleanupScope): Promise<void>;
  languageAvailable?: boolean;
}

export function createManagedSourceService(options: ManagedSourceServiceOptions): ManagedSourceService {
  const { kernel, documents } = options;
  interface ServiceFlight {
    principalId: string;
    address: ManagedSourceAddress;
    operation: ManagedSourceServiceRequest['operation'] | null;
    domain: ManagedSourceServiceRequest['operation']['kind'] | null;
    controller: AbortController;
    work: Promise<unknown> | null;
    settled: boolean;
    continuingMcp: boolean;
    taskCreation?: import('../kernel/protocol.generated.js').SourceMcpHolderBinding;
    taskControl?: import('../kernel/protocol.generated.js').SourceMcpHolderBinding;
    resourceCreation?: import('../kernel/protocol.generated.js').McpResourceBinding;
    drain: Promise<ManagedSourceServiceCancelReceipt['status']>;
  }
  // Live request handles only. Durable effects and recovery remain in their
  // original Storage/domain receipts; this map disappears with this Host.
  const services = new Map<string, ServiceFlight>();
  const closing = new Set<string>();
  const authorityKey = (principal: ManagedSourcePrincipal, input: ManagedSourceAddress) =>
    JSON.stringify([principal.principalId, input.coordinatorHostId, input.authorityId, input.resourceEpoch]);
  const serviceKey = (principal: ManagedSourcePrincipal, input: ManagedSourceAddress & { requestId: string }) => {
    if (typeof input.requestId !== 'string' || !input.requestId) throw new SourceAdmissionError('source_changed');
    return JSON.stringify([principal.principalId, input.coordinatorHostId, input.authorityId, input.resourceEpoch, input.requestId]);
  };
  const requirePrincipal = (principal: ManagedSourcePrincipal, coordinator: string): void => {
    if (!principal.principalId || typeof coordinator !== 'string' || !coordinator.trim()) {
      throw new SourceAdmissionError('source_authority_denied');
    }
  };
  const requireReadPrincipal = (principal: ManagedSourcePrincipal, coordinator: string): void => {
    requirePrincipal(principal, coordinator);
    if (!principal.capabilities.includes('filesystem:read')) throw new SourceAdmissionError('source_authority_denied');
  };
  const address = (principal: ManagedSourcePrincipal, input: ManagedSourceAddress): SourceAuthorityAddress => {
    requirePrincipal(principal, input.coordinatorHostId);
    return { principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId,
      authorityId: input.authorityId, resourceEpoch: input.resourceEpoch };
  };
  const capabilities: ManagedSourceService['capabilities'] = async (principal, input, signal) => {
    requireReadPrincipal(principal, input.coordinatorHostId);
    await kernel.start();
    return kernel.sourceRequest<ManagedSourceCapabilities>('source.capabilities', { mode: input.mode,
      ...(input.enabledTools ? { enabledTools: input.enabledTools } : {}), managed: true,
      clientCapabilities: [...principal.capabilities], languageAvailable: options.languageAvailable === true }, signal);
  };
  const registration = async (source: LaunchSource, signal?: AbortSignal): Promise<void> => {
    if (source.resource_owner.kind !== 'managed_host' || source.resource_owner.hostId !== options.hostId) {
      throw new SourceAdmissionError('source_changed');
    }
    await documents.admitWorkspaceRegistration(source.workspace_id, signal);
    if (source.execution_workspace_id !== source.workspace_id) await documents.admitWorkspaceRegistration(source.execution_workspace_id, signal);
    if (source.mode === 'live_root') {
      if (!source.live_root) throw new SourceAdmissionError('source_changed');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
        liveRoot: source.live_root }, signal);
    }
  };
  const selectedSource = (input: ManagedSourceBindRequest): LaunchSource => ({ resource_owner: input.source.resourceOwner,
    mode: input.source.mode, workspace_id: input.source.workspaceId, execution_workspace_id: input.source.executionWorkspaceId,
    branch_id: input.source.branchId ?? null, revision: input.source.revision ?? null, live_root: input.source.liveRoot ?? null,
    ...('environmentRunId' in input.source && typeof input.source.environmentRunId === 'string'
      ? { environment_run_id: input.source.environmentRunId } : {}) });
  const project = (authority: SourceAuthorityResult, selected: ManagedSourceCapabilities): ManagedSourceBinding => ({
    authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch, executionOwner: authority.executionOwner,
    source: authority.source, physicalRoot: authority.physicalRoot, capabilities: selected,
  });
  type NativeRelease = { authorityId: string; phase: string; receipt?: { pendingProcesses?: unknown; processStopFailures?: unknown } };
  const projectRelease = (result: NativeRelease) => ({ authorityId: result.authorityId, phase: result.phase,
    ...(result.receipt && 'pendingProcesses' in result.receipt ? { pendingProcesses: result.receipt.pendingProcesses } : {}),
    ...(result.receipt && 'processStopFailures' in result.receipt ? { processStopFailures: result.receipt.processStopFailures } : {}),
  });
  const inspect = async (principal: ManagedSourcePrincipal, input: ManagedSourceAddress, signal?: AbortSignal) => {
    await kernel.start();
    return kernel.sourceRequest<SourceAuthorityResult>('source.authority.inspect', address(principal, input), signal);
  };
  const localScope = (principal: ManagedSourcePrincipal, coordinatorHostId: string, authority: SourceAuthorityResult): ManagedSourceLocalScope => ({
    operationId: authority.operationId,
    principal, coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch,
    scope: authority.scope, source: authority.source, grant: kernel.sourceAuthorityGrant(authority), physicalRoot: authority.physicalRoot,
  });
  const drainViews = async (principal: ManagedSourcePrincipal, coordinatorHostId: string, authority: SourceAuthorityResult, retainMcpHolders = false): Promise<void> => {
    // Stop new Host service references before taking the drain snapshot. Native
    // retirement remains the durable authority and validates its actual writers.
    closing.add(authorityKey(principal, { coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch }));
    await processViews.release(principal, { coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch });
    const retained = [...services.entries()].filter(([, flight]) => flight.principalId === principal.principalId
      && flight.address.coordinatorHostId === coordinatorHostId && flight.address.authorityId === authority.authorityId
      && flight.address.resourceEpoch === authority.resourceEpoch
      && !(retainMcpHolders && flight.continuingMcp));
    for (const [, flight] of retained) flight.controller.abort();
    // Cancelling an HTTP waiter does not stop an SDK send already in progress.
    // Start the exact domain owner close before joining its request callbacks:
    // transport shutdown may be what lets those callbacks actually settle.
    const [drainResult, stopResult] = await Promise.allSettled([
      Promise.all(retained.map(([, flight]) => flight.drain)),
      Promise.resolve().then(() => options.releaseSource?.(cleanupScope(principal, coordinatorHostId, authority), { retainMcpHolders })),
    ]);
    if (drainResult.status === 'rejected') throw drainResult.reason;
    if (stopResult.status === 'rejected') throw stopResult.reason;
    const drained = drainResult.value, stopped = stopResult.value;
    // Stopping an original native MCP executor settles only its physical lifetime.
    // Catalog's unknown effect stays unknown. Separately, closed Task controls
    // may release their local references after their original SDK callbacks drained.
    for (let index = 0; index < retained.length; index++) {
      const flight = retained[index]![1];
      if (drained[index] === 'unknown' && flight.domain === 'mcp'
        && (stopped?.mcpExecutorStopped || flight.taskControl && stopped?.mcpTaskControlsDrained === true)) {
        drained[index] = 'drained'; flight.drain = Promise.resolve('drained');
      }
    }
    if (drained.includes('unknown')) throw new Error('Managed source service termination is unconfirmed');
    for (const [key] of retained) services.delete(key);
  };
  const cleanupScope = (principal: ManagedSourcePrincipal, coordinatorHostId: string, authority: SourceAuthorityResult): ManagedSourceCleanupScope =>
    ({ principal, coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch,
      source: authority.source, scope: authority.scope, physicalRoot: authority.physicalRoot, operationId: authority.operationId });
  const cleanupArtifacts = (principal: ManagedSourcePrincipal, coordinatorHostId: string, authority: SourceAuthorityResult) =>
    options.cleanupSource?.(cleanupScope(principal, coordinatorHostId, authority));
  const admit = async (principal: ManagedSourcePrincipal, input: ManagedSourceAddress, signal?: AbortSignal, enabledTools: string[] = []) => {
    if (closing.has(authorityKey(principal, input))) throw new SourceAdmissionError('source_authority_denied');
    const authority = await inspect(principal, input, signal);
    if (authority.phase !== 'ready') throw new SourceAdmissionError('source_authority_denied');
    await registration(authority.source, signal);
    await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: authority.source.mode,
      enabledTools }, signal);
    await kernel.sourceRequest('source.service.call', { ...address(principal, input), requestId: `validate:${randomUUID()}`,
      clientCapabilities: [...principal.capabilities], operation: { kind: 'validate' } }, signal);
    if (closing.has(authorityKey(principal, input))) throw new SourceAdmissionError('source_authority_denied');
    return authority;
  };

  const processAccess = async (principal: ManagedSourcePrincipal, input: import('./managed-remote-types.js').ManagedSourceProcessAddress, signal?: AbortSignal) => {
    if (!['filesystem:read', 'terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))
      throw new SourceAdmissionError('source_authority_denied');
    const authority = await admit(principal, input, signal);
    if (!authority.physicalRoot || authority.scope.kind !== 'run' || !['process_view', 'script_environment'].includes(authority.purpose)
      || authority.operationId !== input.processId) throw new SourceAdmissionError('source_changed');
    const process = await kernel.sourceRequest<import('../kernel/protocol.generated.js').KernelProcessSnapshot>('source.process.access',
      { ...address(principal, input), processId: input.processId }, signal);
    // A reopened Host observes the original spool under its current view grant.
    // The process keeps its creation epoch; Storage still rejects old-epoch input.
    if (process.processId !== input.processId || !process.kernelEpoch
      || process.workspaceId !== authority.source.workspace_id || process.mode !== (authority.purpose === 'script_environment' ? 'pipe' : 'pty')) throw new SourceAdmissionError('source_changed');
    return { authority, process };
  };
  const processViews = createManagedSourceProcesses({ kernel, access: async (principal, input, signal) => (await processAccess(principal, input, signal)).authority,
    release: async (principal, input) => {
      // A script transport is only a projection. Its original execution authority
      // survives disconnection until Catalog cancellation and callback drain settle.
      const authority = await inspect(principal, input);
      if (authority.purpose === 'process_view') await kernel.sourceRequest('source.authority.release', { ...address(principal, input), mode: 'retire' });
    } });

  const cancelServiceFlight = async (principal: ManagedSourcePrincipal, input: Parameters<ManagedSourceService['cancelService']>[1]): Promise<ManagedSourceServiceCancelReceipt> => {
    requirePrincipal(principal, input.coordinatorHostId);
    const key = serviceKey(principal, input);
    let flight = services.get(key);
    if (!flight) {
      const authority = await inspect(principal, input);
      // Recheck after the native observation: a service may have arrived
      // while its original authority was being inspected.
      flight = services.get(key);
      if (!flight) {
        if (authority.resourceEpoch !== kernel.kernelEpoch || authority.phase !== 'ready') {
          return { requestId: input.requestId, resourceEpoch: input.resourceEpoch, status: 'unknown' };
        }
        const controller = new AbortController(); controller.abort();
        flight = { principalId: principal.principalId, address: { coordinatorHostId: input.coordinatorHostId,
          authorityId: input.authorityId, resourceEpoch: input.resourceEpoch }, operation: null, controller,
          domain: null, work: null, settled: false, continuingMcp: false, drain: Promise.resolve('not_started') };
        services.set(key, flight);
      }
    }
    flight.controller.abort();
    return { requestId: input.requestId, resourceEpoch: input.resourceEpoch, status: await flight.drain };
  };

  return {
    async scriptControl(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      return kernel.sourceRequest('source.script.control', { ...input, principalId: principal.principalId }, signal);
    },
    async scriptBinding(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (input.source.mode === 'fixed_branch' || !['terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))
        throw new SourceAdmissionError('source_authority_denied');
      await registration(input.source, signal);
      const node = await resolveScriptNodeBinding();
      signal?.throwIfAborted();
      return node;
    },
    async scriptSpawn(principal, input, signal) {
      if (!['terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))
        throw new SourceAdmissionError('source_authority_denied');
      const authority = await admit(principal, input, signal);
      if (authority.purpose !== 'script_environment' || authority.operationId !== input.processId || !authority.physicalRoot
        || authority.scope.kind !== 'run' || typeof input.cwd !== 'string') throw new SourceAdmissionError('source_changed');
      const node = await resolveScriptNodeBinding();
      if (!isDeepStrictEqual(node, input.node)) throw new Error('Original target script Node binding changed');
      signal?.throwIfAborted();
      return kernel.scoped(kernel.sourceAuthorityGrant(authority)).processSpawn({
        ...scriptNodeSpawnInput(node), processId: input.processId, workspaceId: authority.source.workspace_id,
        rootId: authority.physicalRoot.rootId, cwd: input.cwd, mode: 'pipe', cols: 80, rows: 24,
      }, signal);
    },
    processAccess: async (principal, input, signal) => (await processAccess(principal, input, signal)).process,
    processSubscribe: processViews.processSubscribe,
    processControl: processViews.processControl,
    processWrite: processViews.processWrite,
    processResize: processViews.processResize,
    capabilities,
    async inspectReadScope(principal,input,signal) {
      requirePrincipal(principal,input.coordinatorHostId);await kernel.start();
      return kernel.sourceRequest('source.authority.inspect_read_scope',{...input,principalId:principal.principalId},signal);
    },
    async closeReadScope(principal,input,signal) {
      requirePrincipal(principal,input.coordinatorHostId);await kernel.start();
      return kernel.sourceRequest('source.authority.close_read_scope',{...input,principalId:principal.principalId},signal);
    },
    async fileObservation(principal,input,signal) {
      requirePrincipal(principal,input.coordinatorHostId);
      if(input.action.kind!=='release') {
        requireReadPrincipal(principal,input.coordinatorHostId);
        // This checks current Documents trust, not the caller grant's lifetime.
        // An already accepted observer survives normal Run/caller retirement.
        const authority=await inspect(principal,input,signal);
        await registration(authority.source,signal);
      }
      await kernel.start();
      return kernel.sourceRequest('source.file_observation',{...address(principal,input),requestId:input.requestId,
        clientCapabilities:[...principal.capabilities],action:input.action},signal);
    },
    async handoff(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      return kernel.sourceRequest('source.authority.handoff', { ...input, principalId: principal.principalId }, signal);
    },
    async integrationReceipt(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      return kernel.sourceRequest('source.integration.receipt', { ...input, principalId: principal.principalId }, signal);
    },
    async codeExchange(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (!options.readCodeExchange) throw new Error('The original file exchange reader is unavailable');
      await kernel.start();
      const { path, ...receipt } = input;
      // Authenticate the original receipt after the run has ended, without reopening its source.
      await kernel.sourceRequest('source.integration.receipt', { ...receipt, principalId: principal.principalId }, signal);
      return options.readCodeExchange({ ...receipt, ...(path === undefined ? {} : { path }) }, signal);
    },
    async resolve(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (typeof input.path !== 'string' || !input.path.trim()) throw new SourceAdmissionError('source_changed');
      signal?.throwIfAborted();
      const resolved = await documents.resolveWorkspace({ path: input.path });
      const registration = await documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
      if (resolved.hostId !== options.hostId || registration.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      return { workspaceId: resolved.workspaceId, canonicalRoot: registration.canonicalPath, hostId: options.hostId };
    },
    async prepare(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      const selection = normalizeThreadSourcePreparation(input.input);
      if (selection.resourceOwner.kind !== 'managed_host' || selection.resourceOwner.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      const selected = await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: selection.mode }, signal);
      const key = createHash('sha256').update(JSON.stringify([principal.principalId, input.coordinatorHostId, selection.key])).digest('hex');
      const prepared = await options.prepareSource({ ...selection, resourceOwner: { kind: 'local' }, key }, signal);
      return { ...prepared, source: { ...prepared.source, resourceOwner: selection.resourceOwner,
        tools: selected.tools.map(tool => tool.name) } };
    },
    async bind(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      const source = selectedSource(input);
      const resultOnly = input.purpose === 'result';
      if (input.purpose === 'mcp_owner' && (input.scope.kind !== 'run' || input.retention !== 'run' || input.operationId))
        throw new SourceAdmissionError('source_authority_denied');
      if (['process_view', 'script_environment'].includes(input.purpose) && (input.scope.kind !== 'run' || input.retention !== 'caller' || !input.operationId))
        throw new SourceAdmissionError('source_authority_denied');
      if (['script_environment', 'mcp_owner'].includes(input.purpose) && (source.mode === 'fixed_branch'
        || !['terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))) throw new SourceAdmissionError('source_authority_denied');
      await registration(source, signal);
      const selected = await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: source.mode,
        enabledTools: input.scope.kind === 'source_read' || resultOnly || input.purpose === 'mcp_owner' ? [] : input.source.tools }, signal);
      const integration = input.purpose === 'integration';
      if (integration && (input.scope.kind !== 'run' || !input.operationId || !principal.capabilities.includes('filesystem:write'))) throw new SourceAdmissionError('source_authority_denied');
      if (input.scope.kind === 'run' && input.retention === 'caller' && !input.operationId) throw new SourceAdmissionError('source_authority_denied');
      const delegated = Boolean(input.handoff || input.continuation);
      if (delegated && (input.handoff && input.continuation || input.scope.kind !== 'source_read'
        || input.purpose !== 'read' || input.retention !== 'caller' || input.operationId)) throw new SourceAdmissionError('source_authority_denied');
      const grantId = `managed-source:${randomUUID()}`;
      const grant = delegated ? await kernel.claimManagedChildSource({ principalId: principal.principalId,
        coordinatorHostId: input.coordinatorHostId, grantId, scope: input.scope, source,
        ...(input.handoff ? { handoff: input.handoff } : {}), ...(input.continuation ? { continuation: input.continuation } : {}),
      }, signal) : await kernel.issueGrant({ grantId,
        owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
        threadId: input.scope.threadId, ...(input.scope.kind === 'run' ? { runId: input.scope.runId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        capabilities: [...new Set([...selected.grantCapabilities, ...(integration ? ['recovery'] : []),
          ...(resultOnly ? ['storage.write'] : []), ...(['script_environment', 'mcp_owner'].includes(input.purpose) ? ['process'] : [])])], pathScopes: [''] }, signal);
      let opened: SourceAuthorityResult | undefined;
      try {
        opened = await kernel.sourceRequest<SourceAuthorityResult>('source.authority.open', {
          principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId, scope: input.scope,
          source, grantId: grant.grantId, enabledTools: selected.tools.map(tool => tool.name), purpose: input.purpose,
          ...(input.operationId ? { operationId: input.operationId } : {}),
        }, signal);
        const actor = kernel.scoped(kernel.sourceAuthorityGrant(opened));
        // The native claim verified the exact committed handoff before this
        // target root can be used; a pre-Run read cannot materialize a path.
        const handedPhysical = input.handoff && input.handoff.root.kind !== 'fixed' ? input.handoff.root.root : null;
        let physicalRoot = opened.physicalRoot ?? handedPhysical;
        const branch = source.mode === 'live_root' || handedPhysical ? undefined
          : await actor.readBranch({ branchId: source.branch_id!, revision: source.revision!, includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
        if (branch && (branch.workspaceId !== source.workspace_id || branch.branchId !== source.branch_id
          || branch.view !== 'revision' || branch.revision !== source.revision)) throw new SourceAdmissionError('source_changed');
        if (source.mode === 'live_root' && !resultOnly) {
          const root = source.live_root!;
          const registered = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
            canonicalRoot: root.canonicalRoot }, signal);
          if (registered.rootId !== root.rootId || typeof registered.canonicalRoot !== 'string'
            || normalizePathIdentity(registered.canonicalRoot) !== normalizePathIdentity(root.canonicalRoot)) throw new SourceAdmissionError('source_changed');
          physicalRoot = root;
        } else if (source.mode === 'materialized' && input.scope.kind === 'run' && !resultOnly) {
          const environmentRun = source.environment_run_id ?? (input.scope.kind === 'run' ? input.scope.runId : null);
          if (!environmentRun) throw new SourceAdmissionError('source_environment_unavailable');
          const handshake = kernel.handshake ?? await kernel.start();
          const location = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, environmentRun);
          if (opened.phase === 'preparing' && opened.firstPreparation && !source.environment_run_id) {
            const container = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
              canonicalRoot: location.storageRoot }, signal);
            if (typeof container.rootId !== 'string') throw new SourceAdmissionError('source_environment_unavailable');
            const receipt = await actor.fileMaterialize({ operationId: opened.materializationOperationId, workspaceId: source.workspace_id,
              rootId: container.rootId, path: location.relativeTarget, sourceRoot: branch!.root }, signal);
            if (receipt.status !== 'materialized') throw new SourceAdmissionError('source_environment_unavailable');
          }
          const canonicalRoot = await admitMaterializedRoot(location.targetPath, signal);
          const registered = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot }, signal);
          if (typeof registered.rootId !== 'string') throw new SourceAdmissionError('source_environment_unavailable');
          physicalRoot = { hostId: options.hostId, rootId: registered.rootId, canonicalRoot };
          if (opened.physicalRoot && !isDeepStrictEqual(opened.physicalRoot, physicalRoot)) throw new SourceAdmissionError('source_changed');
        }
        const fixed = { branchId: source.branch_id!, revision: source.revision! };
        const toolBinding: SourceToolBinding | null = input.scope.kind === 'source_read' ? null : {
          resourceOwner: source.resource_owner, grantId: opened.grantId, runId: input.scope.runId, threadId: input.scope.threadId,
          workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, sourceMode: source.mode,
          enabledTools: selected.tools.map(tool => tool.name), ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}),
          ...(source.mode === 'fixed_branch' ? { fileSource: fixed } : source.mode === 'live_root'
            ? { ...(physicalRoot ? { rootId: physicalRoot.rootId } : {}), liveRoot: source.live_root! }
            : { ...(physicalRoot ? { rootId: physicalRoot.rootId } : {}), materializedSource: fixed }),
        };
        await registration(source, signal);
        const bound = await kernel.sourceRequest<SourceAuthorityResult>('source.authority.bind', {
          ...address(principal, { coordinatorHostId: input.coordinatorHostId, authorityId: opened.authorityId, resourceEpoch: opened.resourceEpoch }),
          toolBinding, physicalRoot,
        }, signal);
        return project(bound, selected);
      } catch (error) {
        // The kernel RPC drains cancelled resource preparation before rejection.
        // Retire only this fresh grant, never an older accepted process owner.
        await kernel.retireGrant(grant.grantId).catch(() => undefined);
        throw error;
      } finally {
        if (opened && opened.grantId !== grant.grantId) await kernel.retireGrant(grant.grantId);
      }
    },
    async recovery(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (!principal.capabilities.includes('filesystem:write')) throw new SourceAdmissionError('source_authority_denied');
      if (!options.recovery) throw new SourceAdmissionError('source_unavailable');
      // Recovery is a new user-authorized operation over original journal facts.
      // It must not re-admit or resurrect the retired execution Source grant.
      return options.recovery(principal, input, signal);
    },
    async authorize(principal, input, signal) {
      await admit(principal, input, signal, [input.call.name]);
      return kernel.sourceRequest('source.resource.authorize', { ...address(principal, input), call: input.call,
        ...(input.journal ? { journal: input.journal } : {}) }, signal);
    },
    async execute(principal, input, signal) {
      await admit(principal, input, signal, [input.call.name]);
      return kernel.sourceRequest('source.resource.execute', { ...address(principal, input), call: input.call,
        ...(input.journal ? { journal: input.journal } : {}) }, signal);
    },
    async service(principal, input, signal) {
      const mcpRelease = input.operation.kind === 'mcp' && input.operation.action.kind === 'release';
      const mcpContinuation = input.operation.kind === 'mcp' && (isManagedMcpDerivationContinuation(input.operation.action) || isManagedMcpChildContinuation(input.operation.action) || isManagedMcpTaskContinuation(input.operation.action) || isManagedMcpResourceContinuation(input.operation.action) || isManagedMcpInteractionContinuation(input.operation.action));
      if (mcpRelease || mcpContinuation && input.operation.kind === 'mcp' && ['derivation_inspect', 'derivation_release', 'child_inspect', 'child_release', 'task_inspect', 'task_release', 'task_cancel', 'resource_inspect', 'resource_release', 'interaction_inspect', 'interaction_ack', 'interaction_release', 'interaction_close'].includes(input.operation.action.kind)) requirePrincipal(principal, input.coordinatorHostId);
      else requireReadPrincipal(principal, input.coordinatorHostId);
      const key = serviceKey(principal, input);
      const original = services.get(key);
      if (original) {
        if (original.operation && !isDeepStrictEqual(original.operation, input.operation)) throw new SourceAdmissionError('source_changed');
        if (original.work) return original.work;
        if (original.settled) throw new Error('Original source service already settled; observe its original domain receipt');
        original.controller.signal.throwIfAborted();
        throw new SourceAdmissionError('source_changed');
      }
      if (!mcpRelease && !mcpContinuation && closing.has(authorityKey(principal, input))) throw new SourceAdmissionError('source_authority_denied');
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const operation = structuredClone(input.operation);
      let dispatched = false;
      let nativeDispatch = false;
      const work = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        if (operation.kind === 'mcp') {
          const action = operation.action;
          if ((action.kind === 'snapshot' || action.kind === 'derive') && action.creationRequestId !== input.requestId)
            throw new SourceAdmissionError('source_changed');
          if (action.kind === 'release') {
            if (!action.creationRequestId || action.creationRequestId === input.requestId) throw new SourceAdmissionError('source_changed');
            // Fence and drain the exact creation attempt before releasing its resulting view.
            // cancelServiceFlight also records an early cancellation in the original request map.
            const original = await cancelServiceFlight(principal, { ...input, requestId: action.creationRequestId });
            if (original.status === 'unknown') return { ok: false, executorStopped: false,
              error: { code: 'mcp_original_preparation_unconfirmed', dispatched: true, settlement: 'unknown' } };
          }
        }
        // Cleanup uses the original authenticated address even after read/trust withdrawal.
        const authority = mcpRelease || mcpContinuation ? await inspect(principal, input, controller.signal) : await admit(principal, input, controller.signal);
        if (authority.purpose === 'process_view' || authority.purpose === 'script_environment'
          && !(operation.kind === 'native_resource' && operation.action.kind === 'process_observation')) throw new SourceAdmissionError('source_authority_denied');
        if (authority.purpose === 'mcp_owner' && operation.kind !== 'mcp' && operation.kind !== 'validate'
          || operation.kind === 'mcp' && authority.purpose !== 'mcp_owner') throw new SourceAdmissionError('source_authority_denied');
        if (operation.kind === 'mcp' && isManagedMcpDerivationContinuation(operation.action)) {
          if (!options.mcpDerivationContinuation) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.mcpDerivationContinuation(cleanupScope(principal, input.coordinatorHostId, authority), operation.action, controller.signal);
        }
        if (operation.kind === 'mcp' && isManagedMcpChildContinuation(operation.action)) {
          if (!options.mcpChildContinuation) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.mcpChildContinuation(cleanupScope(principal, input.coordinatorHostId, authority), operation.action, controller.signal);
        }
        if (operation.kind === 'mcp' && isManagedMcpTaskContinuation(operation.action)) {
          if (!options.mcpTaskContinuation) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.mcpTaskContinuation(cleanupScope(principal, input.coordinatorHostId, authority), operation.action, controller.signal);
        }
        if (operation.kind === 'mcp' && isManagedMcpResourceContinuation(operation.action)) {
          if (!options.mcpResourceContinuation) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.mcpResourceContinuation(cleanupScope(principal, input.coordinatorHostId, authority), operation.action, controller.signal);
        }
        if (operation.kind === 'mcp' && isManagedMcpInteractionContinuation(operation.action)) {
          if (!options.mcpInteractionContinuation) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.mcpInteractionContinuation(cleanupScope(principal, input.coordinatorHostId, authority), operation.action, controller.signal);
        }
        if (operation.kind === 'mcp' && operation.action.kind === 'release') {
          if (!options.releaseMcpView) throw new SourceAdmissionError('source_unavailable');
          dispatched = true;
          return options.releaseMcpView(cleanupScope(principal, input.coordinatorHostId, authority), operation.action);
        }
        switch (operation.kind) {
          case 'native_resource': case 'validate':
            dispatched = true;
            nativeDispatch = true;
            return kernel.sourceRequest('source.service.call', { ...address(principal, input), requestId: input.requestId,
              clientCapabilities: [...principal.capabilities], operation }, controller.signal);
          default: {
            if (!options.serviceOperation) throw new SourceAdmissionError('source_unavailable');
            // The original domain owns promotion and drain. No post-effect
            // cancellation/trust check may discard its committed receipt.
            const scope = localScope(principal, input.coordinatorHostId, authority);
            dispatched = true;
            return options.serviceOperation(scope, operation, controller.signal);
          }
        }
      }).finally(() => signal?.removeEventListener('abort', abort));
      const drain = work.then(result => {
        if (operation.kind === 'mcp' && operation.action.kind === 'task_inspect') {
          const recalled = result as { ok?: boolean; value?: { receipt?: { outcome?: { kind: string; error?: { dispatched: boolean; settlement: string } } } } };
          const outcome = recalled?.ok ? recalled.value?.receipt?.outcome : undefined;
          if (outcome && (outcome.kind === 'accepted' || outcome.error && (!outcome.error.dispatched || outcome.error.settlement === 'rpc_response'))) {
            // The original creation response is now durable. Refine only that finite
            // RPC's drain fact; its continuing Task is still held independently.
            for (const prior of services.values()) if (prior.principalId === principal.principalId
              && prior.address.coordinatorHostId === input.coordinatorHostId && prior.address.authorityId === input.authorityId
              && prior.address.resourceEpoch === input.resourceEpoch && isDeepStrictEqual(prior.taskCreation, operation.action.binding))
              prior.drain = Promise.resolve('drained');
          }
        }
        if (operation.kind === 'mcp' && operation.action.kind === 'resource_inspect') {
          const recalled = result as { ok?: boolean; value?: { receipt?: { outcome?: { kind: string; error?: { dispatched: boolean; settlement: string } } } } };
          const outcome = recalled?.ok ? recalled.value?.receipt?.outcome : undefined;
          if (outcome && (outcome.kind === 'subscribed' || outcome.error && (!outcome.error.dispatched || outcome.error.settlement === 'rpc_response'))) {
            for (const prior of services.values()) if (prior.principalId === principal.principalId
              && prior.address.coordinatorHostId === input.coordinatorHostId && prior.address.authorityId === input.authorityId
              && prior.address.resourceEpoch === input.resourceEpoch && isDeepStrictEqual(prior.resourceCreation, operation.action.binding))
              prior.drain = Promise.resolve('drained');
          }
        }
        if (operation.kind === 'mcp' && operation.action.kind === 'task_release') {
          const released = result as { ok?: boolean; value?: { controlsDrained?: boolean } };
          if (released?.ok && released.value?.controlsDrained === true) {
            // Original holder release awaited its actual local SDK controls. Their
            // local references may close; remote Task/effect facts remain in Catalog.
            for (const prior of services.values()) if (prior.principalId === principal.principalId
              && prior.address.coordinatorHostId === input.coordinatorHostId && prior.address.authorityId === input.authorityId
              && prior.address.resourceEpoch === input.resourceEpoch && isDeepStrictEqual(prior.taskControl, operation.action.binding))
              prior.drain = Promise.resolve('drained');
          }
        }
        if (operation.kind === 'schedule') {
          // Schedule uses the original ToolExecutionReceipt contract. A camel-
          // case field or a missing stop acknowledgement cannot prove drainage.
          return result && typeof result === 'object' && (result as { executor_stopped?: unknown }).executor_stopped === true
            ? 'drained' as const : 'unknown' as const;
        }
        if (result && typeof result === 'object') {
          const receipt = result as { executorStopped?: boolean; effect?: string };
          if (receipt.executorStopped === false || receipt.effect === 'unknown' && receipt.executorStopped !== true) return 'unknown' as const;
        }
        return 'drained' as const;
      }, error => !dispatched ? 'not_started' as const : error instanceof ManagedSourceDrainedError && kernel.kernelEpoch === input.resourceEpoch
        ? 'drained' as const : nativeDispatch && controller.signal.aborted && kernel.kernelEpoch === input.resourceEpoch
        && (error instanceof DOMException && error.name === 'AbortError' || error instanceof KernelClientError && error.code === 'cancelled')
          ? 'drained' as const : 'unknown' as const).then(status => {
        const flight = services.get(key);
        if (flight?.work === work) {
          // Only an active request owns its body. Keep short settlement/drain
          // facts for cancellation races, never completed file/PDF/output data.
          flight.work = null; flight.operation = null; flight.settled = true;
        }
        return status;
      });
      services.set(key, { principalId: principal.principalId, address: { coordinatorHostId: input.coordinatorHostId,
        authorityId: input.authorityId, resourceEpoch: input.resourceEpoch }, operation, domain: operation.kind, controller, work, settled: false,
        continuingMcp: operation.kind === 'mcp' && (isManagedMcpTaskContinuation(operation.action) || isManagedMcpResourceContinuation(operation.action) || isManagedMcpInteractionContinuation(operation.action) || operation.action.kind === 'task_start' || operation.action.kind === 'resource_subscribe'),
        ...(operation.kind === 'mcp' && operation.action.kind === 'task_start' ? { taskCreation: operation.action.binding } : {}),
        ...(operation.kind === 'mcp' && operation.action.kind === 'resource_subscribe' ? { resourceCreation: operation.action.binding } : {}),
        ...(operation.kind === 'mcp' && (operation.action.kind === 'task_get' || operation.action.kind === 'task_result' || operation.action.kind === 'task_cancel')
          ? { taskControl: operation.action.binding } : {}), drain });
      return work;
    },
    cancelService: cancelServiceFlight,
    async observe(principal, input, signal) {
      await kernel.start();
      return kernel.sourceRequest('source.resource.observe', { ...address(principal, input), operationId: input.operationId }, signal);
    },
    async releaseReceipt(principal, input, signal) {
      await kernel.start();
      return kernel.sourceRequest('source.resource.release', { ...address(principal, input), operationId: input.operationId }, signal);
    },
    async cancel(principal, input, signal) {
      await kernel.start();
      return kernel.sourceRequest('source.resource.cancel', { ...address(principal, input), operationId: input.operationId }, signal);
    },
    async release(principal, input, signal) {
      await kernel.start();
      let authority = await inspect(principal, input, signal);
      if (authority.purpose === 'mcp_owner') authority = await kernel.sourceRequest<SourceAuthorityResult>(
        'source.authority.seal', address(principal, input), signal);
      const retained = input.mode === 'retire' && (authority.mcpHolders.some(holder => !holder.released) || authority.mcpDeliveries.some(delivery => !delivery.released) || authority.mcpChildren.some(child => !child.released));
      await drainViews(principal, input.coordinatorHostId, authority, retained);
      if (!retained) await cleanupArtifacts(principal, input.coordinatorHostId, authority);
      const result = await kernel.sourceRequest<NativeRelease>('source.authority.release', { ...address(principal, input), mode: input.mode }, signal);
      closing.delete(authorityKey(principal, input));
      return projectRelease(result);
    },
    async inspectScope(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      const authorities = await kernel.sourceRequest<SourceAuthorityResult[]>('source.authority.inspect_scope', {
        principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId, threadId: input.threadId, runId: input.runId,
      }, signal);
      return Promise.all(authorities.map(async authority => {
        // Describe the original binding even if current permissions have been
        // withdrawn. This grants no execution or new source access.
        const selected = await kernel.sourceRequest<ManagedSourceCapabilities>('source.capabilities', {
          mode: authority.source.mode, enabledTools: authority.toolBinding?.enabledTools ?? [], managed: true, languageAvailable: true,
        }, signal);
        return { scope: authority.scope, phase: authority.phase, purpose: authority.purpose, operationId: authority.operationId, mcpHolders: authority.mcpHolders, mcpDeliveries: authority.mcpDeliveries, mcpChildren: authority.mcpChildren, binding: project(authority, selected) };
      }));
    },
    async releaseScope(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      const params = { principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId,
        threadId: input.threadId, runId: input.runId };
      const inspected = await kernel.sourceRequest<SourceAuthorityResult[]>('source.authority.inspect_scope', params, signal);
      // Match native retirement's original lifetime selection. A caller-owned
      // operation can outlive its Run; retirement must not close its Host work.
      const authorities = inspected.filter(authority => input.mode === 'revoke' || authority.operationId === null);
      await Promise.all(authorities.map(async original => {
        // Seal in Storage before the Host snapshot: no late holder may race this drain.
        const authority = original.purpose === 'mcp_owner' ? await kernel.sourceRequest<SourceAuthorityResult>(
          'source.authority.seal', address(principal, { coordinatorHostId: input.coordinatorHostId,
            authorityId: original.authorityId, resourceEpoch: original.resourceEpoch }), signal) : original;
        const retained = input.mode === 'retire' && (authority.mcpHolders.some(holder => !holder.released) || authority.mcpDeliveries.some(delivery => !delivery.released) || authority.mcpChildren.some(child => !child.released));
        await drainViews(principal, input.coordinatorHostId, authority, retained);
        if (!retained) await cleanupArtifacts(principal, input.coordinatorHostId, authority);
      }));
      const result = await kernel.sourceRequest<{ released: NativeRelease[]; pendingAuthorities: string[] }>(
        'source.authority.release_scope', { ...params, mode: input.mode }, signal);
      for (const authority of authorities) if (result.released.some(item => item.authorityId === authority.authorityId)) {
        closing.delete(authorityKey(principal, { coordinatorHostId: input.coordinatorHostId,
          authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch }));
      }
      return { released: result.released.map(projectRelease), pendingAuthorities: result.pendingAuthorities };
    },
  };
}
