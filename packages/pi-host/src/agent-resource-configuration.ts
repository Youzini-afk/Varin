/** Configuration-only resource admission. This never resolves, installs or activates a package. */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DefaultPackageManager, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent';
import { mcpHostAgentDir } from './mcp-host-configuration.js';

export interface InstalledAgentResourcePackage {
  identity: string;
  source: string;
  scope: 'user' | 'project';
  installedPath: string;
}
interface GitParser { parseGitUrl(source: string): { host: string; path: string } | null }
let parser: Promise<GitParser> | undefined;
/** The locked SDK 1.0.4 owns this pure normalization contract; no private manager method is invoked. */
function gitParser(): Promise<GitParser> {
  parser ??= (async () => {
    const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const extension = new URL(entry).pathname.endsWith('.ts') ? 'ts' : 'js';
    const value = await import(new URL(`./utils/git.${extension}`, entry).href) as Partial<GitParser>;
    if (typeof value.parseGitUrl !== 'function') throw new Error('Installed package source normalization is unavailable');
    return value as GitParser;
  })();
  return parser;
}

export async function installedAgentPackageIdentity(source: string, installedPath: string): Promise<string> {
  if (source.startsWith('npm:')) {
    const spec = source.slice(4).trim();
    // Identical to the locked SDK's parseNpmSpec: only the version is removed.
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    return `npm:${match?.[1] ?? spec}`;
  }
  const git = (await gitParser()).parseGitUrl(source);
  return git ? `git:${git.host}/${git.path}` : `local:${await realpath(installedPath)}`;
}

export async function readAgentResourceConfiguration(input: {
  agentDir?: string;
  cwd?: string;
} = {}): Promise<{ agentDir: string; projectTrusted: boolean; packages: InstalledAgentResourcePackage[] }> {
  const agentDir = mcpHostAgentDir(input.agentDir);
  const cwd = resolve(input.cwd ?? agentDir);
  const projectTrusted = input.cwd !== undefined && new ProjectTrustStore(agentDir).get(cwd) === true;
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  if (settings.drainErrors().length) throw new Error('Agent resource package configuration is unavailable');
  const manager = new DefaultPackageManager({ agentDir, cwd, settingsManager: settings });
  const packages: InstalledAgentResourcePackage[] = [];
  for (const entry of manager.listConfiguredPackages()) {
    if (!entry.installedPath) continue;
    const installedPath = await realpath(entry.installedPath);
    packages.push({ identity: await installedAgentPackageIdentity(entry.source, installedPath),
      source: entry.source, scope: entry.scope, installedPath });
  }
  return { agentDir, projectTrusted, packages };
}
