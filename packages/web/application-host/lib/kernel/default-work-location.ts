import { parseWorkspaceLocations, parseDefaultWorkspaceLocationId, workspaceLocationSource,
  type ThreadLocationDirectory, type ProjectEntry, type ProjectSourceSelection, type ThreadIdentity, type ThreadPrepareSource, type ThreadPreparedSource } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { SourceDirectory } from './thread-sources.js';
import { SourceAdmissionError } from './source-admission-error.js';

/** Only for a first use, after branch history/explicit chat-only and task limits
 * have been considered. Never substitute the coordinator when a saved owner is unavailable. */
export function preferredWorkLocation(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown }, projects: ProjectEntry[]) {
  const id = parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null);
  if (id === null) return null;
  const selected = parseWorkspaceLocations(settings.workspaceLocations).find(row => row.id === id);
  if (!selected) throw new Error('The default workspace location is no longer saved; choose another location');
  return workspaceLocationSource(selected, projects);
}

export async function prepareWorkLocation(identity: ThreadIdentity, key: string,
  location: { resourceOwner: SourceResourceOwner; path: string; workspaceId?: string | null; selection?: ProjectSourceSelection },
  directory: Pick<SourceDirectory, 'resolve'>,
  prepare: (input: ThreadPrepareSource, signal?: AbortSignal) => Promise<ThreadPreparedSource>, signal?: AbortSignal) {
  const selected = location.selection?.mode === 'native_workspace'
    ? { resourceOwner: location.resourceOwner, workspaceId: location.selection.workspaceId }
    : await directory.resolve({ resourceOwner: location.resourceOwner, path: location.path }, signal);
  if (!isDeepStrictEqual(location.resourceOwner, selected.resourceOwner) || location.workspaceId && selected.workspaceId !== location.workspaceId) {
    throw new SourceAdmissionError('source_changed');
  }
  return (await prepare({ ...identity, key, resourceOwner: selected.resourceOwner, workspaceId: selected.workspaceId,
    mode: location.selection?.mode ?? 'live_root', ...(location.selection ? { selection: location.selection } : {}),
    content: { mode: 'saved-files' }, captureScopes: [] }, signal)).source;
}

export function listWorkLocations(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown },
  projects: ProjectEntry[], servicePath: string): ThreadLocationDirectory {
  return { servicePath, defaultId: parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null),
    locations: parseWorkspaceLocations(settings.workspaceLocations ?? []).map(row => {
      if (row.kind === 'project' && !projects.some(project => project.id === row.projectId)) {
        return { id: row.id, name: row.projectId, unavailable: 'Project no longer registered' };
      }
      const { name, resourceOwner, path, workspaceId, selection } = workspaceLocationSource(row, projects);
      return { id: row.id, name, resourceOwner, path, ...(workspaceId ? { workspaceId } : {}), ...(selection ? { selection } : {}) };
    }) };
}
