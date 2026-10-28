import { runtimeFetch, projectPathKey, type ProjectEntry, type VersionedProjectWorkspace, type WorkspaceBackendStatus } from '@varin/application-client';
export async function openWorkspaceBackendSettings(id: string): Promise<void> {
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/workspace/backend-settings`, { method: 'POST' });
    if (!response.ok) { const value = await response.json() as { message?: string }; throw new Error(value.message ?? 'Cannot open Host extension settings'); }
}
export type { WorkspaceBackendStatus } from '@varin/application-client';
export interface ProjectWorkspaceStatus {
    preparing: boolean;
    workspace: VersionedProjectWorkspace | null;
    executionPath: string | null;
    mountState: string | null;
    leases: number;
    progress: {
        phase: string;
        entries: number;
        bytes: number;
    } | null;
    capabilities: {
        mountCompiled: boolean;
        hardlinks: boolean;
        symlinks: boolean;
        xattrs: boolean;
    } | null;
}
export async function inspectWorkspaceBackend(id: string, signal?: AbortSignal): Promise<WorkspaceBackendStatus> {
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/workspace/backend`, { method: 'POST', signal });
    const value = await response.json() as WorkspaceBackendStatus & { message?: string };
    if (!response.ok) throw new Error(value.message ?? 'Workspace backend inspection failed');
    return value;
}
export async function projectWorkspaceRequest(id: string, action: 'enable' | 'disable' | 'inspect', signal?: AbortSignal): Promise<ProjectWorkspaceStatus> {
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/workspace/${action}`, { method: 'POST', signal });
    const result = await response.json() as ProjectWorkspaceStatus & {
        message?: string;
    };
    if (!response.ok)
        throw new Error(result.message ?? 'Workspace is unavailable');
    return result;
}
export async function projectExecutionPath(project: Pick<ProjectEntry, 'id' | 'path'> & Partial<Pick<ProjectEntry, 'versionedWorkspace'>>): Promise<string> {
    // Navigation and worktree consumers commonly carry a small project reference.
    // Resolve its current configuration only when it is the registered root;
    // a worktree/subdirectory using the same project ID keeps its own path.
    if (!project.versionedWorkspace) {
        const { useProjectsStore } = await import('@/stores/useProjectsStore');
        const saved = useProjectsStore.getState().projects.find(item => item.id === project.id && projectPathKey(item.path) === projectPathKey(project.path));
        if (saved)
            project = saved;
    }
    if (project.versionedWorkspace?.state !== 'ready')
        return project.path;
    const status = await projectWorkspaceRequest(project.id, 'inspect');
    if (status.mountState !== 'ready' || !status.executionPath)
        throw new Error('The project workspace is unavailable');
    return status.executionPath;
}
