import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@varin/application-client';
import type { SessionSnapshot, SessionSummary } from '@varin/protocol';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  findPiProjectForCwd,
  openPiSessionFromNavigation,
  resolvePiSessionCreationCwd,
  resolvePiSessionWorkspaceBinding,
  resolveRelativePiSession,
  startPiSessionDraftFromNavigation,
} from './sessionNavigation';

const project = (id: string, path: string): ProjectEntry => ({ id, path });
const session = (id: string): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-02T00:00:00.000Z',
  cwd: `D:/work/${id}`,
  firstMessage: '',
  id,
  messageCount: 0,
  persisted: true,
  sessionFile: `D:/sessions/${id}.jsonl`,
  updatedAt: '2026-08-02T00:00:00.000Z',
});

const snapshot = (id: string, cwd: string): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'one-at-a-time',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: id,
  steering: [],
  steeringMode: 'one-at-a-time',
  thinkingLevel: 'off',
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('Pi session navigation', () => {
  test('selects the most specific project containing a session cwd', () => {
    const projects = [
      project('root', 'D:/work'),
      project('nested', 'D:/work/packages/ui'),
      project('other', 'D:/other'),
    ];
    expect(findPiProjectForCwd(projects, 'd:\\WORK\\Packages\\UI\\src')?.id).toBe('nested');
    expect(findPiProjectForCwd(projects, 'D:/unrelated')).toBeNull();
  });

  test('resolves explicit and workspace creation targets while general chat uses home', () => {
    const projects = [project('one', 'D:/one'), project('two', 'D:/two')];
    expect(resolvePiSessionCreationCwd({ directory: 'D:/explicit', projectId: 'two' }, projects, 'one', 'D:/current')).toBe('D:/explicit');
    expect(resolvePiSessionCreationCwd({ projectId: 'two' }, projects, 'one', 'D:/current')).toBe('D:/two');
    expect(resolvePiSessionCreationCwd({}, projects, 'one', 'D:/current')).toBe('D:/one');
    expect(resolvePiSessionCreationCwd({}, projects, null, 'D:/current', 'D:/home')).toBe('D:/home');
    expect(resolvePiSessionCreationCwd({}, projects, null, 'D:/current')).toBe('D:/current');
    expect(resolvePiSessionCreationCwd({}, [], null, '')).toBeNull();
    expect(resolvePiSessionWorkspaceBinding({}, 'one')).toEqual({ id: 'one', kind: 'workspace' });
    expect(resolvePiSessionWorkspaceBinding({ projectId: null }, 'one')).toEqual({ kind: 'unbound' });
  });

  test('navigates the complete active catalog in both directions with wraparound', () => {
    const sessions = [session('newest'), session('middle'), session('oldest')];
    expect(resolveRelativePiSession(sessions, 'newest', 1)?.id).toBe('middle');
    expect(resolveRelativePiSession(sessions, 'newest', -1)?.id).toBe('oldest');
    expect(resolveRelativePiSession(sessions, 'oldest', 1)?.id).toBe('newest');
    expect(resolveRelativePiSession(sessions, 'missing', 1)?.id).toBe('newest');
    expect(resolveRelativePiSession(sessions, 'missing', -1)?.id).toBe('oldest');
    expect(resolveRelativePiSession([], null, 1)).toBeNull();
  });

  test('opens a pending draft without creating a persisted Pi session', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    let createCalls = 0;

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/previous' });
      useProjectsStore.setState({
        activeProjectId: 'draft-project',
        projects: [project('draft-project', 'D:/repo')],
      });
      usePiSessionStore.setState({
        createSession: async () => {
          createCalls += 1;
          throw new Error('session.create must not run while opening a draft');
        },
        currentSessionId: 'existing-session',
      });
      useUIStore.setState({ activeMainTab: 'files', isSessionSwitcherOpen: true, isScheduledTasksDialogOpen: true });

      await startPiSessionDraftFromNavigation({
        directory: 'D:/repo/worktrees/feature',
        projectId: 'draft-project',
      });

      expect(createCalls).toBe(0);
      expect(usePiSessionStore.getState().currentSessionId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/repo/worktrees/feature');
      expect(useProjectsStore.getState().activeProjectId).toBe('draft-project');
      expect(useUIStore.getState().activeMainTab).toBe('chat');
      expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
      expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('opens general chat at home without retaining a workspace selection', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/repo', homeDirectory: 'D:/home' });
      useProjectsStore.setState({
        activeProjectId: 'repo',
        projects: [project('repo', 'D:/repo')],
      });
      usePiSessionStore.setState({ currentSessionId: 'existing-session' });

      await startPiSessionDraftFromNavigation({ projectId: null });

      expect(useProjectsStore.getState().activeProjectId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/home');
      expect(usePiSessionStore.getState().currentSessionId).toBeNull();
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('does not reattach a session when its explicit workspace no longer exists', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    const removedWorkspaceSession = session('removed-workspace');
    removedWorkspaceSession.cwd = 'D:/repo/src';
    removedWorkspaceSession.workspace = { id: 'removed', kind: 'workspace' };

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/repo' });
      useProjectsStore.setState({
        activeProjectId: 'repo',
        projects: [project('repo', 'D:/repo')],
      });
      usePiSessionStore.setState({
        currentSessionId: null,
        openSession: async () => {
          usePiSessionStore.setState({ currentSessionId: removedWorkspaceSession.id });
          return {
            activeTools: [],
            busy: false,
            cwd: removedWorkspaceSession.cwd,
            features: { revision: 0, schemaVersion: 1 },
            followUp: [],
            followUpMode: 'one-at-a-time',
            queuedMessages: [],
            isCompacting: false,
            isStreaming: false,
            leafId: null,
            pendingMessageCount: 0,
            retryAttempt: 0,
            sessionId: removedWorkspaceSession.id,
            steering: [],
            steeringMode: 'one-at-a-time',
            thinkingLevel: 'off',
            workspace: removedWorkspaceSession.workspace,
          };
        },
        summaries: [removedWorkspaceSession],
      });

      await openPiSessionFromNavigation({ sessionId: removedWorkspaceSession.id });

      expect(useProjectsStore.getState().activeProjectId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/repo/src');
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('switches to an already-open session without another runtime request', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    const hotSession = session('hot');
    let openCalls = 0;

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/previous' });
      useProjectsStore.setState({ activeProjectId: null, projects: [] });
      usePiSessionStore.setState({
        currentSessionId: null,
        openSession: async () => {
          openCalls += 1;
          throw new Error('hot sessions must not be reopened');
        },
        records: {
          [hotSession.id]: {
            branchEntries: {
              entries: [],
              leafId: null,
              scope: 'branch',
              sessionId: hotSession.id,
            },
            extensionStates: {},
            open: true,
            sessionId: hotSession.id,
            snapshot: snapshot(hotSession.id, hotSession.cwd),
            toolExecutions: {},
          },
        },
        summaries: [hotSession],
      });

      await openPiSessionFromNavigation({ sessionId: hotSession.id });

      expect(openCalls).toBe(0);
      expect(usePiSessionStore.getState().currentSessionId).toBe(hotSession.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(hotSession.cwd);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('does not let an older open completion move the workspace away from the latest selection', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    const sessionA = session('a');
    const sessionB = session('b');
    const openA = deferred<SessionSnapshot>();
    const openB = deferred<SessionSnapshot>();

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/previous' });
      useProjectsStore.setState({ activeProjectId: null, projects: [] });
      usePiSessionStore.setState({
        currentSessionId: null,
        openSession: (params) => {
          const sessionId = params.sessionId ?? '';
          usePiSessionStore.setState({ currentSessionId: sessionId });
          return sessionId === sessionA.id ? openA.promise : openB.promise;
        },
        summaries: [sessionA, sessionB],
      });

      const first = openPiSessionFromNavigation({ sessionId: sessionA.id });
      const second = openPiSessionFromNavigation({ sessionId: sessionB.id });
      expect(useDirectoryStore.getState().currentDirectory).toBe(sessionB.cwd);

      openB.resolve(snapshot(sessionB.id, sessionB.cwd));
      await second;
      openA.resolve(snapshot(sessionA.id, sessionA.cwd));
      await first;

      expect(usePiSessionStore.getState().currentSessionId).toBe(sessionB.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(sessionB.cwd);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('does not let navigation overwrite a newer direct store selection', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    const sessionA = session('direct-a');
    const sessionB = session('direct-b');
    const opening = deferred<SessionSnapshot>();

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/previous' });
      useProjectsStore.setState({ activeProjectId: null, projects: [] });
      usePiSessionStore.setState({
        currentSessionId: null,
        openSession: () => {
          usePiSessionStore.setState({ currentSessionId: sessionA.id });
          return opening.promise;
        },
        summaries: [sessionA, sessionB],
      });

      const first = openPiSessionFromNavigation({ sessionId: sessionA.id });
      usePiSessionStore.getState().setCurrentSession(sessionB.id);
      useDirectoryStore.getState().setDirectory(sessionB.cwd, { showOverlay: false });

      opening.resolve(snapshot(sessionA.id, sessionA.cwd));
      await first;

      expect(usePiSessionStore.getState().currentSessionId).toBe(sessionB.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(sessionB.cwd);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });
});
