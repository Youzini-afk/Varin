import { renameWorkbenchResourcePrefix } from '@/lib/workbench/editors/session';
import type { DocumentsAPI } from '@varin/application-client';
import { registerRuntimeEndpointSwitchBlocker } from '@varin/application-client';
import { DocumentRegistry } from './registry';

let active: DocumentRegistry | null = null;
let bound: DocumentsAPI | null = null;
let lifecycleBound = false;

const flushRecovery = (): void => {
  void active?.flushRecoveryJournals().catch((error) => {
    console.error('[Documents] Failed to flush recovery journals:', error);
  });
};

const bindRecoveryLifecycle = (): void => {
  if (lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleBound = true;
  window.addEventListener('pagehide', flushRecovery);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRecovery();
  });
  registerRuntimeEndpointSwitchBlocker(async () => {
    await active?.flushRecoveryJournals();
  });
};

export const bindDocumentRegistry = (documents: DocumentsAPI): DocumentRegistry => {
  if (active && bound === documents) return active;
  active?.dispose();
  active = new DocumentRegistry({ documents });
  active.subscribeResourceMoves((from, to) => {
    if (from.workspaceId === to.workspaceId) renameWorkbenchResourcePrefix(from.workspaceId, from.resourceId, to.resourceId);
  });
  bound = documents;
  bindRecoveryLifecycle();
  return active;
};

export const getDocumentRegistry = (): DocumentRegistry => {
  if (!active) throw new Error('Document registry is not bound');
  return active;
};
export const releaseClosedDocumentWorkspace=(workspaceId:string):void=>active?.releaseClosedWorkspace(workspaceId);

export const resetDocumentRegistry = (): void => {
  active?.dispose();
  active = null;
  bound = null;
};
