import React from 'react';
import { modelThinkingLevels, type BotModelSelection } from '@varin/application-client';
import type { ThinkingLevel } from '@varin/protocol';
import { useConfigurationModels } from '../harness/ConfigurationModels';
import { ModelThinkingSelect } from '../shared/ModelThinkingSelect';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useI18n } from '@/lib/i18n';
import { Row } from '../shared/kit';

type Props = { model: BotModelSelection | null; disabled?: boolean; onChange(providerId: string, modelId: string): Promise<void> | void; onThinkingChange(value: ThinkingLevel | undefined): void };
export function BotModelSelector({ model, disabled, onChange, onThinkingChange }: Props) {
  const { t } = useI18n();
  const catalog = useConfigurationModels();
  const defaultLabel = t('settings.roles.defaultModel');
  const selected = catalog.modelsFor(model?.providerId ?? '', 'chat').find(candidate => candidate.id === model?.modelId);
  const levels = selected ? modelThinkingLevels(selected) : [];
  return <>
    <Row label={t('settings.bots.preferredModel')}>
      <ModelSelector providerId={model?.providerId ?? ''} modelId={model?.modelId ?? ''} allowNone disabled={disabled} onChange={onChange}
        placeholder={defaultLabel} defaultSelectionLabel={defaultLabel} className="w-64 max-w-full" />
    </Row>
    {model ? <Row label={t('settings.varin.agents.detail.thinking')}>
      <ModelThinkingSelect value={model.thinkingLevel} levels={levels} defaultLevel={levels[0]} disabled={disabled || !selected} onChange={onThinkingChange} />
    </Row> : null}
    {catalog.error ? <p role="alert" className="typography-meta text-destructive">{catalog.error}</p> : null}
  </>;
}
