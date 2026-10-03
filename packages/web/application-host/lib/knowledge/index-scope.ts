import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface IndexPathScope {
  directories: readonly string[];
  pausedDirectories?: readonly string[] | undefined;
  removedDirectories?: readonly string[] | undefined;
  /** Host-owned private state (for example Bot homes), never a source corpus. */
  excludedDirectories?: readonly string[] | undefined;
}

export interface IndexScope extends IndexPathScope {
  signal: AbortSignal;
}

export const excludedFromIndex = (scope: IndexPathScope | undefined, absolutePath: string): boolean =>
  scope?.excludedDirectories?.some((directory) => insideDirectory(directory, absolutePath)) ?? false;

/** More-specific directory settings override a parent's setting; private Host
 * state always stays excluded. Pause retains query access to published data. */
export function indexPathAllowed(scope: IndexPathScope, absolutePath: string, query = false): boolean {
  if (excludedFromIndex(scope, absolutePath)) return false;
  const rules = [
    ...scope.directories.map((directory) => ({ directory, allowed: true })),
    ...(scope.pausedDirectories ?? []).map((directory) => ({ directory, allowed: query })),
    ...(scope.removedDirectories ?? []).map((directory) => ({ directory, allowed: false })),
  ].filter((rule) => insideDirectory(rule.directory, absolutePath))
    .sort((left, right) => right.directory.length - left.directory.length);
  return rules[0]?.allowed ?? false;
}

export async function resolveScopedIndexRoots(root: string, scope: IndexScope, query = false): Promise<string[]> {
  const selected = query ? [...scope.directories, ...(scope.pausedDirectories ?? [])] : scope.directories;
  return (await resolveIndexScanRoots(root, selected)).filter((directory) => indexPathAllowed(scope, directory, query));
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
  let disposed = false;
  let current = [...new Set(directories)].sort();
  let paused: string[] = [];
  let removed: string[] = [];
  return {
    get: (): IndexScope => ({ directories: current, pausedDirectories: paused, removedDirectories: removed, excludedDirectories, signal: controller.signal }),
    update(next: readonly string[], pausedDirectories: readonly string[] = [], removedDirectories: readonly string[] = []): boolean {
      if (disposed) return false;
      const normalized = [...new Set(next)].sort();
      const nextPaused = [...new Set(pausedDirectories)].sort();
      const nextRemoved = [...new Set(removedDirectories)].sort();
      if (JSON.stringify([normalized, nextPaused, nextRemoved]) === JSON.stringify([current, paused, removed])) return false;
      controller.abort();
      controller = new AbortController();
      current = normalized;
      paused = nextPaused;
      removed = nextRemoved;
      return true;
    },
    dispose: () => { disposed = true; controller.abort(); },
  };
}
