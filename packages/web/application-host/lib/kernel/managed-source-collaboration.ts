import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ChildSourceHandoff, DelegatedExecution, LaunchSource, UnacceptedChildSourcePin } from './protocol.generated.js';
import { sourceToolSchemas, savedSourceLaunch } from './source-launch.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import { captureContinuationStage, prepareChildSourceStore, prepareContinuationSourceStore, prepareRefreshedContinuationSourceStore, releaseRefreshScratch, type ChildSourcePreparation } from './child-source-store.js';
import type { StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceAddress, ManagedSourceLocalScope, ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';

type ChildSourcePinCleanup = UnacceptedChildSourcePin & { operation_id:string;parent_run_id:string;parent_thread_id:string };

function childPreparationSource(child: DelegatedExecution): LaunchSource {
  if (child.trigger.kind !== 'dispatch') {
    if (!child.source_basis) throw new Error('Continuation source is unavailable');
    return child.source_basis.source;
  }
  const source = child.source;
  if (!source || source.kind === 'absent' || !source.handoff) throw new Error('Original child source handoff is unavailable');
  return source.handoff.source;
}

function validateUnacceptedHandoff(source: ChildSourcePinCleanup, handoff: ChildSourceHandoff): void {
  if (handoff.operation_id !== `child-source-handoff:${source.operation_id}` || !isDeepStrictEqual(handoff.source, source.source)
    || handoff.root.kind !== 'fixed' || handoff.root.pin.pin_id !== source.pin_id
    || source.pin_id !== `child-pin:${source.operation_id}`) {
    throw new Error('Unaccepted child source differs from its original handoff');
  }
}

/** The coordinator only retains target addresses. It never treats target grants or
 * content hashes as authority in its own Storage. */
export async function withManagedChildSource<T>(
  runtime: AgentRuntimeClient,
  child: DelegatedExecution,
  signal: AbortSignal,
  consume: (service: ManagedSourceClient, address: ManagedSourceAddress) => Promise<T>,
): Promise<T> {
  const source = childPreparationSource(child);
  if (source.resource_owner.kind !== 'managed_host') throw new Error('Child does not have a managed source');
  const service = await runtime.managedSource(source.resource_owner, signal);
  if (child.source_basis?.kind === 'refreshed' && !child.source) {
    const incoming = child.source_basis.incoming;
    const run = await runtime.run(incoming.run_id, signal);
    const launch = await runtime.launch(run.id, signal);
    if (!launch) throw new Error('Selected Agent launch is unavailable');
    const fixed=incoming.source.mode==='fixed_branch';
    if (!fixed && !isDeepStrictEqual(launch.selection.source,incoming.source)) throw new Error('Selected Agent source changed');
    const { runId: _incomingRun, ...selected } = savedSourceLaunch(run.id, incoming.source, sourceToolSchemas(launch.selection).map(t => t.name));
    const bound = await service.bind({ coordinatorHostId: runtime.coordinatorHostId,
      scope: fixed?{kind:'source_read',threadId:run.thread_id,branchId:run.branch_id,key:`child-refresh:${child.execution_id}`}
        :{ kind: 'run', threadId: run.thread_id, runId: run.id, epoch: run.epoch },
      source: { ...selected, tools: [...selected.tools] }, purpose: fixed?'read':'source', retention: fixed?'caller':'run' }, signal);
    const incomingAddress = { coordinatorHostId: runtime.coordinatorHostId, authorityId: bound.authorityId, resourceEpoch: bound.resourceEpoch };
    try { await service.service({ ...incomingAddress, requestId: randomUUID(), operation: { kind: 'child_refresh_capture', execution: child } }, signal); }
    finally { await service.release({ ...incomingAddress, mode: 'retire' }); }
  }
  const selection = savedSourceLaunch(child.parent_run_id, source, sourceToolSchemas(child.launch).map(tool => tool.name));
  const { runId: _run, ...preparedSource } = selection;
  const handoff = child.source && child.source.kind !== 'absent' ? child.source.handoff : null;
  if (child.trigger.kind === 'dispatch' && !handoff) throw new Error('Original child handoff is unavailable');
  const binding = await service.bind({ coordinatorHostId: runtime.coordinatorHostId,
    scope: { kind: 'source_read', threadId: child.child_thread_id, branchId: child.child_branch_id, key: `child:${child.execution_id}` },
    source: { ...preparedSource, tools: [...preparedSource.tools] }, purpose: 'read', retention: 'caller',
    ...(child.trigger.kind === 'dispatch' ? { handoff: handoff! }
      : { continuation: { executionId: child.execution_id, previousRunId: child.trigger.previous_run_id, root: child.source_basis!.root,
        ...(child.source_basis?.kind==='refreshed'?{refresh:child.source_basis.incoming}:{}) } }),
  }, signal);
  const address = { coordinatorHostId: runtime.coordinatorHostId,
    authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  try {
    if (!isDeepStrictEqual(binding.source, source)) throw new Error('Target changed the frozen child source');
    return await consume(service, address);
  } finally {
    await service.release({ ...address, mode: 'retire' });
  }
}

/** A failed dispatch may have persisted its pin before the coordinator accepted its
 * receipt. Read that exact target receipt before releasing the original pin. */
export async function releaseManagedUnacceptedSource(runtime: AgentRuntimeClient, source: ChildSourcePinCleanup,
  signal: AbortSignal): Promise<void> {
  if (source.source.resource_owner.kind !== 'managed_host') throw new Error('Source has no managed owner');
  const service = await runtime.managedSource(source.source.resource_owner, signal);
  const handoff = await service.handoff({ coordinatorHostId: runtime.coordinatorHostId,
    operationId: source.operation_id, parentRunId: source.parent_run_id,
    parentThreadId: source.parent_thread_id, source: source.source }, signal);
  if (!handoff) return;
  validateUnacceptedHandoff(source, handoff);
  const {runId: _run, ...prepared} = savedSourceLaunch(source.parent_run_id, source.source, []);
  const binding = await service.bind({ coordinatorHostId: runtime.coordinatorHostId,
    scope: { kind: 'source_read', threadId: `thread:child:${source.operation_id}`,
      branchId: `branch:child:${source.operation_id}`, key: `child:${source.operation_id}` },
    source: {...prepared, tools: []}, purpose: 'read', retention: 'caller', handoff }, signal);
  const address = {coordinatorHostId: runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch};
  try {
    if (!isDeepStrictEqual(binding.source, source.source)) throw new Error('Target changed the original unaccepted source');
    await service.service({...address, requestId: randomUUID(),
      operation: { kind: 'child_unaccepted_release', source }}, signal);
  } finally { await service.release({...address, mode:'retire'}); }
}

export function createManagedChildSourceService(options: {
  storage: KernelStorageAdapter;
  capture: StableSourcePreparationOwners;
}): ManagedSourceServiceHandler {
  const context = (scope: ManagedSourceLocalScope) => options.storage.contextFromBranchGrant({
    grant: scope.grant, owningWorkspaceId: scope.source.workspace_id,
    executionWorkspaceId: scope.source.execution_workspace_id,
  });
  return async (scope, operation, suppliedSignal) => {
    const signal = suppliedSignal ?? new AbortController().signal;
    if (operation.kind === 'child_refresh_capture') {
      const child = operation.execution, basis = child.source_basis;
      if (basis?.kind !== 'refreshed' || !isDeepStrictEqual(scope.source, basis.incoming.source)
        || !(scope.scope.kind==='run' && scope.scope.runId===basis.incoming.run_id
          || scope.scope.kind==='source_read' && scope.scope.key===`child-refresh:${child.execution_id}`)) throw new Error('Incoming stage differs from its admitted source');
      // Capturing a read source writes an immutable Storage snapshot, not files
      // in that source. Its short-lived writer belongs to this preparation.
      const grant=await options.storage.client.issueGrant({grantId:`child-stage:${randomUUID()}`,
        owningWorkspace:scope.source.workspace_id,executionWorkspace:scope.source.execution_workspace_id,
        threadId:child.child_thread_id,capabilities:['storage.read','storage.write'],pathScopes:['']},signal);
      try {
        const store = new KernelWorkingStateRootStore(await options.storage.contextFromBranchGrant({grant,
          owningWorkspaceId:scope.source.workspace_id,executionWorkspaceId:scope.source.execution_workspace_id}));
        await captureContinuationStage(child, { store, capture: options.capture,
          physical: async root => new KernelWorkingStateRootStore(await options.storage.contextFromSourceGrant({
            grant, owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id,
            rootId: root.rootId, canonicalRoot: root.canonicalRoot })) }, scope.source, scope.physicalRoot ?? undefined, signal);
        return { captured: true };
      } finally {await options.storage.client.retireGrant(grant.grantId);}
    }
    if (operation.kind === 'child_unaccepted_release') {
      const source = operation.source;
      if (!isDeepStrictEqual(scope.source, source.source) || scope.scope.kind !== 'source_read'
        || scope.scope.threadId !== `thread:child:${source.operation_id}`
        || scope.scope.branchId !== `branch:child:${source.operation_id}`
        || scope.scope.key !== `child:${source.operation_id}` || !source.source.branch_id) {
        throw new Error('Unaccepted child release differs from its admitted source');
      }
      const handoff = await options.storage.client.sourceRequest<ChildSourceHandoff | null>('source.authority.handoff', {
        principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
        operationId: source.operation_id, parentRunId: source.parent_run_id,
        parentThreadId: source.parent_thread_id, source: source.source,
      }, signal);
      if (!handoff) throw new Error('Original unaccepted child handoff is unavailable');
      validateUnacceptedHandoff(source, handoff);
      const store = new KernelWorkingStateRootStore(await context(scope));
      await store.releaseBranchHandoffPin(source.source.branch_id, source.pin_id);
      return { released: true };
    }
    if (operation.kind === 'child_prepare') {
      const source = childPreparationSource(operation.execution);
      if (!isDeepStrictEqual(scope.source, source)) throw new Error('Child preparation differs from its admitted source');
      const store = new KernelWorkingStateRootStore(await context(scope));
      if (operation.execution.trigger.kind !== 'dispatch') {
        const child = operation.execution, basis = child.source_basis;
        if (basis?.kind === 'refreshed') {
          return prepareRefreshedContinuationSourceStore(child, store, signal);
        }
        if (!basis || !basis.source.branch_id || basis.source.revision === null) throw new Error('Continuation source is unavailable');
        const pin = await store.openBranchHandoffPin(basis.source.branch_id, `child-pin:${child.execution_id}`,
          {root:basis.root,revision:basis.source.revision,writeRevision:basis.source.revision},signal);
        return prepareContinuationSourceStore(child, store, signal, pin);
      }
      return prepareChildSourceStore(operation.execution, { store, capture: options.capture,
        physical: async root => {
          if (!scope.physicalRoot || !isDeepStrictEqual(scope.physicalRoot, { ...root, hostId: scope.physicalRoot.hostId })) {
            throw new Error('Child physical handoff differs from its admitted target');
          }
          return new KernelWorkingStateRootStore(await options.storage.contextFromSourceGrant({
            grant: scope.grant, owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
            rootId: root.rootId, canonicalRoot: root.canonicalRoot,
          }));
        },
      }, signal);
    }
    if (operation.kind === 'child_result_read' || operation.kind === 'child_result_prepare' || operation.kind === 'child_result_publish') {
      const child = operation.execution;
      if (child.source?.kind !== 'ready' || !child.receipt || !isDeepStrictEqual(scope.source, child.source.selection)
        || scope.scope.kind !== 'run' || scope.scope.runId !== child.receipt.run_id) {
        throw new Error('Result publication differs from its original child Run');
      }
      const branchId = scope.source.branch_id;
      if (!branchId || !['materialized','fixed_branch'].includes(scope.source.mode)) throw new Error('Child result has no private working source');
      const publicationId = `child-result:${child.execution_id}`;
      const store = new KernelWorkingStateRootStore(await context(scope));
      if (operation.kind === 'child_result_read') return store.readResultCandidate(branchId, publicationId, { signal });
      if (operation.kind === 'child_result_publish') {
        if (child.code_result.kind !== 'candidate') throw new Error('Child has no accepted result candidate');
        return store.publishPreparedResult(publicationId, child.code_result.candidate, { signal });
      }
      let executionRoot=scope.physicalRoot;
      if (scope.source.mode==='fixed_branch') {
        const view=await options.storage.client.scoped(scope.grant).executionViewInspect({workspaceId:scope.source.workspace_id,branchId,revision:scope.source.revision!},signal);
        if (view?.status!=='ready') throw new Error('The original child execution view is unavailable');
        executionRoot={hostId:scope.physicalRoot?.hostId ?? '',rootId:view.rootId,canonicalRoot:view.canonicalRoot};
      }
      if (child.code_result.kind !== 'settling' || !executionRoot) throw new Error('Child result capture has no settled physical source');
      const physical = new KernelWorkingStateRootStore(await options.storage.contextFromSourceGrant({
        grant: scope.grant, owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id,
        rootId: executionRoot.rootId, canonicalRoot: executionRoot.canonicalRoot,
      }));
      return physical.prepareResultCandidate({ publicationId, branchId,
        source: { kind: 'directory', directory: executionRoot.canonicalRoot }, signal });
    }
    if (operation.kind === 'child_release') {
      const child = operation.execution;
      if (!isDeepStrictEqual(scope.source, childPreparationSource(child))) throw new Error('Child release differs from its original source');
      const store = new KernelWorkingStateRootStore(await context(scope));
      if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
      const handoff = child.source?.kind === 'pending' || child.source?.kind === 'ready' ? child.source.handoff : null;
      if (child.trigger.kind === 'dispatch' && (handoff?.root.kind === 'fixed' || handoff?.root.kind === 'derived')) {
        await store.releaseBranchHandoffPin(handoff.root.pin.source.branch_id!, handoff.root.pin.pin_id);
      }
      if (child.trigger.kind !== 'dispatch' && child.source_basis) {
        await store.releaseBranchHandoffPin(child.source_basis.source.branch_id!, `child-pin:${child.execution_id}`);
      }
      if (child.source_basis?.kind === 'refreshed') {
        await releaseRefreshScratch(child,store);
      }
      if (!child.receipt) {
        const branchId = `child-source:${child.execution_id}`;
        const branch = await store.getBranchRoot(branchId);
        if (branch) {
          if (child.source_basis && child.source_basis.kind !== 'refreshed' && branch.baseRoot !== child.source_basis.root) throw new Error('Unused continuation source identity changed');
          await store.releaseBranchHandoffPin(branchId, `child-source-pin:${child.execution_id}`);
          await store.deleteBranch(branchId);
        }
      }
      return { released: true };
    }
    throw new Error(`Unsupported child source service: ${operation.kind}`);
  };
}

export type { ChildSourcePreparation };
