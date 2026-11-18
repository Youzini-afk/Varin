import type { ProjectEntry } from '@varin/application-client';

/** A managed project's settings use its registration namespace on the Agent service;
 * its path must never be interpreted as the local settings directory. */
export function registeredModelSettingsScope(project?: Pick<ProjectEntry, 'id' | 'source' | 'path'>): { cwd?: string; registeredProjectId?: string } {
  return !project ? {} : project.source?.resourceOwner.kind === 'managed_host' ? { registeredProjectId: project.id } : { cwd: project.path };
}
