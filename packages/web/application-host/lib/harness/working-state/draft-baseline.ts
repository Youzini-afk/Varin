import type { RecoveryState, RegularFileState, WorkingBranchRoot, WorkingStateRootStore, WorkingBranchCreateOptions } from "./types.js";
import { defaultNewFileMode } from "./workspace-baseline.js";

export interface EditorDraft {
  path: string;
  content?: string | Buffer | null | undefined;
  mode?: number | undefined;
}

export interface OverlayDraftsOptions {
  baseState: Record<string, RecoveryState>;
  drafts: EditorDraft[] | Record<string, EditorDraft | string | Buffer | null>;
  putObject: (bytes: Buffer) => Promise<{ hash: string; byteLength: number }>;
}

export interface DraftBaselineResult {
  effectiveState: Record<string, RecoveryState>;
  modifiedPaths: string[];
  deletedPaths: string[];
  addedPaths: string[];
  changedPaths: string[];
}

const normalizeRelPath = (p: string): string => {
  const normalized = p
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid draft path: ${p}`);
  }
  return normalized;
};
const DEFAULT_CREATED_FILE_MODE = defaultNewFileMode();
const DEFAULT_CREATED_DIRECTORY_MODE = (process.platform === "win32" ? 0o666 : 0o777) & ~process.umask();

const ancestorPaths = (rel: string): string[] => {
  const parts = rel.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
};

const normalizeDraftList = (drafts: EditorDraft[]): EditorDraft[] => {
  const normalized = drafts.map((draft) => ({ ...draft, path: normalizeRelPath(draft.path) }));
  const paths = normalized.filter((draft) => draft.content !== undefined).map((draft) => draft.path);
  const seen = new Set<string>();
  for (const rel of paths) {
    if (seen.has(rel)) throw new Error(`Draft paths contain a duplicate path: ${rel}`);
    seen.add(rel);
  }
  for (const descendant of [...seen].sort()) {
    const ancestor = ancestorPaths(descendant).find((candidate) => seen.has(candidate));
    if (ancestor) {
      throw new Error(`Draft paths contain an ancestor/descendant conflict: ${ancestor} and ${descendant}`);
    }
  }
  return normalized;
};

/**
 * Overlays in-memory editor dirty drafts onto a disk or git baseline.
 * Produces the coherent effective RecoveryState dictionary.
 */
export async function overlayDraftsOnBaseline(
  options: OverlayDraftsOptions,
): Promise<DraftBaselineResult> {
  const { baseState, putObject } = options;
  const effectiveState: Record<string, RecoveryState> = { ...baseState };

  const modifiedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const addedPaths: string[] = [];

  // Normalize drafts input into EditorDraft[]
  const draftList: EditorDraft[] = Array.isArray(options.drafts)
    ? options.drafts
    : Object.entries(options.drafts).map(([p, val]): EditorDraft => {
        if (val && typeof val === "object" && !Buffer.isBuffer(val) && "content" in val) {
          const draftObj = val as EditorDraft;
          const entry: EditorDraft = {
            path: draftObj.path ?? p,
          };
          if (draftObj.content !== undefined) entry.content = draftObj.content;
          if (draftObj.mode !== undefined) entry.mode = draftObj.mode;
          return entry;
        }
        return { path: p, content: val as string | Buffer | null };
      });

  const normalizedDrafts = normalizeDraftList(draftList);
  const directStates = new Map<string, RecoveryState>();
  const activeDrafts = normalizedDrafts.filter((draft) => draft.content !== undefined);

  for (const draft of normalizedDrafts) {
    const rel = draft.path;
    const existing = baseState[rel];

    if (draft.content === null) {
      // Draft represents file deletion
      const state = { kind: "missing" as const };
      effectiveState[rel] = state;
      directStates.set(rel, state);
      if (existing && existing.kind !== "missing") {
        deletedPaths.push(rel);
      }
      continue;
    }

    if (draft.content !== undefined) {
      const bytes = typeof draft.content === "string"
        ? Buffer.from(draft.content, "utf8")
        : draft.content;

      const { hash, byteLength } = await putObject(bytes);
      const existingMode = existing && existing.kind === "regular-file" ? existing.mode : undefined;
      const fileMode = draft.mode ?? existingMode ?? DEFAULT_CREATED_FILE_MODE;

      const newState: RegularFileState = {
        kind: "regular-file",
        objectHash: hash,
        byteLength,
        ...(fileMode !== undefined ? { mode: fileMode } : {}),
      };

      effectiveState[rel] = newState;
      directStates.set(rel, newState);

      if (existing && existing.kind !== "missing") {
        modifiedPaths.push(rel);
      } else {
        addedPaths.push(rel);
      }
    }
  }

  const changedPathClosure = new Set<string>();
  const basePaths = Object.keys(baseState);
  for (const draft of activeDrafts) {
    const rel = draft.path;
    changedPathClosure.add(rel);
    for (const candidate of basePaths) {
      if (candidate.startsWith(`${rel}/`)) {
        effectiveState[candidate] = { kind: "missing" };
        changedPathClosure.add(candidate);
      }
    }
  }
  for (const [rel, state] of directStates) effectiveState[rel] = state;
  for (const draft of activeDrafts) {
    for (const ancestor of ancestorPaths(draft.path)) {
      if (effectiveState[ancestor]?.kind !== "directory") {
        effectiveState[ancestor] = { kind: "directory", mode: DEFAULT_CREATED_DIRECTORY_MODE };
        changedPathClosure.add(ancestor);
      }
    }
  }

  const changedPaths = [...changedPathClosure].sort();

  return {
    effectiveState,
    modifiedPaths,
    deletedPaths,
    addedPaths,
    changedPaths,
  };
}

export async function createBranchWithDraftBaseline(
  store: WorkingStateRootStore,
  workspaceId: string,
  branchId: string,
  baseState: Record<string, RecoveryState>,
  drafts: EditorDraft[] | Record<string, EditorDraft | string | Buffer | null>,
  baseRef?: string,
  captureScopes: string[] = [],
  options?: WorkingBranchCreateOptions,
): Promise<WorkingBranchRoot> {
  const { effectiveState, changedPaths } = await overlayDraftsOnBaseline({
    baseState,
    drafts,
    putObject: (bytes) => store.putObject(bytes),
  });

  return store.createBranch(workspaceId, branchId, effectiveState, baseRef, changedPaths, captureScopes, options);
}
