import { parseProjectSourceBinding } from './project-folders.js';
import { freezeProjectSourceSelection, type ProjectSourceSelection } from './threads.js';
import type { ProjectEntry, WorkspaceLocation } from './types.js';
import type { SourceResourceOwner } from '@varin/protocol';

const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
export function parseDefaultWorkspaceLocationId(value: unknown): string | null {
  if (value === null || nonempty(value)) return value;
  throw new Error('The default workspace location must name a saved location or be null');
}

export function parseWorkspaceLocations(value: unknown): WorkspaceLocation[] {
  if (!Array.isArray(value)) throw new Error('Workspace locations must be an array');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid workspace location');
    const row = item as Record<string, unknown>;
    if (!nonempty(row.id) || ids.has(row.id)) throw new Error('Workspace location IDs must be nonempty and unique');
    ids.add(row.id);
    if (row.kind === 'project' && nonempty(row.projectId) && Object.keys(row).length === 3) {
      return { kind: 'project', id: row.id, projectId: row.projectId };
    }
    if (row.kind === 'folder' && nonempty(row.path) && nonempty(row.name)
      && Object.keys(row).every(key => ['kind', 'id', 'name', 'path', 'resourceOwner', 'workspaceId'].includes(key))) {
      const binding = parseProjectSourceBinding({ resourceOwner: row.resourceOwner, workspaceId: row.workspaceId })!;
      return { kind: 'folder', id: row.id, name: row.name.trim(), path: row.path, ...binding };
    }
    throw new Error('Invalid workspace location');
  });
}

/** A locator for *preparation*. Never interpret a managed path on this computer.
 * Missing projects stay unavailable rather than falling back to the service directory. */
export function workspaceLocationSource(location: WorkspaceLocation, projects: readonly ProjectEntry[]): {
  name: string; resourceOwner: SourceResourceOwner; path: string; workspaceId?: string; selection?: ProjectSourceSelection;
} {
  if (location.kind === 'folder') return location;
  const project = projects.find(project => project.id === location.projectId);
  if (!project) throw new Error('The saved workspace project is no longer registered. Choose another location.');
  return { name: project.label || project.path, resourceOwner: project.source?.resourceOwner ?? { kind: 'local' },
    path: project.path, ...(project.source ? { workspaceId: project.source.workspaceId } : {}), selection: freezeProjectSourceSelection(project) };
}
