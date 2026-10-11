import React from 'react';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { agentProfileLabels } from './agent-profile-presentation';
import { useAgentProfiles } from './useAgentProfiles';
import { createAgentProfile, selectAgentProfile, selectAgentProfilesRuntime, selectAgentPlugin, setAgentProfilesQuery, setAgentProfilesShowAllFocuses } from './agent-profiles-store';
import { useAgentsPageCatalog } from './useAgentsPageCatalog';
import { requestAgentsCatalogDefinition, selectAgentsCatalogAgent, setAgentsCatalogProviderFilter, setAgentsCatalogQuery, setAgentsCatalogShowAllFocuses } from './agents-catalog-store';

export function AgentsSidebar({ onItemSelect }: { onItemSelect?: () => void }) {
  const profiles = useAgentProfiles();
  return profiles.state.runtime === 'pi'
    ? <PiAgentsSidebar {...profiles} onItemSelect={onItemSelect} />
    : <ProfileSidebar {...profiles} onItemSelect={onItemSelect} />;
}
function PiAgentsSidebar(props: ReturnType<typeof useAgentProfiles> & { onItemSelect?: () => void }) {
  const plugins = useAgentsPageCatalog();
  React.useEffect(() => {
    setAgentsCatalogQuery(props.state.query);
    setAgentsCatalogShowAllFocuses(props.state.showAllFocuses);
  }, [props.state.query, props.state.showAllFocuses]);
  return <ProfileSidebar {...props} plugins={plugins} />;
}
function ProfileSidebar({ state, snapshot, refresh, plugins, onItemSelect }: ReturnType<typeof useAgentProfiles> & {
  onItemSelect?: () => void; plugins?: ReturnType<typeof useAgentsPageCatalog>;
}) {
  const { t } = useI18n();
  const projectFocus = useProjectsStore(value => value.projects.find(project => project.id === value.activeProjectId)?.defaultWorkFocus) ?? 'code';
  const focus = plugins?.focus ?? projectFocus;
  const needle = state.query.trim().toLocaleLowerCase();
  const profiles = snapshot?.profiles.filter(profile => (state.showAllFocuses || !profile.effective.workFocus.length || profile.effective.workFocus.includes(focus))
    && `${profile.id} ${profile.effective.name} ${profile.effective.description} ${agentProfileLabels(profile, t).name} ${agentProfileLabels(profile, t).description}`.toLocaleLowerCase().includes(needle)) ?? [];
  const visibleSelection = profiles.some(profile => profile.id === state.selectedId) ? state.selectedId : profiles[0]?.id ?? null;
  React.useEffect(() => {
    if (snapshot && !state.creating && state.view === 'profiles' && state.selectedId !== visibleSelection) selectAgentProfile(visibleSelection);
  }, [snapshot, state.creating, state.view, state.selectedId, visibleSelection]);
  const canCreateProfile = snapshot?.profiles.some(profile => profile.config.kind === 'builtin' && profile.config.slot === 'retrievalAgent' && profile.defaults !== null);
  const canCreatePlugin = plugins?.catalog.providers.some(provider => provider.id === 'pi-subagents' && provider.available && provider.actions.some(action => action.id === 'create-agent'));
  return <SettingsSidebarLayout variant="background" header={
    <div className="space-y-3 border-b px-3 pt-4 pb-3">
      <div className="flex items-center justify-between gap-2"><h2 className={SETTINGS_PANEL_TITLE_CLASS}>{t('settings.page.agents.title')}</h2>
        <div className="flex items-center"><Button variant="ghost" size="icon" className="size-7" disabled={state.loading || state.saving} onClick={() => { void refresh(true); void plugins?.refresh(); }} aria-label={t('settings.varin.agents.actions.refresh')}><Icon name="refresh" className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-7" disabled={!canCreateProfile || state.saving} onClick={() => { createAgentProfile(); onItemSelect?.(); }} aria-label={t('settings.varin.agents.definition.createAgent')}><Icon name="add" className="size-4" /></Button></div>
      </div>
      <label className="grid gap-1 typography-meta">{t('settings.agents.editRuntime')}
        <select aria-label={t('settings.agents.editRuntime')} className="h-8 w-full rounded-md border bg-background px-2" value={state.runtime} onChange={event => selectAgentProfilesRuntime(event.target.value as 'pi' | 'agent')}>
          <option value="pi">Pi</option><option value="agent">{t('settings.agents.runtimeAgent')}</option>
        </select>
      </label>
      <p className="typography-micro text-muted-foreground">{t('settings.agents.runtimeHint')}</p>
      <Input value={state.query} onChange={event => { setAgentProfilesQuery(event.target.value); if (plugins) setAgentsCatalogQuery(event.target.value); }} placeholder={t('settings.varin.agents.search.placeholder')} aria-label={t('settings.varin.agents.search.placeholder')} className="h-8" />
      <label className="flex items-center gap-2 typography-micro text-muted-foreground"><input type="checkbox" checked={state.showAllFocuses} onChange={event => { setAgentProfilesShowAllFocuses(event.target.checked); if (plugins) setAgentsCatalogShowAllFocuses(event.target.checked); }} />{t('settings.agents.allModes')}</label>
    </div>
  } footer={<div className="border-t px-3 py-2 typography-micro text-muted-foreground">{t('settings.agents.currentFocus', { focus: t(`workFocus.${focus}`) })}</div>}>
    {state.error && <p role="alert" className="px-1 py-2 typography-meta text-destructive">{state.error}</p>}
    {profiles.map(profile => <div key={profile.id} data-agent-id={profile.id}>
      <SettingsSidebarItem title={agentProfileLabels(profile, t).name} selected={state.view === 'profiles' && !state.creating && state.selectedId === profile.id}
        metadata={<span>{t(profile.kind === 'builtin' ? 'settings.agents.builtin' : 'settings.agents.custom')} · {t(!profile.effective.enabled ? 'settings.varin.pluginSettings.subagents.status.disabled' : profile.tools.source === 'unconfigured' || profile.effective.modelSource === 'unconfigured' ? 'settings.varin.pluginSettings.subagents.status.unconfigured' : 'settings.agents.configured')}</span>}
        icon={<Icon name="robot-2" className="size-4 shrink-0 text-muted-foreground" />} onSelect={() => { selectAgentProfile(profile.id); onItemSelect?.(); }} />
    </div>)}
    {plugins && <>
      <div className="mt-3 border-t pt-3 typography-meta text-muted-foreground">{t('settings.agents.piPlugins')}</div>
      <select aria-label={t('settings.varin.agents.filters.allProviders')} className="my-2 h-8 w-full rounded-md border bg-background px-2 typography-meta" value={plugins.state.providerFilter} onChange={event => setAgentsCatalogProviderFilter(event.target.value)}>
        <option value="all">{t('settings.varin.agents.filters.allProviders')}</option>{plugins.catalog.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
      </select>
      {canCreatePlugin && <Button type="button" size="sm" variant="ghost" onClick={() => { selectAgentPlugin(); requestAgentsCatalogDefinition('create-agent'); onItemSelect?.(); }}>Pi Subagents · {t('settings.varin.agents.definition.createAgent')}</Button>}
      {plugins.state.error && <p role="alert" className="typography-meta text-destructive">{plugins.state.error}</p>}
      {plugins.agents.map(agent => <div key={agent.id} data-agent-id={agent.id}><SettingsSidebarItem title={agent.name}
        selected={state.view === 'plugins' && !plugins.state.definitionRequest && plugins.selected?.id === agent.id}
        metadata={<span>{plugins.catalog.providers.find(provider => provider.id === agent.providerId)?.label ?? agent.providerId} · {t(`settings.varin.pluginSettings.subagents.status.${agent.status}`)}</span>}
        icon={<Icon name="apps-2-ai" className="size-4 shrink-0 text-muted-foreground" />} onSelect={() => { selectAgentPlugin(); requestAgentsCatalogDefinition(null); selectAgentsCatalogAgent(agent.id); onItemSelect?.(); }} /></div>)}
    </>}
    {!profiles.length && !plugins?.agents.length && <p role="status" className="px-1 py-4 typography-meta text-muted-foreground">{state.loading ? t('common.loading') : t('settings.varin.agents.catalog.noMatches')}</p>}
  </SettingsSidebarLayout>;
}
