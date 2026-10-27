/** Shared source capture. Documents owns the capture window; Rust owns bytes and roots. */
import type { createDocumentAuthority, DirtyBufferPublication } from '../../documents/authority.js';
import type { CaptureToken } from '../../documents/mutation-authority.js';
import { CaptureInventoryChangedError } from '../../documents/capture-inventory.js';
import { stateIdentity } from '../../recovery/journal-files.js';
import { normalizePathIdentity } from '../../workspace/path-safety.js';
import type { ChildSourceProvenance, SourceResourceCapture, SourceDraftProvenance } from '../../kernel/protocol.generated.js';
type CapturedSourceProvenance = Extract<ChildSourceProvenance, { consistency: 'stable-capture' | 'git-base-with-overlay' }>;
import { createBranchWithDraftBaseline, overlayDraftsOnBaseline } from './draft-baseline.js';
import type { RecoveryState, WorkingBranchRoot, WorkingStateRootStore, WorkingBranchCreateOptions } from './types.js';
import { directoryBaselineFingerprint, gitBaselineFingerprint, withAncestorDirectories, type BaselineInventory } from './workspace-baseline.js';

export class SourceCaptureError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(`Source changed while preparing its snapshot: ${message}. Retry after the writes finish, or select a narrower project folder.`);
    this.name = 'SourceCaptureError';
  }
}

export interface StableDirectoryCaptureInput {
  store: WorkingStateRootStore;
  directory: string;
  captureScopes: readonly string[];
  /** Exact candidates, including observed absences; unlike scopes these do not recurse. */
  capturePaths?: readonly string[];
  baseRef?: string;
  inspectInventory(directory: string, signal?: AbortSignal): Promise<BaselineInventory>;
  /** A caller may already have inspected Git for the immutable-baseline reuse path. */
  inventory?: BaselineInventory;
  /** Original Documents observation may prove namespace continuity, never file bytes. */
  directoryInventory?: { read(): Promise<readonly string[]>; verify(): Promise<void>; assertCurrent?(): void };
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  onDiscovered?: (completed: number) => void;
  onPhase?: (phase: 'inventory' | 'capture' | 'verify' | 'publish') => void;
  changed?: (detail: string) => Error;
}

export interface StableDirectoryCapture {
  states: Record<string, RecoveryState>;
  baseRef: string;
  consistency: CapturedSourceProvenance['consistency'];
}

/** Complete inventory and full-state verification, not merely each file's double read.
 * Documents coordination encloses this algorithm in production callers. */
export async function captureStableDirectoryBaseline(input: StableDirectoryCaptureInput): Promise<StableDirectoryCapture> {
  const { store, directory, signal } = input;
  const changed = input.changed ?? (detail => new SourceCaptureError(detail));
  input.onPhase?.('inventory');
  const inventory = input.inventory ?? await input.inspectInventory(directory, signal);
  const scopes = [...new Set(input.captureScopes)].sort();
  signal?.throwIfAborted();
  const rejectGitlinks = (value: BaselineInventory): void => {
    if (value.kind === 'git' && value.gitlinks.length) {
      throw new Error(`Source baseline cannot capture Git submodule paths: ${value.gitlinks.join(', ')}`);
    }
  };
  rejectGitlinks(inventory);
  const scopePaths = scopes.length ? [...new Set(await store.listCaptureScopePaths(directory, scopes, signal))].sort() : [];
  let baselinePaths: readonly string[];
  try {
    baselinePaths = inventory.kind === 'git' ? inventory.paths
      : input.directoryInventory ? await input.directoryInventory.read() : await store.listWorkspaceBaselinePaths(directory, signal, input.onDiscovered);
  } catch (error) {
    if (error instanceof CaptureInventoryChangedError) throw changed(error.message);
    throw error;
  }
  const paths = inventory.kind === 'git'
    ? withAncestorDirectories([...baselinePaths, ...scopePaths, ...input.capturePaths ?? []])
    : [...new Set([...baselinePaths, ...scopePaths, ...input.capturePaths ?? []])].sort();
  const identity = inventory.kind === 'git' ? gitBaselineFingerprint(inventory) : directoryBaselineFingerprint(baselinePaths);
  let captured: Record<string, RecoveryState> | undefined;
  try {
    const options = { ...(signal ? { signal } : {}), ...(inventory.kind === 'git' && inventory.indexModes ? { indexModes: inventory.indexModes } : {}) };
    const onProgress = (completed: number, total: number) => {
      if (inventory.kind !== 'git') input.directoryInventory?.assertCurrent?.();
      input.onProgress?.(completed, total);
    };
    input.onPhase?.('capture');
    captured = await store.captureDirectory(directory, paths, { ...options, onProgress });
    signal?.throwIfAborted();
    const capturedPaths = Object.keys(captured).sort();
    input.onPhase?.('verify');
    const observed = capturedPaths.length ? await store.captureDirectory(directory, capturedPaths, { ...options, store: false, verifyCaptured: captured,
      onProgress }) : {};
    const different = capturedPaths.filter(file => stateIdentity(captured![file] ?? { kind: 'missing' }) !== stateIdentity(observed[file] ?? { kind: 'missing' }));
    if (different.length) throw changed(`captured content or metadata: ${different.slice(0, 8).join(',')}`);
    // Inventory follows the complete verification pass. An insertion during the
    // last file read must not escape by being absent from the initial path set.
    if (inventory.kind === 'git') {
      const after = await input.inspectInventory(directory, signal);
      rejectGitlinks(after);
      if (after.kind !== 'git' || gitBaselineFingerprint(after) !== identity) throw changed('Git inventory');
    } else if (input.directoryInventory) {
      try { await input.directoryInventory.verify(); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CaptureInventoryChangedError) throw changed(`directory paths: ${error.message}`);
        throw error;
      }
    } else {
      const after = await store.listWorkspaceBaselinePaths(directory, signal);
      if (directoryBaselineFingerprint(after) !== identity) throw changed('directory paths');
    }
    if (scopes.length) {
      const after = [...new Set(await store.listCaptureScopePaths(directory, scopes, signal))].sort();
      if (directoryBaselineFingerprint(after) !== directoryBaselineFingerprint(scopePaths)) throw changed('captureScopes paths');
      // Scope bodies were included in the same complete verification pass. Only
      // their namespace needs a separate check, after that pass has finished.
    }
    signal?.throwIfAborted();
    return { states: captured, baseRef: inventory.kind === 'git' ? inventory.baseRef : input.baseRef ?? 'zero-commit',
      consistency: inventory.kind === 'git' ? 'git-base-with-overlay' : 'stable-capture' };
  } catch (error) {
    if (captured) await store.releaseCapturedStates(captured);
    throw error;
  }
}

export type SourceCaptureDocuments = Pick<ReturnType<typeof createDocumentAuthority>,
  'beginDirtyStateBarrier' | 'beginCapture' | 'captureInventory' | 'completeCapture' | 'discardCapture' | 'inspectDirtyBuffers' | 'inspectMutation' | 'inspectWorkspace' | 'resolveWorkspace'>;

export interface SourceResourceCapturePlan {
  resources: SourceResourceCapture;
  captureScopes: string[];
  observedPaths: string[];
  validate(states: Record<string, RecoveryState>, signal?: AbortSignal): Promise<void>;
}
export interface StableSourcePreparationOwners {
  prepareResources?(input: { store: WorkingStateRootStore; directory: string; workspaceId: string;
    captureWorkspaceId: string; branchId: string; editorDrafts?: readonly { path: string; content: Buffer }[]; signal?: AbortSignal }): Promise<SourceResourceCapturePlan>;
  documents: SourceCaptureDocuments;
  inspectInventory: StableDirectoryCaptureInput['inspectInventory'];
}

export interface StableSourceCaptureInput {
  /** Already admitted scoped store. This service never issues or broadens a grant. */
  store: WorkingStateRootStore;
  workspaceId: string;
  captureWorkspaceId: string;
  branchId: string;
  directory: string;
  captureScopes: readonly string[];
  content: { mode: 'saved-files' } | { mode: 'fixed-draft-baseline'; draftBaselineId?: string };
  captureIdentity?: string;
  drafts?: SourceDraftProvenance;
  editorDrafts?: readonly { path: string; content: Buffer }[];
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  onDiscovered?: (completed: number) => void;
  onPhase?: NonNullable<StableDirectoryCaptureInput['onPhase']>;
}

export interface StableSourceCaptureResult {
  branch: WorkingBranchRoot;
  /** Payload for the existing content/storage owner, never an inline Catalog document. */
  provenance: CapturedSourceProvenance;
}

const draftPaths = (publications: readonly DirtyBufferPublication[]): string[] => [...new Set(publications.flatMap(publication => (
  publication.resources.map(resource => resource.resource.resourceId)
)))].sort();

/** New physical source preparation requires the real Documents owner. Saved-files
 * omits unsaved overlays, not their disk paths. A captured fixed draft can be applied. */
export async function captureStableSourceBaseline(
  input: StableSourceCaptureInput,
  owners: StableSourcePreparationOwners,
): Promise<StableSourceCaptureResult> {
  const { documents } = owners;
  const { store, signal, captureWorkspaceId } = input;
  const restored = await store.readSourcePreparation(input.branchId, signal ? { signal } : undefined);
  if (restored) {
    if (!('contentMode' in restored.provenance) || restored.provenance.contentMode !== input.content.mode
      || restored.provenance.captureIdentity !== input.captureIdentity
      || JSON.stringify(restored.provenance.captureScopes) !== JSON.stringify([...new Set(input.captureScopes)].sort())) {
      throw new Error('Source preparation has different fixed provenance');
    }
    return { branch: restored.branch, provenance: restored.provenance };
  }
  const workspace = await documents.inspectWorkspace(captureWorkspaceId, signal ? { signal } : {});
  if (normalizePathIdentity(workspace.root) !== normalizePathIdentity(input.directory)) throw new Error('Source capture directory differs from its admitted Documents root');
  const barrier = await documents.beginDirtyStateBarrier(captureWorkspaceId, ['.'], { signal });
  let token: CaptureToken | undefined;
  let captured: StableDirectoryCapture | undefined;
  const draftOwners: Array<() => Promise<void>> = [];
  let result: StableSourceCaptureResult | undefined;
  const failures: unknown[] = [];
  try {
    token = await documents.beginCapture(captureWorkspaceId, {}, signal);
    const assertWriters = async (): Promise<void> => {
      const state = await documents.inspectMutation(captureWorkspaceId);
      if (state.activeWriters.length) throw new SourceCaptureError('controlled writers are active');
    };
    await assertWriters();
    let editorDrafts = input.editorDrafts ? [...input.editorDrafts] : [];
    if (input.content.mode === 'fixed-draft-baseline' && input.content.draftBaselineId) {
      if (input.editorDrafts) throw new Error('Source capture cannot select two draft owners');
      const baseline = await store.getDraftBaseline(input.content.draftBaselineId);
      if (!baseline || baseline.workspaceId !== input.workspaceId) throw new Error('Source draft baseline is unavailable');
      editorDrafts = await Promise.all(Object.entries(baseline.pathStates).map(async ([path, state]) => {
        if (state.kind !== 'regular-file') throw new Error('Source draft baseline contains a non-file');
        const content = await store.getObject(state.objectHash);
        if (!content) throw new Error('Source draft baseline bytes are unavailable');
        return { path, content };
      }));
    }
    const resources = await owners.prepareResources?.({ store, directory: input.directory, workspaceId: input.workspaceId,
      captureWorkspaceId, branchId: input.branchId, editorDrafts, ...(signal ? { signal } : {}) });
    captured = await captureStableDirectoryBaseline({ ...input,
      captureScopes: [...input.captureScopes, ...resources?.captureScopes ?? []],
      ...(resources ? { capturePaths: resources.observedPaths } : {}), inspectInventory: owners.inspectInventory,
      directoryInventory: documents.captureInventory(token, scopes => scopes
        ? store.listCaptureScopePaths(input.directory, scopes, signal)
        : store.listWorkspaceBaselinePaths(input.directory, signal, input.onDiscovered), signal) });
    const effective = editorDrafts.length ? await overlayDraftsOnBaseline({ baseState: captured.states, drafts: editorDrafts,
      putObject: async bytes => { signal?.throwIfAborted(); const object = await store.putObject(bytes);
        if (object.release) draftOwners.push(object.release); return object; } }) : { effectiveState: captured.states, changedPaths: [] };
    await resources?.validate(effective.effectiveState, signal);
    await barrier.settle();
    const dirty = await documents.inspectDirtyBuffers(captureWorkspaceId);
    await assertWriters();
    const completed = await documents.completeCapture(token, signal);
    token = undefined;
    if (!completed.stable) throw new SourceCaptureError(`Documents capture: ${completed.reasons.join(',')}`);
    signal?.throwIfAborted();
    const scopes = [...new Set(input.captureScopes)].sort();
    const provenance: CapturedSourceProvenance = { consistency: captured.consistency, contentMode: input.content.mode,
      ...(input.captureIdentity ? { captureIdentity: input.captureIdentity } : {}), ...(input.drafts ? { drafts: input.drafts } : {}),
      omittedDraftPaths: input.content.mode === 'saved-files' ? draftPaths(dirty) : [], captureScopes: scopes,
      ...(resources ? { resources: { ...resources.resources, coverage: captured.consistency === 'stable-capture' ? { kind: 'complete' as const }
        : { kind: 'selected' as const, paths: [...new Set([...Object.keys(effective.effectiveState), ...resources.observedPaths])].sort(),
          subtrees: [...new Set([...scopes, ...resources.captureScopes])].filter(file => file === '.' || effective.effectiveState[file]?.kind === 'directory').map(file => file === '.' ? '' : file).sort() } } } : {}) };
    input.onPhase?.('publish');
    const branch = await store.createBranch(input.workspaceId, input.branchId, effective.effectiveState, captured.baseRef,
      effective.changedPaths, scopes, { sourceProvenance: provenance, ...(signal ? { signal } : {}) });
    result = { branch, provenance };
  } catch (error) {
    failures.push(error instanceof CaptureInventoryChangedError
      ? signal?.aborted ? signal.reason : new SourceCaptureError(error.message) : error);
  }
  // Release each captured owner once, including after a commit. Cleanup must drain
  // without an aborted signal and must not replace the original capture failure.
  const releases = await Promise.allSettled([
    async () => { if (captured) await store.releaseCapturedStates(captured.states); },
    async () => { try { if (token) documents.discardCapture(token); } finally { await barrier.release(); } },
    ...draftOwners,
  ].map(release => release()));
  for (const release of releases) if (release.status === 'rejected') failures.push(release.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Source capture or cleanup failed');
  return result!;
}

export async function createCapturedSourceBranch(
  store: WorkingStateRootStore,
  workspaceId: string,
  branchId: string,
  states: Record<string, RecoveryState>,
  baseRef: string,
  captureScopes: string[],
  draftBaselineId?: string,
  options?: WorkingBranchCreateOptions,
): Promise<WorkingBranchRoot> {
  if (!draftBaselineId) return store.createBranch(workspaceId, branchId, states, baseRef, [], captureScopes, options);
  const baseline = await store.getDraftBaseline(draftBaselineId);
  if (!baseline) throw new Error(`Thread draft baseline not found: ${draftBaselineId}`);
  const drafts = await Promise.all(Object.entries(baseline.pathStates).map(async ([file, state]) => {
    if (state.kind !== 'regular-file') throw new Error(`Thread draft baseline contains a non-file state: ${file}`);
    const content = await store.getObject(state.objectHash);
    if (!content) throw new Error(`Thread draft baseline content is missing: ${file}`);
    return { path: file, content, ...(state.mode === undefined ? {} : { mode: state.mode }) };
  }));
  await createBranchWithDraftBaseline(store, workspaceId, branchId, states, drafts, baseRef, captureScopes, options);
  const branch = await store.getBranchRoot(branchId);
  if (!branch) throw new Error(`Captured branch is unavailable: ${branchId}`);
  return branch;
}
