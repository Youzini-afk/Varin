import { beforeEach, expect, test, vi } from 'vitest';
const f = vi.hoisted(() => ({ save: vi.fn(), read: vi.fn(), project: vi.fn(), home: vi.fn(), calls: [] as string[] }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: f.save }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ conversationOrganization: { read: f.read, project: f.project } }) }));
vi.mock('./useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ homeDirectory: '', goHome: f.home, setDirectory: vi.fn() }) } }));
import { useProjectsStore } from './useProjectsStore';
beforeEach(() => {
  vi.clearAllMocks(); f.calls = [];
  f.read.mockResolvedValue({ rootRevision: 3, containers: [{ id: 'project-node', projectId: 'project', parentId: null, revision: 4, childrenRevision: 5 }] });
  f.save.mockImplementation(async () => { f.calls.push('settings'); return true; });
  f.project.mockImplementation(async () => { f.calls.push('catalog'); return { registered: false, navigation: 'completed' }; });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: null, manualProjectOrder: [] });
});
test('project removal commits the original Settings owner before dissolving navigation, never deleting files', async () => {
  await useProjectsStore.getState().removeProject('project');
  expect(f.calls).toEqual(['settings', 'catalog']);
  expect(useProjectsStore.getState().projects).toEqual([]);
  expect(f.project.mock.calls[0]![0]).toMatchObject({ projectId: 'project', command: { operation: { action: 'dissolve', id: 'project-node', expectedRevision: 4 } } });
});
test('unconfirmed Settings removal leaves the visible project and never claims navigation success', async () => {
  f.save.mockResolvedValue(false);
  await expect(useProjectsStore.getState().removeProject('project')).rejects.toThrow('outcome is unknown');
  expect(useProjectsStore.getState().projects).toHaveLength(1);
  expect(f.project).not.toHaveBeenCalled();
});
test('partial removal retains the Catalog command for retry without recreating the removed registration', async () => {
  f.project.mockResolvedValueOnce({ registered: false, navigation: 'pending', failure: { code: 'unavailable', message: 'offline' } });
  await expect(useProjectsStore.getState().removeProject('project')).rejects.toThrow('navigation cleanup is pending');
  expect(useProjectsStore.getState().projects).toEqual([]);
  const command = f.project.mock.calls[0]![0].command;
  await useProjectsStore.getState().removeProject('project');
  expect(f.project.mock.calls[1]![0].command).toBe(command);
  expect(useProjectsStore.getState().projects).toEqual([]);
});
