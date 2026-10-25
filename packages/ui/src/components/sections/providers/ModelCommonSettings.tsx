import React from 'react';
import { MODEL_THINKING_EFFORTS, modelThinkingConfiguration, type ChannelModel } from '@varin/application-client';
import { isModelThinkingConfiguration } from '@varin/protocol';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  model: ChannelModel;
  disabled: boolean;
  onChange(model: ChannelModel): void;
  validity(field: string, valid: boolean): void;
}

/** Common edits share the channel draft, whether made in a model row or its detail page. */
export function ModelCommonSettings({ model, disabled, onChange, validity }: Props) {
  const { t } = useI18n();
  const id = React.useId();
  const chat = model.operations.includes('chat');
  const thinking = modelThinkingConfiguration(model);
  const update = (patch: Partial<ChannelModel>) => onChange({ ...model, ...patch });
  const capacityFields: ('contextWindow' | 'maxOutputTokens')[] = chat ? ['contextWindow', 'maxOutputTokens'] : ['contextWindow'];
  const invalidThinking = chat && model.reasoning && thinking.mode === 'levels' && !thinking.levels.length;
  const invalidCapacity = capacityFields.some(field => model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field]! <= 0));
  React.useEffect(() => { validity('thinking', !invalidThinking); validity('capacity', !invalidCapacity); }, [invalidThinking, invalidCapacity, validity]);

  return <div className="space-y-5 @container">
    {chat ? <>
    <div className="grid gap-4 @lg:grid-cols-2">
      <div className="flex items-center justify-between gap-4"><label htmlFor={`${id}-image`} className="typography-meta">{t('settings.models.imageInput')}</label><Switch id={`${id}-image`} aria-label={t('settings.models.imageInput')} checked={model.input?.includes('image') ?? false} disabled={disabled} onCheckedChange={enabled => update({ input: enabled ? ['text', 'image'] : ['text'] })} /></div>
      <div className="flex items-center justify-between gap-4"><label htmlFor={`${id}-reasoning`} className="typography-meta">{t('settings.models.reasoning')}</label><Switch id={`${id}-reasoning`} aria-label={t('settings.models.reasoning')} checked={model.reasoning === true} disabled={disabled} onCheckedChange={enabled => update({ reasoning: enabled,
        ...(enabled && !model.thinking ? { thinking: thinking.mode === 'levels' ? thinking : { mode: 'levels', levels: [], allowOff: true } }
          : !enabled && model.thinking && !isModelThinkingConfiguration(model.thinking) ? { thinking: undefined } : {}),
      })} /></div>
    </div>
    <Collapsible open={model.reasoning === true} className="!mt-0">
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] transition-[height,opacity] duration-(--motion-dur-glide) ease-glide data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0 motion-reduce:transition-none">
        <div className="pt-5"><div className="space-y-3 border-l-2 border-border/70 py-1 pl-4">
          {thinking.mode === 'levels' ? <>
            <p className="typography-meta text-muted-foreground">{t('settings.models.availableLevels')}</p>
            <div className="flex flex-wrap gap-2">{MODEL_THINKING_EFFORTS.map(effort => <button key={effort} type="button" disabled={disabled} aria-pressed={thinking.levels.includes(effort)} onClick={() => update({ thinking: { ...thinking, levels: MODEL_THINKING_EFFORTS.filter(value => value === effort ? !thinking.levels.includes(value) : thinking.levels.includes(value)) } })} className={cn('rounded-lg border px-3 py-1.5 typography-meta transition-colors', thinking.levels.includes(effort) ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-interactive-hover')}>{t(`settings.agents.thinking.${effort}`)}</button>)}</div>
            {invalidThinking ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.chooseLevels')}</p> : null}
          </> : <p className="typography-meta text-muted-foreground">{t(`settings.models.thinkingMode.${thinking.mode}`)}</p>}
          {thinking.mode === 'budget' ? <label className="flex items-center gap-3 typography-meta">{t('settings.models.thinkingTokens')}<Input type="number" className="max-w-48" aria-label={t('settings.models.thinkingTokens')} value={thinking.tokens} disabled={disabled} onChange={event => update({ thinking: { ...thinking, tokens: Number(event.target.value) } })} /></label> : null}
          {thinking.mode === 'levels' || thinking.mode === 'budget' ? <label className="flex items-center gap-2 typography-meta"><Checkbox checked={thinking.allowOff} disabled={disabled} onChange={allowOff => update({ thinking: { ...thinking, allowOff } })} />{t('settings.models.allowOff')}</label> : null}
        </div></div>
      </CollapsibleContent>
    </Collapsible>
    </> : null}
    <div className="grid gap-4 @lg:grid-cols-2">{capacityFields.map(field => <div key={field} className="space-y-2"><label htmlFor={`${id}-${field}`} className="block typography-meta text-muted-foreground">{t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')}</label><Input id={`${id}-${field}`} type="number" aria-label={t(field === 'contextWindow' ? 'settings.models.context' : 'settings.models.output')} placeholder={t('settings.models.unspecified')} value={model[field] ?? ''} disabled={disabled} onChange={event => update({ [field]: event.target.value ? Number(event.target.value) : undefined })} /></div>)}</div>
    {invalidCapacity ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.invalidCapacity')}</p> : null}
  </div>;
}
