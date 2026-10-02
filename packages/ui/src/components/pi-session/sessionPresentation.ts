import type { SessionSummary } from '@varin/protocol';
import { normalizePath } from '@/lib/pathNormalization';

export interface PiSessionNode {
  children: PiSessionNode[];
  session: SessionSummary;
}

export interface PiSessionWorkspaceProject {
  addedAt?: number;
  id: string;
  label?: string | null;
  lastOpenedAt?: number;
  path: string;
  additionalPaths?: readonly string[];
  worktrees?: readonly { path: string }[];
}

export interface PiSessionWorkspaceGroup {
  forest: PiSessionNode[];
  id: string;
  path: string | null;
  project: PiSessionWorkspaceProject | null;
}

export type PiSessionPinnedPredicate = (session: SessionSummary) => boolean;

export type PiSessionProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

const projectLabel = (project: PiSessionWorkspaceProject): string => (
  project.label?.trim() || project.path
);

/**
 * Sorts project entries while preserving the caller's order for ties. The
 * manual order is the order supplied by the projects store; every other mode
 * is deterministic and keeps the project's identity as the final tie-breaker.
 */
export const sortPiSessionWorkspaceProjects = <T extends PiSessionWorkspaceProject>(
  projects: readonly T[],
  order: PiSessionProjectSortOrder,
): T[] => {
  if (order === 'manual') return [...projects];
  return projects
    .map((project, index) => ({ index, project }))
    .sort((left, right) => {
      if (order === 'a-z' || order === 'z-a') {
        const compared = projectLabel(left.project).localeCompare(projectLabel(right.project), undefined, {
          sensitivity: 'base',
          numeric: true,
        });
        if (compared !== 0) return order === 'a-z' ? compared : -compared;
      } else {
        const leftValue = order === 'recent'
          ? (left.project.lastOpenedAt ?? left.project.addedAt ?? 0)
          : (left.project.addedAt ?? 0);
        const rightValue = order === 'recent'
          ? (right.project.lastOpenedAt ?? right.project.addedAt ?? 0)
          : (right.project.addedAt ?? 0);
        if (leftValue !== rightValue) return rightValue - leftValue;
      }
      return left.index - right.index;
    })
    .map(({ project }) => project);
};

export const countPiSessionSubtreeValues = (
  node: PiSessionNode,
  values: Readonly<Record<string, number>>,
  includeChildren: boolean,
): number => {
  const own = values[node.session.id] ?? 0;
  if (!includeChildren) return own;
  return own + node.children.reduce(
    (count, child) => count + countPiSessionSubtreeValues(child, values, true),
    0,
  );
};

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const piSessionTitle = (session: SessionSummary, untitled: string): string => {
  const name = session.name?.trim();
  if (name) return name;
  const firstLine = session.firstMessage
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? untitled;
};

export const comparePiSessions = (
  left: SessionSummary,
  right: SessionSummary,
  isPinned: PiSessionPinnedPredicate = () => false,
): number => {
  const leftPinned = isPinned(left);
  const rightPinned = isPinned(right);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (updated !== 0) return updated;
  const created = timestamp(right.createdAt) - timestamp(left.createdAt);
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
};

export const collectPiSessionSubtreeIds = (
  summaries: SessionSummary[],
  rootId: string,
): string[] => {
  const root = summaries.find((summary) => summary.id === rootId);
  if (!root) return [];
  const archived = root.archivedAt !== undefined;
  const children = new Map<string, string[]>();
  for (const summary of summaries) {
    if (!summary.parentId || (summary.archivedAt !== undefined) !== archived) continue;
    const siblings = children.get(summary.parentId) ?? [];
    siblings.push(summary.id);
    children.set(summary.parentId, siblings);
  }

  const ids: string[] = [];
  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const sessionId = pending.pop();
    if (!sessionId || visited.has(sessionId)) continue;
    visited.add(sessionId);
    ids.push(sessionId);
    const childIds = children.get(sessionId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) pending.push(childId);
    }
  }
  return ids;
};

/** Collect selected roots and their descendants once, even when both are selected. */
export const collectPiSessionSelectionSubtreeIds = (
  summaries: SessionSummary[],
  selectedIds: ReadonlySet<string>,
): string[] => {
  const ids = new Set<string>();
  for (const sessionId of selectedIds) {
    collectPiSessionSubtreeIds(summaries, sessionId).forEach((id) => ids.add(id));
  }
  return [...ids];
};

const createsParentCycle = (
  sessionId: string,
  parentId: string,
  sessions: ReadonlyMap<string, SessionSummary>,
): boolean => {
  const visited = new Set<string>([sessionId]);
  let candidateId: string | undefined = parentId;
  while (candidateId !== undefined) {
    if (visited.has(candidateId)) return true;
    visited.add(candidateId);
    const candidate = sessions.get(candidateId);
    candidateId = candidate?.parentId ?? undefined;
  }
  return false;
};

export const buildPiSessionForest = (
  input: readonly SessionSummary[],
  isPinned: PiSessionPinnedPredicate = () => false,
): PiSessionNode[] => {
  const sessions = new Map<string, SessionSummary>();
  for (const session of input) {
    const current = sessions.get(session.id);
    if (!current || comparePiSessions(session, current) < 0) sessions.set(session.id, session);
  }

  const nodes = new Map<string, PiSessionNode>();
  for (const session of sessions.values()) {
    nodes.set(session.id, { children: [], session });
  }

  const roots: PiSessionNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.session.parentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (
      parent === undefined
      || (parent.session.archivedAt === undefined) !== (node.session.archivedAt === undefined)
      || createsParentCycle(node.session.id, parentId!, sessions)
    ) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const sortNodes = (items: PiSessionNode[]): void => {
    items.sort((left, right) => comparePiSessions(left.session, right.session, isPinned));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
};

/** Return every node as a root, sorted with the same rules as the tree view. */
export const flattenPiSessionForest = (
  nodes: readonly PiSessionNode[],
  isPinned: PiSessionPinnedPredicate = () => false,
): PiSessionNode[] => {
  const flattened: PiSessionNode[] = [];
  const visit = (node: PiSessionNode): void => {
    flattened.push({ children: [], session: node.session });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  flattened.sort((left, right) => comparePiSessions(left.session, right.session, isPinned));
  return flattened;
};

const comparablePath = (path: string): string => (
  /^[A-Za-z]:(?:\/|$)/.test(path) ? path.toLowerCase() : path
);

const pathIsWithin = (path: string, root: string): boolean => {
  const target = comparablePath(path);
  const candidate = comparablePath(root);
  return target === candidate || target.startsWith(candidate === '/' ? '/' : `${candidate}/`);
};

type NormalizedWorkspaceProject<T extends PiSessionWorkspaceProject = PiSessionWorkspaceProject> = T & {
  normalizedPath: string;
  normalizedRoots: string[];
};

const normalizeWorkspaceProjects = <T extends PiSessionWorkspaceProject>(
  projects: T[],
): NormalizedWorkspaceProject<T>[] => projects
  .flatMap((project) => {
    const normalizedPath = normalizePath(project.path);
    if (normalizedPath === null) return [];
    const normalizedRoots = [
      normalizedPath,
      ...(project.additionalPaths ?? []).flatMap((folder) => normalizePath(folder) ?? []),
      ...(project.worktrees ?? []).flatMap((worktree) => {
        const path = normalizePath(worktree.path);
        return path === null ? [] : [path];
      }),
    ].sort((left, right) => right.length - left.length);
    return [{ ...project, normalizedPath, normalizedRoots }];
  });

export const resolvePiSessionWorkspaceProject = <T extends PiSessionWorkspaceProject>(
  session: SessionSummary,
  projects: T[],
): T | null => createPiSessionWorkspaceProjectResolver(projects)(session);

const resolveNormalizedWorkspaceProject = <T extends PiSessionWorkspaceProject>(
  session: SessionSummary,
  projects: NormalizedWorkspaceProject<T>[],
): NormalizedWorkspaceProject<T> | null => {
  const binding = session.workspace;
  if (binding?.kind === 'unbound') return null;
  if (binding?.kind === 'workspace') {
    return projects.find((project) => project.id === binding.id) ?? null;
  }
  const cwd = normalizePath(session.cwd);
  if (cwd === null) return null;
  return projects
    .flatMap((project) => project.normalizedRoots.map((root) => ({ project, root })))
    .filter(({ root }) => pathIsWithin(cwd, root))
    .sort((left, right) => right.root.length - left.root.length)[0]?.project ?? null;
};

export const createPiSessionWorkspaceProjectResolver = <T extends PiSessionWorkspaceProject>(
  projects: T[],
): ((session: SessionSummary) => T | null) => {
  const normalizedProjects = normalizeWorkspaceProjects(projects);
  return (session) => resolveNormalizedWorkspaceProject(session, normalizedProjects);
};

export const groupPiSessionForestByWorkspace = (
  forest: PiSessionNode[],
  projects: PiSessionWorkspaceProject[],
  isPinned: PiSessionPinnedPredicate = () => false,
  options: {
    includeEmptyProjects?: boolean;
    showRecentSection?: boolean;
  } = {},
): PiSessionWorkspaceGroup[] => {
  const normalizedProjects = normalizeWorkspaceProjects(projects);
  const groups = new Map<string, PiSessionWorkspaceGroup>();

  const ensureGroup = (project: NormalizedWorkspaceProject | null): PiSessionWorkspaceGroup => {
    const id = project ? `workspace:${project.id}` : 'recent';
    const existing = groups.get(id);
    if (existing) return existing;
    const group: PiSessionWorkspaceGroup = {
      forest: [],
      id,
      path: project?.normalizedPath ?? null,
      project,
    };
    groups.set(id, group);
    return group;
  };

  if (options.includeEmptyProjects) {
    for (const project of normalizedProjects) ensureGroup(project);
  }

  const visit = (
    node: PiSessionNode,
    parent: PiSessionNode | null,
    parentGroupId: string | null,
  ): void => {
    const project = resolveNormalizedWorkspaceProject(node.session, normalizedProjects);
    if (project === null && options.showRecentSection === false) {
      // Hiding the unbound zone must not hide a descendant that has explicit
      // ownership in a project. Revisit descendants as roots of their own zone.
      node.children.forEach((child) => visit(child, null, null));
      return;
    }
    const group = ensureGroup(project);
    const clone: PiSessionNode = { children: [], session: node.session };
    if (parent !== null && parentGroupId === group.id) parent.children.push(clone);
    else group.forest.push(clone);
    for (const child of node.children) visit(child, clone, group.id);
  };

  for (const node of forest) {
    visit(node, null, null);
  }

  const sortNodes = (nodes: PiSessionNode[]): void => {
    nodes.sort((left, right) => comparePiSessions(left.session, right.session, isPinned));
    for (const node of nodes) sortNodes(node.children);
  };
  for (const group of groups.values()) sortNodes(group.forest);

  const projectOrder = new Map(projects.map((project, index) => [`workspace:${project.id}`, index]));
  return [...groups.values()].sort((left, right) => {
    if (left.id === right.id) return 0;
    if (left.id === 'recent') return 1;
    if (right.id === 'recent') return -1;
    return (projectOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (projectOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
};

export const filterPiSessionForest = (
  nodes: PiSessionNode[],
  query: string,
  untitled: string,
): PiSessionNode[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes.flatMap((node) => {
    const session = node.session;
    const searchable = [
      piSessionTitle(session, untitled),
      session.cwd,
      session.firstMessage,
      session.allMessagesText,
    ].join('\n').toLocaleLowerCase();
    const children = filterPiSessionForest(node.children, normalizedQuery, untitled);
    if (searchable.includes(normalizedQuery) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
};
