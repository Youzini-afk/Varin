/** Shared source capture. Documents owns the capture window; Rust owns bytes and roots. */
import type { createDocumentAuthority, DirtyBufferPublication } from '../../documents/authority.js';
import type { CaptureToken } from '../../documents/mutation-authority.js';
import { stateIdentity } from '../../recovery/journal-files.js';
import type { ChildSourceProvenance } from '../../kernel/protocol.generated.js';
type CapturedSourceProvenance = Exclude<ChildSourceProvenance, { consistency: 'fixed-root' }>;
import { createBranchWithDraftBaseline } from './draft-baseline.js';
import type { RecoveryState, WorkingBranchRoot, WorkingStateRootStore, WorkingBranchCreateOptions } from './types.js';
import { directoryBaselineFingerprint, gitBaselineFingerprint, withAncestorDirectories, type BaselineInventory } from './workspace-baseline.js';

export class SourceCaptureError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(`Source baseline is unavailable (baseline-changed): ${message}`);
    this.name = 'SourceCaptureError';
  }
}

export interface StableDirectoryCaptureInput {
  store: WorkingStateRootStore;
  directory: string;
  captureScopes: readonly string[];
  baseRef?: string;
  inspectInventory(directory: string, signal?: AbortSignal): Promise<BaselineInventory>;
  /** A caller may already have inspected Git for the immutable-baseline reuse path. */
  inventory?: BaselineInventory;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
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
  const paths = inventory.kind === 'git'
    ? withAncestorDirectories([...inventory.paths, ...scopePaths])
    : [...new Set(await store.listWorkspaceBaselinePaths(directory, signal))].sort();
  const identity = inventory.kind === 'git' ? gitBaselineFingerprint(inventory) : directoryBaselineFingerprint(paths);
  let captured: Record<string, RecoveryState> | undefined;
  try {
    const options = { ...(signal ? { signal } : {}), ...(inventory.kind === 'git' && inventory.indexModes ? { indexModes: inventory.indexModes } : {}) };
    captured = await store.captureDirectory(directory, paths, { ...options, ...(input.onProgress ? { onProgress: input.onProgress } : {}) });
    signal?.throwIfAborted();
    const capturedPaths = Object.keys(captured).sort();
    const observed = capturedPaths.length ? await store.captureDirectory(directory, capturedPaths, { ...options, store: false }) : {};
    const different = capturedPaths.filter(file => stateIdentity(captured![file] ?? { kind: 'missing' }) !== stateIdentity(observed[file] ?? { kind: 'missing' }));
    if (different.length) throw changed(`captured content or metadata: ${different.slice(0, 8).join(',')}`);
    // Inventory follows the complete verification pass. An insertion during the
    // last file read must not escape by being absent from the initial path set.
    if (inventory.kind === 'git') {
      const after = await input.inspectInventory(directory, signal);
      rejectGitlinks(after);
      if (after.kind !== 'git' || gitBaselineFingerprint(after) !== identity) throw changed('Git inventory');
    } else {
      const after = await store.listWorkspaceBaselinePaths(directory, signal);
      if (directoryBaselineFingerprint(after) !== identity) throw changed('directory paths');
    }
    if (scopes.length) {
      const after = [...new Set(await store.listCaptureScopePaths(directory, scopes, signal))].sort();
      if (directoryBaselineFingerprint(after) !== directoryBaselineFingerprint(scopePaths)) throw changed('captureScopes paths');
      const states = await store.captureDirectory(directory, after, { ...options, store: false });
      if (after.some(file => stateIdentity(captured![file] ?? { kind: 'missing' }) !== stateIdentity(states[file] ?? { kind: 'missing' }))) {
        throw changed('captureScopes content or metadata');
      }
      // Scope verification also reads files; check its inventory after it finishes.
      if (directoryBaselineFingerprint(await store.listCaptureScopePaths(directory, scopes, signal)) !== directoryBaselineFingerprint(scopePaths)) {
        throw changed('captureScopes paths');
      }
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
  'beginDirtyStateBarrier' | 'beginCapture' | 'completeCapture' | 'inspectDirtyBuffers' | 'inspectMutation' | 'inspectWorkspace' | 'resolveWorkspace'>;

export interface StableSourcePreparationOwners {
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
  content: { mode: 'saved-files' } | { mode: 'fixed-draft-baseline'; draftBaselineId: string };
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
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
 * omits unsaved overlays, not their disk paths. Pi's existing fixed draft can be applied. */
export async function captureStableSourceBaseline(
  input: StableSourceCaptureInput,
  owners: StableSourcePreparationOwners,
): Promise<StableSourceCaptureResult> {
  const { documents } = owners;
  const { store, signal, captureWorkspaceId } = input;
  const restored = await store.readSourcePreparation(input.branchId, signal ? { signal } : undefined);
  if (restored) {
    if (restored.provenance.consistency === 'fixed-root' || restored.provenance.contentMode !== input.content.mode
      || JSON.stringify(restored.provenance.captureScopes) !== JSON.stringify([...new Set(input.captureScopes)].sort())) {
      throw new Error('Source preparation has different fixed provenance');
    }
    return { branch: restored.branch, provenance: restored.provenance };
  }
  const workspace = await documents.inspectWorkspace(captureWorkspaceId, signal ? { signal } : {});
  if (workspace.root !== input.directory) throw new Error('Source capture directory differs from its admitted Documents root');
  const barrier = await documents.beginDirtyStateBarrier(captureWorkspaceId, ['.'], { signal });
  let token: CaptureToken | undefined;
  let captured: StableDirectoryCapture | undefined;
  try {
    token = await documents.beginCapture(captureWorkspaceId, {}, signal);
    const assertWriters = async (): Promise<void> => {
      const state = await documents.inspectMutation(captureWorkspaceId);
      if (state.activeWriters.length) throw new SourceCaptureError('controlled writers are active');
    };
    await assertWriters();
    captured = await captureStableDirectoryBaseline({ ...input, inspectInventory: owners.inspectInventory });
    await barrier.settle();
    const dirty = await documents.inspectDirtyBuffers(captureWorkspaceId);
    await assertWriters();
    const completed = await documents.completeCapture(token, signal);
    token = undefined;
    if (!completed.stable) throw new SourceCaptureError(`Documents capture: ${completed.reasons.join(',')}`);
    signal?.throwIfAborted();
    const scopes = [...new Set(input.captureScopes)].sort();
    const provenance: CapturedSourceProvenance = { consistency: captured.consistency, contentMode: input.content.mode,
      omittedDraftPaths: input.content.mode === 'saved-files' ? draftPaths(dirty) : [], captureScopes: scopes };
    const branch = await createCapturedSourceBranch(store, input.workspaceId, input.branchId, captured.states, captured.baseRef,
      scopes, input.content.mode === 'fixed-draft-baseline' ? input.content.draftBaselineId : undefined, { sourceProvenance: provenance });
    return { branch, provenance };
  } catch (error) {
    if (captured) await store.releaseCapturedStates(captured.states);
    throw error;
  } finally {
    // Cleanup does not reuse an aborted signal: the existing capture subscription
    // and barrier still need to release their actual owner resources.
    if (token) await documents.completeCapture(token).catch(() => undefined);
    await barrier.release();
  }
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
