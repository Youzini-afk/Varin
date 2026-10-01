import type { WorkingBranchPathOrigin } from "@varin/protocol";
import type { RecoveryState, WorkingStateReadOptions, WorkingStateRootStore, WorkingStateTreeEntry } from "./types.js";

export interface BranchViewEntry {
  path: string;
  kind: "file" | "directory";
  revision?: string;
}

export interface BranchViewFile {
  path: string;
  bytes: Buffer;
  origin: WorkingBranchPathOrigin;
  revision: string;
  viewRevision: number;
}

export interface ResolvedBranchPath {
  path: string;
  state: RecoveryState;
  origin: WorkingBranchPathOrigin;
  revision: string;
  viewRevision: number;
  entry: WorkingStateTreeEntry;
}

const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new Error(`Invalid branch view path: ${value}`);
  }
  return segments.join("/");
};

const isTextBytes = (bytes: Buffer): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const descendantOf = (file: string, root: string): boolean => (
  !root || file === root || file.startsWith(`${root}/`)
);

const hiddenByTombstone = (states: Record<string, RecoveryState>, file: string): boolean => {
  if (states[file]?.kind === "missing") return true;
  let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  while (parent) {
    if (states[parent]?.kind === "missing") return true;
    parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
  }
  return false;
};

export const branchViewRevision = (branchId: string, revision: number, origin: WorkingBranchPathOrigin): string => (
  `working-branch:${branchId}@${revision}:${origin}`
);

export function listBranchView(
  states: Record<string, RecoveryState>,
  root: string,
  options: { branchId: string; revision: number; immediate?: boolean },
): BranchViewEntry[] {
  const normalizedRoot = normalizeRelative(root);
  const entries = new Map<string, BranchViewEntry>();
  const addDirectory = (relative: string): void => {
    const path = relative || ".";
    if (!entries.has(path)) {
      entries.set(path, { path, kind: "directory", revision: branchViewRevision(options.branchId, options.revision, "base") });
    }
  };
  if (!normalizedRoot || states[normalizedRoot]?.kind === "directory") addDirectory(normalizedRoot || ".");
  if (normalizedRoot && hiddenByTombstone(states, normalizedRoot)) return [];
  if (normalizedRoot && states[normalizedRoot]?.kind === "regular-file") {
    return [{
      path: ".",
      kind: "file",
      revision: branchViewRevision(options.branchId, options.revision, "base"),
    }];
  }

  for (const [file, state] of Object.entries(states)) {
    if (!descendantOf(file, normalizedRoot) || hiddenByTombstone(states, file)) continue;
    if (state.kind === "missing") continue;
    const relative = normalizedRoot ? (file === normalizedRoot ? "." : file.slice(normalizedRoot.length + 1)) : file;
    if (!relative) continue;
    if (options.immediate && relative.includes("/")) {
      const child = relative.slice(0, relative.indexOf("/"));
      addDirectory(child);
      continue;
    }
    if (state.kind === "directory") {
      addDirectory(relative);
      continue;
    }
    if (state.kind === "regular-file" || state.kind === "symlink" || state.kind === "unsupported") {
      entries.set(relative, {
        path: relative,
        kind: "file",
        revision: branchViewRevision(options.branchId, options.revision, "base"),
      });
      if (!options.immediate) {
        let ancestor = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
        while (ancestor) {
          addDirectory(ancestor);
          ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "";
        }
      }
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

export async function resolveBranchPath(
  store: WorkingStateRootStore,
  branchId: string,
  file: string,
  revision?: number,
  readOptions?: Omit<WorkingStateReadOptions, "revision">,
): Promise<ResolvedBranchPath | null> {
  const branch = await store.getBranchRoot(branchId, readOptions);
  if (!branch) return null;
  const path = normalizeRelative(file);
  const entry = await store.readPath(branchId, path, {
    ...(revision === undefined ? {} : { revision }),
    ...readOptions,
  });
  if (!entry) return null;
  const requested = entry.viewRevision ?? readOptions?.pin?.writeRevision ?? revision ?? branch.writeRevision;
  return {
    path,
    state: entry.state,
    origin: entry.origin,
    revision: branchViewRevision(branchId, requested, entry.origin),
    viewRevision: requested,
    entry,
  };
}

export async function readBranchFile(
  store: WorkingStateRootStore,
  branchId: string,
  file: string,
  revision?: number,
  options?: { followSymlinks?: boolean; seen?: ReadonlySet<string>; read?: Omit<WorkingStateReadOptions, "revision"> },
): Promise<BranchViewFile | { missing: true; path: string; revision: string; viewRevision: number; origin: WorkingBranchPathOrigin } | { unavailable: string }> {
  const resolved = await resolveReadableBranchPath(store, branchId, file, revision, options);
  if ('missing' in resolved || 'unavailable' in resolved) return resolved;
  const bytes = await store.readContent(resolved.entry, { ...(options?.read?.signal ? { signal: options.read.signal } : {}) });
  if (!bytes) return { unavailable: `Working-state object is missing for ${resolved.path}` };
  return { path: resolved.path, bytes, origin: resolved.origin, revision: resolved.revision, viewRevision: resolved.viewRevision };
}

export async function resolveReadableBranchPath(
  store: WorkingStateRootStore, branchId: string, file: string, revision?: number,
  options?: { followSymlinks?: boolean; seen?: ReadonlySet<string>; read?: Omit<WorkingStateReadOptions, 'revision'> },
): Promise<ResolvedBranchPath | { missing: true; path: string; revision: string; viewRevision: number; origin: WorkingBranchPathOrigin } | { unavailable: string }> {
  const resolved = await resolveBranchPath(store, branchId, file, revision, options?.read);
  if (!resolved) return { unavailable: `Working branch ${branchId} is unavailable` };
  if (resolved.state.kind === "missing") {
    return { missing: true, path: resolved.path, revision: resolved.revision, viewRevision: resolved.viewRevision, origin: resolved.origin };
  }
  if (resolved.state.kind === "directory") {
    return { unavailable: `${resolved.path || "."} is a directory` };
  }
  if (resolved.state.kind === "unsupported") {
    return { unavailable: `${resolved.path} is not a readable file in this branch` };
  }
  if (resolved.state.kind === "symlink") {
    if (options?.followSymlinks === false) {
      return { unavailable: `${resolved.path} is a symlink and cannot be read as text` };
    }
    const seen = new Set(options?.seen);
    if (seen.has(resolved.path)) {
      return { unavailable: `${resolved.path} is a symlink cycle` };
    }
    seen.add(resolved.path);
    const target = resolved.state.symlinkTarget;
    if (!target || target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.includes("..")) {
      return { unavailable: `${resolved.path} is a symlink that cannot be resolved inside the branch view` };
    }
    const parent = resolved.path.includes("/") ? resolved.path.slice(0, resolved.path.lastIndexOf("/")) : "";
    const joined = parent ? `${parent}/${target}` : target;
    return resolveReadableBranchPath(store, branchId, joined, revision, {
      followSymlinks: true,
      seen,
      ...(options?.read ? { read: options.read } : {}),
    });
  }
  return resolved;
}

export async function listBranchTextFiles(
  store: WorkingStateRootStore,
  branchId: string,
  prefixes: readonly string[],
  revision?: number,
  options?: Omit<WorkingStateReadOptions, "revision">,
): Promise<Array<BranchViewFile & { text: string }>> {
  const roots = prefixes.length > 0 ? prefixes.map(normalizeRelative) : [""];
  const read = await store.listPaths(branchId, roots, {
    ...(revision === undefined ? {} : { revision }),
    ...options,
  });
  if (!read) return [];
  const states = Object.fromEntries(read.entries.map((entry) => [entry.path, entry.state]));
  const files: Array<BranchViewFile & { text: string }> = [];
  for (const entry of read.entries) {
    options?.signal?.throwIfAborted();
    if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw new DOMException("Explore query deadline exceeded", "AbortError");
    }
    const { path: file, state } = entry;
    if (state.kind !== "regular-file" || hiddenByTombstone(states, file)) continue;
    if (!roots.some((root) => descendantOf(file, root))) continue;
    const bytes = await store.readContent(entry, { ...(options?.signal ? { signal: options.signal } : {}) });
    if (!bytes || !isTextBytes(bytes)) continue;
    files.push({
      path: file,
      bytes,
      text: bytes.toString("utf8"),
      origin: entry.origin,
      revision: branchViewRevision(branchId, read.viewRevision, entry.origin),
      viewRevision: read.viewRevision,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listBranchViewFromStore(
  store: WorkingStateRootStore,
  branchId: string,
  root: string,
  options?: { revision?: number; immediate?: boolean; signal?: AbortSignal },
): Promise<BranchViewEntry[] | null> {
  const read = await store.listPaths(branchId, [root], {
    ...(options?.revision === undefined ? {} : { revision: options.revision }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!read) return null;
  return listBranchView(
    Object.fromEntries(read.entries.map((entry) => [entry.path, entry.state])),
    root,
    { branchId, revision: read.viewRevision, ...(options?.immediate === undefined ? {} : { immediate: options.immediate }) },
  );
}
