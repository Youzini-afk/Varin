import { describe, expect, test } from 'vitest'
import type { ProjectEntry } from "@varin/application-client"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"

describe("useProjectsStore settings synchronization", () => {
  test('retains a named project identity and all folders when its default folder changes', () => {
    const project = { id: 'project_stable', path: '/repo/app', additionalPaths: ['/repo/docs', '/other/lib'], label: 'Product' };
    useProjectsStore.getState().synchronizeFromSettings({ projects: [project], activeProjectId: project.id });
    useProjectsStore.getState().synchronizeFromSettings({ projects: [{ ...project, path: '/other/lib', additionalPaths: ['/repo/app', '/repo/docs'] }], activeProjectId: project.id });
    expect(useProjectsStore.getState().getActiveProject()).toEqual({
      id: project.id, label: 'Product', path: '/other/lib', additionalPaths: ['/repo/app', '/repo/docs'],
    });
  });
  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo", defaultWorkFocus: "research" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test("preserves an explicit no-workspace selection while projects remain available", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo", defaultWorkFocus: "research" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({
      activeProjectId: null,
      projects: [project],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toHaveLength(1)
    expect(useProjectsStore.getState().projects[0]?.label).toBe(project.label)
    expect(useProjectsStore.getState().projects[0]?.path).toBe(project.path)
    expect(useProjectsStore.getState().projects[0]?.defaultWorkFocus).toBe("research")
    expect(useProjectsStore.getState().activeProjectId).toBeNull()
  })
})


test('keeps remote identity, folders and offline metadata separate from the same local path', () => {
  const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'connection-b', endpointIdentity: 'endpoint-b' }, workspaceId: 'remote-workspace' };
  useProjectsStore.getState().synchronizeFromSettings({ activeProjectId: 'remote', projects: [
    { id: 'local', path: '/same', label: 'Same' },
    { id: 'remote', path: '/same', additionalPaths: ['~/remote-only'], source, label: 'Same' },
  ] });
  expect(useProjectsStore.getState().projects).toHaveLength(2);
  expect(useProjectsStore.getState().getActiveProject()).toMatchObject({ id: 'remote', path: '/same', additionalPaths: ['~/remote-only'], source });
});
