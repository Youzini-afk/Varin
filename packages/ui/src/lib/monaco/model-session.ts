import { getEditorResourceWorkspace } from '@/lib/workbench/editors/resource-workspace';
import { getDocumentRegistry } from '@/lib/documents/session';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { listEditorGroups } from '@/lib/workbench/editors/groups';
import {
  listEditorWorkbenches,
  subscribeEditorWorkbench,
} from '@/lib/workbench/editors/session';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';
import { FileEditorModelRegistry } from './model-registry';

const OFFICIAL_TEXT_PROVIDER_IDS = new Set<string>([
  BUILTIN_EDITOR_PROVIDER_IDS.text,
  BUILTIN_EDITOR_PROVIDER_IDS.markdown,
  BUILTIN_EDITOR_PROVIDER_IDS.json,
  BUILTIN_EDITOR_PROVIDER_IDS.html,
  BUILTIN_EDITOR_PROVIDER_IDS.drawio,
]);

let active: FileEditorModelRegistry | null = null;
let boundDocuments: ReturnType<typeof getDocumentRegistry> | null = null;
let unsubscribeWorkbench: (() => void) | null = null;
let ownedViewIds = new Set<string>();

const syncWorkbenchOwners = (): void => {
  if (!active) return;
  const nextOwners = new Set<string>();
  for (const workbench of listEditorWorkbenches()) {
    if (getEditorResourceWorkspace(workbench.workspaceId)) continue;
    for (const group of listEditorGroups(workbench.tree)) {
      for (const tab of group.tabs) {
        if (!OFFICIAL_TEXT_PROVIDER_IDS.has(tab.providerId)) continue;
        const ownerId = `tab:${workbench.workspaceId}:${tab.viewId}`;
        nextOwners.add(ownerId);
        active.acquire({ workspaceId: workbench.workspaceId, resourceId: tab.resourceId }, ownerId);
      }
    }
  }
  for (const ownerId of ownedViewIds) {
    if (!nextOwners.has(ownerId)) active.release(ownerId);
  }
  ownedViewIds = nextOwners;
};

const reset = (): void => {
  unsubscribeWorkbench?.();
  unsubscribeWorkbench = null;
  active?.dispose();
  active = null;
  boundDocuments = null;
  ownedViewIds = new Set();
};

subscribeRuntimeEndpointWillChange(reset);

export const getFileEditorModelRegistry = (): FileEditorModelRegistry => {
  const documents = getDocumentRegistry();
  if (active && boundDocuments === documents) return active;
  reset();
  boundDocuments = documents;
  active = new FileEditorModelRegistry({ documents, runtimeKey: getRuntimeKey() });
  unsubscribeWorkbench = subscribeEditorWorkbench(syncWorkbenchOwners);
  syncWorkbenchOwners();
  return active;
};
