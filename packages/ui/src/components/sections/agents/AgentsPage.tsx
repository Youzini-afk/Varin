import React from 'react';
import type { JsonValue, PiAgentDescriptor, RuntimeContextTarget, WorkFocusId } from '@varin/protocol';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runPiAgentProviderAction } from '@/lib/pi-runtime/agent-providers';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useHarnessSettings } from '../harness/useHarnessSettings';
import { NativeAgentDialog } from './NativeAgentDialog';
import { AgentProviderActionDialog } from './AgentProviderActionDialog';
import { PluginAgentDetails } from './PluginAgentDetails';
import { filterAgentsCatalog, nativeAgentDescription, nativeAgentLabel } from './agents-catalog-model';
import { refreshAgentsCatalog, requestAgentsCatalogDefinition, selectAgentsCatalogAgent, setAgentsCatalogProviderFilter, useAgentsCatalogState } from './agents-catalog-store';

export const AgentsPage: React.FC = () => {
  const cwd = useDirectoryStore(state => state.currentDirectory);
  const runtimeKey = usePiSessionStore(state => state.runtimeKey);
  const sessionId = usePiSessionStore(state => {
    const id = state.currentSessionId;
    return id && state.records[id]?.open ? id : undefined;
  });
  const session = usePiSessionStore(state => sessionId ? state.records[sessionId]?.snapshot : undefined);
  const projectFocus = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId)?.defaultWorkFocus);
  const target = React.useMemo<RuntimeContextTarget>(() => sessionId ? { sessionId } : { cwd }, [cwd, sessionId]);
  const targetKey = JSON.stringify([runtimeKey, target]);
  return <AgentList key={targetKey} cwd={cwd} runtimeKey={runtimeKey} target={target} targetKey={targetKey} focus={session?.workFocus?.selected.id ?? projectFocus ?? 'code'} />;
};

export function AgentList({ cwd, runtimeKey, target, targetKey, focus }: { cwd: string; runtimeKey: string; target: RuntimeContextTarget; targetKey: string; focus: WorkFocusId }) {
  const { t } = useI18n();
  const state = useAgentsCatalogState();
  const catalog = state.targetKey === targetKey ? state.catalog : { agents: [], providers: [], diagnostics: [], projectTrusted: false };
  const harness = useHarnessSettings();
  const [query, setQuery] = React.useState('');
  const [source, setSource] = React.useState('all');
  const [allModes, setAllModes] = React.useState(false);
  const [editing, setEditing] = React.useState<{ agent?: PiAgentDescriptor; revision: string } | null>(null);
  const [deleting, setDeleting] = React.useState<PiAgentDescriptor | null>(null);
  const [pluginDetails, setPluginDetails] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);
  const refresh = React.useCallback(() => refreshAgentsCatalog(target, targetKey), [target, targetKey]);
  React.useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'settings-changed' && event.owner === 'pi-settings') void refresh();
    });
    return () => { alive.current = false; unsubscribe(); };
  }, [refresh]);
  const rawMatches = new Set(filterAgentsCatalog(catalog, query, source, 'all').map(agent => agent.id));
  const needle = query.trim().toLocaleLowerCase();
  const filtered = filterAgentsCatalog(catalog, '', source, 'all')
    .filter(agent => rawMatches.has(agent.id) || `${nativeAgentLabel(agent, t)} ${nativeAgentDescription(agent, t)}`.toLocaleLowerCase().includes(needle))
    .filter(agent => allModes || !agent.workFocus?.length || agent.workFocus.includes(focus));
  const nativeRevision = catalog.agents.find(agent => agent.providerId === 'varin')?.definition?.revision;
  const act = async (providerId: string, action: string, agent?: PiAgentDescriptor, input?: JsonValue): Promise<boolean> => {
    if (!alive.current || inFlight.current) return false;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await runPiAgentProviderAction(target, providerId, action, agent?.id, input, runtimeKey);
      if (!alive.current) return false;
      if (!result.success) { setError(result.message); return false; }
      await refreshAgentsCatalog(target, targetKey, true);
      return alive.current;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  };
  const configure = (agent: PiAgentDescriptor) => {
    setError(null);
    if (agent.providerId === 'varin' && agent.definition?.revision) {
      setEditing({ agent, revision: agent.definition.revision });
    } else {
      setAgentsCatalogProviderFilter('all');
      selectAgentsCatalogAgent(agent.id);
      setPluginDetails(true);
    }
  };
  const toggle = (agent: PiAgentDescriptor, enabled: boolean) => {
    const action = agent.actions.find(item => item.id === (enabled ? 'enable' : 'disable'));
    if (!action) return;
    if (action.requiresScope && agent.source.scope !== 'user' && agent.source.scope !== 'project') { configure(agent); return; }
    void act(agent.providerId, action.id, agent, agent.providerId === 'varin'
      ? { expectedRevision: agent.definition?.revision ?? '' }
      : action.requiresScope ? { scope: agent.source.scope } : undefined);
  };
  if (pluginDetails) return <><Button variant="ghost" size="sm" className="m-3" onClick={() => { requestAgentsCatalogDefinition(null); setPluginDetails(false); }}>{t('settings.agents.back')}</Button><PluginAgentDetails /></>;
  return <>
    <SettingsPageLayout title={t('settings.page.agents.title')} description={t('settings.agents.descriptionPage')}
      headerEnd={<div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.loading} onClick={() => { void refresh(); }} aria-label={t('settings.varin.agents.actions.refresh')}><Icon name="refresh" className="size-4" /></Button>
        <Button size="sm" disabled={!nativeRevision || pending} onClick={() => { setError(null); setEditing({ revision: nativeRevision! }); }}><Icon name="add" className="size-4" />{t('settings.varin.agents.definition.createAgent')}</Button>
        {catalog.providers.some(provider => provider.id === 'pi-subagents' && provider.available && provider.actions.some(action => action.id === 'create-agent')) && <DropdownMenu><DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" disabled={pending} aria-label={t('settings.varin.agents.definition.createAgent')}><Icon name="arrow-down" className="size-4" /></Button>
        </DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => {
          setAgentsCatalogProviderFilter('pi-subagents'); selectAgentsCatalogAgent(null);
          requestAgentsCatalogDefinition('create-agent'); setPluginDetails(true);
        }}>Pi Subagents · {t('settings.varin.agents.definition.createAgent')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </div>}>
      <SettingsSection settingsItem="agents.catalog" contentClassName="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings.varin.agents.search.placeholder')} aria-label={t('settings.varin.agents.search.placeholder')} className="min-w-40 flex-1" />
          <Select value={source} onValueChange={setSource}><SelectTrigger className="w-44" aria-label={t('settings.varin.agents.filters.allProviders')}><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="all">{t('settings.varin.agents.filters.allProviders')}</SelectItem>
            {catalog.providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
          </SelectContent></Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 typography-meta text-muted-foreground">
          <span>{t('settings.agents.currentFocus', { focus: t(`workFocus.${focus}`) })}</span>
          <label className="flex items-center gap-2"><input type="checkbox" checked={allModes} onChange={event => setAllModes(event.target.checked)} />{t('settings.agents.allModes')}</label>
        </div>
        {(error || state.error) && <p role="alert" className="typography-meta text-destructive">{error ?? state.error}</p>}
        {catalog.diagnostics.map((item, index) => <p key={`${item.providerId}:${index}`} role="alert" className="typography-meta text-destructive">{item.providerId}: {item.message}</p>)}
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          {filtered.map(agent => {
            const canEnable = agent.actions.some(action => action.id === 'enable');
            const canDisable = agent.actions.some(action => action.id === 'disable');
            const enabled = canDisable || (!canEnable && agent.status !== 'disabled');
            return <div key={agent.id} className="flex items-center gap-3 px-3 py-3" data-agent-id={agent.id}>
              <Icon name={agent.providerId === 'varin' ? 'robot-2' : 'apps-2-ai'} className="size-4 shrink-0 text-muted-foreground" />
              <button type="button" className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => configure(agent)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="typography-ui-label">{nativeAgentLabel(agent, t)}</span>
                  <span className="typography-micro text-muted-foreground">{agent.providerId === 'varin' ? t(agent.source.scope === 'builtin' ? 'settings.agents.builtin' : 'settings.agents.custom') : catalog.providers.find(provider => provider.id === agent.providerId)?.label ?? agent.providerId}</span></div>
                <p className="line-clamp-2 typography-meta text-muted-foreground">{nativeAgentDescription(agent, t)}</p>
                <p className="truncate typography-micro text-muted-foreground">{agent.model ?? t(agent.status === 'unconfigured' ? 'settings.harness.models.noModel' : 'settings.varin.agents.detail.inherited')} · {t(`settings.varin.pluginSettings.subagents.status.${agent.status}`)}</p>
              </button>
              {(canEnable || canDisable) && <Switch checked={enabled} disabled={pending || state.loading} aria-label={`${t('settings.agents.enabled')}: ${nativeAgentLabel(agent, t)}`} onCheckedChange={checked => toggle(agent, checked)} />}
              <Button variant="ghost" size="icon" disabled={pending} aria-label={`${t('settings.varin.agents.actions.configure')}: ${nativeAgentLabel(agent, t)}`} onClick={() => configure(agent)}><Icon name="settings-3" className="size-4" /></Button>
              {agent.providerId === 'varin' && agent.source.scope === 'user' && <Button variant="ghost" size="icon" disabled={pending} aria-label={`${t('settings.common.actions.delete')}: ${agent.name}`} onClick={() => { setError(null); setDeleting(agent); }}><Icon name="delete-bin" className="size-4" /></Button>}
            </div>;
          })}
          {!filtered.length && <p role="status" className="p-5 typography-meta text-muted-foreground">{state.loading ? t('common.loading') : t('settings.varin.agents.catalog.noMatches')}</p>}
        </div>
        <p className="typography-meta text-muted-foreground">{t('settings.agents.applies')}</p>
      </SettingsSection>
      {harness.harness && <SettingsSection title={t('settings.page.harness.section.review')} settingsItem="harness.review" contentClassName="space-y-3">
        <SettingsCheckboxRow checked={harness.harness.review.enabled} onChange={enabled => harness.update({ review: { enabled } })} label={t('settings.page.harness.review.enabled')} description={t('settings.page.harness.section.review.description')} />
        {harness.harness.review.enabled && <SettingsCheckboxRow checked={harness.harness.review.gate} onChange={gate => harness.update({ review: { gate } })} label={t('settings.page.harness.review.gate')} description={t('settings.page.harness.review.gate.description')} />}
        {harness.error && <div role="alert" className="flex items-center gap-2 typography-meta text-destructive"><span>{harness.error}</span><Button size="sm" variant="outline" onClick={() => { void harness.retry(); }}>{t('settings.harness.retry')}</Button></div>}
      </SettingsSection>}
    </SettingsPageLayout>
    {editing && <NativeAgentDialog key={editing.agent?.id ?? 'new'} agent={editing.agent} cwd={cwd} busy={pending} error={error} onClose={() => setEditing(null)}
      onSave={config => act('varin', editing.agent ? 'update' : 'create-agent', editing.agent, { expectedRevision: editing.revision, config })} />}
    <AgentProviderActionDialog open={Boolean(deleting)} action={deleting ? { id: 'delete', label: t('settings.common.actions.delete'), destructive: true } : null} agent={deleting} projectTrusted={catalog.projectTrusted} submitting={pending} error={error}
      onOpenChange={open => { if (!open) setDeleting(null); }} onSubmit={async () => deleting ? act('varin', 'delete', deleting, { expectedRevision: deleting.definition?.revision ?? '' }) : false} />
  </>;
}
