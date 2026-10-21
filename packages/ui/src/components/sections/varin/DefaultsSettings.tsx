import React from 'react';
import { RetrySettings } from './RetrySettings';
import { toast } from '@/components/ui';
import { ProjectTrustSettings } from '@/components/sections/shared/ProjectTrustSettings';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, modelThinkingLevels, type AgentSettingsSnapshot } from '@varin/application-client';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import type { JsonValue } from '@varin/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const cwd = useDirectoryStore(state => state.currentDirectory);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trustVersion = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const [scope, setScope] = React.useState<'global' | 'project'>('global');
  const [snapshot, setSnapshot] = React.useState<AgentSettingsSnapshot>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const showDeletionDialog = useUIStore(state => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore(state => state.setShowDeletionDialog);
  const sequence = React.useRef(0);
  const scopeKey = JSON.stringify([host, cwd, scope, trustVersion]);
  const currentScope = React.useRef(scopeKey); currentScope.current = scopeKey;
  const reload = React.useCallback(async () => {
    const request = ++sequence.current;
    try { const next = await api.readSettings(cwd); if (request === sequence.current) { setSnapshot(next); setError(undefined); } }
    catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [api, cwd]);
  React.useEffect(() => { setSnapshot(undefined); setScope('global'); setSaving(false); void reload(); return () => { sequence.current += 1; }; }, [reload, trustVersion]);
  const settings = snapshot?.[scope] ?? {};
  const channels = useModelCatalogStore(state => state.channels);
  const effective = { ...snapshot?.global, ...settings };
  const selectedModel = channels.find(channel => channel.id === effective.defaultProvider)?.models.find(model => model.id === effective.defaultModel);
  const thinkingLevels = selectedModel ? modelThinkingLevels(selectedModel) : [];
  const save = async (set: Record<string, JsonValue>, remove: string[] = []) => {
    if (!snapshot || saving || currentScope.current !== scopeKey || host !== getRuntimeEndpointGeneration()
      || trustVersion !== getProjectTrustGeneration() || scope === 'project' && !snapshot.projectTrusted) return;
    const owner = host; const saveScope = scopeKey; setSaving(true); setError(undefined);
    try {
      const next = await api.updateSettings({ cwd, scope, set, remove, expectedRevision: scope === 'global' ? snapshot.globalRevision : snapshot.projectRevision });
      if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) { setSnapshot(next); toast.success(t('settings.defaults.saved')); }
    } catch (failure) { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setSaving(false); }
  };
  const string = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
  const model = (value: JsonValue | undefined) => value && typeof value === 'object' && !Array.isArray(value)
    ? { providerId: string(value.providerId), modelId: string(value.modelId) } : { providerId: '', modelId: '' };
  return <>
  <SettingsSection title={t('settings.varin.defaults.title')} divider={false} contentClassName="divide-y divide-border/50">
    <ProjectTrustSettings />
    {!snapshot && !error && <p role="status" className="py-3 typography-meta text-muted-foreground">{t('settings.defaults.loading')}</p>}
    {error && <p role="alert" className="text-destructive text-sm">{error} <Button variant="ghost" onClick={() => void reload()}>{t('assistant.reload')}</Button></p>}
    <SettingsFieldRow label={t('assistant.scope')}><Select value={scope} disabled={saving} onValueChange={value => setScope(value as 'global' | 'project')}>
      <SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="global">{t('assistant.scope.global')}</SelectItem><SelectItem value="project" disabled={!snapshot?.projectTrusted}>{t('assistant.scope.project')}</SelectItem>
      </SelectContent>
    </Select></SettingsFieldRow>
    <SettingsFieldRow label={t('settings.varin.agents.detail.model')}><ModelSelector providerId={string(settings.defaultProvider)} modelId={string(settings.defaultModel)} disabled={!snapshot || saving}
      displayProviderId={scope === 'project' ? string(snapshot?.global.defaultProvider) : undefined}
      displayModelId={scope === 'project' ? string(snapshot?.global.defaultModel) : undefined}
      placeholder={scope === 'project' ? t('settings.bots.model.inherit') : undefined}
      defaultSelectionLabel={scope === 'project' ? t('settings.bots.model.inherit') : undefined}
      onChange={(providerId, modelId) => save(providerId && modelId ? { defaultProvider: providerId, defaultModel: modelId } : {}, providerId && modelId ? ['defaultThinkingLevel'] : ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'])} /></SettingsFieldRow>
    <SettingsFieldRow label={t('settings.varin.agents.detail.thinking')}><Select value={string(settings.defaultThinkingLevel) || 'inherit'} disabled={!snapshot || saving} onValueChange={value => void save(value !== 'inherit' ? { defaultThinkingLevel: value } : {}, value !== 'inherit' ? [] : ['defaultThinkingLevel'])}>
      <SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="inherit">{t('chat.modelControls.default')}</SelectItem>{thinkingLevels.map(level => <SelectItem key={level} value={level}>{t(`settings.agents.thinking.${level}`)}</SelectItem>)}
      </SelectContent>
    </Select></SettingsFieldRow>
    {scope === 'global' && <SettingsFieldRow label={t('thread.settings.utilityModel')} info={t('settings.varin.defaults.utilityModel.description')} settingsItem="sessions.small-model">
      <ModelSelector {...model(settings.utilityModel)} disabled={!snapshot || saving} placeholder={t('settings.bots.model.inherit')}
        onChange={(providerId, modelId) => save(providerId && modelId ? { utilityModel: { providerId, modelId } } : {}, providerId && modelId ? [] : ['utilityModel'])} />
    </SettingsFieldRow>}
    {scope === 'project' && <p className="py-3 typography-meta text-muted-foreground">{t('settings.defaults.projectInheritance')}</p>}
  </SettingsSection>
  {scope === 'global' && snapshot && <RetrySettings key={`${host}:${JSON.stringify(snapshot.global.retry)}`} value={snapshot.global.retry} disabled={saving} api={api} onSave={save} />}
  <SettingsSection title={t('settings.defaults.clientPreferences')}>
    <SettingsCheckboxRow checked={showDeletionDialog} onChange={setShowDeletionDialog} label={t('thread.settings.confirmDelete')} />
  </SettingsSection></>;
};
