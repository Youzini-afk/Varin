/** Fixed workspace baseline at branch create: Git inventory or one directory scan. */

import { createHash } from "node:crypto";
import type fs from "node:fs";
import type path from "node:path";

export type GitBaselineInventory = {
  kind: "git";
  baseRef: string;
  unborn: boolean;
  paths: string[];
  gitlinks: string[];
  /** Index modes for tracked regular files ("100644" | "100755"); restores exec intent where fs cannot (D-243). */
  indexModes?: Record<string, string>;
  /** Workdir identity of dirty/untracked paths; detects content replacement with an unchanged path set. */
  contentIdentities?: Record<string, string>;
  /** Raw byte hashes for all regular working files; Git filters/EOL normalization are bypassed. */
  rawFileHashes?: Record<string, string>;
};

export type BaselineInventory = GitBaselineInventory | { kind: "directory" };

export type WorkdirIdentityIo = {
  readFile: typeof fs.promises.readFile;
  lstat: typeof fs.promises.lstat;
  readlink: typeof fs.promises.readlink;
  join: typeof path.join;
};

/** Default mode for a newly created regular file. Never creates a probe file in the user tree. */
export const defaultNewFileMode = (): number => 0o666 & ~process.umask();

export const withAncestorDirectories = (paths: readonly string[]): string[] => {
  const result = new Set<string>();
  for (const file of paths) {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized === ".") continue;
    result.add(normalized);
    let parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    while (parent) {
      result.add(parent);
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
  }
  return [...result].sort();
};

export const parseGitNullList = (value: string): string[] => value.split("\0").filter(Boolean);

export const parseGitStageList = (value: string): Array<{ mode: string; path: string }> => {
  const entries: Array<{ mode: string; path: string }> = [];
  for (const token of value.split("\0").filter(Boolean)) {
    const tab = token.indexOf("\t");
    if (tab === -1) continue;
    const mode = token.slice(0, tab).trim().split(/\s+/)[0];
    const entryPath = token.slice(tab + 1);
    if (mode && entryPath) entries.push({ mode, path: entryPath });
  }
  return entries;
};

export const isNotGitRepositoryError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /not a git repository/i.test(message);
};

export const isUnbornHeadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /ambiguous argument ['"]?HEAD['"]?/i.test(message)
    || /unknown revision/i.test(message)
    || /needed a single revision/i.test(message);
};

export const gitBaselineFingerprint = (inventory: GitBaselineInventory): string => JSON.stringify({
  baseRef: inventory.baseRef,
  unborn: inventory.unborn,
  paths: [...inventory.paths].sort(),
  gitlinks: [...inventory.gitlinks].sort(),
  indexModes: Object.fromEntries(
    Object.entries(inventory.indexModes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ),
  contentIdentities: Object.fromEntries(
    Object.entries(inventory.contentIdentities ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ),
  ...(inventory.rawFileHashes ? { rawFileHashes: Object.fromEntries(Object.entries(inventory.rawFileHashes).sort(([left], [right]) => left.localeCompare(right))) } : {}),
});

export const directoryBaselineFingerprint = (
  paths: readonly string[],
  contentIdentities?: Record<string, string>,
): string => JSON.stringify({
  kind: "directory",
  paths: [...paths].sort(),
  contentIdentities: Object.fromEntries(
    Object.entries(contentIdentities ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ),
});

export async function workdirContentIdentities(
  directory: string,
  paths: readonly string[],
  io: WorkdirIdentityIo,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const identities: Record<string, string> = {};
  for (const relative of [...new Set(paths)].sort()) {
    signal?.throwIfAborted();
    if (!relative || relative === ".") continue;
    const absolute = io.join(directory, ...relative.split("/"));
    try {
      const stat = await io.lstat(absolute);
      if (stat.isSymbolicLink()) {
        identities[relative] = `symlink:${await io.readlink(absolute)}`;
        continue;
      }
      if (stat.isDirectory()) {
        identities[relative] = `directory:${(stat.mode & 0o7777).toString(8)}`;
        continue;
      }
      const bytes = await io.readFile(absolute, { signal });
      identities[relative] = `file:${createHash("sha256").update(bytes).digest("hex")}:${(stat.mode & 0o7777).toString(8)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        identities[relative] = "missing";
        continue;
      }
      throw error;
    }
  }
  return identities;
}
