import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, modelThinkingLevels, type AgentSettingsSnapshot } from '@varin/application-client';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsFieldRow } from '../shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import type { JsonValue } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { useI18n } from '@/lib/i18n';

/** Edits the same project defaults consumed when a new conversation selects its model. */
export function ProjectDefaultModelField({ directory }: { directory: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trust = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<AgentSettingsSnapshot>();
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const generation = React.useRef(0);
  const writing = React.useRef(false);
  const channels = useModelCatalogStore(state => state.channels);
  React.useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setSnapshot(undefined); setError(''); setBusy(false); writing.current = false;
    void api.readSettings(directory, controller.signal).then(value => {
      if (current === generation.current) setSnapshot(value);
    }, cause => { if (!controller.signal.aborted && current === generation.current) setError(String(cause)); });
    return () => { generation.current = current + 1; controller.abort(); };
  }, [api, directory, trust, attempt]);
  const save = async (set: Record<string, JsonValue>, remove: string[]) => {
    if (!snapshot?.projectTrusted || writing.current) return;
    const current = generation.current;
    writing.current = true; setBusy(true); setError('');
    try {
      const value = await api.updateSettings({ cwd: directory, scope: 'project', expectedRevision: snapshot.projectRevision,
        set, remove });
      if (current === generation.current) setSnapshot(value);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally { if (current === generation.current) { writing.current = false; setBusy(false); } }
  };
  const value = (entry: unknown) => typeof entry === 'string' ? entry : '';
  const effective = { ...snapshot?.global, ...snapshot?.project };
  const selectedModel = channels.find(channel => channel.id === effective.defaultProvider)?.models.find(model => model.id === effective.defaultModel);
  const levels = selectedModel ? modelThinkingLevels(selectedModel) : [];
  return <div className="space-y-2">
    <SettingsFieldRow label={t('settings.varin.agents.detail.model')}>
      <ModelSelector providerId={value(snapshot?.project.defaultProvider)} modelId={value(snapshot?.project.defaultModel)}
        displayProviderId={value(effective.defaultProvider)} displayModelId={value(effective.defaultModel)}
        placeholder={t('settings.bots.model.inherit')} defaultSelectionLabel={t('settings.bots.model.inherit')}
        disabled={!snapshot?.projectTrusted || busy} onChange={(providerId, modelId) => save(
          providerId && modelId ? { defaultProvider: providerId, defaultModel: modelId } : {},
          providerId && modelId ? ['defaultThinkingLevel'] : ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'])} className="h-8 w-64 max-w-full" />
    </SettingsFieldRow>
    <SettingsFieldRow label={t('settings.varin.agents.detail.thinking')}>
      <Select value={value(snapshot?.project.defaultThinkingLevel) || 'inherit'} disabled={!snapshot?.projectTrusted || busy}
        onValueChange={level => { void save(level === 'inherit' ? {} : { defaultThinkingLevel: level }, level === 'inherit' ? ['defaultThinkingLevel'] : []).catch(() => {}); }}>
        <SelectTrigger size="settings" aria-label={t('settings.varin.agents.detail.thinking')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="inherit">{t('settings.bots.model.inherit')}</SelectItem>
          {levels.map(level => <SelectItem key={level} value={level}>{t(`settings.agents.thinking.${level}`)}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {snapshot && !snapshot.projectTrusted && <p className="typography-meta text-muted-foreground">{t('settings.projectTrust.defaultsHint')}</p>}
    {error && <p role="alert" className="typography-meta text-destructive">{error}<Button size="sm" variant="ghost" disabled={busy} onClick={retry}>{t('settings.harness.retry')}</Button></p>}
  </div>;
}
