import type { ProjectEntry } from '@varin/application-client';
import { projectFolders } from '@varin/application-client';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore, selectActivePiSessions } from '@/stores/usePiSessionStore';
import { refreshBotSessionIndex, regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type {
  SessionSnapshot,
  SessionSummary,
  SessionWorkspaceBinding,
} from '@varin/protocol';

export interface PiSessionOpenTarget {
  directory?: string | null;
  sessionId: string;
}

export interface PiSessionCreateTarget {
  directory?: string | null;
  projectId?: string | null;
}

let piSessionNavigationGeneration = 0;
const CANONICAL_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const canRecoverProjectBinding = (workspace: SessionWorkspaceBinding | undefined): boolean => (
  workspace?.kind === 'workspace'
  && (workspace.authorityId !== undefined || CANONICAL_WORKSPACE_ID.test(workspace.id))
);

const beginPiSessionNavigation = (): number => {
  piSessionNavigationGeneration += 1;
  return piSessionNavigationGeneration;
};

const isCurrentPiSessionNavigation = (generation: number, sessionId: string): boolean => (
  generation === piSessionNavigationGeneration
  && usePiSessionStore.getState().currentSessionId === sessionId
);

const comparablePath = (path: string): string => (
  /^[A-Za-z]:(?:\/|$)/.test(path) ? path.toLowerCase() : path
);

const isPathWithin = (path: string, root: string): boolean => {
  const comparableTarget = comparablePath(path);
  const comparableRoot = comparablePath(root);
  return comparableTarget === comparableRoot
    || comparableTarget.startsWith(comparableRoot === '/' ? '/' : `${comparableRoot}/`);
};

export const findPiProjectForCwd = (
  projects: ProjectEntry[],
  cwd: string,
): ProjectEntry | null => {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return null;
  return projects
    .flatMap((project) => projectFolders(project).map((folder) => ({ normalizedPath: normalizePath(folder), project })))
    .filter((entry): entry is { normalizedPath: string; project: ProjectEntry } => (
      entry.normalizedPath !== null && isPathWithin(normalizedCwd, entry.normalizedPath)
    ))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)[0]?.project ?? null;
};

export const resolvePiSessionCreationCwd = (
  target: PiSessionCreateTarget,
  projects: ProjectEntry[],
  activeProjectId: string | null,
  currentDirectory: string,
  homeDirectory?: string,
): string | null => {
  const explicit = target.directory?.trim();
  if (explicit) return explicit;
  const requestedProject = target.projectId
    ? projects.find((project) => project.id === target.projectId)
    : undefined;
  if (requestedProject?.path.trim()) return requestedProject.path;
  const effectiveActiveProjectId = target.projectId === undefined ? activeProjectId : null;
  const activeProject = effectiveActiveProjectId
    ? projects.find((project) => project.id === effectiveActiveProjectId)
    : undefined;
  return activeProject?.path.trim()
    || homeDirectory?.trim()
    || currentDirectory.trim()
    || null;
};

export const resolvePiSessionWorkspaceBinding = (
  target: PiSessionCreateTarget,
  activeProjectId: string | null,
): SessionWorkspaceBinding => {
  const projectId = target.projectId === undefined ? activeProjectId : target.projectId;
  return projectId
    ? { id: projectId, kind: 'workspace' }
    : { kind: 'unbound' };
};

export const resolveRelativePiSession = (
  sessions: readonly SessionSummary[],
  currentSessionId: string | null,
  offset: number,
): SessionSummary | null => {
  if (sessions.length === 0 || !Number.isFinite(offset) || offset === 0) return null;
  const currentIndex = sessions.findIndex((session) => session.id === currentSessionId);
  const baseIndex = currentIndex === -1 ? (offset > 0 ? -1 : 0) : currentIndex;
  const nextIndex = ((baseIndex + Math.trunc(offset)) % sessions.length + sessions.length) % sessions.length;
  return sessions[nextIndex] ?? null;
};

const applyPiSessionLocation = (
  cwd: string,
  preferredProjectId?: string | null,
  workspace?: SessionWorkspaceBinding,
): void => {
  const projectsState = useProjectsStore.getState();
  const boundProject = workspace?.kind === 'workspace'
    ? projectsState.projects.find((project) => project.id === workspace.id)
    : undefined;
  const preferredProject = workspace?.kind === 'unbound'
    ? undefined
    : preferredProjectId
      ? projectsState.projects.find((project) => project.id === preferredProjectId)
      : undefined;
  const project = workspace?.kind === 'unbound'
    ? null
    : workspace?.kind === 'workspace'
      ? boundProject ?? (canRecoverProjectBinding(workspace)
        ? findPiProjectForCwd(projectsState.projects, cwd)
        : null)
      : preferredProject ?? findPiProjectForCwd(projectsState.projects, cwd);
  if ((project?.id ?? null) !== projectsState.activeProjectId) {
    projectsState.setActiveProjectIdOnly(project?.id ?? null);
  }

  const directoryState = useDirectoryStore.getState();
  if (normalizePath(directoryState.currentDirectory) !== normalizePath(cwd)) {
    directoryState.setDirectory(cwd, { showOverlay: false });
  }
  const uiState = useUIStore.getState();
  // Explicit navigation also leaves a task page when reselecting the same
  // conversation or opening another draft (no session-id change to observe).
  uiState.closeMainSurfaces();
  uiState.setActiveMainTab('chat');
  uiState.setSessionSwitcherOpen(false);
};

export const openPiSessionFromNavigation = async (
  target: PiSessionOpenTarget,
): Promise<SessionSnapshot> => {
  const navigationGeneration = beginPiSessionNavigation();
  const sessionId = target.sessionId.trim();
  if (!sessionId) throw new Error('A Pi session ID is required');
  const state = usePiSessionStore.getState();
  const summary = state.summaries.find((candidate) => candidate.id === sessionId);
  const cwd = target.directory?.trim() || summary?.cwd;
  const existing = state.records[sessionId];
  let snapshot: SessionSnapshot;
  if (existing?.open && existing.snapshot && existing.branchEntries) {
    state.setCurrentSession(sessionId);
    snapshot = existing.snapshot;
    if (isCurrentPiSessionNavigation(navigationGeneration, sessionId)) {
      applyPiSessionLocation(snapshot.cwd, undefined, snapshot.workspace ?? summary?.workspace);
    }
  } else {
    const project = cwd ? findPiProjectForCwd(useProjectsStore.getState().projects, cwd) : undefined;
    const workspace = summary?.workspace?.kind === 'workspace' && project
      && canRecoverProjectBinding(summary.workspace)
      ? { ...summary.workspace, id: project.id }
      : summary?.workspace;
    const opening = state.openSession({
      ...(cwd ? { cwd } : {}),
      sessionId,
      ...(workspace === undefined ? {} : { workspace }),
    });
    if (cwd && isCurrentPiSessionNavigation(navigationGeneration, sessionId)) {
      applyPiSessionLocation(cwd, undefined, summary?.workspace);
    }
    snapshot = await opening;
    if (isCurrentPiSessionNavigation(navigationGeneration, sessionId)) {
      applyPiSessionLocation(snapshot.cwd, undefined, snapshot.workspace ?? summary?.workspace);
    }
  }
  return snapshot;
};

export const createPiSessionFromNavigation = async (
  target: PiSessionCreateTarget = {},
): Promise<SessionSnapshot> => {
  const navigationGeneration = beginPiSessionNavigation();
  const projectsState = useProjectsStore.getState();
  const workspace = resolvePiSessionWorkspaceBinding(target, projectsState.activeProjectId);
  const cwd = resolvePiSessionCreationCwd(
    target,
    projectsState.projects,
    projectsState.activeProjectId,
    useDirectoryStore.getState().currentDirectory,
    useDirectoryStore.getState().homeDirectory,
  );
  if (!cwd) throw new Error('A working directory is required to create a Pi session');
  const snapshot = await usePiSessionStore.getState().createSession(cwd, undefined, undefined, workspace);
  if (isCurrentPiSessionNavigation(navigationGeneration, snapshot.sessionId)) {
    applyPiSessionLocation(snapshot.cwd, target.projectId, workspace);
  }
  return snapshot;
};

/**
 * Open the Pi-native pending draft for a regular "new session" navigation.
 *
 * This deliberately does not call `session.create`; the first send from
 * `PiChatView` owns creation so an abandoned draft never becomes a session.
 */
export const startPiSessionDraftFromNavigation = async (
  target: PiSessionCreateTarget = {},
): Promise<void> => {
  beginPiSessionNavigation();
  const projectsState = useProjectsStore.getState();
  const workspace = resolvePiSessionWorkspaceBinding(target, projectsState.activeProjectId);
  const cwd = resolvePiSessionCreationCwd(
    target,
    projectsState.projects,
    projectsState.activeProjectId,
    useDirectoryStore.getState().currentDirectory,
    useDirectoryStore.getState().homeDirectory,
  );
  if (!cwd) throw new Error('A working directory is required to create a Pi session');

  applyPiSessionLocation(cwd, target.projectId, workspace);
  usePiSessionStore.getState().setCurrentSession(null);
};

export const navigateRelativePiSession = async (offset: number): Promise<SessionSnapshot | null> => {
  let state = usePiSessionStore.getState();
  if (!state.catalogLoaded) {
    await state.loadCatalog();
    state = usePiSessionStore.getState();
  }
  await refreshBotSessionIndex(state.runtimeKey);
  const target = resolveRelativePiSession(
    regularPiSessions(selectActivePiSessions(state), useBotSessionIndex.getState(), state.runtimeKey),
    state.currentSessionId,
    offset,
  );
  return target === null
    ? null
    : openPiSessionFromNavigation({ directory: target.cwd, sessionId: target.id });
};
