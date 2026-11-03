import React from 'react';
import { MODEL_THINKING_EFFORTS, modelThinkingConfiguration, type ChannelModel } from '@varin/application-client';
import { isModelThinkingConfiguration } from '@varin/protocol';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ModelAutoSaveField } from './ModelAutoSaveField';
import { ModelFieldLabel } from './ModelFieldStatus';
import { SettingsFieldRow } from '../shared/SettingsSection';

export function ModelCommonSettings({ model, disabled, onChange, group, children }: {
  model: ChannelModel; disabled: boolean; onChange(patch: Partial<ChannelModel>): void;
  group: 'capabilities' | 'capacity'; children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const chat = model.operations.includes('chat');
  const thinking = modelThinkingConfiguration(model);
  if (group === 'capacity') return <div className="space-y-3">
    {(['contextWindow', ...(chat ? ['maxOutputTokens' as const] : [])] as const).map(field => <SettingsFieldRow key={field} label={<ModelFieldLabel field={field}>{t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')}</ModelFieldLabel>}>
      <ModelAutoSaveField catalogField={field} type="number" min="1" step="1" aria-label={t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')} placeholder={t('settings.models.unspecified')} value={String(model[field] ?? '')} disabled={disabled}
        validate={value => value === '' || Number.isSafeInteger(Number(value)) && Number(value) > 0 ? null : t('settings.models.invalidCapacity')}
        onCommit={value => onChange({ [field]: value === '' ? undefined : Number(value) })} />
    </SettingsFieldRow>)}
  </div>;
  if (!chat) return null;
  return <div className="space-y-4">
    <SettingsFieldRow label={<ModelFieldLabel field="input">{t('settings.models.imageInput')}</ModelFieldLabel>}><Switch aria-label={t('settings.models.imageInput')} checked={model.input?.includes('image') ?? false} disabled={disabled} onCheckedChange={enabled => onChange({ input: enabled ? ['text', 'image'] : ['text'] })} /></SettingsFieldRow>
    <SettingsFieldRow label={<ModelFieldLabel field="reasoning">{t('settings.models.reasoning')}</ModelFieldLabel>}><Switch aria-label={t('settings.models.reasoning')} checked={model.reasoning === true} disabled={disabled} onCheckedChange={enabled => onChange({ reasoning: enabled,
      ...(enabled && !model.thinking ? { thinking: { mode: 'levels', levels: [], allowOff: true } }
        : !enabled && model.thinking && !isModelThinkingConfiguration(model.thinking) ? { thinking: undefined } : {}),
    })} /></SettingsFieldRow>
    {model.reasoning ? <div className="space-y-4">
      {children}
      {thinking.mode === 'levels' ? <div className="space-y-3">
        <ModelFieldLabel field="thinking">{t('settings.models.availableLevels')}</ModelFieldLabel>
        <div className="flex flex-wrap gap-2">{MODEL_THINKING_EFFORTS.map(effort => <button key={effort} type="button" disabled={disabled} aria-pressed={thinking.levels.includes(effort)} onClick={() => onChange({ thinking: { ...thinking, levels: MODEL_THINKING_EFFORTS.filter(value => value === effort ? !thinking.levels.includes(value) : thinking.levels.includes(value)) } })} className={cn('rounded-lg border px-3 py-1.5 typography-meta transition-colors', thinking.levels.includes(effort) ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-interactive-hover')}>{t(`settings.agents.thinking.${effort}`)}</button>)}</div>
        {!thinking.levels.length ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.chooseLevels')}</p> : null}
      </div> : null}
      {thinking.mode === 'budget' ? <SettingsFieldRow label={<ModelFieldLabel field="thinking">{t('settings.models.thinkingTokens')}</ModelFieldLabel>}><ModelAutoSaveField catalogField="thinking" type="number" min="1" step="1" aria-label={t('settings.models.thinkingTokens')} value={String(thinking.tokens)} disabled={disabled}
        validate={value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? null : t('settings.models.invalidBudget')}
        onCommit={value => onChange({ thinking: { ...thinking, tokens: Number(value) } })} /></SettingsFieldRow> : null}
      {thinking.mode === 'levels' || thinking.mode === 'budget' ? <label className="flex items-center gap-2 typography-meta"><Checkbox checked={thinking.allowOff} disabled={disabled} onChange={allowOff => onChange({ thinking: { ...thinking, allowOff } })} />{t('settings.models.allowOff')}</label> : null}
    </div> : null}
  </div>;
}
