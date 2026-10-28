import React from 'react';
import { RetrySettings } from './RetrySettings';
import { ExternalAgentDefault } from '@/components/sections/external-agents/ExternalAgentsPage';
import { toast } from '@/components/ui';
import { SettingsPageLink } from '@/components/sections/shared/SettingsPageLink';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, modelThinkingLevels, type AgentSettingsSnapshot } from '@varin/application-client';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import type { JsonValue, ThinkingLevel } from '@varin/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { ModelThinkingSelect } from '@/components/sections/shared/ModelThinkingSelect';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<AgentSettingsSnapshot>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const showDeletionDialog = useUIStore(state => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore(state => state.setShowDeletionDialog);
  const sequence = React.useRef(0);
  const scopeKey = String(host);
  const currentScope = React.useRef(scopeKey); currentScope.current = scopeKey;
  const reload = React.useCallback(async () => {
    const request = ++sequence.current;
    try { const next = await api.readSettings(); if (request === sequence.current) { setSnapshot(next); setError(undefined); } }
    catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [api]);
  React.useEffect(() => { setSnapshot(undefined); setSaving(false); void reload(); return () => { sequence.current += 1; }; }, [reload]);
  const settings = snapshot?.global ?? {};
  const channels = useModelCatalogStore(state => state.channels);
  const selectedModel = channels.find(channel => channel.id === settings.defaultProvider)?.models.find(model => model.id === settings.defaultModel);
  const thinkingLevels = selectedModel ? modelThinkingLevels(selectedModel) : [];
  const save = async (set: Record<string, JsonValue>, remove: string[] = []) => {
    if (!snapshot || saving || currentScope.current !== scopeKey || host !== getRuntimeEndpointGeneration()) return false;
    const owner = host; const saveScope = scopeKey; setSaving(true); setError(undefined);
    try {
      const next = await api.updateSettings({ scope: 'global', set, remove, expectedRevision: snapshot.globalRevision });
      if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) { setSnapshot(next); toast.success(t('settings.defaults.saved')); return true; }
      return false;
    } catch (failure) { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setSaving(false); }
  };
  const string = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
  const model = (value: JsonValue | undefined) => value && typeof value === 'object' && !Array.isArray(value)
    ? { providerId: string(value.providerId), modelId: string(value.modelId) } : { providerId: '', modelId: '' };
  const utility = model(settings.utilityModel);
  const utilityModel = utility.providerId && utility.modelId
    ? channels.find(channel => channel.id === utility.providerId)?.models.find(model => model.id === utility.modelId) : selectedModel;
  const utilityLevels = utilityModel ? modelThinkingLevels(utilityModel) : undefined;
  const defaultThinking = string(settings.defaultThinkingLevel) as ThinkingLevel;
  const utilityDefault = !utility.modelId && utilityLevels?.includes(defaultThinking) ? defaultThinking : utilityLevels?.[0];
  return <>
  <SettingsSection title={t('settings.varin.defaults.title')} description={t('settings.defaults.globalHint')} divider={false} contentClassName="divide-y divide-border/50">
    <ExternalAgentDefault />
    {!snapshot && !error && <p role="status" className="py-3 typography-meta text-muted-foreground">{t('settings.defaults.loading')}</p>}
    {error && <p role="alert" className="text-destructive text-sm">{error} <Button variant="ghost" onClick={() => void reload()}>{t('assistant.reload')}</Button></p>}
    <SettingsFieldRow label={t('settings.varin.agents.detail.model')}><ModelSelector providerId={string(settings.defaultProvider)} modelId={string(settings.defaultModel)} disabled={!snapshot || saving}
      onChange={async (providerId, modelId) => { await save(providerId && modelId ? { defaultProvider: providerId, defaultModel: modelId } : {}, [...(providerId && modelId ? ['defaultThinkingLevel'] : ['defaultProvider', 'defaultModel', 'defaultThinkingLevel']), ...(!utility.modelId ? ['utilityThinkingLevel'] : [])]); }} /></SettingsFieldRow>
    <SettingsFieldRow label={t('settings.varin.agents.detail.thinking')}><Select value={string(settings.defaultThinkingLevel) || 'inherit'} disabled={!snapshot || saving} onValueChange={value => void save(value !== 'inherit' ? { defaultThinkingLevel: value } : {}, value !== 'inherit' ? [] : ['defaultThinkingLevel'])}>
      <SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="inherit">{t('chat.modelControls.default')}</SelectItem>{thinkingLevels.map(level => <SelectItem key={level} value={level}>{t(`settings.agents.thinking.${level}`)}</SelectItem>)}
      </SelectContent>
    </Select></SettingsFieldRow>
    <SettingsFieldRow label={t('thread.settings.utilityModel')} info={t('settings.varin.defaults.utilityModel.description')} settingsItem="sessions.small-model">
      <ModelSelector {...model(settings.utilityModel)} disabled={!snapshot || saving} placeholder={t('settings.bots.model.inherit')}
        onChange={async (providerId, modelId) => { await save(providerId && modelId ? { utilityModel: { providerId, modelId } } : {}, providerId && modelId ? ['utilityThinkingLevel'] : ['utilityModel', 'utilityThinkingLevel']); }} />
    </SettingsFieldRow>
    <SettingsFieldRow label={t('settings.varin.agents.detail.thinking')}>
      <ModelThinkingSelect value={string(settings.utilityThinkingLevel)} levels={utilityLevels} defaultLevel={utilityDefault}
        disabled={!snapshot || saving} label={`${t('thread.settings.utilityModel')} · ${t('settings.varin.agents.detail.thinking')}`}
        onChange={value => void save(value ? { utilityThinkingLevel: value } : {}, value ? [] : ['utilityThinkingLevel'])} />
    </SettingsFieldRow>
    <SettingsPageLink page="projects" description={t('settings.defaults.projectLinkHint')} onNavigate={() => { const id = useProjectsStore.getState().activeProjectId; if (id) useUIStore.getState().setSettingsProjectsSelectedId(id); }}>{t('settings.page.projects.title')}</SettingsPageLink>
  </SettingsSection>
  {snapshot && <RetrySettings key={host} value={snapshot.global.retry} disabled={saving} api={api} onSave={save} />}
  <SettingsSection title={t('settings.defaults.clientPreferences')}>
    <SettingsCheckboxRow checked={showDeletionDialog} onChange={setShowDeletionDialog} label={t('thread.settings.confirmDelete')} />
  </SettingsSection></>;
};
