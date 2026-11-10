import {nativeExecutionWorkspaceId} from './native-workspaces.js';
/** Storage-side child preparation. The caller has already admitted the original source
 * owner; these functions neither create a Catalog Run nor mint a resource grant. */
import type { DelegatedExecution, ChildSourceProvenance, ChildSourcePin, LaunchSource, ChildPreparationProgress, KernelTextPolicy } from './protocol.generated.js';
import type { WorkingStateRootStore, WorkingStatePin } from '../harness/working-state/types.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { buildThreeWayMergePlan, type PathTextInterpretations } from '../harness/working-state/three-way-merge.js';
import type { ChildPhysicalCapture } from './child-source-capture.js';
import { scopeFixedSourceResources } from './scoped-source-resources.js';
import { textEncodingForResource } from '../projects/text-encoding.js';
import { inspectDocumentBytes, serializeDocumentText } from '../documents/inspect.js';

export interface ChildSourcePreparation {
  source: LaunchSource;
  pin: ChildSourcePin;
  provenance: ChildSourceProvenance;
}

export interface ChildSourceStoreOwners {
  store: WorkingStateRootStore;
  capture: StableSourcePreparationOwners;
  onProgress?(progress: ChildPreparationProgress): void;
  capturePhysical?: ChildPhysicalCapture;
  nativeWorkspaces?:import('./native-workspaces.js').NativeWorkspaceOwner|undefined;
  /** The original physical handoff, checked by the source owner before opening it. */
  physical(root: { rootId: string; canonicalRoot: string }): Promise<WorkingStateRootStore>;
}

/** The selected immutable revision owns its format choices, including unchanged ASCII bytes. */
async function fixedTextEncoding(store: WorkingStateRootStore, branchId: string, revision: number,
  root: string | undefined, signal: AbortSignal): Promise<KernelTextPolicy> {
  return store.readTextEncoding(branchId, revision, { signal, ...(root === undefined ? {} : { root }) });
}

/** Rebase original source-relative rules exactly once with an already accepted subtree pin. */
function scopedTextEncoding(policy: KernelTextPolicy, prefix: string): KernelTextPolicy {
  const insensitive = /^[a-z]:/i.test(policy.root ?? '') || policy.root?.startsWith('//');
  const comparablePrefix = insensitive ? prefix.toLowerCase() : prefix;
  const project = <T>(values: Record<string, T> | undefined): Record<string, T> => {
    const scoped: Record<string, T> = Object.create(null);
    let inherited: { length: number; value: T } | undefined;
    for (const [file, value] of Object.entries(values ?? {})) {
      const comparableFile = insensitive ? file.toLowerCase() : file;
      const directory = comparableFile.endsWith('/');
      const rule = comparableFile === './' ? '' : directory ? comparableFile.slice(0, -1) : comparableFile;
      if (directory && (!rule || comparablePrefix === rule || comparablePrefix.startsWith(`${rule}/`))) {
        if (!inherited || rule.length > inherited.length) inherited = { length: rule.length, value };
      } else if (comparableFile.startsWith(`${comparablePrefix}/`)) {
        scoped[file.slice(prefix.length + 1)] = value;
      }
    }
    if (inherited) scoped['./'] = inherited.value;
    return scoped;
  };
  const files = project(policy.files);
  const choiceRevisions = project(policy.choiceRevisions);
  return { ...(policy.defaultEncoding ? { defaultEncoding: policy.defaultEncoding } : {}),
    ...(policy.root ? { root: `${policy.root.replace(/\\/g, '/').replace(/\/$/, '')}/${prefix}` } : {}),
    ...(Object.keys(files).length ? { files } : {}),
    ...(Object.keys(choiceRevisions).length ? { choiceRevisions } : {}) };
}

function draftEncoding(provenance: ChildSourceProvenance | undefined, file: string): string | undefined {
  const drafts = provenance && ('drafts' in provenance ? provenance.drafts
    : provenance.consistency === 'fixed-root' ? provenance.selection?.drafts : undefined);
  return drafts?.resources.find(resource => resource.resourceId === file)?.encoding;
}

export async function prepareChildSourceStore(
  child: DelegatedExecution,
  owners: ChildSourceStoreOwners,
  signal: AbortSignal,
): Promise<ChildSourcePreparation> {
  if (child.trigger.kind !== 'dispatch') return child.source_basis?.kind === 'refreshed'
    ? prepareRefreshedContinuationSourceStore(child, owners.store, signal) : prepareContinuationSourceStore(child, owners.store, signal);
  const { capturePhysical, ...shared } = owners;
  return prepareDispatchSourceStore(child, { ...shared, ...(capturePhysical ? { capturePhysical: args => capturePhysical({ ...args, child }) } : {}) }, signal);
}

/** Source preparation is also used by independent harnesses; it does not require a native child Run. */
export async function prepareDispatchSourceStore(
  child: Pick<DelegatedExecution, 'execution_id' | 'source'> & { selected_profile: Pick<DelegatedExecution['selected_profile'], 'work_mode'> },
  owners: Omit<ChildSourceStoreOwners, 'capturePhysical'> & { capturePhysical?: (args: Omit<Parameters<ChildPhysicalCapture>[0], 'child'>) => ReturnType<ChildPhysicalCapture> },
  signal: AbortSignal,
): Promise<ChildSourcePreparation> {
  const handoff = child.source?.kind === 'pending' || child.source?.kind === 'ready' ? child.source.handoff : null;
  if (!handoff) throw new Error('Dispatch source handoff is unavailable');
  const sourceBranch = `child-source:${child.execution_id}`;
  const workspace = handoff.source.workspace_id;
  let store = owners.store;
  let provenance: ChildSourceProvenance;
  if ((handoff.root.kind === 'fixed'||handoff.root.kind==='native')) {
    const fixed = handoff.root.pin;
    if (!fixed.source.branch_id || fixed.source.revision === null) throw new Error('Fixed child source has incomplete identity');
    if (!store.openBranchHandoffPin) throw new Error('Durable source handoff is unavailable');
    const pin = await store.openBranchHandoffPin(fixed.source.branch_id, fixed.pin_id,
      { root: fixed.root, revision: fixed.source.revision, writeRevision: fixed.source.revision }, signal);
    const original = await store.readOriginalSource(fixed.source.branch_id, { signal });
    const resources=original?.provenance.resources;
    const selectedPath = handoff.root.kind === 'fixed' ? handoff.source_path?.replace(/\\/g, '/').replace(/\/$/, '') : undefined;
    const prefix = selectedPath && selectedPath !== '.' ? selectedPath : undefined;
    // branch.read validates the original full revision itself. A subtree pin has
    // a different root, so it cannot be compared with that full revision root.
    const policy = await fixedTextEncoding(store, fixed.source.branch_id, fixed.source.revision, prefix ? undefined : fixed.root, signal);
    const textEncoding = prefix ? scopedTextEncoding(policy, prefix) : policy;
    provenance = { consistency: 'fixed-root', root: fixed.root, textEncoding, ...(resources ? { resources: handoff.source_path && handoff.root.kind !== 'native'
      ? await scopeFixedSourceResources(store,{branchId:fixed.source.branch_id,revision:fixed.source.revision},resources,handoff.source_path,signal,policy) : resources } : {}) };
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
      if (owners.capturePhysical) {
        provenance = await owners.capturePhysical({ directory, rootId: physical.rootId,
          captureWorkspaceId: resolved.workspaceId, signal, onProgress: owners.onProgress });
      } else {
      let phase: ChildPreparationProgress['phase'] = 'inventory';
      const captured = await captureStableSourceBaseline({ store, workspaceId: workspace,
        captureWorkspaceId: resolved.workspaceId, branchId: sourceBranch, directory,
        captureScopes: [], content: { mode: 'saved-files' }, signal,
        onPhase: value => { phase = value; owners.onProgress?.({ phase }); },
        onProgress: (completed, total) => owners.onProgress?.({ phase, completed, total }) }, owners.capture);
      provenance = captured.provenance;
      }
    }
  }
  if (!store.pinBranchHandoff) throw new Error('Durable source pin is unavailable');
  const pin = await store.pinBranchHandoff(sourceBranch, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
  signal.throwIfAborted();
  const source: LaunchSource = { resource_owner: handoff.source.resource_owner,
    mode: child.selected_profile.work_mode === 'isolated_write' ? 'native_workspace' : 'fixed_branch', live_root: null,
    workspace_id: workspace, execution_workspace_id: child.selected_profile.work_mode==='isolated_write'?nativeExecutionWorkspaceId(child.execution_id):handoff.source.execution_workspace_id,
    branch_id: sourceBranch, revision: child.selected_profile.work_mode==='isolated_write'?null:0 };
  return { source, pin: { pin_id: pin.pinId, root: pin.root, source: { ...source, mode: 'fixed_branch',revision:0 } }, provenance };
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
    const textEncoding = await fixedTextEncoding(store, basis.source.branch_id, basis.source.revision, basis.root, signal);
    // Catalog accepted this exact provenance before preparation. Storage owns
    // the selected revision's policy separately; do not rewrite that receipt.
    const provenance = basis.provenance;
    const branch = await store.createBranchFromPin(basis.source.workspace_id, branchId, pin,
      `${basis.source.branch_id}@${basis.source.revision}`, undefined, [], { sourceProvenance: provenance, textEncoding });
    if (branch.baseRoot !== basis.root) throw new Error('Continuation branch has a different fixed baseline');
    const retained = await store.pinBranchHandoff(branchId, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
    signal.throwIfAborted();
    const source: LaunchSource = { resource_owner: basis.source.resource_owner,
      mode: child.selected_profile.work_mode === 'isolated_write' ? 'native_workspace' : 'fixed_branch', live_root: null,
      workspace_id: basis.source.workspace_id, execution_workspace_id:child.selected_profile.work_mode==='isolated_write'?nativeExecutionWorkspaceId(child.execution_id):basis.source.execution_workspace_id,
      branch_id: branchId, revision:child.selected_profile.work_mode==='isolated_write'?null:0 };
    return { source, pin: { pin_id: retained.pinId, root: retained.root, source: { ...source, mode: 'fixed_branch',revision:0 } }, provenance };
  } finally { if (!handoffPin) await pin.release(); }
}

/** Captures the selected concrete worktree once; later preparation reads this exact stage. */
export async function captureContinuationStage(child: DelegatedExecution, owners: ChildSourceStoreOwners,
  source: LaunchSource, physical: { rootId: string; canonicalRoot: string } | undefined, signal: AbortSignal): Promise<void> {
  const branchId = `child-incoming:${child.execution_id}`;
  if (await owners.store.readSourcePreparation(branchId, { signal })) return;
  if(source.mode==='native_workspace'){
    if(!owners.nativeWorkspaces)throw new Error('Native continuation source is unavailable');
    const admitted = await owners.nativeWorkspaces.open(source, signal);
    const native = await owners.nativeWorkspaces.acquire(source, admitted.grant, signal);
    const workspace = await owners.capture.documents.resolveWorkspace({ path: native.path });
    const textEncoding = await owners.capture.documents.resolveTextEncodingPolicy?.(workspace.workspaceId) ?? {};
    await owners.nativeWorkspaces.snapshot(source,branchId,`child-incoming-snapshot:${child.execution_id}`,signal,undefined,{ textEncoding });return;
  }
  if (source.mode === 'fixed_branch' || source.mode === 'materialized' && !physical) {
    if (!source.branch_id || source.revision === null) throw new Error('Incoming source is incomplete');
    const pin = await owners.store.pinBranch(source.branch_id, { revision: source.revision, signal });
    try {
      const original = await owners.store.readOriginalSource(source.branch_id, { signal });
      const textEncoding = await fixedTextEncoding(owners.store, source.branch_id, source.revision, pin.root, signal);
      await owners.store.createBranchFromPin(source.workspace_id, branchId, pin, `${source.branch_id}@${source.revision}`, undefined, [],
        { sourceProvenance: { consistency: 'fixed-root', root: pin.root, textEncoding, ...(original?.provenance.resources ? { resources: original.provenance.resources } : {}) } });
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
    const formatPaths = Object.keys(result?.textFormats ?? {});
    const allPaths = [...new Set([...paths, ...changes, ...formatPaths])];
    const states = await store.readStateSlice(incomingBranch, allPaths, { revision: 0, signal });
    if (!states) throw new Error('Incoming stage content is unavailable');
    const original = result ? await store.readOriginalSource(result.branchId, { signal }) : null;
    const basePolicy = result ? await fixedTextEncoding(store, result.branchId, 0, result.baseRoot, signal) : {};
    const childPolicy = result ? await fixedTextEncoding(store, result.branchId, result.resultRevision, result.root, signal) : basePolicy;
    const incomingPolicy = await fixedTextEncoding(store, incomingBranch, 0, incoming.branch.baseRoot, signal);
    const interpretations: Record<string, PathTextInterpretations> = Object.fromEntries(changes.map(file => {
      const format = result?.textFormats?.[file];
      const baseEncoding = format?.base?.encoding ?? draftEncoding(original?.provenance ?? basis.provenance, file);
      return [file, {
        base: baseEncoding ? { encoding: baseEncoding } : textEncodingForResource(basePolicy, file),
        parent: textEncodingForResource(incomingPolicy, file),
        child: format?.child ? { encoding: format.child.encoding } : textEncodingForResource(childPolicy, file),
      }];
    }));
    const selectedFiles = { ...incomingPolicy.files };
    // Format-only choices may have no raw diff. Carry them only when the incoming
    // state is still the exact state whose interpretation the result retained.
    if (result && formatPaths.length) {
      const fixed = await store.readStateSlice(result.branchId, formatPaths, { revision: result.resultRevision, signal });
      if (!fixed) throw new Error('Previous result format states are unavailable');
      for (const file of formatPaths) {
        const format = result.textFormats?.[file]?.child;
        const previous = fixed[file], current = states[file];
        if (format && previous?.kind === 'regular-file' && current?.kind === 'regular-file'
          && previous.objectHash === current.objectHash && previous.byteLength === current.byteLength) selectedFiles[file] = format.encoding;
      }
    }
    const plan = await buildThreeWayMergePlan({ interpretations, operationId: `child-refresh:${child.execution_id}`,
      workspaceId: basis.source.workspace_id, threadId: child.child_thread_id, resultRevision: result?.resultRevision ?? 0,
      allPaths: changes, baseState: result?.baseStates ?? {}, parentState: states, childState: result?.pathStates ?? {},
      readContent: state => state.kind === 'regular-file' ? store.getObject(state.objectHash) : Promise.resolve(null) });
    const owned: Array<() => Promise<void>> = [];
    try {
      for (const path of plan.paths) {
        signal.throwIfAborted();
        if (path.mergedText !== undefined || path.conflictMarkers !== undefined) {
          const baseline = path.parentState.kind === 'regular-file' ? await store.getObject(path.parentState.objectHash) : null;
          const format = path.textFormat;
          if (!baseline || !format) throw new Error('Refreshed text has no original format baseline');
          const serialized = await serializeDocumentText({ content: path.mergedText ?? path.conflictMarkers!,
            encoding: format.encoding, bom: format.bom, sourceBytes: baseline, sourceFormat: format, normalizeLineEndings: false });
          const object = await store.putObject(serialized.bytes);
          if (object.release) owned.push(object.release);
          selectedFiles[path.path] = serialized.format.encoding;
          states[path.path] = { kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength,
            ...((path.mergedMode ?? (path.childState.kind === 'regular-file' ? path.childState.mode : undefined)) === undefined ? {}
              : { mode: path.mergedMode ?? (path.childState.kind === 'regular-file' ? path.childState.mode : undefined) }),
            ...(path.mergedNative ? { native: path.mergedNative } : {}) };
        } else if (path.mergedState || path.decision === 'apply-child' || path.decision === 'conflict') {
          const selected = path.mergedState ?? path.childState;
          states[path.path] = selected;
          if (selected.kind === 'regular-file') {
            const bytes = await store.getObject(selected.objectHash);
            if (!bytes) throw new Error('Previous result content is unavailable');
            const keepsIncomingBytes = path.mergedState && path.parentState.kind === 'regular-file'
              && selected.objectHash === path.parentState.objectHash;
            const interpretation = keepsIncomingBytes
              ? textEncodingForResource({ ...incomingPolicy, files: selectedFiles }, path.path) : interpretations[path.path]?.child;
            const decoded = await inspectDocumentBytes(bytes, false, interpretation);
            const encoding = decoded.kind === 'text' ? decoded.format.encoding : interpretation?.encoding;
            if (encoding) selectedFiles[path.path] = encoding;
          }
        }
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
        conflicts: [...conflicts].sort(), textEncoding: { ...incomingPolicy, ...(Object.keys(selectedFiles).length ? { files: selectedFiles } : {}) }, ...(incoming.provenance.resources ? { resources: incoming.provenance.resources } : {}) };
      const pin = await store.pinBranch(provisional, { revision: 0, signal });
      try {
        await store.createBranchFromPin(basis.source.workspace_id, branchId, pin, `${provisional}@0`, undefined, [], { sourceProvenance: provenance });
      } finally { await pin.release(); }
      prepared = await store.readSourcePreparation(branchId, { signal });
    } finally { for (const release of owned) await release(); }
  }
  if (!prepared) throw new Error('Continuation source was not retained');
  const pin = await store.pinBranchHandoff(branchId, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
  const source: LaunchSource = { ...basis.source, mode: child.selected_profile.work_mode === 'read_only' ? 'fixed_branch' : 'native_workspace',
    live_root: null, environment_run_id: null, branch_id: branchId, revision:child.selected_profile.work_mode==='isolated_write'?null:0,
    execution_workspace_id:child.selected_profile.work_mode==='isolated_write'?nativeExecutionWorkspaceId(child.execution_id):basis.source.execution_workspace_id };
  // The captured incoming root is already scoped; the new branch owns that root.
  delete source.native_scope;
  return { source, pin: { pin_id: pin.pinId, root: pin.root, source: { ...source, mode: 'fixed_branch',revision:0 } }, provenance: prepared.provenance };
}

export async function releaseRefreshScratch(child:DelegatedExecution,store:WorkingStateRootStore):Promise<void> {
  if(child.source_basis?.kind!=='refreshed')return;
  const provenance=child.source?.kind==='ready'?child.source.provenance:undefined;
  const retainIncoming=!!child.receipt && provenance?.consistency==='refreshed-root' && provenance.conflicts.length>0;
  const ids=[`child-refresh:${child.execution_id}`,...(retainIncoming?[]:[`child-incoming:${child.execution_id}`])];
  for(const id of ids)if(await store.getBranchRoot(id))await store.deleteBranch(id);
}
