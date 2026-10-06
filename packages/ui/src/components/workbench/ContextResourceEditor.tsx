import React from 'react';
import { ResourceEditorHost } from '@/components/workbench/ResourceEditorHost';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { activeEditorTab, listEditorGroups } from '@/lib/workbench/editors/groups';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import { useI18n } from '@/lib/i18n';

export const ContextResourceEditor: React.FC<{
  filePath: string;
  viewId: string;
  editorViewId?: string;
  workspaceRoot: string;
}> = ({ filePath, viewId, editorViewId, workspaceRoot }) => {
  const { t } = useI18n();
  const { documents } = useRuntimeAPIs();
  const runtimeGeneration = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration,
  );
  const [resolution, setResolution] = React.useState<{
    root: string; generation: number; workspaceId?: string; error?: string;
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void documents.resolveWorkspace({ path: workspaceRoot }).then((workspace) => {
      if (!cancelled) setResolution({ root: workspaceRoot, generation: runtimeGeneration, workspaceId: workspace.workspaceId });
    }).catch((error: unknown) => {
      if (!cancelled) setResolution({ root: workspaceRoot, generation: runtimeGeneration, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [documents, runtimeGeneration, workspaceRoot]);
  const currentResolution = resolution?.root === workspaceRoot && resolution.generation === runtimeGeneration ? resolution : null;
  const workspaceId = currentResolution?.workspaceId;
  const resourceId = resourceIdFromWorkspacePath(workspaceRoot, filePath);
  const workbench = useEditorWorkbench(workspaceId);
  const active = workbench ? activeEditorTab(workbench) : undefined;
  const allTabs = workbench ? listEditorGroups(workbench.tree).flatMap(group => group.tabs) : [];
  const requested = editorViewId ? allTabs.find(candidate => candidate.viewId === editorViewId && candidate.resourceId === resourceId) : undefined;
  const tab = requested ?? (active?.resourceId === resourceId && !active.providerPinned ? active
    : allTabs.find(candidate => candidate.resourceId === resourceId && !candidate.providerPinned));
  React.useEffect(() => {
    if (workspaceId && resourceId && !tab) openWorkbenchEditor(workspaceId, resourceId, undefined, { preview: true });
  }, [workspaceId, resourceId, tab, viewId]);
  if (!resourceId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-muted-foreground">
        {t('filesView.document.outsideWorkspace')}
      </div>
    );
  }
  if (currentResolution?.error) return <div role="alert" className="flex h-full items-center justify-center p-4 typography-meta text-destructive">{currentResolution.error}</div>;
  if (!workspaceId || !tab) return <div role="status" className="flex h-full items-center justify-center p-4 typography-meta text-muted-foreground">{t('common.loading')}</div>;
  return (
    <ResourceEditorHost
      key={tab.viewId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      tab={tab}
    />
  );
};
