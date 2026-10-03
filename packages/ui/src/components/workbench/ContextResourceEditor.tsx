import React from 'react';
import { ResourceEditorHost } from '@/components/workbench/ResourceEditorHost';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { resolveEditorProviderId } from '@/lib/workbench/editors/providers';
import type { EditorTab, EditorViewState } from '@/lib/workbench/editors/types';
import { useI18n } from '@/lib/i18n';

export const ContextResourceEditor: React.FC<{
  filePath: string;
  viewId: string;
  workspaceRoot: string;
}> = ({ filePath, viewId, workspaceRoot }) => {
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
  const [viewState, setViewState] = React.useState<EditorViewState>({});
  React.useEffect(() => setViewState({}), [resourceId, viewId, workspaceRoot]);
  const tab = React.useMemo<EditorTab | null>(() => resourceId ? ({
    tabId: `context:${viewId}`,
    viewId: `context:${viewId}`,
    resourceId,
    preview: false,
    pinned: true,
    providerId: resolveEditorProviderId(resourceId),
    viewState,
  }) : null, [resourceId, viewId, viewState]);
  const patchViewState = React.useCallback((patch: EditorViewState) => {
    setViewState((current) => ({ ...current, ...patch }));
  }, []);
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
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      tab={tab}
      onViewStateChange={patchViewState}
    />
  );
};
