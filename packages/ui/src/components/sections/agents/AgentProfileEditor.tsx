import React from 'react';
import { type ThinkingLevel } from '@varin/protocol';
import { modelThinkingLevels } from '@varin/application-client';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import type { AgentProfileSaveRequest, AgentProfilesSnapshot, AgentProfileView } from '@varin/application-client';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { ModelSelector } from './ModelSelector';
import { agentProfileLabels, agentProfileDefaultLabels } from './agent-profile-presentation';
import { agentProfileDrafts, agentProfileSaveRequest, makeAgentProfileDraft, type AgentProfileDraft } from './agent-profile-draft';
import { ContextAgentDetails } from './ContextAgentDetails';

interface Props {
  profile?: AgentProfileView;
  snapshot: AgentProfilesSnapshot;
  host: string;
  cwd: string;
  onSave(input: AgentProfileSaveRequest): Promise<boolean>;
  onCancel?(): void;
  busy: boolean;
}

export function AgentProfileEditor({ profile, snapshot, host, cwd, onSave, onCancel, busy }: Props) {
  const { t } = useI18n();
  const builtin = profile?.config.kind === 'builtin';
  const newTools = snapshot.profiles.find(entry => entry.config.kind === 'builtin' && entry.config.slot === 'retrievalAgent')?.defaults?.tools;
  const makeDraft = React.useCallback(() => ({ ...makeAgentProfileDraft(profile, newTools),
    ...(profile ? agentProfileLabels(profile, t) : {}) }), [profile, newTools, t]);
  const draftKey = JSON.stringify([host, snapshot.runtime, profile?.id ?? 'new']);
  const retained = agentProfileDrafts.get(draftKey);
  const [draft, setDraft] = React.useState(() => retained?.values ?? makeDraft());
  const [revision, setRevision] = React.useState(retained?.revision ?? snapshot.revision);
  const [dirty, setDirty] = React.useState(Boolean(retained));
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const latest = React.useRef({ values: draft, revision, dirty });
  latest.current = { values: draft, revision, dirty };
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (latest.current.dirty) agentProfileDrafts.set(draftKey, { values: latest.current.values, revision: latest.current.revision });
      else agentProfileDrafts.delete(draftKey);
    };
  }, [draftKey]);
  React.useEffect(() => {
    if (dirty) return;
    setDraft(makeDraft()); setRevision(snapshot.revision);
  }, [makeDraft, snapshot.revision, dirty]);
  const update = (patch: Partial<AgentProfileDraft>) => {
    setDraft(current => ({ ...current, ...patch })); setDirty(true); setValidationError(null);
  };
  const discard = () => {
    latest.current.dirty = false; agentProfileDrafts.delete(draftKey); setDirty(false);
    setDraft(makeDraft()); setRevision(snapshot.revision); setValidationError(null);
  };
  const resetTools = () => update({ tools: profile?.defaults?.tools.join(', ') ?? '', toolsChange: 'reset' });
  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy) return false;
    const temperature = draft.temperature.trim() ? Number(draft.temperature) : undefined;
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0)) {
      setValidationError(t('settings.agents.page.field.temperatureTooltip')); return false;
    }
    reportSettingsSaveState('saving');
    const saved = await onSave(agentProfileSaveRequest(snapshot.runtime, revision, draft, profile, agentProfileDefaultLabels(profile, t)));
    if (!alive.current) {
      if (saved) agentProfileDrafts.delete(draftKey);
      return saved;
    }
    reportSettingsSaveState(saved ? 'saved' : 'error');
    if (saved) { latest.current.dirty = false; agentProfileDrafts.delete(draftKey); setDirty(false); }
    return saved;
  };
  const source = draft.toolsChange === 'explicit' ? 'explicit' : draft.toolsChange === 'reset' ? (builtin ? 'default' : 'unconfigured') : profile?.tools.source ?? 'explicit';
  const notBuiltin = snapshot.capabilities === null ? [] : draft.tools.split(/[\n,]/u).map(value => value.trim()).filter(Boolean)
    .filter(name => !snapshot.capabilities!.some(capability => capability.name === name));
  const emptyModelLabel = t(profile?.effective.modelSource === 'unconfigured' ? 'settings.harness.models.noModel' : 'settings.varin.agents.detail.inherited');
  const channels = useModelCatalogStore(state => state.channels);
  const selection = draft.providerId && draft.modelId ? draft : profile?.effective.model;
  const selectedModel = channels.find(channel => channel.id === selection?.providerId)?.models.find(model => model.id === selection?.modelId);
  const thinkingLevels = selectedModel ? modelThinkingLevels(selectedModel) : [];
  return <form onSubmit={event => { void save(event); }} data-agent-editor="profile" data-runtime={snapshot.runtime}>
    <SettingsSection settingsItem="agents.catalog" contentClassName="space-y-5" info={t('settings.agents.applies')}>
      <p className="typography-meta text-muted-foreground">{t(profile?.automation ? 'settings.agents.context.applies' : 'settings.agents.sharedFields')}</p>
      <div className="flex items-center justify-between gap-3"><label htmlFor="agent-enabled" className="typography-ui-label">{t(profile?.automation ? 'settings.agents.context.enabled' : 'settings.agents.enabled')}</label>
        <Switch id="agent-enabled" checked={draft.enabled} disabled={busy} onCheckedChange={enabled => update({ enabled })} /></div>
      <SettingsStackedField label={t('settings.agents.name')}><Input aria-label={t('settings.agents.name')} required value={draft.name} disabled={busy} onChange={event => update({ name: event.target.value })} /></SettingsStackedField>
      <SettingsStackedField label={t('settings.agents.description')}><Input aria-label={t('settings.agents.description')} value={draft.description} disabled={busy} onChange={event => update({ description: event.target.value })} /></SettingsStackedField>
    </SettingsSection>
    <SettingsSection title={t('settings.agents.page.section.modelParameters')} contentClassName="space-y-5">
      <SettingsStackedField label={t('settings.varin.agents.detail.model')}>
        <ModelSelector cwd={cwd} providerId={draft.providerId} modelId={draft.modelId} allowNone disabled={busy} placeholder={emptyModelLabel} defaultSelectionLabel={emptyModelLabel} className="w-full max-w-none" onChange={(providerId, modelId) => update({ providerId, modelId, thinkingLevel: 'inherit' })} />
      </SettingsStackedField>
      <SettingsTwoColumn>
        <SettingsStackedField label={t('settings.agents.page.field.temperature')} info={t('settings.agents.page.field.temperatureTooltip')}>
          <Input aria-label={t('settings.agents.page.field.temperature')} type="number" min="0" step="any" value={draft.temperature} disabled={busy} placeholder={t('chat.modelControls.default')} onChange={event => update({ temperature: event.target.value })} />
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.varin.agents.detail.thinking')}><Select value={draft.thinkingLevel} disabled={busy} onValueChange={thinkingLevel => update({ thinkingLevel: thinkingLevel as ThinkingLevel | 'inherit' })}>
          <SelectTrigger className="w-full"><SelectValue>{draft.thinkingLevel === 'inherit' ? t('chat.modelControls.default') : t(`settings.agents.thinking.${draft.thinkingLevel}`)}</SelectValue></SelectTrigger><SelectContent>
            <SelectItem value="inherit">{t('chat.modelControls.default')}</SelectItem>
            {thinkingLevels.map(level => <SelectItem key={level} value={level}>{t(`settings.agents.thinking.${level}`)}</SelectItem>)}
          </SelectContent></Select></SettingsStackedField>
      </SettingsTwoColumn>
    </SettingsSection>
    <SettingsSection title={t('settings.agents.instructions')}><Textarea aria-label={t('settings.agents.instructions')} rows={9} className="resize-y font-mono typography-meta" value={draft.instructions} disabled={busy} onChange={event => update({ instructions: event.target.value })} /></SettingsSection>
    {profile?.automation ? <ContextAgentDetails definition={profile.automation} instructions={draft.instructions} /> : <>
    <SettingsSection title={t('settings.agents.tools')} info={t('settings.agents.runtimeTools')} contentClassName="space-y-3">
      <p className="typography-meta" data-tools-source={source}>{t(`settings.agents.toolsSource.${source}`)}</p>
      <Textarea aria-label={t('settings.agents.tools')} rows={3} className="font-mono typography-meta" value={draft.tools} disabled={busy} onChange={event => update({ tools: event.target.value, toolsChange: 'explicit' })} />
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => update({ tools: '', toolsChange: 'explicit' })}>{t('settings.agents.noTools')}</Button>
        {profile && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={resetTools}>{t('settings.agents.resetTools')}</Button>}</div>
      {source === 'unconfigured' && <p className="typography-meta text-[var(--status-warning)]">{t('settings.agents.toolsUnconfigured')}</p>}
      {notBuiltin.length > 0 && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('settings.agents.toolsOutsideDirectory', { tools: notBuiltin.join(', ') })}</p>}
      {snapshot.capabilities !== null && <details className="typography-meta"><summary>{t('settings.agents.availableTools')}</summary><p className="mt-2 break-words font-mono">{snapshot.capabilities.map(capability => capability.name).join(', ') || t('settings.agents.noTools')}</p></details>}
    </SettingsSection>
    <SettingsSection contentClassName="space-y-3">
      <label className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.worktree === 'isolated'} disabled={busy} onChange={event => update({ worktree: event.target.checked ? 'isolated' : 'none' })} />{t('settings.agents.isolated')}</label>
      <fieldset className="space-y-2"><legend className="typography-meta">{t('settings.agents.focus')}{builtin ? ` · ${t('settings.agents.builtinFocus')}` : ''}</legend><div className="flex gap-4">
        {(['code', 'research'] as const).map(focus => <label key={focus} className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.workFocus.includes(focus)} disabled={busy || builtin}
          onChange={event => update({ workFocus: event.target.checked ? [...draft.workFocus, focus] : draft.workFocus.filter(value => value !== focus) })} />{t(`workFocus.${focus}`)}</label>)}
      </div></fieldset>
    </SettingsSection>
    </>}
    {validationError && <p role="alert" className="mb-4 typography-meta text-destructive">{validationError}</p>}
    {dirty && revision !== snapshot.revision && <p role="status" className="mb-3 typography-meta text-[var(--status-warning)]">{t('settings.agents.changedElsewhere')}</p>}
    <SettingsActionBar dirty={dirty || !profile} saving={busy} onSave={() => save()} onCancel={() => { discard(); onCancel?.(); }} saveDisabled={!draft.name.trim()} saveLabel={t('settings.common.actions.saveChanges')} error={validationError}>
      {builtin && profile.defaults && <Button type="button" variant="ghost" disabled={busy} onClick={() => update({ ...profile.defaults!, ...agentProfileDefaultLabels(profile, t), tools: profile.defaults!.tools.join(', '), toolsChange: 'reset', temperature: '', thinkingLevel: 'inherit' })}>{t('settings.common.actions.reset')}</Button>}
    </SettingsActionBar>
  </form>;
}
