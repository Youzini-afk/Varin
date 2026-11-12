import React from 'react';
import { createResourceFilesHttpAPI, freezeProjectSourceSelection, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, type ProjectEntry, type ResourceFileLocation } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useEffectiveDirectory } from './useEffectiveDirectory';

export type ProjectFileLocation = ResourceFileLocation & { projectId?: string };
interface Resolution { location?: ProjectFileLocation; error?: string; loading: boolean }
const EMPTY: Resolution = { loading: false };
const resolutions = new Map<string, Resolution>();
const requests = new Map<string, { promise: Promise<ProjectFileLocation>; controller: AbortController }>();
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const projectFileLocationKey = (project: ProjectEntry) => JSON.stringify([getRuntimeKey(), project.id, project.path, project.source, freezeProjectSourceSelection(project)]);

/** One original target workspace resolution shared by tree, search and palette. */
export function resolveProjectFileLocation(project: ProjectEntry, refresh = false): Promise<ProjectFileLocation> {
  if (project.source?.resourceOwner.kind !== 'managed_host') return Promise.reject(new Error('A managed project source is required'));
  const key = projectFileLocationKey(project);
  const cached = resolutions.get(key);
  if (!refresh && cached?.location) return Promise.resolve(cached.location);
  const pending = requests.get(key); if (pending) return pending.promise;
  const controller = new AbortController();
  const owner = project.source.resourceOwner;
  const selection = freezeProjectSourceSelection(project);
  resolutions.set(key, { loading: true }); publish();
  const promise = createResourceFilesHttpAPI().request({ resourceOwner: owner, selection, command: { kind: 'open', path: project.path } }, controller.signal).then(result => {
    controller.signal.throwIfAborted();
    if (result.kind !== 'opened') throw new Error('The source did not resolve a file workspace');
    const location = { projectId: project.id, resourceOwner: owner, selection, root: result.root, workspaceId: result.workspaceId };
    resolutions.set(key, { loading: false, location }); publish();
    return location;
  }).catch(error => {
    if (!controller.signal.aborted) { resolutions.set(key, { loading: false, error: error instanceof Error ? error.message : String(error) }); publish(); }
    throw error;
  }).finally(() => { if (requests.get(key)?.controller === controller) requests.delete(key); });
  requests.set(key, { promise, controller }); return promise;
}
subscribeRuntimeEndpointWillChange(() => {
  for (const request of requests.values()) request.controller.abort();
  requests.clear(); resolutions.clear(); publish();
});

export interface ProjectFileContext extends Resolution { remote: boolean; key: string; root: string; retry(): void }
export function useProjectFileLocation(enabled = true): ProjectFileContext {
  const runtime = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const project = useProjectsStore(state => state.projects.find(entry => entry.id === state.activeProjectId));
  const localDirectory = useEffectiveDirectory() ?? '';
  const remote = project?.source?.resourceOwner.kind === 'managed_host';
  const key = remote ? projectFileLocationKey(project) : JSON.stringify([runtime, 'local', localDirectory]);
  const resolution = React.useSyncExternalStore(subscribe, () => resolutions.get(key) ?? EMPTY, () => EMPTY);
  React.useEffect(() => {
    if (enabled && remote && project && !resolution.location && !resolution.loading && !resolution.error) void resolveProjectFileLocation(project).catch(() => {});
  }, [enabled, remote, project, resolution]);
  const retry = React.useCallback(() => { if (remote && project) void resolveProjectFileLocation(project, true).catch(() => {}); }, [remote, project]);
  return { ...resolution, remote, key, root: remote ? resolution.location?.root ?? project.path : localDirectory, retry };
}
