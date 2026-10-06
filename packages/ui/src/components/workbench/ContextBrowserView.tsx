import { BrowserResourceView } from './BrowserResourceView';
import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { listEditorGroups } from '@/lib/workbench/editors/groups';
import { useI18n } from '@/lib/i18n';

export function ContextBrowserView({ directory, tabID, initialUrl, editorViewId }: {
  directory: string; tabID: string; initialUrl: string; editorViewId?: string;
}) {
  const { documents } = useRuntimeAPIs();
  const { t } = useI18n();
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [resolved, setResolved] = React.useState<{ directory: string; generation: number; workspaceId?: string; error?: string }>();
  React.useEffect(() => {
    if (!editorViewId) return;
    let cancelled = false;
    void documents.resolveWorkspace({ path: directory }).then(identity => {
      if (!cancelled) setResolved({ directory, generation, workspaceId: identity.workspaceId });
    }).catch(error => {
      if (!cancelled) setResolved({ directory, generation, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [directory, documents, editorViewId, generation]);
  const resolution = resolved?.directory === directory && resolved.generation === generation ? resolved : undefined;
  const workspaceId = resolution?.workspaceId;
  const workbench = useEditorWorkbench(workspaceId);
  const tab = workbench && editorViewId ? listEditorGroups(workbench.tree).flatMap(group => group.tabs)
    .find(candidate => candidate.viewId === editorViewId) : undefined;
  if (editorViewId && !resolution) return <div role="status" className="p-3 typography-meta text-muted-foreground">{t('common.loading')}</div>;
  return <div className="flex h-full min-h-0 flex-col">
    {resolution?.error ? <div role="alert" className="px-3 py-2 typography-meta text-status-error">{resolution.error}</div> : null}
    <div className="min-h-0 flex-1"><BrowserResourceView key={`${generation}:${directory}:${tabID}`} directory={directory} tabID={tabID} initialUrl={initialUrl}
      initialPosition={tab?.viewState.browserPosition} /></div>
  </div>;
}
