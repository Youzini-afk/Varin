import type { I18nKey } from '@/lib/i18n';
import type { PiAgentCatalogSnapshot, PiAgentDescriptor } from '@varin/protocol';
import type { AgentProviderFilter, AgentStatusFilter } from './agents-catalog-store';

export const AGENT_KIND_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  delegatable: 'settings.varin.pluginSettings.subagents.kind.delegatable',
  internal: 'settings.varin.agents.kind.internal',
  primary: 'settings.varin.agents.kind.primary',
  profile: 'settings.varin.agents.kind.profile',
  service: 'settings.varin.agents.kind.service',
  workflow: 'settings.varin.pluginSettings.subagents.kind.workflow',
};

export function filterAgentsCatalog(
  catalog: PiAgentCatalogSnapshot,
  query: string,
  providerFilter: AgentProviderFilter,
  statusFilter: AgentStatusFilter,
): PiAgentDescriptor[] {
  const providerById = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return catalog.agents.filter((agent) => {
    if (providerFilter !== 'all' && agent.providerId !== providerFilter) return false;
    if (statusFilter !== 'all' && agent.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    const provider = providerById.get(agent.providerId);
    const haystack = [
      agent.name,
      agent.id,
      agent.description,
      agent.kind,
      agent.status,
      agent.model,
      agent.thinking,
      agent.source.scope,
      agent.source.path,
      agent.source.packageName,
      provider?.label,
      provider?.id,
      provider?.source,
      ...(agent.aliases ?? []),
      ...(agent.fallbackModels ?? []),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

