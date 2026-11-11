import React from 'react';
import { createResourceFilesHttpAPI, getRuntimeEndpointGeneration, projectGitLocation, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, type DocumentsAPI } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { retainResourceWorkspace, type ResourceDocumentScope } from '@/lib/documents/resource-session';
import { resolveProjectEditorWorkspace, type ProjectEditorFileLocation } from './resource-workspace';

export interface GitDocumentWorkspace {
  directory: string;
  workspaceId: string;
  editorWorkspaceId: string;
  scope?: ResourceDocumentScope;
  location?: ProjectEditorFileLocation;
}
const resolutions = new Map<string, Promise<GitDocumentWorkspace>>();
const requests = new Set<AbortController>();
subscribeRuntimeEndpointWillChange(() => {
  for (const controller of requests) controller.abort();
  requests.clear(); resolutions.clear();
});

/** Resolve the exact Git view, not whichever project is currently selected. */
export function resolveGitDocumentWorkspace(directory: string, documents: DocumentsAPI): Promise<GitDocumentWorkspace> {
  const generation = getRuntimeEndpointGeneration();
  const key = JSON.stringify([generation, directory]);
  const existing = resolutions.get(key); if (existing) return existing;
  const controller = new AbortController(); requests.add(controller);
  const promise = (async () => {
    const source = projectGitLocation(directory);
    if (!source) {
      const workspace = await documents.resolveWorkspace({ path: directory });
      controller.signal.throwIfAborted();
      return { directory, workspaceId: workspace.workspaceId, editorWorkspaceId: workspace.workspaceId };
    }
    const result = await createResourceFilesHttpAPI().request({ resourceOwner: source.source.resourceOwner,
      selection: source.selection, command: { kind: 'open', path: source.path } }, controller.signal);
    controller.signal.throwIfAborted();
    if (result.kind !== 'opened') throw new Error('The original Git source did not resolve a file workspace');
    const location = { projectId: source.projectId, resourceOwner: source.source.resourceOwner, selection: source.selection,
      root: result.root, workspaceId: result.workspaceId };
    const workspace = resolveProjectEditorWorkspace(location);
    return { directory: result.root, workspaceId: workspace.documentWorkspaceId, editorWorkspaceId: workspace.workspaceId, scope: workspace.scope, location };
  })().catch(error => { if (resolutions.get(key) === promise) resolutions.delete(key); throw error; })
    .finally(() => requests.delete(controller));
  resolutions.set(key, promise); return promise;
}

export function useGitDocumentWorkspace(directory: string | null | undefined) {
  const documents = useRuntimeAPIs().documents;
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [snapshot, setSnapshot] = React.useState<{ directory: string; generation: number; workspace?: GitDocumentWorkspace; error?: string }>();
  React.useEffect(() => {
    if (!directory) return;
    let current = true;
    void resolveGitDocumentWorkspace(directory, documents).then(workspace => {
      if (current) setSnapshot({ directory, generation, workspace });
    }).catch(error => { if (current) setSnapshot({ directory, generation, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [directory, documents, generation]);
  const workspace = snapshot && snapshot.directory === directory && snapshot.generation === generation ? snapshot.workspace : undefined;
  React.useEffect(() => workspace?.scope ? retainResourceWorkspace(workspace.scope, workspace.workspaceId) : undefined, [workspace]);
  return { workspace, error: snapshot && snapshot.directory === directory && snapshot.generation === generation ? snapshot.error : undefined };
}
