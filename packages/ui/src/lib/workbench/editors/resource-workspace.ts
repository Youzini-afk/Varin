import { getRuntimeKey, subscribeRuntimeEndpointWillChange, type ResourceFileLocation } from '@varin/application-client';
import { getResourceDocumentScope, type ResourceDocumentScope } from '@/lib/documents/resource-session';
import { openWorkbenchEditor } from './session';
import type { EditorViewState } from './types';
import { activeEditorTab } from './groups';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';

export type ProjectEditorFileLocation = ResourceFileLocation & { projectId?: string };
export interface ProjectEditorWorkspace {
  workspaceId: string;
  documentWorkspaceId: string;
  location: ProjectEditorFileLocation;
  scope: ResourceDocumentScope;
}
const workspaces = new Map<string, ProjectEditorWorkspace>();
/** A navigation identity, never sent to Documents or used as an execution source. */
export function resolveProjectEditorWorkspace(location: ProjectEditorFileLocation): ProjectEditorWorkspace {
  const owner = location.resourceOwner.kind === 'managed_host' ? { kind: 'managed_host' as const, hostId: location.resourceOwner.hostId, connectionId: location.resourceOwner.connectionId, endpointIdentity: location.resourceOwner.endpointIdentity } : location.resourceOwner;
  const workspaceId = location.resourceOwner.kind === 'local' ? location.workspaceId
    : `resource-editor:${JSON.stringify([getRuntimeKey(), owner, location.workspaceId, location.root, location.selection ?? null, location.task ?? null, location.projectId ?? null])}`;
  if (owner.kind === 'local') return { workspaceId, documentWorkspaceId: location.workspaceId, location: structuredClone(location), scope: getResourceDocumentScope(owner) };
  let workspace = workspaces.get(workspaceId);
  if (!workspace) {
    workspace = { workspaceId, documentWorkspaceId: location.workspaceId, location: structuredClone(location), scope: getResourceDocumentScope(location.resourceOwner) };
    workspaces.set(workspaceId, workspace);
  }
  return workspace;
}
export function getEditorResourceWorkspace(workspaceId: string | undefined): ProjectEditorWorkspace | undefined {
  if (!workspaceId) return;
  const existing = workspaces.get(workspaceId);
  if (existing) return existing;
  if (!workspaceId.startsWith('resource-editor:')) return;
  // Saved view identities contain only routing metadata, never credentials. The
  // original Host revalidates every read; restoration cannot grant file access.
  try {
    const [runtimeKey, resourceOwner, targetWorkspaceId, root, selection, task, projectId] = JSON.parse(workspaceId.slice('resource-editor:'.length));
    if (runtimeKey !== getRuntimeKey() || resourceOwner?.kind !== 'managed_host'
      || typeof resourceOwner.hostId !== 'string' || typeof resourceOwner.connectionId !== 'string' || typeof resourceOwner.endpointIdentity !== 'string'
      || typeof targetWorkspaceId !== 'string' || typeof root !== 'string') return;
    return resolveProjectEditorWorkspace({ resourceOwner, workspaceId: targetWorkspaceId, root, ...(selection ? { selection } : {}), ...(task ? { task } : {}), ...(typeof projectId === 'string' ? { projectId } : {}) });
  } catch { return; }
}
export function openProjectResourceFile(location: ProjectEditorFileLocation, resourceId: string, options?: { target?: 'editor' | 'context'; preview?: boolean; viewState?: EditorViewState; providerId?: string }) {
  const workspace = resolveProjectEditorWorkspace(location);
  const opened = openWorkbenchEditor(workspace.workspaceId, resourceId, options?.providerId, options);
  const tab = activeEditorTab(opened);
  if (options?.target === 'context' && tab) {
    useUIStore.getState().openContextPanelTab(useDirectoryStore.getState().currentDirectory || location.root, { mode: 'file', targetPath: workspacePathFromResourceId(location.root, resourceId), targetDirectory: location.root, editorWorkspaceId: workspace.workspaceId, editorViewId: tab.viewId, dedupeKey: `${workspace.workspaceId}:${resourceId}` });
  } else useUIStore.getState().setActiveMainTab('files');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('varin:ide-focus-editor'));
  return opened;
}
subscribeRuntimeEndpointWillChange(() => workspaces.clear());
