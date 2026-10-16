import React from 'react';
import type { BotModelSelection } from '@varin/application-client';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useI18n } from '@/lib/i18n';

type Props = { model: BotModelSelection | null; disabled?: boolean; onChange(providerId: string, modelId: string): Promise<void> | void };
export function BotModelSelector({ model, disabled, onChange }: Props) {
  const { t } = useI18n();
  return <ModelSelector providerId={model?.providerId ?? ''} modelId={model?.modelId ?? ''} allowNone disabled={disabled} onChange={onChange}
    placeholder={t('settings.varin.agents.detail.inherited')} defaultSelectionLabel={t('settings.varin.agents.detail.inherited')} className="w-full max-w-none" />;
}
