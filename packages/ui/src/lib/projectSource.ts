import { runtimeFetch, type ProjectSourceBinding, type ThreadResolvedSource } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
/** Registration uses the same Documents/source owner as execution, without creating a Thread. */
export async function resolveProjectSource(resourceOwner: SourceResourceOwner, path: string, signal?: AbortSignal): Promise<ThreadResolvedSource> {
  const response = await runtimeFetch('/api/projects/sources/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceOwner, path }), signal,
  });
  const result = await response.json() as ThreadResolvedSource & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Project source is unavailable');
  return result;
}
export async function resolveProjectFolders(owner: SourceResourceOwner, folders: string[], signal?: AbortSignal): Promise<{ folders: string[]; source: ProjectSourceBinding }> {
  const resolved = [];
  for (const path of folders) resolved.push(await resolveProjectSource(owner, path, signal));
  if (!resolved[0]) throw new Error('A project needs at least one folder.');
  return { folders: resolved.map(entry => entry.path), source: { resourceOwner: resolved[0].resourceOwner, workspaceId: resolved[0].workspaceId } };
}
