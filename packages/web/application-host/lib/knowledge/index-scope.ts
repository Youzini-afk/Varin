import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface IndexScope {
  directories: readonly string[];
  /** Host-owned private state (for example Bot homes), never a source corpus. */
  excludedDirectories?: readonly string[];
  signal: AbortSignal;
}

export const excludedFromIndex = (scope: IndexScope | undefined, absolutePath: string): boolean =>
  scope?.excludedDirectories?.some((directory) => insideDirectory(directory, absolutePath)) ?? false;

export async function resolveScopedIndexRoots(root: string, scope: IndexScope): Promise<string[]> {
  return (await resolveIndexScanRoots(root, scope.directories)).filter((directory) => !excludedFromIndex(scope, directory));
}

export const insideDirectory = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Intersect explicitly selected folders with a Documents resource root. */
export async function resolveIndexScanRoots(root: string, selected: readonly string[] | null | undefined): Promise<string[]> {
  // Standalone runtime tests may opt into the entire supplied root. Production
  // always supplies the explicit project collection (empty means no indexing).
  if (selected === null || selected === undefined) return [root];
  const canonical = await Promise.all(selected.map(async (directory) => {
    try { return await realpath(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return directory;
    }
  }));
  const candidates = canonical.flatMap((directory) => {
    if (insideDirectory(directory, root)) return [root];
    return insideDirectory(root, directory) ? [directory] : [];
  }).sort((left, right) => left.length - right.length);
  return candidates.filter((directory, index) => !candidates.slice(0, index).some((earlier) => insideDirectory(earlier, directory)));
}

/** A folder edit cancels work accepted under the previous indexing scope. */
export function createProjectIndexScope(directories: readonly string[], excludedDirectories: readonly string[] = []) {
  let controller = new AbortController();
  let current = [...new Set(directories)].sort();
  return {
    get: (): IndexScope => ({ directories: current, excludedDirectories, signal: controller.signal }),
    update(next: readonly string[]): boolean {
      const normalized = [...new Set(next)].sort();
      if (JSON.stringify(normalized) === JSON.stringify(current)) return false;
      controller.abort();
      controller = new AbortController();
      current = normalized;
      return true;
    },
    dispose: () => controller.abort(),
  };
}
