import { beforeEach, expect, it, vi } from 'vitest';
import { rememberOrdinarySession, restoreOrdinarySession } from './bot-session-location';
const state = vi.hoisted(() => ({
  threads: { hostKey: 'host-a', selectedIdentity: { runtime: 'agent' as const, threadId: 'ordinary', branchId: 'fork-a' } as { runtime: 'agent'; threadId: string; branchId: string } | null,
    threads: [{ thread_id: 'ordinary', bot_id: null }], selectThread: vi.fn(async (identity: { runtime: 'agent'; threadId: string; branchId: string }) => { state.threads.selectedIdentity = identity; return identity; }) },
  directory: { currentDirectory: '/project', homeDirectory: '/home', setDirectory: vi.fn((path: string) => { state.directory.currentDirectory = path; }) },
  projects: { activeProjectId: 'project-a' as string | null, setActiveProjectIdOnly: vi.fn((id: string | null) => { state.projects.activeProjectId = id; }) },
  ui: { setActiveMainTab: vi.fn() },
}));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: { getState: () => state.threads, setState: (patch: object) => Object.assign(state.threads, patch) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => state.directory } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => state.projects } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => state.ui } }));
beforeEach(() => {
  state.threads.hostKey = 'host-a'; state.threads.selectedIdentity = { runtime: 'agent', threadId: 'ordinary', branchId: 'fork-a' };
  state.directory.currentDirectory = '/project'; state.projects.activeProjectId = 'project-a'; state.threads.selectThread.mockClear();
});
it('restores the exact ordinary branch and project after Bot mode', () => {
  rememberOrdinarySession(); state.directory.currentDirectory = '/bots/bot-a'; state.projects.activeProjectId = null;
  restoreOrdinarySession();
  expect(state.threads.selectedIdentity).toEqual({ runtime: 'agent', threadId: 'ordinary', branchId: 'fork-a' });
  expect(state.directory.currentDirectory).toBe('/project'); expect(state.projects.activeProjectId).toBe('project-a');
});
it('never restores a same-named conversation on another Host', () => {
  rememberOrdinarySession(); state.threads.hostKey = 'host-b'; state.directory.currentDirectory = '/bots/bot-a';
  restoreOrdinarySession();
  expect(state.threads.selectedIdentity).toBeNull(); expect(state.threads.selectThread).not.toHaveBeenCalled();
  expect(state.directory.currentDirectory).toBe('/home'); expect(state.projects.activeProjectId).toBeNull();
});
