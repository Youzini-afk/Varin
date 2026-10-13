/** Storage-side child preparation. The caller has already admitted the original source
 * owner; these functions neither create a Catalog Run nor mint a resource grant. */
import type { DelegatedExecution, ChildSourceProvenance, ChildSourcePin, LaunchSource } from './protocol.generated.js';
import type { WorkingStateRootStore, WorkingStatePin } from '../harness/working-state/types.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';

export interface ChildSourcePreparation {
  source: LaunchSource;
  pin: ChildSourcePin;
  provenance: ChildSourceProvenance;
}

export interface ChildSourceStoreOwners {
  store: WorkingStateRootStore;
  capture: StableSourcePreparationOwners;
  /** The original physical handoff, checked by the source owner before opening it. */
  physical(root: { rootId: string; canonicalRoot: string }): Promise<WorkingStateRootStore>;
}

export async function prepareChildSourceStore(
  child: DelegatedExecution,
  owners: ChildSourceStoreOwners,
  signal: AbortSignal,
): Promise<ChildSourcePreparation> {
  if (child.trigger.kind !== 'dispatch') return prepareContinuationSourceStore(child, owners.store, signal);
  const handoff = child.source?.kind === 'pending' || child.source?.kind === 'ready' ? child.source.handoff : null;
  if (!handoff) throw new Error('Dispatch source handoff is unavailable');
  const sourceBranch = `child-source:${child.execution_id}`;
  const workspace = handoff.source.workspace_id;
  let store = owners.store;
  let provenance: ChildSourceProvenance;
  if (handoff.root.kind === 'fixed') {
    const fixed = handoff.root.pin;
    if (!fixed.source.branch_id || fixed.source.revision === null) throw new Error('Fixed child source has incomplete identity');
    if (!store.openBranchHandoffPin) throw new Error('Durable source handoff is unavailable');
    const pin = await store.openBranchHandoffPin(fixed.source.branch_id, fixed.pin_id,
      { root: fixed.root, revision: fixed.source.revision, writeRevision: fixed.source.revision }, signal);
    const original = await store.readOriginalSource(fixed.source.branch_id, { signal });
    provenance = { consistency: 'fixed-root', root: fixed.root, ...(original?.provenance.resources ? { resources: original.provenance.resources } : {}) };
    const branch = await store.createBranchFromPin(workspace, sourceBranch, pin,
      `${fixed.source.branch_id}@${fixed.source.revision}`, undefined, [], { sourceProvenance: provenance });
    if (branch.baseRoot !== fixed.root) throw new Error('Child source root changed');
  } else {
    const restored = await store.readSourcePreparation(sourceBranch, { signal });
    if (restored) provenance = restored.provenance;
    else {
      const physical = handoff.root.root;
      const resolved = await owners.capture.documents.resolveWorkspace({ path: physical.canonicalRoot });
      if ((await owners.capture.documents.inspectWorkspace(resolved.workspaceId)).root !== physical.canonicalRoot) {
        throw new Error('Child source Documents authority changed');
      }
      store = await owners.physical(physical);
      const captured = await captureStableSourceBaseline({ store, workspaceId: workspace,
        captureWorkspaceId: resolved.workspaceId, branchId: sourceBranch, directory: physical.canonicalRoot,
        captureScopes: [], content: { mode: 'saved-files' }, signal }, owners.capture);
      provenance = captured.provenance;
    }
  }
  if (!store.pinBranchHandoff) throw new Error('Durable source pin is unavailable');
  const pin = await store.pinBranchHandoff(sourceBranch, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
  signal.throwIfAborted();
  const source: LaunchSource = { resource_owner: handoff.source.resource_owner,
    mode: child.code_result.kind === 'no_changes' ? 'fixed_branch' : 'materialized', live_root: null,
    workspace_id: workspace, execution_workspace_id: handoff.source.execution_workspace_id,
    branch_id: sourceBranch, revision: 0 };
  return { source, pin: { pin_id: pin.pinId, root: pin.root, source: { ...source, mode: 'fixed_branch' } }, provenance };
}

export async function prepareContinuationSourceStore(
  child: DelegatedExecution,
  store: WorkingStateRootStore,
  signal: AbortSignal,
  handoffPin?: WorkingStatePin,
): Promise<ChildSourcePreparation> {
  const basis = child.source_basis;
  if (!basis || basis.source.branch_id === null || basis.source.revision === null) throw new Error('Continuation has no exact immutable source');
  if (!store.pinBranchHandoff) throw new Error('Durable source pin is unavailable');
  const pin = handoffPin ?? await store.pinBranch(basis.source.branch_id, { revision: basis.source.revision, signal });
  try {
    if (pin.root !== basis.root) throw new Error('Continuation source root changed');
    signal.throwIfAborted();
    const branchId = `child-source:${child.execution_id}`;
    const branch = await store.createBranchFromPin(basis.source.workspace_id, branchId, pin,
      `${basis.source.branch_id}@${basis.source.revision}`, undefined, [], { sourceProvenance: basis.provenance });
    if (branch.baseRoot !== basis.root) throw new Error('Continuation branch has a different fixed baseline');
    const retained = await store.pinBranchHandoff(branchId, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
    signal.throwIfAborted();
    const source: LaunchSource = { resource_owner: basis.source.resource_owner,
      mode: child.selected_profile.work_mode === 'read_only' ? 'fixed_branch' : 'materialized', live_root: null,
      workspace_id: basis.source.workspace_id, execution_workspace_id: basis.source.execution_workspace_id,
      branch_id: branchId, revision: 0 };
    return { source, pin: { pin_id: retained.pinId, root: retained.root, source: { ...source, mode: 'fixed_branch' } }, provenance: basis.provenance };
  } finally { if (!handoffPin) await pin.release(); }
}
