import React from 'react';
import type { ChannelModel, ModelTokenizer } from '@varin/application-client';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { SettingsFieldRow } from '../shared/SettingsSection';

export function ModelTokenizerSettings({ model, disabled, onChange, validity }: {
  model: ChannelModel; disabled: boolean; onChange(patch: Partial<ChannelModel>): void;
  validity(field: string, valid: boolean): void;
}) {
  const { t } = useI18n();
  const source = model.tokenizer;
  const value = source?.kind === 'encoding' ? source.name : source?.kind === 'huggingface' ? source.repository
    : source?.kind === 'url' ? source.url : source?.kind === 'file' ? source.path : '';
  const valid = !source || value.trim().length > 0;
  React.useEffect(() => { validity('tokenizer', valid); return () => validity('tokenizer', true); }, [valid, validity]);
  const changeKind = (kind: ModelTokenizer['kind'] | 'auto') => onChange({ tokenizer: kind === 'auto' ? undefined
    : kind === 'encoding' ? { kind, name: 'o200k_base' } : kind === 'huggingface' ? { kind, repository: '' }
      : kind === 'url' ? { kind, url: '' } : { kind, path: '' } });
  const changeValue = (value: string) => {
    if (!source) return;
    onChange({ tokenizer: source.kind === 'encoding' ? { ...source, name: value } : source.kind === 'huggingface' ? { ...source, repository: value }
      : source.kind === 'url' ? { ...source, url: value } : { ...source, path: value } });
  };
  return <div className="space-y-3">
    <SettingsFieldRow label={t('settings.models.tokenizer')}>
      <Select value={source?.kind ?? 'auto'} disabled={disabled} onValueChange={value => changeKind(value as ModelTokenizer['kind'] | 'auto')}>
        <SelectTrigger size="settings" aria-label={t('settings.models.tokenizer')}><SelectValue /></SelectTrigger>
        <SelectContent>{(['auto', 'encoding', 'huggingface', 'url', 'file'] as const).map(kind => <SelectItem key={kind} value={kind}>{t(`settings.models.tokenizer.${kind}`)}</SelectItem>)}</SelectContent>
      </Select>
    </SettingsFieldRow>
    {source ? <Input aria-label={t('settings.models.tokenizer.source')} value={value} disabled={disabled} onChange={event => changeValue(event.target.value)}
      placeholder={source.kind === 'encoding' ? 'o200k_base' : source.kind === 'huggingface' ? 'organization/model' : source.kind === 'url' ? 'https://…/tokenizer.json' : t('settings.models.tokenizer.filePlaceholder')} /> : null}
    {source?.kind === 'huggingface' ? <Input aria-label={t('settings.models.tokenizer.revision')} placeholder={t('settings.models.tokenizer.revision')} value={source.revision ?? ''} disabled={disabled}
      onChange={event => onChange({ tokenizer: { ...source, revision: event.target.value || undefined } })} /> : null}
    <p className="typography-micro text-muted-foreground">{t('settings.models.tokenizer.description')}</p>
    {!valid ? <p role="alert" className="typography-micro text-destructive">{t('settings.models.tokenizer.required')}</p> : null}
  </div>;
}
