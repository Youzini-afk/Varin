import type { SourceResourceOwner } from '@varin/protocol';
import { getRuntimeKey, registerRuntimeEndpointSwitchBlocker, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { DocumentRegistry } from './registry';
import { createResourceDocumentsAPI } from '@varin/application-client';
import { FileEditorModelRegistry } from '@/lib/monaco/model-registry';
import { getDocumentRegistry } from './session';
import { getFileEditorModelRegistry } from '@/lib/monaco/model-session';
import { holdEditorWorkspace, retainEditorWorkspace } from './workspace-retention';
import { peekEditorWorkbench } from '@/lib/workbench/editors/session';
import { listEditorGroups } from '@/lib/workbench/editors/groups';

export interface ResourceDocumentScope { documents: DocumentRegistry; models: FileEditorModelRegistry; api: import('@varin/application-client').DocumentsAPI }
const scopes = new Map<string, ResourceDocumentScope>();
const viewers = new WeakMap<DocumentRegistry, Map<string, number>>();
export function retainResourceWorkspace(scope: ResourceDocumentScope, workspaceId: string): () => void {
  const counts = viewers.get(scope.documents) ?? new Map<string, number>();
  viewers.set(scope.documents, counts); counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  const releaseView = holdEditorWorkspace(scope.api, workspaceId);
  return () => {
    counts.set(workspaceId, (counts.get(workspaceId) ?? 1) - 1);
    if (counts.get(workspaceId)) { void releaseView().catch(error => console.error('[Resource documents] Could not release file view', error)); return; }
    counts.delete(workspaceId);
    const workbench = peekEditorWorkbench(workspaceId);
    if (workbench && listEditorGroups(workbench.tree).some(group => group.tabs.length)) { void releaseView().catch(error => console.error('[Resource documents] Could not release file view', error)); return; }
    void scope.documents.flushRecoveryJournals().then(async () => {
      if (counts.has(workspaceId)) return;
      scope.documents.releaseClosedWorkspace(workspaceId);
      await retainEditorWorkspace(scope.api, workspaceId, false);
    }).finally(releaseView).catch(error => console.error('[Resource documents] Could not release file view', error));
  };
}
export function getResourceDocumentScope(owner: SourceResourceOwner): ResourceDocumentScope {
  if (owner.kind === 'local') return { documents: getDocumentRegistry(), models: getFileEditorModelRegistry(), api: createResourceDocumentsAPI(owner) };
  const key = JSON.stringify([getRuntimeKey(), owner]);
  let scope = scopes.get(key);
  if (!scope) {
    const api = createResourceDocumentsAPI(owner);
    const documents = new DocumentRegistry({ documents: api });
    scope = { api, documents, models: new FileEditorModelRegistry({ documents, runtimeKey: key }) };
    scopes.set(key, scope);
  }
  return scope;
}
const flush = () => Promise.all([...scopes.values()].map(scope => scope.documents.flushRecoveryJournals()));
registerRuntimeEndpointSwitchBlocker(async () => { await flush(); });
subscribeRuntimeEndpointWillChange(() => {
  for (const scope of scopes.values()) { scope.models.dispose(); scope.documents.dispose(); }
  scopes.clear();
});
if (typeof window !== 'undefined') {
  const save = () => { void flush().catch(error => console.error('[Resource documents] Recovery persistence failed', error)); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}
