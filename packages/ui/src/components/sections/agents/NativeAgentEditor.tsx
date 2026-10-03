import React from 'react';
import { HARNESS_MODEL_ROLES, THINKING_LEVELS, type HarnessModelRole, type JsonValue, type PiAgentDescriptor, type WorkFocusId } from '@varin/protocol';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { ModelSelector } from './ModelSelector';
import { nativeAgentDescription, nativeAgentLabel } from './agents-catalog-model';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
interface NativeAgentDraft {
  name: string; description: string; instructions: string; enabled: boolean;
  providerId: string; modelId: string; temperature: string; thinkingLevel: string;
  tools: string; worktree: 'none' | 'isolated'; workFocus: WorkFocusId[];
}
export type NativeAgentDraftCache = Map<string, { values: NativeAgentDraft; revision: string | undefined }>;
interface Props {
  agent?: PiAgentDescriptor;
  cwd: string;
  drafts: NativeAgentDraftCache;
  onSave(config: JsonValue, revision?: string): Promise<boolean>;
  onCancel?(): void;
  busy: boolean;
  error?: string | null;
}

export function NativeAgentEditor({ agent, cwd, drafts, onSave, onCancel, busy, error }: Props) {
  const { t } = useI18n();
  const config = agent?.definition?.config;
  const builtin = config?.kind === 'builtin';
  const defaults = record(config?.defaults);
  const slot = String(config?.slot);
  const knownSlot = HARNESS_MODEL_ROLES.includes(slot as HarnessModelRole);
  const defaultName = knownSlot ? t(`settings.harness.role.${slot as HarnessModelRole}`) : String(defaults.name ?? '');
  const defaultDescription = knownSlot ? t(`settings.harness.role.${slot as HarnessModelRole}.description`) : String(defaults.description ?? '');
  const emptyModelLabel = t(builtin && !['hardImplement', 'review'].includes(slot) ? 'settings.harness.models.noModel' : 'settings.varin.agents.detail.inherited');
  const makeDraft = React.useCallback(() => {
    const original = builtin ? record(config?.binding) : record(config?.agent);
    const profile = builtin ? record(config) : original;
    const model = builtin ? original : record(original.model);
    const settings = record(profile.modelSettings);
    return {
      name: agent ? nativeAgentLabel(agent, t) : '',
      description: agent ? nativeAgentDescription(agent, t) : '',
      instructions: typeof profile.instructions === 'string' ? profile.instructions : '',
      enabled: original.enabled !== false,
      providerId: typeof model.providerId === 'string' ? model.providerId : '',
      modelId: typeof model.modelId === 'string' ? model.modelId : '',
      temperature: typeof settings.temperature === 'number' ? String(settings.temperature) : '',
      thinkingLevel: typeof settings.thinkingLevel === 'string' ? settings.thinkingLevel : 'inherit',
      tools: Array.isArray(profile.tools) ? profile.tools.join(', ') : 'read, grep, find, ls',
      worktree: profile.worktree === 'isolated' ? 'isolated' as const : 'none' as const,
      workFocus: (Array.isArray(original.workFocus) ? original.workFocus : []) as WorkFocusId[],
    };
  }, [agent, builtin, config, t]);
  const draftKey = agent?.id ?? 'new';
  const retained = drafts.get(draftKey);
  const [draft, setDraft] = React.useState<NativeAgentDraft>(() => retained?.values ?? makeDraft());
  const [revision, setRevision] = React.useState(retained?.revision ?? agent?.definition?.revision);
  const [dirty, setDirty] = React.useState(Boolean(retained));
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const latestDraft = React.useRef({ values: draft, revision, dirty });
  latestDraft.current = { values: draft, revision, dirty };
  React.useEffect(() => () => {
    const latest = latestDraft.current;
    if (latest.dirty) drafts.set(draftKey, { values: latest.values, revision: latest.revision });
    else drafts.delete(draftKey);
  }, [draftKey, drafts]);
  React.useEffect(() => {
    if (dirty) return;
    setDraft(makeDraft());
    setRevision(agent?.definition?.revision);
  }, [agent, dirty, makeDraft]);
  const update = (patch: Partial<typeof draft>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); setValidationError(null); };
  const reset = () => update({ name: defaultName, description: defaultDescription,
    instructions: String(defaults.instructions ?? ''), tools: Array.isArray(defaults.tools) ? defaults.tools.join(', ') : '',
    worktree: defaults.worktree === 'isolated' ? 'isolated' : 'none', temperature: '', thinkingLevel: 'inherit' });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const temperature = draft.temperature.trim() ? Number(draft.temperature) : undefined;
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0)) {
      setValidationError(t('settings.agents.page.field.temperatureTooltip')); return;
    }
    const modelSettings = { ...(temperature === undefined ? {} : { temperature }),
      ...(draft.thinkingLevel === 'inherit' ? {} : { thinkingLevel: draft.thinkingLevel }) };
    const model = draft.providerId && draft.modelId ? { providerId: draft.providerId, modelId: draft.modelId } : undefined;
    const tools = [...new Set(draft.tools.split(/[\n,]/u).map(tool => tool.trim()).filter(Boolean))];
    const overrides = {
      ...(draft.name.trim() === defaultName ? {} : { name: draft.name.trim() }),
      ...(draft.description === defaultDescription ? {} : { description: draft.description }),
      ...(draft.instructions === defaults.instructions ? {} : { instructions: draft.instructions }),
      ...(JSON.stringify(tools) === JSON.stringify(defaults.tools) ? {} : { tools }),
      ...(draft.worktree === defaults.worktree ? {} : { worktree: draft.worktree }),
      ...(Object.keys(modelSettings).length ? { modelSettings } : {}),
    };
    const value = builtin ? { enabled: draft.enabled, ...model, ...(Object.keys(overrides).length ? { agent: overrides } : {}) } : {
      name: draft.name.trim(), description: draft.description, instructions: draft.instructions, enabled: draft.enabled,
      ...(model ? { model } : {}), ...(Object.keys(modelSettings).length ? { modelSettings } : {}),
      tools, worktree: draft.worktree, workFocus: draft.workFocus,
    };
    reportSettingsSaveState('saving');
    const saved = await onSave(value, revision);
    reportSettingsSaveState(saved ? 'saved' : 'error');
    if (saved) { drafts.delete(draftKey); setDirty(false); }
  };

  return <form onSubmit={event => { void save(event); }} data-agent-editor="native">
    <SettingsSection settingsItem="agents.catalog" contentClassName="space-y-5" info={t('settings.agents.applies')}>
      <div className="flex items-center justify-between gap-3"><label htmlFor="agent-enabled" className="typography-ui-label">{t('settings.agents.enabled')}</label>
        <Switch id="agent-enabled" checked={draft.enabled} disabled={busy} onCheckedChange={enabled => update({ enabled })} /></div>
      <SettingsStackedField label={t('settings.agents.name')}><Input aria-label={t('settings.agents.name')} required value={draft.name} disabled={busy} onChange={event => update({ name: event.target.value })} /></SettingsStackedField>
      <SettingsStackedField label={t('settings.agents.description')}><Input aria-label={t('settings.agents.description')} value={draft.description} disabled={busy} onChange={event => update({ description: event.target.value })} /></SettingsStackedField>
    </SettingsSection>
    <SettingsSection title={t('settings.agents.page.section.modelParameters')} contentClassName="space-y-5">
      <SettingsStackedField label={t('settings.varin.agents.detail.model')}><ModelSelector cwd={cwd} providerId={draft.providerId} modelId={draft.modelId} allowNone disabled={busy}
        placeholder={emptyModelLabel} defaultSelectionLabel={emptyModelLabel} className="w-full max-w-none" onChange={(providerId, modelId) => update({ providerId, modelId })} /></SettingsStackedField>
      <SettingsTwoColumn>
        <SettingsStackedField label={t('settings.agents.page.field.temperature')} info={t('settings.agents.page.field.temperatureTooltip')}>
          <div className="flex w-full items-center gap-1"><Input aria-label={t('settings.agents.page.field.temperature')} type="number" min="0" step="any" value={draft.temperature} disabled={busy} placeholder={t('chat.modelControls.default')} onChange={event => update({ temperature: event.target.value })} />
            {draft.temperature && <Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={t('settings.agents.page.field.clearTemperatureAria')} onClick={() => update({ temperature: '' })}>×</Button>}</div>
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.varin.agents.detail.thinking')}><Select value={draft.thinkingLevel} disabled={busy} onValueChange={thinkingLevel => update({ thinkingLevel })}>
          <SelectTrigger className="w-full"><SelectValue>{draft.thinkingLevel === 'inherit' ? t('chat.modelControls.default') : t(`settings.varin.pluginSettings.subagents.thinking.${draft.thinkingLevel as typeof THINKING_LEVELS[number]}`)}</SelectValue></SelectTrigger><SelectContent>
            <SelectItem value="inherit">{t('chat.modelControls.default')}</SelectItem>
            {THINKING_LEVELS.map(level => <SelectItem key={level} value={level}>{t(`settings.varin.pluginSettings.subagents.thinking.${level}`)}</SelectItem>)}
          </SelectContent></Select></SettingsStackedField>
      </SettingsTwoColumn>
    </SettingsSection>
    <SettingsSection title={t('settings.agents.instructions')}>
      <Textarea aria-label={t('settings.agents.instructions')} rows={9} className="resize-y font-mono typography-meta" value={draft.instructions} disabled={busy} onChange={event => update({ instructions: event.target.value })} />
    </SettingsSection>
    <SettingsSection title={t('settings.agents.tools')} info={t('settings.agents.toolsHint')} contentClassName="space-y-5">
      <Textarea aria-label={t('settings.agents.tools')} rows={3} className="font-mono typography-meta" value={draft.tools} disabled={busy} onChange={event => update({ tools: event.target.value })} />
      <label className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.worktree === 'isolated'} disabled={busy} onChange={event => update({ worktree: event.target.checked ? 'isolated' : 'none' })} />{t('settings.agents.isolated')}</label>
      {!builtin && <fieldset className="space-y-2"><legend className="typography-meta">{t('settings.agents.focus')}</legend><div className="flex gap-4">
        {(['code', 'research'] as const).map(focus => <label key={focus} className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.workFocus.includes(focus)} disabled={busy}
          onChange={event => update({ workFocus: event.target.checked ? [...draft.workFocus, focus] : draft.workFocus.filter(value => value !== focus) })} />{t(`workFocus.${focus}`)}</label>)}
      </div></fieldset>}
    </SettingsSection>
    {(validationError || error) && <p role="alert" className="mb-4 typography-meta text-destructive">{validationError ?? error}</p>}
    <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
      {builtin && <Button type="button" variant="ghost" disabled={busy} onClick={reset}>{t('settings.common.actions.reset')}</Button>}
      {onCancel && <Button type="button" variant="outline" disabled={busy} onClick={() => {
        latestDraft.current.dirty = false; drafts.delete(draftKey); onCancel();
      }}>{t('settings.common.actions.cancel')}</Button>}
      <Button type="submit" disabled={busy || !draft.name.trim() || (Boolean(agent) && !dirty)}>{t('settings.common.actions.saveChanges')}</Button>
    </div>
  </form>;
}
