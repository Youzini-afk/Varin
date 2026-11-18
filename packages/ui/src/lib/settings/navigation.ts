import type { SettingsPageMeta } from './page-types';

/** Navigation grouped by what the user manages; see docs/design/settings-preview/README.md. */
export const SETTINGS_GROUP_ORDER = ['general', 'models', 'harness', 'capabilities', 'projects', 'connections', 'data'] as const;
export type SettingsNavigationGroup = typeof SETTINGS_GROUP_ORDER[number];
const pages = {
  general: ['general', 'appearance', 'chat', 'notifications', 'voice', 'shortcuts', 'companion'],
  models: ['model-connections', 'model-roles', 'usage'],
  harness: ['harness-bots', 'agents', 'external-agents', 'agent-prompt', 'agent-memory', 'harness-context'],
  capabilities: ['harness-tools', 'harness-permissions', 'workspaces', 'harness-computers', 'browsers', 'harness-web', 'mcp-connections', 'skills', 'extensions'],
  projects: ['projects', 'editor', 'terminal', 'git', 'code-intel'],
  connections: ['devices', 'remote-access', 'proxy'],
  data: ['storage', 'history', 'about'],
} satisfies Record<SettingsNavigationGroup, string[]>;

/** Pages that were folded into another page keep resolving, so old links and saved state land in the right place. */
export const SETTINGS_SLUG_ALIASES: Readonly<Record<string, string>> = {
  sessions: 'model-roles',
  images: 'model-roles',
  'harness-embeddings': 'agent-memory',
  commands: 'skills',
  'harness-retrieval': 'code-intel',
  'language-support': 'code-intel',
  'work-connections': 'devices',
  'remote-instances': 'devices',
  access: 'remote-access',
  tunnel: 'remote-access',
  network: 'proxy',
  providers: 'model-connections',
  models: 'model-connections',
  mcp: 'mcp-connections',
  plugins: 'extensions',
  varin: 'harness-bots',
  instructions: 'agent-prompt',
  memory: 'agent-memory',
  context: 'harness-context',
  tools: 'harness-tools',
  permissions: 'harness-permissions',
  desktops: 'harness-computers',
  web: 'harness-web',
};

export const settingsNavigationGroup = (page: Pick<SettingsPageMeta, 'slug' | 'group'>): SettingsNavigationGroup | SettingsPageMeta['group'] =>
  SETTINGS_GROUP_ORDER.find(group => (pages[group] as string[]).includes(page.slug)) ?? page.group;
export function settingsNavigationOrder(page: Pick<SettingsPageMeta, 'slug' | 'group' | 'order'>) {
  const group = settingsNavigationGroup(page);
  const list = (pages as Record<string, string[]>)[group] ?? [];
  const rank = list.indexOf(page.slug);
  return rank < 0 ? 1000 + page.order : rank;
}
export const isSettingsNavigationPage = (slug: string) => SETTINGS_GROUP_ORDER.some(group => (pages[group] as string[]).includes(slug));
