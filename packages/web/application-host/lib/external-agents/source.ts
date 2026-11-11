/** Reuses Storage's admitted handoff, immutable baseline and materializer. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stat } from 'node:fs/promises';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from '../kernel/storage-adapter.js';
import { prepareDispatchSourceStore } from '../kernel/child-source-store.js';
import { originalMaterializationLocation, admitMaterializedRoot } from '../kernel/source-launch.js';
import type { ExternalChild, LaunchSource } from '../kernel/protocol.generated.js';
import type { StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import { record, text } from './transport.js';
import { createPhysicalSourceCapture } from '../kernel/child-source-capture.js';
import { requireNativeWorkspaceBackend } from '../kernel/native-workspaces.js';

export interface ManagedChildSourceAuthority { principalId: string; coordinatorHostId: string }

export interface ExternalPreparedSource {cwd:string;workspaceId:string;executionWorkspaceId:string;[key:string]:unknown}

export function createExternalSourceOwner(deps: {
  kernel: KernelClient;
  managed?: import('./managed-transport.js').ManagedExternalOwner;
  prepareProjectSource?: import('../kernel/child-project-source.js').ChildProjectSourcePreparer;
  storage: KernelStorageAdapter;
  capture: StableSourcePreparationOwners & {
    documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'>;
  };
}) {
  const capture = createPhysicalSourceCapture(deps.kernel, deps.storage, deps.capture);
  const withSource = async <T>(
    child: ExternalChild,
    signal: AbortSignal,
    run: (
      store: KernelWorkingStateRootStore,
      grant: Awaited<ReturnType<KernelClient['claimChildSource']>>,
    ) => Promise<T>,
    managedAuthority?: ManagedChildSourceAuthority,
  ) => {
    const handoff = child.handoff;
    if (!handoff) throw new Error('External delegate has no source handoff');
    if (handoff.source.resource_owner.kind !== 'local' && handoff.source.resource_owner.hostId !== deps.kernel.handshake?.hostId)
      throw new Error('Run this external Agent on the Host that owns the selected source');
    await deps.capture.documents.admitWorkspaceRegistration(handoff.source.workspace_id, signal);
    if (handoff.source.execution_workspace_id !== handoff.source.workspace_id)
      await deps.capture.documents.admitWorkspaceRegistration(handoff.source.execution_workspace_id, signal);
    const grant = managedAuthority ? await deps.kernel.claimManagedChildSource({
      ...managedAuthority,
      grantId: `external-source:${randomUUID()}`,
      scope: { kind: 'external_child', conversationId: child.conversation_id, operationId: child.dispatch_operation_id ?? child.operation_id },
      source: handoff.source, handoff,
    }, signal) : await deps.kernel.claimChildSource(
      {
        handoffOperationId: handoff.operation_id,
        grantId: `external-source:${randomUUID()}`,
        childThreadId: child.conversation_id,
        childBranchId: `external-source:${child.operation_id}`,
      },
      signal,
    );
    try {
      return await run(
        new KernelWorkingStateRootStore(
          await deps.storage.contextFromBranchGrant({
            grant,
            owningWorkspaceId: handoff.source.workspace_id,
            executionWorkspaceId: handoff.source.execution_workspace_id,
          }),
        ),
        grant,
      );
    } finally {
      await deps.kernel.revokeGrant(grant.grantId);
    }
  };
  const remoteHandoff = (child:ExternalChild) => child.handoff?.source.resource_owner.kind==='managed_host'
    && child.handoff.source.resource_owner.hostId!==deps.kernel.handshake?.hostId ? child.handoff.source.resource_owner : null;
  const remoteCommand = async(child:ExternalChild,action:'prepare'|'release'|'remove',signal?:AbortSignal,unstarted=false)=>{
    const owner=remoteHandoff(child);if(!owner||!deps.managed)throw new Error('Original external child source owner is unavailable');
    const client=await deps.managed.source(owner,signal);
    return client.externalChildSource({coordinatorHostId:deps.managed.coordinatorHostId,action,child,...(unstarted?{unstarted}:{})},signal);
  };
  const prepare = async (child: ExternalChild, signal: AbortSignal, managedAuthority?: ManagedChildSourceAuthority):Promise<ExternalPreparedSource> => {
    if(!child.project_source&&remoteHandoff(child)) {
      const result=await remoteCommand(child,'prepare',signal);
      if(result.status!=='prepared')throw new Error('Original external source preparation is unavailable');
      return result.source;
    }
    const saved = record(child.source);
    if (child.project_source?.kind === 'project') {
      if (!deps.prepareProjectSource) throw new Error('Registered project source preparation is unavailable');
      const prepared = await deps.prepareProjectSource(child.project_source.project,
        { runtime:'agent',threadId:child.parent_thread_id,branchId:child.parent_branch_id },
        'external-project:'+(child.dispatch_operation_id ?? child.operation_id),child.work_mode,child.project_source.source_path,signal);
      const source=prepared.source;
      let baseline: unknown;
      if (child.work_mode === 'isolated_write') {
        if (source.mode !== 'native_workspace' || !source.branchId || !prepared.provenance) throw new Error('Independent project source is incomplete');
        if(source.resourceOwner.kind==='managed_host') {
          if(!deps.managed)throw new Error('Original managed project source owner is unavailable');
          const selected:LaunchSource={resource_owner:source.resourceOwner,workspace_id:source.workspaceId,
            execution_workspace_id:source.executionWorkspaceId,mode:source.mode,branch_id:source.branchId,revision:null,live_root:null};
          const client=await deps.managed.source(source.resourceOwner,signal);
          const result=await client.externalProjectSource({coordinatorHostId:deps.managed.coordinatorHostId,action:'baseline',
            identity:{runtime:'agent',threadId:child.parent_thread_id,branchId:child.parent_branch_id},
            key:'external-project:'+(child.dispatch_operation_id??child.operation_id),source:selected},signal);
          if(result.status!=='baseline'||!isDeepStrictEqual(result.baseline.source,selected))throw new Error('Original managed project baseline changed');
          baseline=result.baseline;
        } else {
        const grant=await deps.kernel.issueGrant({grantId:`external-project-pin:${randomUUID()}`,threadId:child.parent_thread_id,
          owningWorkspace:source.workspaceId,executionWorkspace:source.executionWorkspaceId,capabilities:['storage.read','storage.write','storage.maintenance'],pathScopes:['']},signal);
        try {
          const store=new KernelWorkingStateRootStore(await deps.storage.contextFromBranchGrant({grant,owningWorkspaceId:source.workspaceId,executionWorkspaceId:source.executionWorkspaceId}));
          const pin=await store.pinBranchHandoff!(source.branchId,`external-project-pin:${child.dispatch_operation_id??child.operation_id}`,{revision:0,signal});
          const selected:LaunchSource={resource_owner:source.resourceOwner,workspace_id:source.workspaceId,execution_workspace_id:source.executionWorkspaceId,
            mode:source.mode,branch_id:source.branchId,revision:null,live_root:null};
          baseline={source:selected,pin:{pin_id:pin.pinId,root:pin.root,source:{...selected,mode:'fixed_branch',revision:0}},provenance:prepared.provenance};
        } finally { await deps.kernel.revokeGrant(grant.grantId); }
        }
      }
      return { cwd:prepared.path,workspaceId:source.workspaceId,executionWorkspaceId:source.executionWorkspaceId,
        kind:child.work_mode==='isolated_write'?'isolated' as const:'shared' as const,
        ...(source.mode==='native_workspace'?{nativeSource:{resource_owner:source.resourceOwner,workspace_id:source.workspaceId,
          execution_workspace_id:source.executionWorkspaceId,mode:source.mode,branch_id:source.branchId,revision:null,live_root:null,...(source.nativeScope?{native_scope:source.nativeScope}:{})}}:{}),
        projectSource:source,provenance:prepared.provenance,...(baseline?{baseline}:{}) };
    }
    const native=record(saved.nativeSource);
    const nativeView=async(source:LaunchSource,baseline?:unknown)=>{
      const owner=deps.kernel.nativeWorkspaces;if(!owner)throw new Error('Native external source is unavailable');
      const entry=await owner.open(source,signal),view=await owner.acquire(source,entry.grant,signal);
      await deps.capture.documents.admitWorkspaceRegistration(source.execution_workspace_id,signal);
      return {...saved,cwd:view.path,workspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id,
        kind:child.work_mode==='shared'?'shared' as const:'isolated' as const,nativeSource:source,...(baseline?{baseline}:{})};
    };
    if(native.mode==='native_workspace'){
      const reference=native as unknown as LaunchSource;
      if(reference.workspace_id!==child.handoff?.source.workspace_id||!reference.branch_id)throw new Error('External workspace identity changed');
      return nativeView(reference);
    }
    if (child.resources_released && text(saved.cwd)) {
      const cwd = await admitMaterializedRoot(text(saved.cwd), signal);
      await deps.capture.documents.admitWorkspaceRegistration(text(saved.workspaceId), signal);
      return {
        ...saved,
        cwd,
        workspaceId: text(saved.workspaceId),
        executionWorkspaceId: text(saved.executionWorkspaceId),
      };
    }
    return withSource(child, signal, async (store, grant) => {
      const handoff = child.handoff!;
      const workspaceId = handoff.source.workspace_id,
        executionWorkspaceId = handoff.source.execution_workspace_id;
      if(child.work_mode==='shared'&&handoff.source.mode==='native_workspace'){
        const scope=[handoff.source.native_scope,handoff.source_path].filter(Boolean).join('/');
        return nativeView({...handoff.source,...(scope?{native_scope:scope}:{})});
      }
      if (
        child.work_mode === 'shared' &&
        (handoff.root.kind === 'physical' || handoff.root.kind === 'derived')
      ) {
        const cwd = await admitMaterializedRoot(handoff.root.root.canonicalRoot, signal);
        return { cwd, workspaceId, executionWorkspaceId, kind: 'shared' as const };
      }
      const existing = record(child.source);
      if (text(existing.cwd)) {
        const cwd = await admitMaterializedRoot(text(existing.cwd), signal);
        return { ...existing, cwd, workspaceId, executionWorkspaceId };
      }
      if (child.work_mode === 'isolated_write') await requireNativeWorkspaceBackend(deps.kernel.scoped(grant), signal);
      if(!managedAuthority&&child.work_mode==='isolated_write'&&deps.kernel.nativeWorkspaces)await deps.kernel.nativeWorkspaces.retainPrepared({...handoff.source,branch_id:`child-source:${child.operation_id}`},child.parent_thread_id,false,signal);
      const prepared = await prepareDispatchSourceStore(
        {
          execution_id: child.operation_id,
          selected_profile: { work_mode: child.work_mode },
          source: { kind: 'pending', handoff },
        },
        {
          store,
          capture: deps.capture,
          capturePhysical: (args) =>
            capture({
              ...args,
              handoff,
              ownerId: child.conversation_id,
              executionId: child.operation_id,
              selectionIdentity: null,
            }),
          physical: async (root) =>
            new KernelWorkingStateRootStore(
              await deps.storage.contextFromSourceGrant({
                grant,
                owningWorkspaceId: workspaceId,
                executionWorkspaceId,
                rootId: root.rootId,
                canonicalRoot: root.canonicalRoot,
              }),
            ),
        },
        signal,
      ).catch((error) => {
        throw new Error(
          `External source capture: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      });
      if(prepared.source.mode==='native_workspace')return nativeView(prepared.source,prepared);
      const handshake = deps.kernel.handshake ?? (await deps.kernel.start());
      const location = await originalMaterializationLocation(
        handshake.storageRoot,
        workspaceId,
        child.conversation_id,
      );
      const actor = deps.kernel.scoped(grant);
      const container = await actor
        .fileRootRegister({ workspaceId, executionWorkspaceId, canonicalRoot: location.storageRoot }, signal)
        .catch((error) => {
          throw new Error(
            `External materialization root: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        });
      const result = await actor
        .fileMaterialize(
          {
            operationId: `external-materialize:${location.key}`,
            workspaceId,
            rootId: String(container.rootId),
            path: location.relativeTarget,
            sourceRoot: prepared.pin.root,
          },
          signal,
        )
        .catch((error) => {
          throw new Error(
            `External source materialization: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        });
      if (result.status !== 'materialized')
        throw new Error('External Agent source materialization requires reconciliation');
      const cwd = await admitMaterializedRoot(location.targetPath, signal);
      return { cwd, workspaceId, executionWorkspaceId, kind: 'isolated' as const, baseline: prepared };
    }, managedAuthority);
  };
  // Retain an isolated baseline while its conversation owns the editable copy. Only the
  // original temporary handoff pin is released after execution; result/recovery uses baseline.
  const release = (child: ExternalChild, signal: AbortSignal, managedAuthority?: ManagedChildSourceAuthority) =>
    child.project_source ? Promise.resolve() : remoteHandoff(child) ? remoteCommand(child,'release',signal).then(result=>{
      if(result.status!=='released')throw new Error('Original external handoff release is unconfirmed');
    }) : withSource(child, signal, async (_store, grant) => {
      const root = child.handoff!.root;
      if (root.kind === 'fixed' || root.kind === 'native' || root.kind === 'derived')
        await deps.kernel
          .scoped(grant)
          .unpinBranch(
            {
              branchId: root.pin.source.branch_id!,
              pinId: root.pin.pin_id,
              operationId: `external-handoff-release:${child.operation_id}`,
            },
            signal,
          );
      if(root.kind==='native')await deps.kernel.scoped(grant).deleteBranch({operationId:`external-handoff-delete:${child.operation_id}`,branchId:root.pin.source.branch_id!},signal);
    }, managedAuthority);
  const remove = async (child: ExternalChild, unstarted = false) => {
    if(!child.project_source&&remoteHandoff(child)) {
      const result=await remoteCommand(child,'remove',undefined,unstarted);
      if(result.status!=='released')throw new Error('Original external source cleanup is unconfirmed');
      return;
    }
    if(child.project_source){
      // Follow-up messages never own deletion of their original dispatch source.
      if(child.dispatch_operation_id)return;
      let prepared=record(record(child.source).projectSource);
      if(!Object.keys(prepared).length && child.work_mode==='isolated_write') {
        // A crash can precede Catalog's child_source receipt but follow the
        // original Source preparation. Recall its exact original key through
        // that owner; never guess a branch or recreate the external baseline pin.
        if(child.project_source.kind!=='project'||!deps.prepareProjectSource)throw new Error('Original project preparation cleanup is unavailable');
        const recalled=await deps.prepareProjectSource(child.project_source.project,
          {runtime:'agent',threadId:child.parent_thread_id,branchId:child.parent_branch_id},
          'external-project:'+child.operation_id,child.work_mode,child.project_source.source_path,new AbortController().signal);
        prepared=record(recalled.source);
      }
      const resourceOwner=record(prepared.resourceOwner);
      if(resourceOwner.kind==='managed_host'&&prepared.mode==='native_workspace'&&child.work_mode==='isolated_write') {
        if(!deps.managed)throw new Error('Original managed project source owner is unavailable');
        const selected:LaunchSource={resource_owner:resourceOwner as unknown as LaunchSource['resource_owner'],
          workspace_id:text(prepared.workspaceId),execution_workspace_id:text(prepared.executionWorkspaceId),
          mode:'native_workspace',branch_id:text(prepared.branchId),revision:null,live_root:null};
        if(selected.resource_owner.kind!=='managed_host')throw new Error('Original managed project owner changed');
        const client=await deps.managed.source(selected.resource_owner);
        const result=await client.externalProjectSource({coordinatorHostId:deps.managed.coordinatorHostId,action:'remove',
          identity:{runtime:'agent',threadId:child.parent_thread_id,branchId:child.parent_branch_id},
          key:'external-project:'+(child.dispatch_operation_id??child.operation_id),source:selected});
        if(result.status!=='removed')throw new Error('Original managed project cleanup is unconfirmed');
        return;
      }
      if(prepared.mode!=='native_workspace'||child.work_mode!=='isolated_write')return;
      if(!deps.kernel.nativeWorkspaces)throw new Error('Native project source is unavailable');
      const source={workspace_id:text(prepared.workspaceId),execution_workspace_id:text(prepared.executionWorkspaceId),branch_id:text(prepared.branchId)};
      await deps.kernel.nativeWorkspaces.releaseSource(source);
      const grant=await deps.kernel.issueGrant({grantId:'external-project-cleanup:'+randomUUID(),owningWorkspace:source.workspace_id,executionWorkspace:source.execution_workspace_id,capabilities:['storage.read','storage.write','storage.maintenance'],pathScopes:['']});
      try{
        const actor=deps.kernel.scoped(grant);
        await actor.unpinBranch({operationId:`external-project-unpin:${child.operation_id}`,branchId:source.branch_id,pinId:`external-project-pin:${child.operation_id}`});
        await actor.deleteBranch({operationId:'external-project-delete:'+child.operation_id,branchId:source.branch_id});
      }
      finally{await deps.kernel.revokeGrant(grant.grantId);}
      return;
    }

    const source = record(child.source);
    if (
      !child.handoff ||
      child.dispatch_operation_id ||
      (source.kind !== 'isolated' &&
        !(
          unstarted &&
          !child.turn_id &&
          (child.work_mode === 'isolated_write' || child.handoff.root.kind === 'fixed')
        ))
    )
      return;
    if (unstarted && child.work_mode === 'isolated_write') {
      // Mount admission can fail before the source is attached to the external
      // conversation. Close that original session before deleting its baseline.
      await deps.kernel.nativeWorkspaces?.releaseSource({ ...child.handoff.source,
        branch_id: `child-source:${child.operation_id}` });
    }
    const native=record(source.nativeSource);
    if(native.mode==='native_workspace'){
      const reference=native as unknown as LaunchSource;
      if(reference.branch_id!==`child-source:${child.operation_id}`||reference.workspace_id!==child.handoff.source.workspace_id)throw new Error('External native cleanup identity changed');
      if(!deps.kernel.nativeWorkspaces)throw new Error('Native external source owner is unavailable');
      await deps.kernel.nativeWorkspaces.releaseSource(reference);
      const grant=await deps.kernel.issueGrant({grantId:`external-cleanup:${randomUUID()}`,owningWorkspace:reference.workspace_id,
        executionWorkspace:reference.execution_workspace_id,capabilities:['storage.read','storage.write','storage.maintenance'],pathScopes:['']});
      try{
        const actor=deps.kernel.scoped(grant);
        await actor.unpinBranch({operationId:`external-baseline-unpin:${child.operation_id}`,branchId:reference.branch_id,pinId:`child-source-pin:${child.operation_id}`});
        // The saved parent and other external conversations may still own this
        // branch. Conversation deletion's original source retirement releases it.
      }finally{await deps.kernel.revokeGrant(grant.grantId);}
      return;
    }
    const workspaceId = child.handoff.source.workspace_id,
      executionWorkspaceId = child.handoff.source.execution_workspace_id;
    const handshake = deps.kernel.handshake ?? (await deps.kernel.start());
    const location = await originalMaterializationLocation(
      handshake.storageRoot,
      workspaceId,
      child.conversation_id,
    );
    if (source.cwd !== undefined && text(source.cwd) !== location.targetPath)
      throw new Error('External source cleanup identity changed');
    if (await stat(location.targetPath).catch(() => null)) await admitMaterializedRoot(location.targetPath);
    const grant = await deps.kernel.issueGrant({
      grantId: `external-cleanup:${randomUUID()}`,
      owningWorkspace: workspaceId,
      executionWorkspace: executionWorkspaceId,
      capabilities: ['storage.read', 'storage.write', 'storage.maintenance'],
      pathScopes: [''],
    });
    try {
      const actor = deps.kernel.scoped(grant);
      const root = await actor.fileRootRegister({
        workspaceId,
        executionWorkspaceId,
        canonicalRoot: location.storageRoot,
      });
      await actor.fileRemove({
        operationId: `external-directory-delete:${location.key}`,
        workspaceId,
        rootId: String(root.rootId),
        path: location.relativeTarget,
        recursive: true,
        force: true,
      });
      const branchId = `child-source:${child.operation_id}`;
      await actor.unpinBranch({
        operationId: `external-baseline-unpin:${child.operation_id}`,
        branchId,
        pinId: `child-source-pin:${child.operation_id}`,
      });
      await actor.deleteBranch({ operationId: `external-baseline-delete:${child.operation_id}`, branchId });
    } finally {
      await deps.kernel.revokeGrant(grant.grantId);
    }
  };
  return { prepare, release, remove };
}
