/** Resolve an explicitly selected registered project through the existing source owner.
 * The frozen descriptor selects a source; registration/admission still supplies its authority. */
import path from 'node:path';
import type { ThreadIdentity, ThreadPreparedSource, ThreadPrepareSource } from '@varin/application-client';
import type { ChildProjectSource, ChildWorkMode, KernelWorkspaceBackend } from './protocol.generated.js';
import { WorkspaceBackendUnavailableError } from './native-workspaces.js';
import type { SourceDirectory } from './thread-sources.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';

export type ChildProjectSourcePreparer = (project: ChildProjectSource, identity: ThreadIdentity, key: string,
  mode: ChildWorkMode, sourcePath: string | null, signal: AbortSignal) => Promise<ThreadPreparedSource>;

export function createChildProjectSourcePreparer(owners: {
  projects(): Promise<Array<{ id: string; path: string }>>;
  inspectBackend(projectId: string, signal: AbortSignal): Promise<KernelWorkspaceBackend & { hostId?: string }>;
  sources: Pick<SourceDirectory, 'resolve'>;
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
}): ChildProjectSourcePreparer {
  return async (selected, identity, key, mode, relative, signal) => {
    const project = (await owners.projects()).find(row => row.id === selected.id);
    if (!project || normalizePathIdentity(project.path) !== normalizePathIdentity(selected.path)) {
      throw Object.assign(new Error('The selected project was removed or its location changed; select it again.'), { code: 'project_source_changed' });
    }
    if (mode === 'isolated_write') {
      const backend=await owners.inspectBackend(selected.id,signal);
      if (!backend.dependenciesReady) throw new WorkspaceBackendUnavailableError(backend);
    }
    // sourcePath was validated as a normalized relative directory by native dispatch admission.
    const directory = relative ? path.join(project.path, ...relative.split('/')) : project.path;
    const source = await owners.sources.resolve({ resourceOwner: selected.resource_owner, path: directory }, signal);
    return owners.prepare({ ...identity, key, workspaceId: source.workspaceId, resourceOwner: source.resourceOwner,
      mode: mode === 'isolated_write' ? 'materialized' : 'live_root', content: { mode: 'saved-files' }, captureScopes: [] }, signal);
  };
}
