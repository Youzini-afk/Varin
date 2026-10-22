/** Storage-side child preparation. The caller has already admitted the original source
 * owner; these functions neither create a Catalog Run nor mint a resource grant. */
import type { DelegatedExecution, ChildSourceProvenance, ChildSourcePin, LaunchSource, ChildPreparationProgress } from './protocol.generated.js';
import type { WorkingStateRootStore, WorkingStatePin } from '../harness/working-state/types.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { buildThreeWayMergePlan } from '../harness/working-state/three-way-merge.js';

export interface ChildSourcePreparation {
  source: LaunchSource;
  pin: ChildSourcePin;
  provenance: ChildSourceProvenance;
}

export interface ChildSourceStoreOwners {
  store: WorkingStateRootStore;
  capture: StableSourcePreparationOwners;
  onProgress?(progress: ChildPreparationProgress): void;
  /** The original physical handoff, checked by the source owner before opening it. */
  physical(root: { rootId: string; canonicalRoot: string }): Promise<WorkingStateRootStore>;
}

export async function prepareChildSourceStore(
  child: DelegatedExecution,
  owners: ChildSourceStoreOwners,
  signal: AbortSignal,
): Promise<ChildSourcePreparation> {
  if (child.trigger.kind !== 'dispatch') return child.source_basis?.kind === 'refreshed'
    ? prepareRefreshedContinuationSourceStore(child, owners.store, signal) : prepareContinuationSourceStore(child, owners.store, signal);
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
      const directory = (await owners.capture.documents.inspectWorkspace(resolved.workspaceId)).root;
      if (normalizePathIdentity(directory) !== normalizePathIdentity(physical.canonicalRoot)) {
        throw new Error('Child source Documents authority changed');
      }
      store = await owners.physical(physical);
      let phase: ChildPreparationProgress['phase'] = 'inventory';
      const captured = await captureStableSourceBaseline({ store, workspaceId: workspace,
        captureWorkspaceId: resolved.workspaceId, branchId: sourceBranch, directory,
        captureScopes: [], content: { mode: 'saved-files' }, signal,
        onPhase: value => { phase = value; owners.onProgress?.({ phase }); },
        onProgress: (completed, total) => owners.onProgress?.({ phase, completed, total }) }, owners.capture);
      provenance = captured.provenance;
    }
  }
  if (!store.pinBranchHandoff) throw new Error('Durable source pin is unavailable');
  const pin = await store.pinBranchHandoff(sourceBranch, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
  signal.throwIfAborted();
  const source: LaunchSource = { resource_owner: handoff.source.resource_owner,
    mode: child.selected_profile.work_mode === 'isolated_write' ? 'materialized' : 'fixed_branch', live_root: null,
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
      mode: child.selected_profile.work_mode === 'isolated_write' ? 'materialized' : 'fixed_branch', live_root: null,
      workspace_id: basis.source.workspace_id, execution_workspace_id: basis.source.execution_workspace_id,
      branch_id: branchId, revision: 0 };
    return { source, pin: { pin_id: retained.pinId, root: retained.root, source: { ...source, mode: 'fixed_branch' } }, provenance: basis.provenance };
  } finally { if (!handoffPin) await pin.release(); }
}

/** Captures the selected concrete worktree once; later preparation reads this exact stage. */
export async function captureContinuationStage(child: DelegatedExecution, owners: ChildSourceStoreOwners,
  source: LaunchSource, physical: { rootId: string; canonicalRoot: string } | undefined, signal: AbortSignal): Promise<void> {
  const branchId = `child-incoming:${child.execution_id}`;
  if (await owners.store.readSourcePreparation(branchId, { signal })) return;
  if (source.mode === 'fixed_branch') {
    if (!source.branch_id || source.revision === null) throw new Error('Incoming source is incomplete');
    const pin = await owners.store.pinBranch(source.branch_id, { revision: source.revision, signal });
    try {
      const original = await owners.store.readOriginalSource(source.branch_id, { signal });
      await owners.store.createBranchFromPin(source.workspace_id, branchId, pin, `${source.branch_id}@${source.revision}`, undefined, [],
        { sourceProvenance: { consistency: 'fixed-root', root: pin.root, ...(original?.provenance.resources ? { resources: original.provenance.resources } : {}) } });
    } finally { await pin.release(); }
    return;
  }
  if (!physical) throw new Error('Selected Agent file environment is unavailable');
  const workspace = await owners.capture.documents.resolveWorkspace({ path: physical.canonicalRoot });
  const store = await owners.physical(physical);
  await captureStableSourceBaseline({ store, workspaceId: source.workspace_id, captureWorkspaceId: workspace.workspaceId,
    directory: physical.canonicalRoot, branchId, captureScopes: [], content: { mode: 'saved-files' }, signal }, owners.capture);
}

/** Carry the previous result over the new fixed stage with the ordinary three-way merge. */
export async function prepareRefreshedContinuationSourceStore(child: DelegatedExecution, store: WorkingStateRootStore,
  signal: AbortSignal): Promise<ChildSourcePreparation> {
  const basis = child.source_basis;
  if (basis?.kind !== 'refreshed' || !store.pinBranchHandoff) throw new Error('Continuation refresh is unavailable');
  const branchId = `child-source:${child.execution_id}`;
  let prepared = await store.readSourcePreparation(branchId, { signal });
  if (!prepared) {
    const incomingBranch = `child-incoming:${child.execution_id}`;
    const incoming = await store.readSourcePreparation(incomingBranch, { signal });
    if (!incoming) throw new Error('Selected Agent stage has not been captured');
    const staged = await store.listPaths(incomingBranch, [''], { revision: 0, signal });
    if (!staged) throw new Error('Incoming stage is unavailable');
    const paths = staged.entries.map(e => e.path);
    const result = basis.result ? await store.getResult(basis.result.branch_id, basis.result.result_revision, { signal }) : null;
    if (basis.result && (!result || result.root !== basis.root)) throw new Error('Previous result changed');
    const changes = result?.changedPaths ?? [];
    const allPaths = [...new Set([...paths, ...changes])];
    const states = await store.readStateSlice(incomingBranch, allPaths, { revision: 0, signal });
    if (!states) throw new Error('Incoming stage content is unavailable');
    const plan = await buildThreeWayMergePlan({ operationId: `child-refresh:${child.execution_id}`,
      workspaceId: basis.source.workspace_id, threadId: child.child_thread_id, resultRevision: result?.resultRevision ?? 0,
      allPaths: changes, baseState: result?.baseStates ?? {}, parentState: states, childState: result?.pathStates ?? {},
      readContent: state => state.kind === 'regular-file' ? store.getObject(state.objectHash) : Promise.resolve(null) });
    const owned: Array<() => Promise<void>> = [];
    try {
      for (const path of plan.paths) {
        signal.throwIfAborted();
        if (path.decision === 'apply-child') states[path.path] = path.childState;
        else if (path.mergedText !== undefined || path.conflictMarkers !== undefined) {
          const object = await store.putObject(Buffer.from(path.mergedText ?? path.conflictMarkers!, 'utf8'));
          if (object.release) owned.push(object.release);
          states[path.path] = { kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength,
            ...((path.mergedMode ?? (path.childState.kind === 'regular-file' ? path.childState.mode : undefined)) === undefined ? {}
              : { mode: path.mergedMode ?? (path.childState.kind === 'regular-file' ? path.childState.mode : undefined) }) };
        } else if (path.decision === 'conflict') states[path.path] = path.childState;
      }
      const conflicts=new Set(plan.conflictPaths);
      // A file/deletion replacing a directory also owns its descendants. Keep
      // that version coherent and retain the incoming tree as the alternative.
      for(const path of plan.paths) {
        const state=states[path.path];
        if(!state || state.kind==='directory')continue;
        const descendants=Object.keys(states).filter(file=>file.startsWith(`${path.path}/`) && states[file]?.kind!=='missing');
        if(descendants.length) {
          conflicts.add(path.path);
          for(const file of descendants)delete states[file];
        }
      }
      // Conflicting binary/structural alternatives remain in the two immutable
      // source roots; carry this Agent's version and name the conflict in context.
      const provisional = `child-refresh:${child.execution_id}`;
      let merged = await store.getBranchRoot(provisional);
      if (!merged) merged = await store.createBranch(basis.source.workspace_id, provisional, states);
      const provenance: ChildSourceProvenance = { consistency: 'refreshed-root', root: merged.baseRoot,
        previousRoot: basis.root, incoming: basis.incoming, incomingRoot: incoming.branch.baseRoot,
        conflicts: [...conflicts].sort(), ...(incoming.provenance.resources ? { resources: incoming.provenance.resources } : {}) };
      const pin = await store.pinBranch(provisional, { revision: 0, signal });
      try {
        await store.createBranchFromPin(basis.source.workspace_id, branchId, pin, `${provisional}@0`, undefined, [], { sourceProvenance: provenance });
      } finally { await pin.release(); }
      prepared = await store.readSourcePreparation(branchId, { signal });
    } finally { for (const release of owned) await release(); }
  }
  if (!prepared) throw new Error('Continuation source was not retained');
  const pin = await store.pinBranchHandoff(branchId, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
  const source: LaunchSource = { ...basis.source, mode: child.selected_profile.work_mode === 'read_only' ? 'fixed_branch' : 'materialized',
    live_root: null, environment_run_id: null, branch_id: branchId, revision: 0 };
  return { source, pin: { pin_id: pin.pinId, root: pin.root, source: { ...source, mode: 'fixed_branch' } }, provenance: prepared.provenance };
}

export async function releaseRefreshScratch(child:DelegatedExecution,store:WorkingStateRootStore):Promise<void> {
  if(child.source_basis?.kind!=='refreshed')return;
  const provenance=child.source?.kind==='ready'?child.source.provenance:undefined;
  const retainIncoming=!!child.receipt && provenance?.consistency==='refreshed-root' && provenance.conflicts.length>0;
  const ids=[`child-refresh:${child.execution_id}`,...(retainIncoming?[]:[`child-incoming:${child.execution_id}`])];
  for(const id of ids)if(await store.getBranchRoot(id))await store.deleteBranch(id);
}
