/** Resolve an explicitly selected registered project through the existing source owner.
 * The frozen descriptor selects a source; registration/admission still supplies its authority. */
import path from 'node:path';
import { projectResourceOwnerKey, type ProjectSourceBinding } from '@varin/application-client';
import type { ThreadIdentity, ThreadPreparedSource, ThreadPrepareSource } from '@varin/application-client';
import type { ChildProjectSource, ChildWorkMode, KernelWorkspaceBackend } from './protocol.generated.js';
import { WorkspaceBackendUnavailableError } from './native-workspaces.js';
import type { SourceDirectory } from './thread-sources.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';

export type ChildProjectSourcePreparer = (project: ChildProjectSource, identity: ThreadIdentity, key: string,
  mode: ChildWorkMode, sourcePath: string | null, signal: AbortSignal) => Promise<ThreadPreparedSource>;

export function createChildProjectSourcePreparer(owners: {
  projects(): Promise<Array<{ id: string; path: string; source?: ProjectSourceBinding }>>;
  inspectBackend(projectId: string, signal: AbortSignal): Promise<KernelWorkspaceBackend & { hostId?: string }>;
  sources: Pick<SourceDirectory, 'resolve'>;
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
}): ChildProjectSourcePreparer {
  return async (selected, identity, key, mode, relative, signal) => {
    const project = (await owners.projects()).find(row => row.id === selected.id);
    if (!project || normalizePathIdentity(project.path) !== normalizePathIdentity(selected.path)
      || projectResourceOwnerKey(project) !== projectResourceOwnerKey({ source: { resourceOwner: selected.resource_owner, workspaceId: '' } })) {
      throw Object.assign(new Error('The selected project was removed or its location changed; select it again.'), { code: 'project_source_changed' });
    }
    if (selected.selection?.mode === 'native_workspace') {
      if (project.source && selected.selection.workspaceId !== project.source.workspaceId) throw Object.assign(new Error('The frozen project registration changed.'), {code:'project_source_changed'});
      const selection = { ...selected.selection, ...(relative ? { nativeScope: relative } : {}) };
      return owners.prepare({ ...identity, key, workspaceId: selection.workspaceId, resourceOwner: selected.resource_owner,
        mode: mode === 'isolated_write' ? 'materialized' : mode === 'read_only' ? 'fixed_branch' : 'native_workspace',
        selection, content: { mode: 'saved-files' }, captureScopes: [] }, signal);
    }
    if (mode === 'isolated_write' && selected.resource_owner.kind === 'local') {
      const backend=await owners.inspectBackend(selected.id,signal);
      if (!backend.dependenciesReady) throw new WorkspaceBackendUnavailableError(backend);
    }
    // Resolve with the selected Host's path syntax, not the coordinator's OS.
    const paths = /^[a-zA-Z]:[\\/]|^\\\\/.test(project.path) ? path.win32 : path.posix;
    const directory = relative ? paths.resolve(project.path, relative) : project.path;
    const source = await owners.sources.resolve({ resourceOwner: selected.resource_owner, path: directory }, signal);
    if (!relative && project.source && source.workspaceId !== project.source.workspaceId) throw Object.assign(new Error('The project source registration changed; select it again.'), { code: 'project_source_changed' });
    return owners.prepare({ ...identity, key, workspaceId: source.workspaceId, resourceOwner: source.resourceOwner,
      mode: mode === 'isolated_write' ? 'materialized' : mode === 'read_only' ? 'fixed_branch' : 'live_root', ...(selected.selection ? {selection:selected.selection} : {}), content: { mode: 'saved-files' }, captureScopes: [] }, signal);
  };
}
