import type { ProjectEntry } from "@varin/application-client";
import { projectFolders, projectPathKey, projectResourceOwnerKey } from "@varin/application-client";
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
    if (p.source?.resourceOwner.kind === 'managed_host') continue;
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
    const exact = projects.find((p) => p.source?.resourceOwner.kind !== 'managed_host' && normalizeProjectPath(p.path) === c) ?? null;
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

/** Execution sources are scoped by the complete owner identity, never by a bare path. */
export function resolveProjectForSource(projects: ProjectEntry[], source: {
  resourceOwner: import('@varin/protocol').SourceResourceOwner;
  projectId?: string;
  workspaceId?: string;
  path?: string;
}): ProjectEntry | null {
  const ownerKey = projectResourceOwnerKey({ source: { resourceOwner: source.resourceOwner, workspaceId: '' } });
  const candidates = projects.filter(project => projectResourceOwnerKey(project) === ownerKey);
  const explicit = candidates.find(project => project.id === source.projectId);
  if (explicit && (!source.workspaceId || !explicit.source || explicit.source.workspaceId === source.workspaceId)) return explicit;
  if (source.workspaceId) {
    const registered = candidates.filter(project => project.source?.workspaceId === source.workspaceId
      || source.resourceOwner.kind === 'local' && project.versionedWorkspace?.workspaceId === source.workspaceId);
    if (registered.length === 1) return registered[0]!;
    if (registered.length > 1) return null;
  }
  const path = source.path ? projectPathKey(source.path) : null;
  if (!path) return null;
  const matches = candidates.flatMap(project => projectFolders(project).flatMap(folder => {
    const root = projectPathKey(folder);
    return path === root || path.startsWith(root === '/' ? '/' : `${root}/`) ? [{ project, depth: root.length }] : [];
  })).sort((a, b) => b.depth - a.depth);
  const best = matches[0];
  if (!best) return null;
  return matches.some(match => match.depth === best.depth && match.project.id !== best.project.id) ? null : best.project;
}

/** Only remote projects use the coordinating Host's registered-project settings namespace.
 * Local defaults follow the frozen cwd; an edited registration must not redirect that read. */
export function projectModelSettingsId(projects: ProjectEntry[], projectId: string | undefined, source: { resourceOwner: import('@varin/protocol').SourceResourceOwner; path: string } | undefined): string | undefined {
  if (!projectId || source?.resourceOwner.kind !== 'managed_host') return undefined;
  const project = projects.find(project => project.id === projectId);
  const registered = project?.source?.resourceOwner;
  if (!project || registered?.kind !== 'managed_host' || registered.hostId !== source.resourceOwner.hostId
    || registered.connectionId !== source.resourceOwner.connectionId || registered.endpointIdentity !== source.resourceOwner.endpointIdentity) return undefined;
  const selected = projectPathKey(source.path);
  return projectFolders(project).some(folder => { const root = projectPathKey(folder); return selected === root || selected.startsWith(root === '/' ? '/' : `${root}/`); }) ? projectId : undefined;
}
