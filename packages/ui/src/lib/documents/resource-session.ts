import type { SourceResourceOwner } from '@varin/protocol';
import { getRuntimeKey, registerRuntimeEndpointSwitchBlocker, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { DocumentRegistry } from './registry';
import { createResourceDocumentsAPI } from '@varin/application-client';
import { FileEditorModelRegistry } from '@/lib/monaco/model-registry';
import { getDocumentRegistry, getDocumentRegistryAPI } from './session';
import { getFileEditorModelRegistry } from '@/lib/monaco/model-session';
import { holdEditorWorkspace, retainEditorWorkspace } from './workspace-retention';
import { listEditorWorkbenches, renameWorkbenchResourcePrefix, subscribeEditorWorkbench } from '@/lib/workbench/editors/session';
import { getEditorResourceWorkspace } from '@/lib/workbench/editors/resource-workspace';
import { listEditorGroups } from '@/lib/workbench/editors/groups';

export interface ResourceDocumentScope { documents: DocumentRegistry; models: FileEditorModelRegistry; api: import('@varin/application-client').DocumentsAPI }
const scopes = new Map<string, ResourceDocumentScope>();
const tabOwners = new Map<ResourceDocumentScope, Set<string>>();
const viewers = new WeakMap<DocumentRegistry, Map<string, number>>();
export function retainResourceWorkspace(scope: ResourceDocumentScope, workspaceId: string): () => void {
  const counts = viewers.get(scope.documents) ?? new Map<string, number>();
  viewers.set(scope.documents, counts); counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  const releaseView = holdEditorWorkspace(scope.api, workspaceId);
  return () => {
    counts.set(workspaceId, (counts.get(workspaceId) ?? 1) - 1);
    if (counts.get(workspaceId)) { void releaseView().catch(error => console.error('[Resource documents] Could not release file view', error)); return; }
    counts.delete(workspaceId);
    const retained = listEditorWorkbenches().some(workbench => {
      const resource = getEditorResourceWorkspace(workbench.workspaceId);
      return (resource ? resource.scope === scope && resource.documentWorkspaceId === workspaceId : workbench.workspaceId === workspaceId) && listEditorGroups(workbench.tree).some(group => group.tabs.length);
    });
    if (retained) { void releaseView().catch(error => console.error('[Resource documents] Could not release file view', error)); return; }
    void scope.documents.flushRecoveryJournals().then(async () => {
      if (counts.has(workspaceId)) return;
      scope.documents.releaseClosedWorkspace(workspaceId);
      await retainEditorWorkspace(scope.api, workspaceId, false);
    }).finally(releaseView).catch(error => console.error('[Resource documents] Could not release file view', error));
  };
}
export function getResourceDocumentScope(owner: SourceResourceOwner): ResourceDocumentScope {
  bindWorkbenchModels();
  if (owner.kind === 'local') return { documents: getDocumentRegistry(), models: getFileEditorModelRegistry(), api: getDocumentRegistryAPI() };
  const key = JSON.stringify([getRuntimeKey(), owner.kind, owner.hostId, owner.connectionId, owner.endpointIdentity]);
  let scope = scopes.get(key);
  if (!scope) {
    const api = createResourceDocumentsAPI(owner);
    const documents = new DocumentRegistry({ documents: api });
    scope = { api, documents, models: new FileEditorModelRegistry({ documents, runtimeKey: key }) };
    scopes.set(key, scope);
    const original = scope;
    documents.subscribeResourceMoves((from, to) => {
      if (from.workspaceId !== to.workspaceId) return;
      for (const workbench of listEditorWorkbenches()) {
        const resource = getEditorResourceWorkspace(workbench.workspaceId);
        if (resource?.scope === original && resource.documentWorkspaceId === from.workspaceId) renameWorkbenchResourcePrefix(workbench.workspaceId, from.resourceId, to.resourceId);
      }
    });
  }
  return scope;
}
const flush = () => Promise.all([...scopes.values()].map(scope => scope.documents.flushRecoveryJournals()));
registerRuntimeEndpointSwitchBlocker(async () => { await flush(); });
subscribeRuntimeEndpointWillChange(() => {
  for (const scope of scopes.values()) { scope.models.dispose(); scope.documents.dispose(); }
  scopes.clear();
  tabOwners.clear();
});
if (typeof window !== 'undefined') {
  const save = () => { void flush().catch(error => console.error('[Resource documents] Recovery persistence failed', error)); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}

// Tabs retain the original resource model independently of which shell or view
// is currently mounted, just like local editor tabs. They never enter the local registry.
let modelSubscriptionBound = false;
function bindWorkbenchModels() {
  if (modelSubscriptionBound) return;
  modelSubscriptionBound = true;
  subscribeEditorWorkbench(() => {
    const next = new Map<ResourceDocumentScope, Set<string>>();
    for (const workbench of listEditorWorkbenches()) {
      const resource = getEditorResourceWorkspace(workbench.workspaceId);
      if (!resource || resource.location.resourceOwner.kind === 'local') continue;
      const owners = next.get(resource.scope) ?? new Set<string>();
      next.set(resource.scope, owners);
      for (const group of listEditorGroups(workbench.tree)) for (const tab of group.tabs) {
        if (!['varin.builtin.text', 'varin.builtin.markdown', 'varin.builtin.json', 'varin.builtin.html', 'varin.builtin.drawio'].includes(tab.providerId)) continue;
        const owner = `tab:${workbench.workspaceId}:${tab.viewId}`;
        owners.add(owner);
        resource.scope.models.acquire({ workspaceId: resource.documentWorkspaceId, resourceId: tab.resourceId }, owner);
      }
    }
    for (const [scope, owners] of tabOwners) for (const owner of owners) if (!next.get(scope)?.has(owner)) scope.models.release(owner);
    tabOwners.clear();
    for (const [scope, owners] of next) tabOwners.set(scope, owners);
  });
}
