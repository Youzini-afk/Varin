import { encodeProjectCommandResult } from '@varin/application-client';
import {managedExternalCapture,cleanupManagedExternalCaptures} from '../external-agents/managed-capture.js';
import { resolveSourceTextPolicy } from '../kernel/source-provenance.js';
/** The target Host admits its own Source resources. Catalog execution facts stay
 * with the coordinator; this adapter stores neither operations nor grants. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseProjectSourceSelection, type ThreadPrepareSource, type ThreadPreparedSource } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import { KernelClientError, type KernelClient } from '../kernel/kernel-client.js';
import type { LiveSourceResolver } from '../kernel/live-source.js';
import type { LaunchSource, SourceAuthorityAddress, SourceAuthorityResult, SourceToolBinding } from '../kernel/protocol.generated.js';
import { admitMaterializedRoot, originalMaterializationLocation } from '../kernel/source-launch.js';
import { SourceAdmissionError, sourceReadError } from '../kernel/source-admission-error.js';
import { normalizeThreadSourcePreparation } from '../kernel/thread-sources.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { createManagedAttachmentImport } from './managed-attachment-import.js';
import { ManagedSourceDrainedError } from './managed-source-drain.js';
import { resolveScriptNodeBinding, scriptNodeSpawnInput } from '../kernel/script-node-binding.js';
import { isManagedMcpDerivationContinuation, isManagedMcpChildContinuation, isManagedMcpTaskContinuation, isManagedMcpResourceContinuation, isManagedMcpInteractionContinuation } from './managed-mcp-contract.js';
import { createManagedSourceProcesses } from './managed-source-processes.js';
import { defaultExecutionEnvironment } from '../platform/execution-environment.js';
import type { ManagedSourceAddress, ManagedSourceBindRequest, ManagedSourceBinding, ManagedSourceCapabilities,
  ManagedSourcePrincipal, ManagedSourceService, ManagedSourceServiceHandler, ManagedSourceLocalScope,
  ManagedSourceServiceRequest, ManagedSourceServiceCancelReceipt } from './managed-remote-types.js';
import type { ManagedSourceCleanupScope } from './managed-remote-types.js';
import type { ManagedRecoveryReply, ManagedRecoveryRequest } from './managed-recovery-contract.js';

export interface ManagedSourceServiceOptions {
  prepareExternalLiveSource?: (workspaceId:string,executionWorkspaceId:string,conversationId:string,signal?:AbortSignal)=>Promise<import('../kernel/protocol.generated.js').LiveRoot>;
  externalChildSource?: ReturnType<typeof import('../external-agents/managed-child-source.js').createManagedExternalChildSourceOwner>;
  projectManagement?: ReturnType<typeof import('../projects/managed-project-management.js').createManagedProjectManagementOwner>;
  externalProjectSource?: ReturnType<typeof import('../external-agents/managed-project-source.js').createManagedExternalProjectSourceOwner>;
  terminal?:ReturnType<typeof import('../terminal/managed-owner.js').createManagedTerminalOwner>;
  externalSettings?:(signal?:AbortSignal)=>Promise<import('@varin/application-client').ExternalAgentSettings>;
  externalLaunch?: (configurationId: string, harness: import('@varin/application-client').ExternalHarness, sessionId?: string, signal?: AbortSignal) => Promise<{binding:import('./managed-remote-types.js').ManagedExternalLaunchBinding;command:string;args:string[];env:NodeJS.ProcessEnv}>;
  workspaceFiles?: import('../workspace/resource-files.js').ResourceFilesOwner;
  deviceFileAccess?: boolean;
  executionEnvironment?: () => Promise<import('../kernel/protocol.generated.js').ExecutionEnvironment>;
  kernel: KernelClient;
  hostId: string;
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration' | 'resolveWorkspace' | 'inspectWorkspace'>;
  validateLiveSource: LiveSourceResolver;
  /** The target's local original preparer, never the coordinator's remote dispatcher. */
  prepareSource(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  draftSourceFiles?(input: import('@varin/application-client').ThreadDraftFileOptions, signal?: AbortSignal): Promise<import('@varin/application-client').ThreadSourceFilePage>;
  draftSourceSkills?(workspaceId: string, signal?: AbortSignal): Promise<import('@varin/application-client').ThreadSkillCatalog>;
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
}

export function createManagedSourceService(options: ManagedSourceServiceOptions): ManagedSourceService {
  const { kernel, documents } = options;
  const attachments = createManagedAttachmentImport(kernel);
  interface AttachmentCapture {
    principalId: string; coordinatorHostId: string;
    scope: SourceAuthorityResult['scope']; source: LaunchSource;
    operationId: string; ref: string; path: string;
  }
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
    attachmentCapture?: AttachmentCapture;
    drain: Promise<ManagedSourceServiceCancelReceipt['status']>;
  }
  // Live request handles only. Durable effects and recovery remain in their
  // original Storage/domain receipts; this map disappears with this Host.
  const services = new Map<string, ServiceFlight>();
  // These fences prove only this Host lifetime. Missing flights after restart
  // remain unknown; they are never inferred stopped from an empty map.
  const captureFences: AttachmentCapture[] = [];
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
    const selected = await kernel.sourceRequest<ManagedSourceCapabilities>('source.capabilities', { mode: input.mode,
      ...(input.enabledTools ? { enabledTools: input.enabledTools } : {}),
      clientCapabilities: [...principal.capabilities] }, signal);
    return { ...selected, ...(selected.tools.some(tool => tool.name === 'process_spawn')
      ? { executionEnvironment: await (options.executionEnvironment?.() ?? defaultExecutionEnvironment.snapshot()) } : {}) };
  };
  const registration = async (source: LaunchSource, signal?: AbortSignal, metadataOnly=false): Promise<void> => {
    if (source.resource_owner.kind !== 'managed_host' || source.resource_owner.hostId !== options.hostId) {
      throw new SourceAdmissionError('source_changed');
    }
    await documents.admitWorkspaceRegistration(source.workspace_id, signal);
    if (source.execution_workspace_id !== source.workspace_id) await documents.admitWorkspaceRegistration(source.execution_workspace_id, signal);
    if (metadataOnly) return;
    if(source.mode==='native_workspace'){if(!kernel.nativeWorkspaces)throw new SourceAdmissionError('source_unavailable');await kernel.nativeWorkspaces.open(source,signal);}
    if (source.mode === 'live_root') {
      if (!source.live_root) throw new SourceAdmissionError('source_changed');
      await options.validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
        liveRoot: source.live_root }, signal);
    }
  };
  const selectedSource = (input: ManagedSourceBindRequest): LaunchSource => ({ ...(input.source.mode==='native_workspace'&&input.source.nativeScope?{native_scope:input.source.nativeScope}:{}),resource_owner: input.source.resourceOwner,
    mode: input.source.mode, workspace_id: input.source.workspaceId, execution_workspace_id: input.source.executionWorkspaceId,
    branch_id: input.source.branchId ?? null, revision: input.source.revision ?? null, live_root: input.source.liveRoot ?? null,
    ...('environmentRunId' in input.source && typeof input.source.environmentRunId === 'string'
      ? { environment_run_id: input.source.environmentRunId } : {}) });
  const project = (authority: SourceAuthorityResult, selected: ManagedSourceCapabilities): ManagedSourceBinding => ({
    ...(authority.toolBinding?.textEncoding ? { textEncoding: authority.toolBinding.textEncoding } : {}),
    authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch, executionOwner: authority.executionOwner,
    source: authority.source, physicalRoot: authority.physicalRoot, capabilities: selected,
    ...(authority.toolBinding?.executionEnvironment ? { executionEnvironment: authority.toolBinding.executionEnvironment } : {}),
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
    ...(authority.toolBinding?.textEncoding ? { textEncoding: authority.toolBinding.textEncoding } : {}),
    operationId: authority.operationId,
    principal, coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch,
    scope: authority.scope, source: authority.source, grant: kernel.sourceAuthorityGrant(authority), physicalRoot: authority.physicalRoot,
  });
  const drainViews = async (principal: ManagedSourcePrincipal, coordinatorHostId: string, authority: SourceAuthorityResult, retainMcpHolders = false): Promise<void> => {
    // Stop new Host service references before taking the drain snapshot. Native
    // retirement remains the durable authority and validates its actual writers.
    closing.add(authorityKey(principal, { coordinatorHostId, authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch }));
    await attachments.drain(cleanupScope(principal, coordinatorHostId, authority));
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
    await registration(authority.source, signal, authority.purpose === 'result');
    await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: authority.source.mode,
      enabledTools }, signal);
    if(authority.scope.kind === 'external') await kernel.assertGrantForScope(kernel.sourceAuthorityGrant(authority));
    else await kernel.sourceRequest('source.service.call', { ...address(principal, input), requestId: `validate:${randomUUID()}`,
      clientCapabilities: [...principal.capabilities], operation: { kind: 'validate' } }, signal);
    if (closing.has(authorityKey(principal, input))) throw new SourceAdmissionError('source_authority_denied');
    return authority;
  };

  const processAccess = async (principal: ManagedSourcePrincipal, input: import('./managed-remote-types.js').ManagedSourceProcessAddress, signal?: AbortSignal) => {
    if (!['filesystem:read', 'terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))
      throw new SourceAdmissionError('source_authority_denied');
    const authority = await admit(principal, input, signal);
    if (!authority.physicalRoot || !((authority.scope.kind === 'run' && ['process_view','script_environment'].includes(authority.purpose)) || (authority.scope.kind === 'external' && authority.purpose === 'external_harness'))
      || authority.operationId !== input.processId) throw new SourceAdmissionError('source_changed');
    const process = await kernel.sourceRequest<import('../kernel/protocol.generated.js').KernelProcessSnapshot>('source.process.access',
      { ...address(principal, input), processId: input.processId }, signal);
    // A reopened Host observes the original spool under its current view grant.
    // The process keeps its creation epoch; Storage still rejects old-epoch input.
    if (process.processId !== input.processId || !process.kernelEpoch
      || process.workspaceId !== authority.source.workspace_id || process.mode !== (['script_environment','external_harness'].includes(authority.purpose) ? 'pipe' : 'pty')) throw new SourceAdmissionError('source_changed');
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

  const attachmentScope = async (principal: ManagedSourcePrincipal, input: ManagedSourceAddress, signal?: AbortSignal) => {
    const authority = await admit(principal, input, signal);
    if (!(authority.scope.kind === 'run' && authority.purpose === 'source') && !(authority.scope.kind === 'external' && authority.purpose === 'external_harness')) throw new SourceAdmissionError('source_authority_denied');
    return localScope(principal, input.coordinatorHostId, authority);
  };
  return {
    async attachmentBegin(principal, input, signal) { return attachments.begin(await attachmentScope(principal, input, signal), input, signal); },
    async attachmentPut(principal, input, body, signal) { return attachments.put(await attachmentScope(principal, input, signal), input, body, signal); },
    async attachmentPath(principal, input, signal) { return attachments.path(await attachmentScope(principal, input, signal), input, signal); },
    async externalCapture(principal,input,signal){
      const authority=await admit(principal,input,signal);
      if(authority.scope.kind!=='external'||authority.purpose!=='external_harness')throw new SourceAdmissionError('source_authority_denied');
      return managedExternalCapture(kernel,localScope(principal,input.coordinatorHostId,authority),input,signal);
    },
    async externalChildSource(principal,input,signal){
      if(input.action==='prepare')requireReadPrincipal(principal,input.coordinatorHostId);else requirePrincipal(principal,input.coordinatorHostId);
      if(!options.externalChildSource)throw new SourceAdmissionError('source_unavailable');
      return options.externalChildSource(principal,input,signal);
    },
    async projectManagement(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (!options.projectManagement) throw new SourceAdmissionError('source_unavailable');
      const value = await options.projectManagement(principal, input, signal);
      const command = input.command;
      return command.action === 'git-command' || command.action === 'github-command'
        ? encodeProjectCommandResult(command.action, command.input.operation, value) : value;
    },
    async externalProjectSource(principal,input,signal){
      requireReadPrincipal(principal,input.coordinatorHostId);
      if(!options.externalProjectSource)throw new SourceAdmissionError('source_unavailable');
      if(input.action!=='remove')await registration(input.source,signal);
      return options.externalProjectSource(principal,input,signal);
    },
    async externalSettings(principal,input,signal) {
      requireReadPrincipal(principal,input.coordinatorHostId);
      if(!options.externalSettings)throw new SourceAdmissionError('source_unavailable');
      return options.externalSettings(signal);
    },
    async externalPrepare(principal,input,signal) {
      requireReadPrincipal(principal,input.coordinatorHostId);
      if (!options.prepareExternalLiveSource || input.resourceOwner.kind !== 'managed_host' || input.resourceOwner.hostId !== options.hostId
        || !input.conversationId || !['terminal:use','process:control'].every(c=>principal.capabilities.includes(c))) throw new SourceAdmissionError('source_authority_denied');
      const resolved = await documents.resolveWorkspace({path:input.path});
      if(input.expectedWorkspaceId && input.expectedWorkspaceId!==resolved.workspaceId)throw new SourceAdmissionError('source_changed');
      const workspace = await documents.admitWorkspaceRegistration(resolved.workspaceId,signal);
      if (principal.allowedDirectories?.length) {
        const {assertResourcePathAllowed}=await import('../workspace/resource-access.js');
        await assertResourcePathAllowed(workspace.canonicalPath,principal.allowedDirectories);
      }
      const liveRoot = await options.prepareExternalLiveSource(resolved.workspaceId,resolved.workspaceId,input.conversationId,signal);
      return {resource_owner:input.resourceOwner,mode:'live_root',workspace_id:resolved.workspaceId,execution_workspace_id:resolved.workspaceId,
        branch_id:null,revision:null,live_root:liveRoot};
    },
    async terminal(principal,input,signal){requireReadPrincipal(principal,input.coordinatorHostId);if(!options.terminal)throw new SourceAdmissionError('source_unavailable');return options.terminal.command(principal,input,signal);},
    async terminalStream(principal,input,emit,signal){requireReadPrincipal(principal,input.coordinatorHostId);if(!options.terminal)throw new SourceAdmissionError('source_unavailable');return options.terminal.stream(principal,input,emit,signal);},
    async externalBinding(principal, input, signal) {
      requireReadPrincipal(principal,input.coordinatorHostId);
      if (!['terminal:use','process:control'].every(c => principal.capabilities.includes(c)) || !options.externalLaunch) throw new SourceAdmissionError('source_authority_denied');
      await registration(input.source,signal);
      return (await options.externalLaunch(input.configurationId,input.harness,input.sessionId,signal)).binding;
    },
    async externalSpawn(principal,input,signal) {
      if (!['terminal:use','process:control'].every(c => principal.capabilities.includes(c)) || !options.externalLaunch) throw new SourceAdmissionError('source_authority_denied');
      const authority = await admit(principal,input,signal);
      if (authority.purpose !== 'external_harness' || authority.scope.kind !== 'external' || authority.operationId !== input.processId || authority.scope.transportId !== input.processId || !authority.physicalRoot) throw new SourceAdmissionError('source_changed');
      const launch = await options.externalLaunch(input.launch.configuration.id,input.launch.configuration.harness,input.sessionId,signal);
      if (!isDeepStrictEqual(launch.binding,input.launch)) throw new Error('Original target external Harness configuration changed');
      signal?.throwIfAborted();
      // Once dispatched, retain its exact receipt even if the HTTP waiter disconnects.
      return kernel.scoped(kernel.sourceAuthorityGrant(authority)).processSpawn({processId:input.processId,workspaceId:authority.source.workspace_id,
        rootId:authority.physicalRoot.rootId,cwd:'',command:launch.command,args:launch.args,mode:'pipe',
        env:Object.entries(launch.env).flatMap(([name,value]) => value === undefined || name === 'NODE_CHANNEL_FD' ? [] : [{name,value}])});
    },
    async externalControl(principal,input,signal) {
      requirePrincipal(principal,input.coordinatorHostId); await kernel.start();
      const {releaseCaptures,release,...control}=input;
      let receipt = await kernel.sourceRequest<import('./managed-remote-types.js').ManagedExternalControlReceipt>('source.external.control',{...control,principalId:principal.principalId},signal);
      if(receipt.executorStopped&&releaseCaptures)await cleanupManagedExternalCaptures(kernel,{principal,coordinatorHostId:input.coordinatorHostId,scope:{kind:'external',conversationId:input.conversationId,transportId:input.transportId}});
      if (receipt.executorStopped) for (const address of receipt.authorities) {
        const authority = await inspect(principal,{coordinatorHostId:input.coordinatorHostId,...address},signal);
        await attachments.drain(cleanupScope(principal,input.coordinatorHostId,authority));
        await attachments.cleanup(cleanupScope(principal,input.coordinatorHostId,authority));
      }
      if(release){
        if(!receipt.executorStopped)throw new Error('Original external process output is still in use');
        for(const authority of receipt.authorities)await processViews.release(principal,{coordinatorHostId:input.coordinatorHostId,...authority});
        receipt=await kernel.sourceRequest<import('./managed-remote-types.js').ManagedExternalControlReceipt>('source.external.control',{...control,release:true,principalId:principal.principalId},signal);
      }
      return receipt;
    },
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
    async fileReceipt(principal, input, signal) {
      requirePrincipal(principal, input.coordinatorHostId);
      await kernel.start();
      return kernel.sourceRequest('source.file.receipt', { ...input, principalId: principal.principalId }, signal);
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
    async workspace(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (!['open', 'locations', 'list', 'bytes', 'readlink', 'filename-search', 'content-search'].includes(input.command?.kind) && !principal.capabilities.includes('filesystem:write')) throw new SourceAdmissionError('source_authority_denied');
      if (!options.workspaceFiles) throw new SourceAdmissionError('source_unavailable');
      const { assertResourcePathAllowed } = await import('../workspace/resource-access.js');
      const selection = input.selection === undefined ? undefined : parseProjectSourceSelection(input.selection);
      if (selection?.mode === 'native_workspace') {
        const registration = await documents.admitWorkspaceRegistration(selection.workspaceId, signal);
        await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
      }
      if (selection?.mode !== 'native_workspace' && input.root && principal.allowedDirectories?.length) {
        const workspace = await documents.resolveWorkspace({ path: input.root });
        const registration = await documents.admitWorkspaceRegistration(workspace.workspaceId, signal);
        await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
      }
      if (selection?.mode !== 'native_workspace' && input.command.kind === 'open' && input.command.path) await assertResourcePathAllowed(input.command.path, principal.allowedDirectories);
      const selected = input.command.kind === 'open' && !input.command.path && !input.taskSource && principal.allowedDirectories?.length
        ? { ...input, command: { ...input.command, path: principal.allowedDirectories[0]! } } : input;
      const result = await options.workspaceFiles.request(selected, signal);
      if (result.kind === 'opened' && selection?.mode !== 'native_workspace') {
        const registration = await documents.admitWorkspaceRegistration(result.workspaceId, signal);
        await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
      }
      if ((result.kind === 'opened' || result.kind === 'locations') && principal.allowedDirectories?.length) result.locations = [...principal.allowedDirectories];
      return result;
    },
    async workspaceAsset(principal,input,signal) {
      requireReadPrincipal(principal,input.coordinatorHostId);
      if(!options.workspaceFiles)throw new SourceAdmissionError('source_unavailable');
      const selection=input.selection===undefined?undefined:parseProjectSourceSelection(input.selection);
      const registration=await documents.admitWorkspaceRegistration(selection?.mode==='native_workspace'?selection.workspaceId:input.workspaceId,signal);
      const {assertResourcePathAllowed}=await import('../workspace/resource-access.js');
      await assertResourcePathAllowed(registration.authorizationRoot,principal.allowedDirectories);
      return options.workspaceFiles.asset(input,signal);
    },
    async workspaceUpload(principal, input, body, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (!principal.capabilities.includes('filesystem:write')) throw new SourceAdmissionError('source_authority_denied');
      if (!options.workspaceFiles) throw new SourceAdmissionError('source_unavailable');
      const { assertResourcePathAllowed } = await import('../workspace/resource-access.js');
      if (principal.allowedDirectories?.length) {
        const selection = input.selection === undefined ? undefined : parseProjectSourceSelection(input.selection);
        const registration = await documents.admitWorkspaceRegistration(selection?.mode === 'native_workspace' ? selection.workspaceId : input.workspaceId, signal);
        await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
      }
      return options.workspaceFiles.upload(input, body, signal);
    },
    async files(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (typeof input.path !== 'string' || !input.path.trim()) throw new SourceAdmissionError('source_changed');
      if (!options.draftSourceFiles) throw new SourceAdmissionError('source_unavailable');
      const resolved = await documents.resolveWorkspace({ path: input.path });
      const registration = await documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
      if (resolved.hostId !== options.hostId || registration.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      return options.draftSourceFiles({ ...input, source: { resourceOwner: { kind: 'local' }, path: registration.canonicalPath } }, signal);
    },
    async skills(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      if (typeof input.path !== 'string' || !input.path.trim()) throw new SourceAdmissionError('source_changed');
      if (!options.draftSourceSkills) throw new SourceAdmissionError('source_unavailable');
      const resolved = await documents.resolveWorkspace({ path: input.path });
      const registration = await documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
      if (resolved.hostId !== options.hostId || registration.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      return options.draftSourceSkills(resolved.workspaceId, signal);
    },
    async prepare(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      const selection = normalizeThreadSourcePreparation(input.input);
      if (selection.resourceOwner.kind !== 'managed_host' || selection.resourceOwner.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      const registration = await documents.admitWorkspaceRegistration(selection.workspaceId, signal);
      if (registration.hostId !== options.hostId) throw new SourceAdmissionError('source_changed');
      if (principal.allowedDirectories?.length) {
        const { assertResourcePathAllowed } = await import('../workspace/resource-access.js');
        await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
      }
      const selected = await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: selection.mode }, signal);
      const key = createHash('sha256').update(JSON.stringify([principal.principalId, input.coordinatorHostId, selection.key])).digest('hex');
      const prepared = await options.prepareSource({ ...selection, resourceOwner: { kind: 'local' }, key }, signal);
      return { ...prepared, source: { ...prepared.source, resourceOwner: selection.resourceOwner,
        tools: selected.tools.map(tool => tool.name) } };
    },
    async bind(principal, input, signal) {
      requireReadPrincipal(principal, input.coordinatorHostId);
      const source = selectedSource(input);
      if (input.purpose === 'external_harness' && (input.scope.kind !== 'external' || input.retention !== 'caller' || input.operationId !== input.scope.transportId)) throw new SourceAdmissionError('source_authority_denied');
      const resultOnly = input.purpose === 'result';
      if (input.purpose === 'mcp_owner' && (input.scope.kind !== 'run' || input.retention !== 'run' || input.operationId))
        throw new SourceAdmissionError('source_authority_denied');
      if (['process_view', 'script_environment'].includes(input.purpose) && (input.scope.kind !== 'run' || input.retention !== 'caller' || !input.operationId))
        throw new SourceAdmissionError('source_authority_denied');
      if (['script_environment', 'mcp_owner', 'external_harness'].includes(input.purpose) && (source.mode === 'fixed_branch'
        || !['terminal:use', 'process:control'].every(capability => principal.capabilities.includes(capability)))) throw new SourceAdmissionError('source_authority_denied');
      await registration(source, signal,resultOnly);
      const selected = await capabilities(principal, { coordinatorHostId: input.coordinatorHostId, mode: source.mode,
        enabledTools: input.scope.kind === 'source_read' || input.scope.kind === 'external' || resultOnly || input.purpose === 'mcp_owner' ? [] : input.source.tools }, signal);
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
        ...(input.scope.kind === 'external' ? {externalTransportId:input.scope.transportId} : {}),
        threadId: input.scope.kind === 'external' ? input.scope.conversationId : input.scope.threadId, ...(input.scope.kind === 'run' ? { runId: input.scope.runId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        capabilities: [...new Set([...selected.grantCapabilities, ...(source.mode === 'live_root' && options.deviceFileAccess !== false && !principal.allowedDirectories?.length ? ['filesystem.device'] : []), ...(integration ? ['recovery'] : []),
          ...(resultOnly ? ['storage.write'] : []), ...(['script_environment', 'mcp_owner', 'external_harness'].includes(input.purpose) ? ['process'] : [])])], pathScopes: [''] }, signal);
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
        const handedPhysical = input.handoff && (input.handoff.root.kind === 'physical'||input.handoff.root.kind==='derived') ? input.handoff.root.root : null;
        let physicalRoot = opened.physicalRoot ?? handedPhysical;
        const branch = resultOnly || source.mode === 'live_root' || source.mode==='native_workspace' || handedPhysical ? undefined
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
        } else if (source.mode === 'materialized' && (input.scope.kind === 'run' || source.environment_run_id) && !resultOnly) {
          const environmentRun = source.environment_run_id ?? (input.scope.kind === 'run' ? input.scope.runId : null);
          if (!environmentRun) throw new SourceAdmissionError('source_environment_unavailable');
          const handshake = kernel.handshake ?? await kernel.start();
          const location = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, environmentRun);
          const previous = await actor.getOperation(opened.materializationOperationId, signal);
          if (input.scope.kind === 'run' && !input.deferMaterialization && (!previous || previous.state !== 'committed')) {
            const container = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
              canonicalRoot: location.storageRoot }, signal);
            if (typeof container.rootId !== 'string') throw new SourceAdmissionError('source_environment_unavailable');
            const receipt = await actor.fileMaterialize({ operationId: opened.materializationOperationId, workspaceId: source.workspace_id,
              rootId: container.rootId, path: location.relativeTarget, sourceRoot: branch!.root }, signal);
            if (receipt.status !== 'materialized') throw new SourceAdmissionError('source_environment_unavailable');
          }
          const materialized = await actor.getOperation(opened.materializationOperationId, signal);
          if (materialized?.state === 'committed' && (materialized.result as { status?: unknown })?.status === 'materialized') {
          const canonicalRoot = await admitMaterializedRoot(location.targetPath, signal);
          const registered = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot }, signal);
          if (typeof registered.rootId !== 'string') throw new SourceAdmissionError('source_environment_unavailable');
          physicalRoot = { hostId: options.hostId, rootId: registered.rootId, canonicalRoot };
          if (opened.physicalRoot && !isDeepStrictEqual(opened.physicalRoot, physicalRoot)) throw new SourceAdmissionError('source_changed');
          } else if (input.scope.kind === 'run' && !input.deferMaterialization) throw new SourceAdmissionError('source_environment_unavailable');
        }
        let native:Awaited<ReturnType<NonNullable<KernelClient['nativeWorkspaces']>['acquire']>>|undefined;
        if(source.mode==='native_workspace'&&!resultOnly){
          if(!kernel.nativeWorkspaces)throw new SourceAdmissionError('source_unavailable');
          native=await kernel.nativeWorkspaces.acquire(source,kernel.sourceAuthorityGrant(opened),signal);
          physicalRoot={hostId:options.hostId,rootId:native.rootId,canonicalRoot:native.path};
        }
        const fixed = { branchId: source.branch_id!, revision: source.revision! };
        const textEncoding = opened.toolBinding?.textEncoding ?? (input.scope.kind !== 'run' || resultOnly
          ? undefined : await resolveSourceTextPolicy(kernel, actor, source, physicalRoot, signal));
        const toolBinding: SourceToolBinding | null = input.scope.kind !== 'run' ? null : {
          ...(textEncoding ? { textEncoding } : {}),
          executionEnvironment: await (options.executionEnvironment?.() ?? defaultExecutionEnvironment.snapshot()),
          resourceOwner: source.resource_owner, grantId: opened.grantId, runId: input.scope.runId, threadId: input.scope.threadId,
          workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, sourceMode: source.mode,
          enabledTools: selected.tools.map(tool => tool.name), ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}),
          ...(source.mode === 'fixed_branch' ? { fileSource: fixed } : source.mode === 'live_root'
            ? { ...(physicalRoot ? { rootId: physicalRoot.rootId } : {}), liveRoot: source.live_root! }
            : source.mode==='native_workspace'?{nativeWorkspace:native?.address??{branchId:source.branch_id!,...(source.native_scope?{sourcePath:source.native_scope}:{})},...(native?{rootId:native.rootId,liveRoot:physicalRoot!}:{})}
            : { ...(physicalRoot ? { rootId: physicalRoot.rootId } : {}), materializedSource: fixed }),
        };
        await registration(source, signal,resultOnly);
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
      if (['attachment_cleanup', 'attachment_discard'].includes(input.operation.kind) && !principal.capabilities.includes('filesystem:write')) throw new SourceAdmissionError('source_authority_denied');
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
        if (authority.purpose === 'result' && !['validate', 'attachment_recover', 'attachment_describe', 'attachment_read', 'attachment_release', 'attachment_cleanup', 'attachment_discard', 'child_result_read', 'child_result_publish', 'child_release', 'native_resource'].includes(operation.kind))
          throw new SourceAdmissionError('source_authority_denied');
        if (authority.purpose === 'result' && operation.kind === 'native_resource' && operation.action.kind !== 'child_storage_receipt')
          throw new SourceAdmissionError('source_authority_denied');
        if (operation.kind === 'attachment_recover' && (authority.purpose !== 'result' || authority.scope.kind !== 'run')) throw new SourceAdmissionError('source_authority_denied');
        if (['attachment_cleanup', 'attachment_discard'].includes(operation.kind) && (authority.purpose !== 'result' || authority.scope.kind !== 'run')) throw new SourceAdmissionError('source_authority_denied');
        if (operation.kind === 'attachment_capture' || operation.kind === 'attachment_discard') {
          const identity: AttachmentCapture = { principalId: principal.principalId, coordinatorHostId: input.coordinatorHostId,
            scope: structuredClone(authority.scope), source: structuredClone(authority.source),
            operationId: operation.operationId, ref: operation.ref, path: operation.path };
          const fenced = captureFences.some(value => isDeepStrictEqual(value, identity));
          if (operation.kind === 'attachment_capture') {
            if (fenced) throw new Error('Original attachment capture is closed for cleanup');
            services.get(key)!.attachmentCapture = identity;
          } else {
            const originals = [...services.values()].filter(flight => isDeepStrictEqual(flight.attachmentCapture, identity));
            // Fence before waiting, so a delayed admission cannot create a new
            // writer between this check and the exact intent's withdrawal.
            if (!fenced) captureFences.push(identity);
            for (const flight of originals) flight.controller.abort();
            if (!originals.length || (await Promise.all(originals.map(flight => flight.drain))).some(status => status !== 'drained'))
              throw new Error('Original attachment capture cleanup is pending: its writer termination is unconfirmed');
          }
        }
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
            if (scope.source.mode === 'materialized' && !scope.physicalRoot && scope.scope.kind === 'run' && authority.purpose !== 'result') {
              const actor = kernel.scoped(scope.grant);
              const location = await originalMaterializationLocation(kernel.handshake!.storageRoot, scope.source.workspace_id,
                scope.source.environment_run_id ?? scope.scope.runId);
              const operationId = `source-materialize:${location.key}`;
              let materialized = await actor.getOperation(operationId, controller.signal);
              const needsPhysical = ['binary_write', 'code_capture', 'code_apply', 'external_code_apply', 'integration', 'user_integration',
                'package_capture', 'experiment_admit', 'experiment_capture', 'attachment_capture'].includes(operation.kind)
                || operation.kind === 'language' && operation.query.method !== 'structure';
              if (needsPhysical && (!materialized || materialized.state !== 'committed')) {
                const branch = await actor.readBranch({ branchId: scope.source.branch_id!, revision: scope.source.revision!, includeEntries: false }, controller.signal);
                const container = await actor.fileRootRegister({workspaceId:scope.source.workspace_id,executionWorkspaceId:scope.source.execution_workspace_id,canonicalRoot:location.storageRoot},controller.signal);
                await actor.fileMaterialize({workspaceId:scope.source.workspace_id,rootId:String(container.rootId),operationId,path:location.relativeTarget,sourceRoot:branch.root},controller.signal);
                materialized=await actor.getOperation(operationId,controller.signal);
              }
              if (materialized?.state === 'committed' && (materialized.result as {status?:unknown})?.status === 'materialized') {
                const canonicalRoot=await admitMaterializedRoot(location.targetPath,controller.signal);
                const registered=await actor.fileRootRegister({workspaceId:scope.source.workspace_id,executionWorkspaceId:scope.source.execution_workspace_id,canonicalRoot},controller.signal);
                scope.physicalRoot={hostId:options.hostId,rootId:String(registered.rootId),canonicalRoot};
                if(authority.toolBinding) await kernel.sourceRequest('source.authority.bind',{
                  ...address(principal,input), toolBinding:{...authority.toolBinding,rootId:scope.physicalRoot.rootId},physicalRoot:scope.physicalRoot},controller.signal);
              }
            }
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
      if (!retained && authority.purpose === 'source' && ['retired', 'revoked'].includes(result.phase)) await attachments.cleanup(cleanupScope(principal, input.coordinatorHostId, authority));
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
          mode: authority.source.mode, enabledTools: authority.toolBinding?.enabledTools ?? [],
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
        const released = result.released.find(item => item.authorityId === authority.authorityId)!;
        if (authority.purpose === 'source' && !result.pendingAuthorities.includes(authority.authorityId) && ['retired', 'revoked'].includes(released.phase))
          await attachments.cleanup(cleanupScope(principal, input.coordinatorHostId, authority));
        closing.delete(authorityKey(principal, { coordinatorHostId: input.coordinatorHostId,
          authorityId: authority.authorityId, resourceEpoch: authority.resourceEpoch }));
      }
      return { released: result.released.map(projectRelease), pendingAuthorities: result.pendingAuthorities };
    },
  };
}
