import React from 'react';
import { THINKING_LEVELS, type ThinkingLevel } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Unknown inherited models are resolved and validated by the actual request owner. */
export function ModelThinkingSelect({ value, levels = [...THINKING_LEVELS], defaultLevel, disabled, label, onChange }: {
  value?: string;
  levels?: ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
  disabled?: boolean;
  label?: string;
  onChange(value: ThinkingLevel | undefined): void;
}) {
  const { t } = useI18n();
  const defaultLabel = t('chat.modelControls.default') + (defaultLevel ? ` · ${t(`settings.agents.thinking.${defaultLevel}`)}` : '');
  return <Select value={value || 'inherit'} disabled={disabled} onValueChange={next => onChange(next === 'inherit' ? undefined : next as ThinkingLevel)}>
    <SelectTrigger size="settings" className="w-48 max-w-full" aria-label={label ?? t('settings.varin.agents.detail.thinking')}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="inherit">{defaultLabel}</SelectItem>
      {value && !levels.includes(value as ThinkingLevel) ? <SelectItem value={value} disabled>{THINKING_LEVELS.includes(value as ThinkingLevel) ? t(`settings.agents.thinking.${value as ThinkingLevel}`) : value}</SelectItem> : null}
      {levels.map(level => <SelectItem key={level} value={level}>{t(`settings.agents.thinking.${level}`)}</SelectItem>)}
    </SelectContent>
  </Select>;
}
