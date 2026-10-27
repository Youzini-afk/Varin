/** Reuses Storage's admitted handoff, immutable baseline and materializer. */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from '../kernel/storage-adapter.js';
import { prepareDispatchSourceStore } from '../kernel/child-source-store.js';
import { originalMaterializationLocation, admitMaterializedRoot } from '../kernel/source-launch.js';
import type { ExternalChild } from '../kernel/protocol.generated.js';
import type { StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import { record, text } from './transport.js';
import { createPhysicalSourceCapture } from '../kernel/child-source-capture.js';

export function createExternalSourceOwner(deps: {
  kernel: KernelClient;
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
  ) => {
    const handoff = child.handoff;
    if (!handoff) throw new Error('External delegate has no source handoff');
    if (handoff.source.resource_owner.kind !== 'local')
      throw new Error('Run this external Agent on the Host that owns the selected source');
    await deps.capture.documents.admitWorkspaceRegistration(handoff.source.workspace_id, signal);
    if (handoff.source.execution_workspace_id !== handoff.source.workspace_id)
      await deps.capture.documents.admitWorkspaceRegistration(handoff.source.execution_workspace_id, signal);
    const grant = await deps.kernel.claimChildSource(
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
  const prepare = async (child: ExternalChild, signal: AbortSignal) => {
    const saved = record(child.source);
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
    });
  };
  // Retain an isolated baseline while its conversation owns the editable copy. Only the
  // original temporary handoff pin is released after execution; result/recovery uses baseline.
  const release = (child: ExternalChild, signal: AbortSignal) =>
    withSource(child, signal, async (_store, grant) => {
      const root = child.handoff!.root;
      if (root.kind === 'fixed' || root.kind === 'derived')
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
    });
  const remove = async (child: ExternalChild, unstarted = false) => {
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
