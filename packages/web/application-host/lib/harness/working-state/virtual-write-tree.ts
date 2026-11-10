import type { RecoveryState } from "./types.js";

export class VirtualWriteTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualWriteTreeError";
  }
}

const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new VirtualWriteTreeError(`Invalid working-branch path: ${value}`);
  }
  return segments.join("/");
};

const parentPath = (file: string): string => {
  if (!file.includes("/")) return "";
  return file.slice(0, file.lastIndexOf("/"));
};

export const liveViewRevision = (branch: { writeRevision?: number; headRevision: number }): number => (
  Number.isSafeInteger(branch.writeRevision) && Number(branch.writeRevision) >= 0
    ? Number(branch.writeRevision)
    : branch.headRevision
);

const ancestorKindBlocksChild = (kind: RecoveryState["kind"] | undefined): boolean => (
  kind === "regular-file" || kind === "symlink" || kind === "unsupported"
);

export const assertVirtualWriteTree = (
  current: Record<string, RecoveryState>,
  writes: Record<string, RecoveryState>,
): void => {
  const normalized = new Map<string, RecoveryState>();
  for (const [file, next] of Object.entries(writes)) {
    normalized.set(normalizeRelative(file), next);
  }
  const paths = [...normalized.keys()].sort();
  for (let index = 0; index < paths.length; index += 1) {
    const left = paths[index]!;
    for (const right of paths.slice(index + 1)) {
      if (right.startsWith(`${left}/`) || left.startsWith(`${right}/`)) {
        const ancestor = right.startsWith(`${left}/`) ? left : right;
        const child = ancestor === left ? right : left;
        const ancestorWrite = normalized.get(ancestor)!;
        if (ancestorKindBlocksChild(ancestorWrite.kind)) {
          throw new VirtualWriteTreeError(`Cannot write ${child} under ${ancestorWrite.kind} ${ancestor} in the same batch`);
        }
      }
    }
  }
  for (const file of normalized.keys()) {
    let parent = parentPath(file);
    while (parent) {
      const ancestor = normalized.get(parent) ?? current[parent];
      if (ancestorKindBlocksChild(ancestor?.kind)) {
        throw new VirtualWriteTreeError(`Cannot create ${file} under ${ancestor!.kind} ${parent}`);
      }
      parent = parentPath(parent);
    }
  }
};
