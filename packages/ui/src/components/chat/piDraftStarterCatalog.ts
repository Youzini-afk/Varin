import type {
  PiResourceCatalogSnapshot,
  RuntimeMethodResult,
} from '@varin/protocol';
import type { DraftStarterType } from '@/lib/draftStarters';

export interface PiDraftStarterCatalogItem {
  invocation: string;
  name: string;
  scope: 'project' | 'user';
  source: string;
  type: DraftStarterType;
}

const resourceScopes = (
  catalog: PiResourceCatalogSnapshot,
): Map<string, 'project' | 'user'> => {
  const scopes = new Map<string, 'project' | 'user'>();
  for (const resource of catalog.resources) {
    if (!resource.active || scopes.has(resource.name)) continue;
    scopes.set(resource.name, resource.sourceInfo.scope === 'project' ? 'project' : 'user');
  }
  return scopes;
};

const skillNameFromCommand = (name: string): string => (
  name.startsWith('skill:') ? name.slice('skill:'.length) : name
);

export const buildPiDraftStarterCatalog = (
  commands: RuntimeMethodResult<'command.list'>,
  skills: PiResourceCatalogSnapshot,
): PiDraftStarterCatalogItem[] => {
  const skillScopes = resourceScopes(skills);
  const items: PiDraftStarterCatalogItem[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const invocationName = command.name.trim();
    if (!invocationName) continue;
    const type: DraftStarterType = command.source === 'skill' ? 'skill' : 'command';
    const name = type === 'skill' ? skillNameFromCommand(invocationName) : invocationName;
    if (!name) continue;
    const key = `${type}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = command.source === 'skill'
        ? skillScopes.get(name) ?? 'user'
        : 'user';
    items.push({
      invocation: `/${invocationName}`,
      name,
      scope,
      source: command.source ?? 'unknown',
      type,
    });
  }

  return items;
};
