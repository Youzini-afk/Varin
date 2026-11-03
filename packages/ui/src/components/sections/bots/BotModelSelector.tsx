import React from 'react';
import { modelThinkingLevels, type BotModelSelection } from '@varin/application-client';
import type { ThinkingLevel } from '@varin/protocol';
import { useConfigurationModels } from '../harness/ConfigurationModels';
import { ModelThinkingSelect } from '../shared/ModelThinkingSelect';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useI18n } from '@/lib/i18n';

type Props = { model: BotModelSelection | null; disabled?: boolean; onChange(providerId: string, modelId: string): Promise<void> | void; onThinkingChange(value: ThinkingLevel | undefined): void };
export function BotModelSelector({ model, disabled, onChange, onThinkingChange }: Props) {
  const { t } = useI18n();
  const catalog = useConfigurationModels();
  const selected = catalog.modelsFor(model?.providerId ?? '', 'chat').find(candidate => candidate.id === model?.modelId);
  const levels = selected ? modelThinkingLevels(selected) : [];
  return <div className="flex w-full min-w-0 flex-col items-end gap-3">
    <ModelSelector providerId={model?.providerId ?? ''} modelId={model?.modelId ?? ''} allowNone disabled={disabled} onChange={onChange}
      placeholder={t('settings.varin.agents.detail.inherited')} defaultSelectionLabel={t('settings.varin.agents.detail.inherited')} className="w-full max-w-none" />
    {model ? <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <span className="typography-meta text-muted-foreground">{t('settings.varin.agents.detail.thinking')}</span>
      <ModelThinkingSelect value={model.thinkingLevel} levels={levels} defaultLevel={levels[0]} disabled={disabled || !selected} onChange={onThinkingChange} />
    </div> : null}
    {catalog.error ? <p role="alert" className="typography-meta text-destructive">{catalog.error}</p> : null}
  </div>;
}
