import type { ProjectEntry } from "@varin/application-client";
import { projectFolders, projectPathKey } from "@varin/application-client";
import type { WorktreeMetadata } from "@/types/worktree";

import { normalizePath } from "@/lib/pathNormalization";
export const normalizeProjectPath = normalizePath;

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = directory ? projectPathKey(directory) : null;
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  let bestLength = -1;
  for (const p of projects) {
    for (const folder of projectFolders(p)) {
      const pp = projectPathKey(folder);
      if (nd !== pp && !nd.startsWith(pp === '/' ? '/' : `${pp}/`)) continue;
      if (pp.length > bestLength) { best = p; bestLength = pp.length; }
    }
  }
  return best;
};

const resolveProjectFromWorktreeDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let matchedWorktree: WorktreeMetadata | null = null;
  let matchedProjectPath: string | null = null;
  let bestLen = -1;
  for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
    for (const wt of worktrees) {
      const wp = normalizeProjectPath(wt.path);
      if (!wp) continue;
      if (nd !== wp && !nd.startsWith(`${wp}/`)) continue;
      if (wp.length > bestLen) {
        bestLen = wp.length;
        matchedWorktree = wt;
        matchedProjectPath = normalizeProjectPath(projectPath);
      }
    }
  }
  if (!matchedWorktree) return null;
  const candidates = [normalizeProjectPath(matchedWorktree.projectDirectory), matchedProjectPath]
    .filter((v): v is string => Boolean(v));
  for (const c of candidates) {
    const exact = projects.find((p) => normalizeProjectPath(p.path) === c) ?? null;
    if (exact) return exact;
    const nested = resolveProjectForDirectory(projects, c);
    if (nested) return nested;
  }
  return null;
};

export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null =>
  resolveProjectForDirectory(projects, directory) ??
  resolveProjectFromWorktreeDirectory(projects, availableWorktreesByProject, directory);
