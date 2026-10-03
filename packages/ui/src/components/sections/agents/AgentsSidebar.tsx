import React from 'react';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { nativeAgentLabel } from './agents-catalog-model';
import { useAgentsPageCatalog } from './useAgentsPageCatalog';
import { requestAgentsCatalogDefinition, selectAgentsCatalogAgent, setAgentsCatalogProviderFilter, setAgentsCatalogQuery, setAgentsCatalogShowAllFocuses } from './agents-catalog-store';

export function AgentsSidebar({ onItemSelect }: { onItemSelect?: () => void }) {
  const { t } = useI18n();
  const { state, catalog, agents, selected, focus, refresh } = useAgentsPageCatalog();
  const nativeRevision = catalog.agents.find(agent => agent.providerId === 'varin')?.definition?.revision;
  const canCreatePlugin = catalog.providers.some(provider => provider.id === 'pi-subagents' && provider.available && provider.actions.some(action => action.id === 'create-agent'));
  const create = (kind: 'create-native' | 'create-agent') => {
    requestAgentsCatalogDefinition(kind);
    onItemSelect?.();
  };
  return <SettingsSidebarLayout variant="background" header={
    <div className="space-y-3 border-b px-3 pt-4 pb-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className={SETTINGS_PANEL_TITLE_CLASS}>{t('settings.page.agents.title')} <span className="typography-meta text-muted-foreground">{agents.length}</span></h2>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="size-7" disabled={state.loading} onClick={() => { void refresh(); }} aria-label={t('settings.varin.agents.actions.refresh')}><Icon name="refresh" className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-7" disabled={!nativeRevision} onClick={() => create('create-native')} aria-label={t('settings.varin.agents.definition.createAgent')}><Icon name="add" className="size-4" /></Button>
          {canCreatePlugin && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-6" aria-label={t('settings.varin.agents.filters.allProviders')}><Icon name="arrow-down-s" className="size-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => create('create-agent')}>Pi Subagents · {t('settings.varin.agents.definition.createAgent')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      <Input value={state.query} onChange={event => setAgentsCatalogQuery(event.target.value)} placeholder={t('settings.varin.agents.search.placeholder')} aria-label={t('settings.varin.agents.search.placeholder')} className="h-8" />
      <Select value={state.providerFilter} onValueChange={setAgentsCatalogProviderFilter}>
        <SelectTrigger className="h-8 w-full" aria-label={t('settings.varin.agents.filters.allProviders')}><SelectValue>{catalog.providers.find(provider => provider.id === state.providerFilter)?.label ?? t('settings.varin.agents.filters.allProviders')}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="all">{t('settings.varin.agents.filters.allProviders')}</SelectItem>{catalog.providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}</SelectContent>
      </Select>
      <label className="flex items-center gap-2 typography-micro text-muted-foreground"><input type="checkbox" checked={state.showAllFocuses} onChange={event => setAgentsCatalogShowAllFocuses(event.target.checked)} />{t('settings.agents.allModes')}</label>
    </div>
  } footer={<div className="border-t px-3 py-2 typography-micro text-muted-foreground">{t('settings.agents.currentFocus', { focus: t(`workFocus.${focus}`) })}</div>}>
    {state.error && <p role="alert" className="px-1 py-2 typography-meta text-destructive">{state.error}</p>}
    {agents.map(agent => <div key={agent.id} data-agent-id={agent.id}>
      <SettingsSidebarItem title={nativeAgentLabel(agent, t)} selected={!state.definitionRequest && selected?.id === agent.id}
        metadata={<span className="flex items-center gap-1.5"><span className={agent.status === 'disabled' ? 'text-muted-foreground/60' : ''}>{agent.providerId === 'varin' ? t(agent.source.scope === 'builtin' ? 'settings.agents.builtin' : 'settings.agents.custom') : catalog.providers.find(provider => provider.id === agent.providerId)?.label ?? agent.providerId}</span><span aria-hidden>·</span>{t(`settings.varin.pluginSettings.subagents.status.${agent.status}`)}</span>}
        icon={<Icon name={agent.providerId === 'varin' ? 'robot-2' : 'apps-2-ai'} className="size-4 shrink-0 text-muted-foreground" />}
        onSelect={() => { requestAgentsCatalogDefinition(null); selectAgentsCatalogAgent(agent.id); onItemSelect?.(); }} />
    </div>)}
    {!agents.length && <p role="status" className="px-1 py-4 typography-meta text-muted-foreground">{state.loading ? t('common.loading') : t('settings.varin.agents.catalog.noMatches')}</p>}
  </SettingsSidebarLayout>;
}
