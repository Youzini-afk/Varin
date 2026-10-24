import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { EditorGroupsLayout } from '@/components/workbench/EditorGroupsLayout';
import { ResourceEditorHost } from '@/components/workbench/ResourceEditorHost';
import { WorkbenchPanelArea } from '@/components/workbench/WorkbenchPanelArea';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDirtyResourceIds } from '@/lib/documents/hooks';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import {
  closeWorkbenchEditor,
  ensureEditorWorkbench,
  moveWorkbenchEditor,
  pinWorkbenchEditor,
  setActiveWorkbenchEditor,
  setActiveWorkbenchWorkspaceId,
  setWorkbenchSplitRatio,
  splitActiveEditor,
} from '@/lib/workbench/editors/session';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { activeEditorTab, listEditorGroups } from '@/lib/workbench/editors/groups';
import type { EditorTab } from '@/lib/workbench/editors/types';
import { useFilesExplorerStore } from '@/stores/useFilesExplorerStore';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';
import { closeEmbeddedBrowserPage } from '@/lib/browser-page';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';

export const EditorWorkbenchArea: React.FC<{ showPanel?: boolean }> = ({ showPanel = true }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const workspaceId = useWorkbenchWorkspaceId();
  const root = useEffectiveDirectory() ?? '';
  const editorWorkbench = useEditorWorkbench(workspaceId);
  const dirtyResourceIds = useDirtyResourceIds(workspaceId);
  const [closingTab, setClosingTab] = React.useState<EditorTab | null>(null);
  const requestClose = React.useCallback((tabId: string): void => {
    if (!workspaceId) return;
    const state = ensureEditorWorkbench(workspaceId);
    const tab = listEditorGroups(state.tree)
      .flatMap((group) => group.tabs)
      .find((candidate) => candidate.tabId === tabId);
    if (!tab) return;
    const record = getDocumentRegistry().get({ workspaceId, resourceId: tab.resourceId });
    if (record?.dirty) {
      setClosingTab(tab);
      return;
    }
    closeWorkbenchEditor(workspaceId, tabId);
    if (tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser) closeEmbeddedBrowserPage(root, tab.viewState.browserTabId ?? tab.viewId);
  }, [workspaceId, root]);
  const closePending = React.useCallback((): void => {
    if (!workspaceId || !closingTab) return;
    closeWorkbenchEditor(workspaceId, closingTab.tabId);
    setClosingTab(null);
  }, [closingTab, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !root) return;
    const legacy = useFilesExplorerStore.getState().consumeLegacyEditorTabs(root);
    const resourceIds = legacy.openPaths
      .map((path) => resourceIdFromWorkspacePath(root, path))
      .filter((resourceId): resourceId is string => resourceId !== null && resourceId.length > 0);
    const selectedResourceId = legacy.selectedPath
      ? resourceIdFromWorkspacePath(root, legacy.selectedPath) ?? undefined
      : undefined;
    ensureEditorWorkbench(workspaceId, {
      resourceIds,
      ...(selectedResourceId ? { selectedResourceId } : {}),
    });
  }, [root, workspaceId]);

  React.useEffect(() => {
    setActiveWorkbenchWorkspaceId(workspaceId);
    return () => setActiveWorkbenchWorkspaceId(undefined);
  }, [workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !editorWorkbench) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      const tab = activeEditorTab(editorWorkbench);
      if (!tab) return;
      event.preventDefault();
      void getDocumentRegistry().save({ workspaceId, resourceId: tab.resourceId }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorWorkbench, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const tab = editorWorkbench ? activeEditorTab(editorWorkbench) : undefined;
    setWorkbenchContextKey('editorIsOpen', Boolean(tab));
    setWorkbenchContextKey('editorDirty', Boolean(tab && dirtyResourceIds.has(tab.resourceId)));
    setWorkbenchContextKey('editorResource', tab?.resourceId ?? '');
  }, [dirtyResourceIds, editorWorkbench, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const dispose = [
      registerWorkbenchCommand('workbench.action.splitEditor', 'files', () => {
        splitActiveEditor(workspaceId, 'vertical');
      }),
      registerWorkbenchCommand('workbench.action.splitEditorOrthogonal', 'files', () => {
        splitActiveEditor(workspaceId, 'horizontal');
      }),
      registerWorkbenchCommand('workbench.action.closeActiveEditor', 'files', () => {
        const state = ensureEditorWorkbench(workspaceId);
        const tab = activeEditorTab(state);
        if (tab) requestClose(tab.tabId);
      }),
      registerWorkbenchMenuItem({
        id: 'editor.tab.split',
        commandId: 'workbench.action.splitEditor',
        group: 'editor/tab',
        order: 1,
        when: { editorIsOpen: true },
      }),
    ];
    return () => {
      for (const unregister of dispose) unregister();
    };
  }, [requestClose, workspaceId]);

  if (!workspaceId || !root || !editorWorkbench) {
    return <div className="h-full min-h-0 bg-background" />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorGroupsLayout
          tree={editorWorkbench.tree}
          activeGroupId={editorWorkbench.activeGroupId}
          workspaceRoot={root}
          workspaceId={workspaceId}
          dirtyResourceIds={dirtyResourceIds}
          alwaysShowActions={isMobile || isTablet}
          isMobile={isMobile}
          onActivate={(groupId, tabId) => setActiveWorkbenchEditor(workspaceId, groupId, tabId)}
          onClose={requestClose}
          onPin={(tabId, pinned) => pinWorkbenchEditor(workspaceId, tabId, pinned)}
          onMove={(tabId, targetGroupId) => moveWorkbenchEditor(workspaceId, tabId, targetGroupId)}
          onSplitRatio={(splitId, ratio) => setWorkbenchSplitRatio(workspaceId, splitId, ratio)}
          renderEditor={(_group, tab) => tab
            ? <ResourceEditorHost workspaceId={workspaceId} workspaceRoot={root} tab={tab} />
            : (
              <div className="flex h-full items-center justify-center typography-ui text-muted-foreground">
                {t('filesView.editor.selectFile')}
              </div>
            )}
        />
      </div>
      {showPanel ? <WorkbenchPanelArea workspaceId={workspaceId} directory={root} /> : null}

      <Dialog open={Boolean(closingTab)} onOpenChange={(open) => { if (!open) setClosingTab(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('filesView.unsaved.title')}</DialogTitle>
          </DialogHeader>
          <p className="typography-body text-muted-foreground">{t('filesView.unsaved.description')}</p>
          <DialogFooter className="flex-wrap">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!closingTab) return;
                getDocumentRegistry().discard({ workspaceId, resourceId: closingTab.resourceId });
                closePending();
              }}
            >
              {t('filesView.unsaved.discard')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void getDocumentRegistry().flushRecoveryJournals()
                  .then(closePending)
                  .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
              }}
            >
              {t('filesView.document.conflict.keepEdits')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!closingTab) return;
                const identity = { workspaceId, resourceId: closingTab.resourceId };
                void getDocumentRegistry().save(identity)
                  .then((saved) => {
                    if (!saved.dirty) closePending();
                  })
                  .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
              }}
            >
              {t('filesView.unsaved.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
