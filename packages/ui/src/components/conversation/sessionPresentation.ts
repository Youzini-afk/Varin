import type { SidebarConversation as SessionSummary } from './sidebarCatalog';
import { normalizePath } from '@/lib/pathNormalization';

export interface ConversationSessionNode {
  children: ConversationSessionNode[];
  session: SessionSummary;
}

export interface ConversationSessionWorkspaceProject {
  addedAt?: number;
  id: string;
  label?: string | null;
  lastOpenedAt?: number;
  path: string;
  additionalPaths?: readonly string[];
  worktrees?: readonly { path: string }[];
}

export interface ConversationSessionWorkspaceGroup {
  forest: ConversationSessionNode[];
  id: string;
  path: string | null;
  project: ConversationSessionWorkspaceProject | null;
}

export type ConversationSessionPinnedPredicate = (session: SessionSummary) => boolean;

export type ConversationSessionProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

const projectLabel = (project: ConversationSessionWorkspaceProject): string => (
  project.label?.trim() || project.path
);

/**
 * Sorts project entries while preserving the caller's order for ties. The
 * manual order is the order supplied by the projects store; every other mode
 * is deterministic and keeps the project's identity as the final tie-breaker.
 */
export const sortConversationSessionWorkspaceProjects = <T extends ConversationSessionWorkspaceProject>(
  projects: readonly T[],
  order: ConversationSessionProjectSortOrder,
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

export const countConversationSessionSubtreeValues = (
  node: ConversationSessionNode,
  values: Readonly<Record<string, number>>,
  includeChildren: boolean,
): number => {
  const own = values[node.session.id] ?? 0;
  if (!includeChildren) return own;
  return own + node.children.reduce(
    (count, child) => count + countConversationSessionSubtreeValues(child, values, true),
    0,
  );
};

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const conversationSessionTitle = (session: SessionSummary, untitled: string): string => {
  const name = session.name?.trim();
  if (name) return name;
  const firstLine = session.firstMessage
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? untitled;
};

export const compareConversationSessions = (
  left: SessionSummary,
  right: SessionSummary,
  isPinned: ConversationSessionPinnedPredicate = () => false,
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

export const collectConversationSessionSubtreeIds = (
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
export const collectConversationSessionSelectionSubtreeIds = (
  summaries: SessionSummary[],
  selectedIds: ReadonlySet<string>,
): string[] => {
  const ids = new Set<string>();
  for (const sessionId of selectedIds) {
    collectConversationSessionSubtreeIds(summaries, sessionId).forEach((id) => ids.add(id));
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

export const buildConversationSessionForest = (
  input: readonly SessionSummary[],
  isPinned: ConversationSessionPinnedPredicate = () => false,
): ConversationSessionNode[] => {
  const sessions = new Map<string, SessionSummary>();
  for (const session of input) {
    const current = sessions.get(session.id);
    if (!current || compareConversationSessions(session, current) < 0) sessions.set(session.id, session);
  }

  const nodes = new Map<string, ConversationSessionNode>();
  for (const session of sessions.values()) {
    nodes.set(session.id, { children: [], session });
  }

  const roots: ConversationSessionNode[] = [];
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

  const sortNodes = (items: ConversationSessionNode[]): void => {
    items.sort((left, right) => compareConversationSessions(left.session, right.session, isPinned));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
};

/** Return every node as a root, sorted with the same rules as the tree view. */
export const flattenConversationSessionForest = (
  nodes: readonly ConversationSessionNode[],
  isPinned: ConversationSessionPinnedPredicate = () => false,
): ConversationSessionNode[] => {
  const flattened: ConversationSessionNode[] = [];
  const visit = (node: ConversationSessionNode): void => {
    flattened.push({ children: [], session: node.session });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  flattened.sort((left, right) => compareConversationSessions(left.session, right.session, isPinned));
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

type NormalizedWorkspaceProject<T extends ConversationSessionWorkspaceProject = ConversationSessionWorkspaceProject> = T & {
  normalizedPath: string;
  normalizedRoots: string[];
};

const normalizeWorkspaceProjects = <T extends ConversationSessionWorkspaceProject>(
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

export const resolveConversationSessionWorkspaceProject = <T extends ConversationSessionWorkspaceProject>(
  session: SessionSummary,
  projects: T[],
): T | null => createConversationSessionWorkspaceProjectResolver(projects)(session);

const resolveNormalizedWorkspaceProject = <T extends ConversationSessionWorkspaceProject>(
  session: SessionSummary,
  projects: NormalizedWorkspaceProject<T>[],
): NormalizedWorkspaceProject<T> | null => {
  const associated = projects.find(project => session.projectIds.includes(project.id));
  if (associated) return associated;
  const cwd = normalizePath(session.cwd);
  if (cwd === null) return null;
  return projects
    .flatMap((project) => project.normalizedRoots.map((root) => ({ project, root })))
    .filter(({ root }) => pathIsWithin(cwd, root))
    .sort((left, right) => right.root.length - left.root.length)[0]?.project ?? null;
};

export const createConversationSessionWorkspaceProjectResolver = <T extends ConversationSessionWorkspaceProject>(
  projects: T[],
): ((session: SessionSummary) => T | null) => {
  const normalizedProjects = normalizeWorkspaceProjects(projects);
  return (session) => resolveNormalizedWorkspaceProject(session, normalizedProjects);
};

export const groupConversationSessionForestByWorkspace = (
  forest: ConversationSessionNode[],
  projects: ConversationSessionWorkspaceProject[],
  isPinned: ConversationSessionPinnedPredicate = () => false,
  options: {
    includeEmptyProjects?: boolean;
    showRecentSection?: boolean;
  } = {},
): ConversationSessionWorkspaceGroup[] => {
  const normalizedProjects = normalizeWorkspaceProjects(projects);
  const groups = new Map<string, ConversationSessionWorkspaceGroup>();

  const ensureGroup = (project: NormalizedWorkspaceProject | null): ConversationSessionWorkspaceGroup => {
    const id = project ? `workspace:${project.id}` : 'recent';
    const existing = groups.get(id);
    if (existing) return existing;
    const group: ConversationSessionWorkspaceGroup = {
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

  const cloneTree = (node: ConversationSessionNode): ConversationSessionNode => ({
    children: node.children.map(cloneTree),
    session: node.session,
  });

  const visit = (node: ConversationSessionNode): void => {
    const project = resolveNormalizedWorkspaceProject(node.session, normalizedProjects);
    if (project === null && options.showRecentSection === false) {
      // Hiding the unbound zone must not hide a descendant that has explicit
      // ownership in a project. Revisit descendants as roots of their own zone.
      node.children.forEach(visit);
      return;
    }
    // Navigation follows the conversation family. A child may execute in an
    // isolated or unbound workspace without becoming an unrelated Recent item.
    ensureGroup(project).forest.push(cloneTree(node));
  };

  for (const node of forest) {
    visit(node);
  }

  const sortNodes = (nodes: ConversationSessionNode[]): void => {
    nodes.sort((left, right) => compareConversationSessions(left.session, right.session, isPinned));
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

export const filterConversationSessionForest = (
  nodes: ConversationSessionNode[],
  query: string,
  untitled: string,
): ConversationSessionNode[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes.flatMap((node) => {
    const session = node.session;
    const searchable = [
      conversationSessionTitle(session, untitled),
      session.cwd,
      session.firstMessage,

    ].join('\n').toLocaleLowerCase();
    const children = filterConversationSessionForest(node.children, normalizedQuery, untitled);
    if (searchable.includes(normalizedQuery) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
};
