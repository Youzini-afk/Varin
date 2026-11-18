import type { SettingsPageMeta } from './page-types';

export const SETTINGS_GROUP_ORDER = ['general', 'models', 'harness', 'capabilities', 'projects', 'connections', 'data'] as const;
const pages = {
  general: ['general', 'appearance', 'chat', 'notifications', 'voice', 'shortcuts', 'companion'],
  models: ['model-connections', 'model-roles', 'sessions', 'images', 'usage'],
  harness: ['harness-bots', 'agents', 'external-agents', 'agent-prompt', 'agent-memory', 'harness-embeddings', 'harness-context'],
  capabilities: ['harness-tools', 'harness-permissions', 'workspaces', 'harness-computers', 'browsers', 'harness-web', 'mcp-connections', 'skills', 'commands', 'extensions'],
  projects: ['projects', 'editor', 'terminal', 'git', 'harness-retrieval', 'language-support'],
  connections: ['work-connections', 'remote-instances', 'access', 'tunnel', 'network'],
  data: ['storage', 'history', 'about'],
} satisfies Record<typeof SETTINGS_GROUP_ORDER[number], string[]>;

export const settingsNavigationGroup = (page: SettingsPageMeta) =>
  SETTINGS_GROUP_ORDER.find(group => (pages[group] as string[]).includes(page.slug)) ?? page.group;
export function settingsNavigationOrder(page: SettingsPageMeta) {
  const rank = (pages[settingsNavigationGroup(page)] as string[]).indexOf(page.slug);
  return rank < 0 ? 1000 + page.order : rank;
}
