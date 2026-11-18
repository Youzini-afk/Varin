import React from 'react';
import { projectPathKey, projectResourceOwnerKey, type ThreadSourcesAPI, type ThreadSourceTargets } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';

export function useWorkLocationLabel(
  sources: ThreadSourcesAPI, host: number, location: { owner: SourceResourceOwner; path: string; workspaceId?: string | undefined } | undefined,
  allowDefaultLabel = false, showToolLocations = false,
) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const [directory, setDirectory] = React.useState<{ host: number; value: ThreadSourceTargets }>();
  const visible = Boolean(location) || showToolLocations;
  React.useEffect(() => {
    if (!visible) return;
    const request = new AbortController();
    void sources.list(null, request.signal).then(value => {
      if (!request.signal.aborted) setDirectory({ host, value });
    }, () => { /* The bound path remains visible if discovery is unavailable. */ });
    return () => request.abort();
  }, [sources, host, visible]);

  const value = directory?.host === host ? directory.value : undefined;
  const fallback = { label: t('chat.modelControls.default'), targets: value?.targets, unavailable: value?.unavailable };
  if (!location) return fallback;
  const { owner, path, workspaceId } = location;
  const ownerKey = (resourceOwner: SourceResourceOwner) => resourceOwner.kind === 'local'
    ? 'local' : JSON.stringify([resourceOwner.hostId, resourceOwner.connectionId, resourceOwner.endpointIdentity]);
  const key = ownerKey(owner);
  const target = value?.targets.find(row => ownerKey(row.resourceOwner) === key);
  const device = target?.label ?? (owner.kind === 'managed_host'
    ? value?.unavailable.find(row => row.connectionId === owner.connectionId)?.label ?? t('thread.composer.workLocationRemote')
    : t('thread.composer.workLocationService'));
  const samePath = projectPathKey(path);
  const project = projects.find(row => projectResourceOwnerKey(row) === key
    && (projectPathKey(row.path) === samePath || Boolean(workspaceId && row.source?.workspaceId === workspaceId)));
  const saved = value?.workspace?.locations.find(row => 'resourceOwner' in row && ownerKey(row.resourceOwner) === key
    && (projectPathKey(row.path) === samePath || Boolean(workspaceId && row.workspaceId === workspaceId)));
  const workspace = value?.workspace;
  if (allowDefaultLabel && workspace && (workspace.defaultId ? saved?.id === workspace.defaultId
    : key === 'local' && projectPathKey(workspace.servicePath) === samePath)) return fallback;
  return { ...fallback, label: `${device} · ${saved?.name || project?.label || formatDirectoryName(path)}` };
}
