/** Native resource package admission. Installation belongs to the extension/package owner;
 * this reader never installs packages, executes their scripts or consults another runtime. */
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsService } from '../models/settings.js';
import { readResourceSettings, type ConfiguredPackage, type ResourceSettings } from './configuration.js';

export interface InstalledAgentResourcePackage {
  identity: string;
  source: string;
  scope: 'user' | 'project';
  installedPath: string;
}
export const resourceDirectory = (dataDirectory: string, projectRoot?: string) => projectRoot
  ? path.join(projectRoot, '.varin', 'resources') : path.join(dataDirectory, 'resources');

function localPath(value: string, base: string): string | undefined {
  if (value.startsWith('file:')) return fileURLToPath(value);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !path.win32.isAbsolute(value)) return undefined;
  if (value === '~') return homedir();
  if (/^~[/\\]/.test(value)) return path.resolve(homedir(), value.slice(2));
  return path.resolve(base, value);
}
function identity(entry: ConfiguredPackage, canonical: string): string {
  if (entry.source.startsWith('npm:')) {
    const name = entry.source.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.+)?$/)?.[1];
    if (!name) throw new Error('Invalid npm resource package source');
    return `npm:${name}`;
  }
  if (entry.source.startsWith('git:')) {
    const url = new URL(entry.source.slice(4));
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search) throw new Error('Invalid Git resource package source');
    url.hash = ''; url.pathname = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
    return `git:${url.href}`;
  }
  return `local:${canonical}`;
}

export async function readAgentResourceConfiguration(input: {
  dataDirectory: string;
  settings: Pick<AgentSettingsService, 'snapshot' | 'projectTrusted'>;
  cwd?: string;
  /** Parsed from the exact configuration file captured by the resource preparation. */
  resources?: ResourceSettings;
}): Promise<{ projectTrusted: boolean; packages: InstalledAgentResourcePackage[] }> {
  const packages: InstalledAgentResourcePackage[] = [];
  const capturedTrust = input.cwd !== undefined && input.settings.projectTrusted(input.cwd);
  const snapshot = input.resources ? undefined : await input.settings.snapshot(input.cwd);
  const projectTrusted = snapshot?.projectTrusted ?? capturedTrust;
  const selections: { scope: 'user' | 'project'; resources: ResourceSettings; root: string }[] = input.resources
    ? [{ scope: input.cwd ? 'project' : 'user', resources: input.resources, root: resourceDirectory(input.dataDirectory, input.cwd) }]
    : [
      { scope: 'user', resources: readResourceSettings(snapshot!.global), root: resourceDirectory(input.dataDirectory) },
      ...(input.cwd ? [{ scope: 'project' as const, resources: readResourceSettings(snapshot!.project), root: resourceDirectory(input.dataDirectory, input.cwd) }] : []),
    ];
  for (const { scope, resources, root } of selections) {
    if (scope === 'project' && !projectTrusted) continue;
    for (const entry of resources.packages) {
      const candidate = localPath(entry.installedPath ?? entry.source, root);
      // A remote declaration without an explicit native installation remains unavailable.
      // Discovery must not execute a network install or guess another runtime's cache path.
      if (!candidate) continue;
      let canonical: string;
      try { canonical = await realpath(candidate); if (!(await stat(canonical)).isDirectory()) throw new Error('Resource package installation must be a directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      packages.push({ identity: identity(entry, canonical), source: entry.source, scope, installedPath: canonical });
    }
  }
  return { projectTrusted, packages };
}
