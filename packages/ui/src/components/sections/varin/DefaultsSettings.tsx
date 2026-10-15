import React from 'react';
import { ProjectTrustSettings } from '@/components/sections/shared/ProjectTrustSettings';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type AgentSettingsSnapshot } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

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
  const save = async (set: Record<string, JsonValue>, remove: string[] = []) => {
    if (!snapshot || saving || currentScope.current !== scopeKey || host !== getRuntimeEndpointGeneration()
      || trustVersion !== getProjectTrustGeneration() || scope === 'project' && !snapshot.projectTrusted) return;
    const owner = host; const saveScope = scopeKey; setSaving(true); setError(undefined);
    try {
      const next = await api.updateSettings({ cwd, scope, set, remove, expectedRevision: scope === 'global' ? snapshot.globalRevision : snapshot.projectRevision });
      if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setSnapshot(next);
    } catch (failure) { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (owner === getRuntimeEndpointGeneration() && saveScope === currentScope.current) setSaving(false); }
  };
  const string = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
  const model = (value: JsonValue | undefined) => value && typeof value === 'object' && !Array.isArray(value)
    ? { providerId: string(value.providerId), modelId: string(value.modelId) } : { providerId: '', modelId: '' };
  return <SettingsSection title={t('settings.varin.defaults.title')} divider={false}>
    <ProjectTrustSettings />
    {error && <p role="alert" className="text-destructive text-sm">{error} <Button variant="ghost" onClick={() => void reload()}>{t('assistant.reload')}</Button></p>}
    <SettingsFieldRow label="Settings scope"><select value={scope} disabled={saving} onChange={event => setScope(event.target.value as 'global' | 'project')}>
      <option value="global">Global</option><option value="project" disabled={!snapshot?.projectTrusted}>Project</option>
    </select></SettingsFieldRow>
    <SettingsFieldRow label="Conversation model"><ModelSelector providerId={string(settings.defaultProvider)} modelId={string(settings.defaultModel)} disabled={!snapshot || saving}
      onChange={(providerId, modelId) => save(providerId && modelId ? { defaultProvider: providerId, defaultModel: modelId } : {}, providerId && modelId ? [] : ['defaultProvider', 'defaultModel'])} /></SettingsFieldRow>
    <SettingsFieldRow label="Thinking level"><select value={string(settings.defaultThinkingLevel)} disabled={!snapshot || saving} onChange={event => void save(event.target.value ? { defaultThinkingLevel: event.target.value } : {}, event.target.value ? [] : ['defaultThinkingLevel'])}>
      <option value="">Inherit</option>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level}>{level}</option>)}
    </select></SettingsFieldRow>
    {scope === 'global' && (['utilityModel', 'walkthroughModel'] as const).map(key => <SettingsFieldRow key={key} label={key === 'utilityModel' ? 'Utility model' : 'Walkthrough model'}>
      <ModelSelector {...model(settings[key])} disabled={!snapshot || saving} placeholder="Use configured conversation model"
        onChange={(providerId, modelId) => save(providerId && modelId ? { [key]: { providerId, modelId } } : {}, providerId && modelId ? [] : [key])} />
    </SettingsFieldRow>)}
    <SettingsCheckboxRow checked={showDeletionDialog} onChange={setShowDeletionDialog} label="Confirm conversation deletion" />
  </SettingsSection>;
};
