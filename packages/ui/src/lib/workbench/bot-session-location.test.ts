import { beforeEach, expect, it, vi } from 'vitest';
import { rememberOrdinarySession, restoreOrdinarySession } from './bot-session-location';

const state = vi.hoisted(() => ({
  sessions: {
    runtimeKey: 'host-a',
    currentSessionId: 'ordinary' as string | null,
    records: { ordinary: { open: true } } as Record<string, { open: boolean }>,
    setCurrentSession: vi.fn((id: string | null) => { state.sessions.currentSessionId = id; }),
  },
  directory: {
    currentDirectory: '/project',
    homeDirectory: '/home',
    setDirectory: vi.fn((path: string) => { state.directory.currentDirectory = path; }),
  },
  projects: {
    activeProjectId: 'project-a' as string | null,
    setActiveProjectIdOnly: vi.fn((id: string | null) => { state.projects.activeProjectId = id; }),
  },
  index: { runtimeKey: 'host-a', ids: new Set(['bot-entry']) },
  ui: { setActiveMainTab: vi.fn() },
  open: vi.fn(),
}));

vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: { getState: () => state.sessions } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => state.directory } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => state.projects } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => state.ui } }));
vi.mock('@/stores/useBotSessionIndex', () => ({ useBotSessionIndex: { getState: () => state.index } }));
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: state.open }));

beforeEach(() => {
  state.sessions.runtimeKey = 'host-a';
  state.sessions.currentSessionId = 'ordinary';
  state.directory.currentDirectory = '/project';
  state.projects.activeProjectId = 'project-a';
  state.sessions.setCurrentSession.mockClear();
  state.directory.setDirectory.mockClear();
  state.projects.setActiveProjectIdOnly.mockClear();
  state.ui.setActiveMainTab.mockClear();
  state.open.mockClear();
});

it('restores the prior ordinary conversation and project after Bot mode', () => {
  rememberOrdinarySession();
  state.sessions.currentSessionId = 'bot-entry';
  state.directory.currentDirectory = '/bots/bot-a';
  state.projects.activeProjectId = null;

  restoreOrdinarySession();

  expect(state.sessions.currentSessionId).toBe('ordinary');
  expect(state.directory.currentDirectory).toBe('/project');
  expect(state.projects.activeProjectId).toBe('project-a');
  expect(state.open).not.toHaveBeenCalled();
});

it('does not restore a conversation from another runtime', () => {
  rememberOrdinarySession();
  state.sessions.runtimeKey = 'host-b';
  state.sessions.currentSessionId = 'bot-entry';
  state.directory.currentDirectory = '/bots/bot-a';
  state.projects.activeProjectId = null;

  restoreOrdinarySession();

  expect(state.sessions.currentSessionId).toBeNull();
  expect(state.directory.currentDirectory).toBe('/home');
  expect(state.projects.activeProjectId).toBeNull();
});
